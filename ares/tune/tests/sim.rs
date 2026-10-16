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
    let nominal = simulate(&r, &t, &code(5.0), &World::nominal(&r), &opts);
    let slick = simulate(&r, &t, &code(5.0), &World { mu: 0.6, ..World::nominal(&r) }, &opts);
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
