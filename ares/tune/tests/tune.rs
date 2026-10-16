use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use ares_core::trajectory::Trajectory;
use ares_core::RobotConfig;
use ares_tune::tune::{run, worlds, Criterion, Method, Param, TuneConfig};
use ares_tune::{RobotCode, SimOptions, World};

const PROJECT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../areslib/src/test/resources/project");

fn robot() -> RobotConfig {
    RobotConfig::from_json(&std::fs::read_to_string(format!("{PROJECT}/bot.robot.json")).unwrap()).unwrap()
}

fn traj(name: &str) -> Trajectory {
    serde_json::from_str(&std::fs::read_to_string(format!("{PROJECT}/trajectories/{name}.traj.json")).unwrap()).unwrap()
}

fn params(start: f64) -> Vec<Param> {
    vec![
        Param { key: "translationKp".into(), min: 0.5, max: 30.0, start, log: true, tune: true },
        Param { key: "rotationKp".into(), min: 0.5, max: 30.0, start, log: true, tune: true },
        Param { key: "translationKd".into(), min: 0.0, max: 0.5, start: 0.0, log: false, tune: false },
    ]
}

fn config(method: Method, start: f64) -> TuneConfig {
    let r = robot();
    let mut vary = BTreeMap::new();
    vary.insert("massKg".to_string(), 4.0);
    vary.insert("mu".to_string(), 0.1);
    vary.insert("batteryV".to_string(), 1.0);
    TuneConfig {
        code: RobotCode::default(),
        params: params(start),
        world: World::nominal(&r),
        vary,
        environments: 8,
        method,
        criterion: Criterion::Worst,
        sim: SimOptions { abort_m: 1.0, ..Default::default() },
        seed: 7,
    }
}

#[test]
fn the_worlds_spread_over_the_ranges_and_keep_the_nominal_first() {
    let r = robot();
    let mut vary = BTreeMap::new();
    vary.insert("massKg".to_string(), 4.0);
    let w = worlds(&World::nominal(&r), &vary, 11, 1);
    assert_eq!(w.len(), 11);
    assert_eq!(w[0].mass_kg, r.mass_kg);
    let masses: Vec<f64> = w[1..].iter().map(|w| w.mass_kg).collect();
    assert!(masses.iter().all(|m| (m - r.mass_kg).abs() <= 4.0 + 1e-9));
    // A Latin hypercube: one world in each tenth of the range.
    let mut slices: Vec<usize> = masses.iter().map(|m| ((m - (r.mass_kg - 4.0)) / 0.8).floor() as usize).collect();
    slices.sort();
    assert_eq!(slices, (0..10).collect::<Vec<_>>());
}

#[test]
fn a_population_search_beats_the_gains_it_started_from() {
    let cfg = config(Method::Population { generations: 8, population: 24 }, 1.0);
    let mut seen = 0;
    let out = run(&robot(), &[traj("Alt")], &cfg, Arc::new(AtomicBool::new(false)), |_| seen += 1);
    assert!(out.done);
    assert_eq!(seen, 10); // the baseline, 8 generations, the end
    assert!(out.best.score < out.baseline.score * 0.9, "best {} baseline {}", out.best.score, out.baseline.score);
    // The best so far never gets worse.
    assert!(out.history.windows(2).all(|w| w[1].best <= w[0].best + 1e-12));
    assert_eq!(out.best.per_env.len(), 8);
    assert_eq!(out.tracks.len(), 8);
    println!("baseline {:.4} -> best {:.4} with {:?} in {:.2} s ({} runs)", out.baseline.score, out.best.score, out.best.values, out.elapsed_s, out.runs);
}

#[test]
fn a_grid_tries_every_combination() {
    let cfg = config(Method::Grid { steps: 4 }, 5.0);
    let out = run(&robot(), &[traj("Alt")], &cfg, Arc::new(AtomicBool::new(false)), |_| {});
    assert_eq!(out.runs, (1 + 16) * 8);
    assert!(out.best.score <= out.baseline.score);
}

#[test]
fn it_stops_when_told() {
    let cfg = config(Method::Population { generations: 50, population: 24 }, 1.0);
    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let mut gens = 0;
    let out = run(&robot(), &[traj("Alt")], &cfg, cancel, move |p| {
        gens = p.generation;
        if p.generation >= 2 {
            c.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    });
    assert!(out.cancelled);
    assert!(out.generation < 50);
}

#[test]
fn the_app_s_config_reads_as_is() {
    // What app/src/tune/model.ts sends (TuneConfig), field for field.
    let json = r#"{
      "code": { "translation": { "kp": 5, "ki": 0, "kd": 0 }, "rotation": { "kp": 5, "ki": 0, "kd": 0 },
                "driveKp": 0.1, "driveKs": 0, "driveKv": 0.124, "speedAt12vMps": 5.85,
                "statorLimitA": 120, "supplyLimitA": 70, "forceFf": true },
      "params": [{ "key": "translationKp", "min": 0.5, "max": 40, "start": 5, "log": true, "tune": true }],
      "world": { "massKg": 58, "moiKgM2": 7, "cogHeightM": 0.35, "mu": 0.9, "batteryV": 12.5, "batteryROhm": 0.015,
                 "wheelRadiusM": 0.0508, "motorScale": 1, "driveFrictionV": 0.2, "wheelMassKg": 1.5, "latencyS": 0.02,
                 "poseNoiseM": 0, "headingNoiseRad": 0, "startOffsetXM": 0, "startOffsetYM": 0, "startOffsetRad": 0,
                 "steerTauS": 0.02, "steerRateRadps": 24, "perfectOdometry": false, "seed": 1 },
      "vary": { "massKg": 4, "mu": 0.1 },
      "environments": 24,
      "method": { "kind": "population", "generations": 40, "population": 32 },
      "criterion": "p90",
      "sim": { "abortM": 0.5, "settleS": 0.5, "record": false },
      "seed": 2026
    }"#;
    let cfg: TuneConfig = serde_json::from_str(json).unwrap();
    assert_eq!(cfg.code.speed_at_12v_mps, 5.85);
    assert_eq!(cfg.world.battery_r_ohm, 0.015);
    assert_eq!(cfg.criterion, Criterion::P90);
    assert_eq!(cfg.method, Method::Population { generations: 40, population: 32 });
    // And the progress goes back with the names the app reads.
    let p = serde_json::to_value(ares_tune::tune::Progress::default()).unwrap();
    for k in ["generation", "generations", "runs", "elapsedS", "baseline", "best", "population", "history", "tracks", "baselineTracks", "worlds", "done", "cancelled"] {
        assert!(p.get(k).is_some(), "{k}");
    }
    let c = serde_json::to_value(ares_tune::tune::Candidate::default()).unwrap();
    for k in ["values", "score", "perEnv", "perPath", "aborts", "meanRmsM", "worstFinalM"] {
        assert!(c.get(k).is_some(), "{k}");
    }
}
