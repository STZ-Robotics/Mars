use ares_core::trajectory::Trajectory;
use ares_core::RobotConfig;
use ares_tune::{simulate, Pid, RobotCode, SimOptions, World};

const PROJECT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../areslib/src/test/resources/project");

fn robot() -> RobotConfig {
    RobotConfig::from_json(&std::fs::read_to_string(format!("{PROJECT}/bot.robot.json")).unwrap()).unwrap()
}

fn traj(name: &str) -> Trajectory {
    serde_json::from_str(&std::fs::read_to_string(format!("{PROJECT}/trajectories/{name}.traj.json")).unwrap()).unwrap()
}

fn code(kp: f64) -> RobotCode {
    RobotCode { translation: Pid { kp, ki: 0.0, kd: 0.0 }, rotation: Pid { kp, ki: 0.0, kd: 0.0 }, ..Default::default() }
}

/// No slip, no sag, no load transfer, perfect odometry: only the controller,
/// the motors and the steering between the trajectory and the robot.
fn ideal(r: &RobotConfig) -> World {
    World { mu: 3.0, cog_height_m: 0.0, battery_r_ohm: 0.0, perfect_odometry: true, ..World::nominal(r) }
}

#[test]
fn in_an_ideal_world_it_follows_closely() {
    let (r, t) = (robot(), traj("Main"));
    let out = simulate(&r, &t, &code(5.0), &ideal(&r), &SimOptions::default());
    assert!(!out.aborted);
    assert!(out.rms_pos_m < 0.05, "rms {}", out.rms_pos_m);
    assert!(out.final_pos_m < 0.02, "final {}", out.final_pos_m);
}

#[test]
fn feeding_the_forces_forward_tracks_better() {
    let (r, t) = (robot(), traj("Main"));
    let w = ideal(&r);
    let with = simulate(&r, &t, &code(3.0), &w, &SimOptions { abort_m: 5.0, ..Default::default() });
    let without = simulate(&r, &t, &RobotCode { force_ff: false, ..code(3.0) }, &w, &SimOptions { abort_m: 5.0, ..Default::default() });
    assert!(with.rms_pos_m < 0.6 * without.rms_pos_m, "with {} without {}", with.rms_pos_m, without.rms_pos_m);
}

#[test]
fn a_path_with_margin_is_followed_in_the_nominal_world() {
    // Alt continues Main: it starts moving, as the trajectory does.
    let (r, t) = (robot(), traj("Alt"));
    let out = simulate(&r, &t, &code(5.0), &World::nominal(&r), &SimOptions::default());
    assert!(out.rms_pos_m < 0.08, "rms {}", out.rms_pos_m);
}

#[test]
fn a_path_at_the_edge_of_grip_slips_and_the_odometry_drifts() {
    // Main was planned at 100% of the grip: no margin for the feedback.
    let (r, t) = (robot(), traj("Main"));
    let opts = SimOptions { abort_m: 5.0, ..Default::default() };
    // Without vision, to see the odometry drift on its own.
    let blind = World { vision_hz: 0.0, ..World::nominal(&r) };
    let nominal = simulate(&r, &t, &code(5.0), &blind, &opts);
    let slick = simulate(&r, &t, &code(5.0), &World { mu: 0.6, ..blind.clone() }, &opts);
    assert!(nominal.max_slip_mps > 0.5 && nominal.odometry_drift_m > 0.1, "{nominal:?}");
    assert!(slick.odometry_drift_m > nominal.odometry_drift_m * 0.8);
    // And the battery sags while it accelerates.
    assert!(nominal.min_bus_v < 11.0, "{}", nominal.min_bus_v);
}

#[test]
fn no_feedback_and_no_feedforward_misses_badly() {
    let (r, t) = (robot(), traj("Main"));
    let lost = simulate(&r, &t, &RobotCode { force_ff: false, ..code(0.0) }, &World { mass_kg: 70.0, ..World::nominal(&r) }, &SimOptions::default());
    let good = simulate(&r, &t, &code(5.0), &ideal(&r), &SimOptions::default());
    assert!(lost.cost > 3.0 * good.cost, "lost {} good {}", lost.cost, good.cost);
}

#[test]
fn the_same_world_gives_the_same_run() {
    let (r, t) = (robot(), traj("Main"));
    let w = World { pose_noise_m: 0.02, latency_s: 0.04, ..World::nominal(&r) };
    let a = simulate(&r, &t, &code(5.0), &w, &SimOptions::default());
    let b = simulate(&r, &t, &code(5.0), &w, &SimOptions::default());
    assert_eq!(a, b);
}

fn shoved(r: &RobotConfig, force: f64, duration: f64) -> World {
    World { pushes: vec![ares_tune::sim::Push { at: 0.4, duration_s: duration, fx_n: 0.0, fy_n: force, torque_nm: 40.0 }], ..World::nominal(r) }
}

#[test]
fn a_shove_knocks_it_off_and_it_comes_back() {
    let (r, t) = (robot(), traj("Alt"));
    let out = simulate(&r, &t, &code(5.0), &shoved(&r, 500.0, 0.2), &SimOptions::default());
    println!("{out:?}");
    assert!(!out.aborted);
    assert!(out.max_pushed_m > 0.05, "pushed {}", out.max_pushed_m);
    assert!(out.recovery_s > 0.0 && out.recovery_s < 2.5, "recovery {}", out.recovery_s);
    assert_eq!(out.push_marks.len(), 1);
}

#[test]
fn a_hard_shove_loses_the_path_on_feedback_alone_and_replanning_saves_it() {
    let (r, t) = (robot(), traj("Alt"));
    // A robot driving into it: about a ton-force-meter of impulse… 900 N for a quarter second.
    let w = shoved(&r, 900.0, 0.25);
    let alone = simulate(&r, &t, &RobotCode { replan: None, ..code(5.0) }, &w, &SimOptions::default());
    let saved = simulate(&r, &t, &code(5.0), &w, &SimOptions::default());
    println!("alone {alone:?}\nsaved {saved:?}");
    assert!(alone.aborted);
    assert!(!saved.aborted);
    assert!(saved.replans >= 1);
    assert!(saved.overrun_s > 0.0, "finding the way back takes time");
    // And it ends where the path ends, not where the shove left it.
    assert!(saved.final_pos_m < 0.15, "final {}", saved.final_pos_m);
}

#[test]
fn without_vision_a_sideways_shove_goes_unnoticed() {
    let (r, t) = (robot(), traj("Alt"));
    let blind = simulate(&r, &t, &code(5.0), &World { vision_hz: 0.0, ..shoved(&r, 500.0, 0.2) }, &SimOptions { abort_m: 5.0, ..Default::default() });
    let seeing = simulate(&r, &t, &code(5.0), &shoved(&r, 500.0, 0.2), &SimOptions { abort_m: 5.0, ..Default::default() });
    // The wheels slide sideways, the encoders see nothing: the code believes it is on the path.
    assert!(blind.final_pos_m > 2.0 * seeing.final_pos_m, "blind {} seeing {}", blind.final_pos_m, seeing.final_pos_m);
}

#[test]
fn without_shoves_nothing_changes() {
    let (r, t) = (robot(), traj("Alt"));
    let out = simulate(&r, &t, &code(5.0), &World::nominal(&r), &SimOptions::default());
    assert_eq!((out.recovery_s, out.overrun_s, out.replans), (0.0, 0.0, 0));
}
