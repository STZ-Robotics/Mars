use std::sync::atomic::AtomicBool;

use ares_core::trajectory::Trajectory;
use ares_core::RobotConfig;
use ares_tune::calibrate::{calibrate, FitVar, Observation};
use ares_tune::{simulate, Pid, RobotCode, SimOptions, World};

const PROJECT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../areslib/src/test/resources/project");

fn robot() -> RobotConfig {
    RobotConfig::from_json(&std::fs::read_to_string(format!("{PROJECT}/bot.robot.json")).unwrap()).unwrap()
}

fn traj(name: &str) -> Trajectory {
    serde_json::from_str(&std::fs::read_to_string(format!("{PROJECT}/trajectories/{name}.traj.json")).unwrap()).unwrap()
}

/// What a log of the "true" robot would say: where it was every 20 ms.
pub fn observe(r: &RobotConfig, t: &Trajectory, code: &RobotCode, truth: &World) -> Vec<Observation> {
    let run = simulate(r, t, code, truth, &SimOptions { abort_m: 5.0, settle_s: 0.5, record: true, record_every: 1 });
    run.track.iter().enumerate().map(|(k, p)| Observation { t: k as f64 * 0.02, x: p[0] as f64, y: p[1] as f64, heading: p[2] as f64 }).collect()
}

#[test]
fn it_finds_a_world_that_does_what_the_robot_did() {
    let (r, t) = (robot(), traj("Main"));
    let code = RobotCode { translation: Pid { kp: 3.0, ki: 0.0, kd: 0.0 }, rotation: Pid { kp: 3.0, ki: 0.0, kd: 0.0 }, ..Default::default() };
    // The truth: heavier, a bit slicker and later than the robot.json says.
    let nominal = World { vision_hz: 0.0, ..World::nominal(&r) };
    let truth = World { mass_kg: 62.0, mu: 0.85, latency_s: 0.05, ..nominal.clone() };
    let obs = observe(&r, &t, &code, &truth);
    let vars = vec![
        FitVar { key: "massKg".into(), min: 50.0, max: 70.0 },
        FitVar { key: "mu".into(), min: 0.6, max: 1.2 },
        FitVar { key: "latencyS".into(), min: 0.0, max: 0.1 },
    ];
    let mut generations = 0;
    let c = calibrate(&r, &t, &code, &nominal, &vars, &obs, 25, 24, &AtomicBool::new(false), |g, _| generations = g);
    println!("before {:.4} after {:.4} values {:?} runs {}", c.rms_before_m, c.rms_after_m, c.values, c.runs);
    assert_eq!(generations, 25);
    // It reproduces the run: what Tune needs.
    assert!(c.rms_after_m < 0.35 * c.rms_before_m, "{} -> {}", c.rms_before_m, c.rms_after_m);
    assert!(c.rms_after_m < 0.06, "{}", c.rms_after_m);
    // The grip comes out close; mass and grip trade against each other (both
    // limit the acceleration), so neither is exact on its own.
    assert!((c.values[1] - 0.85).abs() < 0.1, "mu {}", c.values[1]);
    assert!(c.history.windows(2).all(|w| w[1] <= w[0] + 1e-12));
}

#[test]
fn it_starts_from_where_the_robot_really_started() {
    let (r, t) = (robot(), traj("Alt"));
    let code = RobotCode::default();
    let truth = World { start_offset_x_m: 0.2, start_offset_y_m: -0.1, vision_hz: 0.0, ..World::nominal(&r) };
    let obs = observe(&r, &t, &code, &truth);
    // Nothing to fit: the start alone should match it.
    let c = calibrate(&r, &t, &code, &World { vision_hz: 0.0, ..World::nominal(&r) }, &[], &obs, 0, 6, &AtomicBool::new(false), |_, _| {});
    assert!(c.rms_before_m < 0.01, "{}", c.rms_before_m);
}

/// Writes the Logs harness's fixture: a run of Main as a heavier, later robot
/// drove it, shaped as log_run returns it, and its real calibration.
#[test]
#[ignore]
fn record() {
    let Ok(dir) = std::env::var("ARES_HARNESS") else { return };
    let (r, t) = (robot(), traj("Main"));
    let code = RobotCode { translation: Pid { kp: 3.0, ki: 0.0, kd: 0.0 }, rotation: Pid { kp: 3.0, ki: 0.0, kd: 0.0 }, ..Default::default() };
    let nominal = World { vision_hz: 0.0, ..World::nominal(&r) };
    let truth = World { mass_kg: 62.0, mu: 0.85, latency_s: 0.05, start_offset_x_m: 0.04, ..nominal.clone() };
    let obs = observe(&r, &t, &code, &truth);
    let at = |time: f64| t.samples.iter().min_by(|a, b| (a.t - time).abs().total_cmp(&(b.t - time).abs())).unwrap();
    let samples: Vec<serde_json::Value> = obs.iter().enumerate().map(|(k, o)| {
        let s = at(o.t);
        let prev = obs[k.saturating_sub(1)];
        let dt = if k == 0 { 1.0 } else { o.t - prev.t };
        let err = ((s.x - o.x).powi(2) + (s.y - o.y).powi(2)).sqrt();
        serde_json::json!({
            "t": o.t, "robot": [o.x, o.y, o.heading], "target": [s.x, s.y, s.heading],
            "commanded": [s.vx, s.vy, s.omega],
            "measured": [(o.x - prev.x) / dt, (o.y - prev.y) / dt, (o.heading - prev.heading) / dt],
            "err": err,
        })
    }).collect();
    let errs: Vec<f64> = samples.iter().map(|s| s["err"].as_f64().unwrap()).collect();
    let run = serde_json::json!({
        "index": 0, "path": "Main", "startS": 15.3, "durationS": obs.last().unwrap().t, "replans": 0,
        "maxErrM": errs.iter().copied().fold(0.0, f64::max), "meanErrM": errs.iter().sum::<f64>() / errs.len() as f64,
        "translation": [3.0, 0.0, 0.0], "rotation": [3.0, 0.0, 0.0],
        "pathPoses": t.samples.iter().map(|s| [s.x, s.y, s.heading]).collect::<Vec<_>>(),
        "samples": samples,
    });
    let vars = vec![
        FitVar { key: "massKg".into(), min: 50.0, max: 70.0 },
        FitVar { key: "mu".into(), min: 0.6, max: 1.3 },
        FitVar { key: "latencyS".into(), min: 0.0, max: 0.12 },
    ];
    let c = calibrate(&r, &t, &code, &nominal, &vars, &obs, 25, 24, &AtomicBool::new(false), |_, _| {});
    std::fs::write(format!("{dir}/logrun.json"), serde_json::to_string(&serde_json::json!({ "run": run, "calibration": c })).unwrap()).unwrap();
}
