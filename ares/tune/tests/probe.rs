use ares_core::trajectory::Trajectory;
use ares_core::RobotConfig;
use ares_tune::{simulate, Pid, RobotCode, SimOptions, World};
const PROJECT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../areslib/src/test/resources/project");
#[test]
#[ignore]
fn probe() {
    let r = RobotConfig::from_json(&std::fs::read_to_string(format!("{PROJECT}/bot.robot.json")).unwrap()).unwrap();
    for name in ["Main", "Alt"] {
        let t: Trajectory = serde_json::from_str(&std::fs::read_to_string(format!("{PROJECT}/trajectories/{name}.traj.json")).unwrap()).unwrap();
        let n = World::nominal(&r);
        let cases: Vec<(&str, World)> = vec![
            ("ideal", World { mu: 3.0, cog_height_m: 0.0, battery_r_ohm: 0.0, perfect_odometry: true, ..n.clone() }),
            ("ideal+batt", World { mu: 3.0, cog_height_m: 0.0, perfect_odometry: true, ..n.clone() }),
            ("ideal+cog", World { mu: 3.0, battery_r_ohm: 0.0, perfect_odometry: true, ..n.clone() }),
            ("nominal", n.clone()),
            ("cog 0", World { cog_height_m: 0.0, ..n.clone() }),
            ("mu 1.2", World { mu: 1.2, ..n.clone() }),
            ("perfect odo", World { perfect_odometry: true, ..n.clone() }),
            ("mu1.2+perfect", World { mu: 1.2, perfect_odometry: true, ..n.clone() }),
        ];
        for kp in [2.0, 5.0, 10.0] {
            let code = RobotCode { translation: Pid { kp, ki: 0.0, kd: 0.0 }, rotation: Pid { kp, ki: 0.0, kd: 0.0 }, ..Default::default() };
            for (label, w) in &cases {
                let o = simulate(&r, &t, &code, w, &SimOptions { abort_m: 5.0, ..Default::default() });
                println!("{name} kp {kp:4} {label:14} rms {:.3} max {:.3} final {:.3} slip {:.2} drift {:.3} bus {:.1}", o.rms_pos_m, o.max_pos_m, o.final_pos_m, o.max_slip_mps, o.odometry_drift_m, o.min_bus_v);
            }
        }
    }
}

#[test]
#[ignore]
fn tune_defaults() {
    use ares_tune::tune::{run, Criterion, Method, Param, TuneConfig};
    use std::collections::BTreeMap;
    let r = RobotConfig::from_json(&std::fs::read_to_string(format!("{PROJECT}/bot.robot.json")).unwrap()).unwrap();
    let load = |n: &str| -> Trajectory { serde_json::from_str(&std::fs::read_to_string(format!("{PROJECT}/trajectories/{n}.traj.json")).unwrap()).unwrap() };
    let mut world = World::nominal(&r);
    world.latency_s = 0.02;
    let vary: BTreeMap<String, f64> = [("massKg", 4.0), ("mu", 0.1), ("batteryV", 1.0), ("batteryROhm", 0.005), ("wheelRadiusM", 0.0015), ("motorScale", 0.05), ("latencyS", 0.01), ("startOffsetXM", 0.05), ("startOffsetYM", 0.05), ("startOffsetRad", 0.035)]
        .into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    let p = |key: &str, min: f64, max: f64, start: f64, log: bool| Param { key: key.into(), min, max, start, log, tune: true };
    for name in ["Alt", "Main"] {
        let cfg = TuneConfig {
            code: RobotCode::default(),
            params: vec![p("translationKp", 0.5, 40.0, 5.0, true), p("translationKd", 0.0, 0.6, 0.0, false), p("rotationKp", 0.5, 40.0, 5.0, true), p("rotationKd", 0.0, 0.6, 0.0, false)],
            world: world.clone(), vary: vary.clone(), environments: 24,
            method: Method::Population { generations: 40, population: 32 }, criterion: Criterion::Worst,
            sim: SimOptions::default(), seed: 2026,
        };
        let out = run(&r, &[load(name)], &cfg, std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), |_| {});
        println!("{name}: now {:.4} (rms {:.1} cm, worst end {:.1} cm, lost {}) -> best {:.4} (rms {:.1} cm, worst end {:.1} cm, lost {}) gains {:?} | {} runs in {:.1} s",
            out.baseline.score, out.baseline.mean_rms_m * 100.0, out.baseline.worst_final_m * 100.0, out.baseline.aborts,
            out.best.score, out.best.mean_rms_m * 100.0, out.best.worst_final_m * 100.0, out.best.aborts,
            out.best.values.iter().map(|v| (v * 100.0).round() / 100.0).collect::<Vec<_>>(), out.runs, out.elapsed_s);
    }
}

/// Records a real run's progress events for the app's visual harness
/// (app/harness): ARES_HARNESS=<dir> cargo test -p ares-tune --test probe record -- --ignored
#[test]
#[ignore]
fn record() {
    use ares_tune::tune::{run, Criterion, Method, Param, TuneConfig};
    use std::collections::BTreeMap;
    let Ok(dir) = std::env::var("ARES_HARNESS") else { return };
    let r = RobotConfig::from_json(&std::fs::read_to_string(format!("{PROJECT}/bot.robot.json")).unwrap()).unwrap();
    let load = |n: &str| -> Trajectory { serde_json::from_str(&std::fs::read_to_string(format!("{PROJECT}/trajectories/{n}.traj.json")).unwrap()).unwrap() };
    let mut world = World::nominal(&r);
    world.latency_s = 0.02;
    let vary: BTreeMap<String, f64> = [("massKg", 4.0), ("mu", 0.1), ("batteryV", 1.0), ("batteryROhm", 0.005), ("wheelRadiusM", 0.0015), ("motorScale", 0.05), ("latencyS", 0.01), ("startOffsetXM", 0.05), ("startOffsetYM", 0.05), ("startOffsetRad", 0.035)]
        .into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    let p = |key: &str, min: f64, max: f64, start: f64, log: bool, tune: bool| Param { key: key.into(), min, max, start, log, tune };
    let cfg = TuneConfig {
        code: RobotCode::default(),
        params: vec![
            p("translationKp", 0.5, 40.0, 5.0, true, true), p("translationKd", 0.0, 0.6, 0.0, false, true), p("translationKi", 0.0, 2.0, 0.0, false, false),
            p("rotationKp", 0.5, 40.0, 5.0, true, true), p("rotationKd", 0.0, 0.6, 0.0, false, true), p("rotationKi", 0.0, 2.0, 0.0, false, false),
            p("driveKp", 0.01, 1.0, 0.1, true, false), p("driveKs", 0.0, 0.4, 0.0, false, false), p("driveKv", 0.08, 0.16, 0.124, false, false),
        ],
        world, vary, environments: 24,
        method: Method::Population { generations: 30, population: 32 }, criterion: Criterion::Worst,
        sim: SimOptions::default(), seed: 2026,
    };
    let mut events = Vec::new();
    run(&r, &[load("Alt"), load("Main")], &cfg, std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), |p| events.push(serde_json::to_value(p).unwrap()));
    std::fs::write(format!("{dir}/progress.json"), serde_json::to_string(&events).unwrap()).unwrap();
}
