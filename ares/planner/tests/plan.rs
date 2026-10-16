//! Stage 2 against the physics it claims to respect.

use ares_core::path::{PathConstraints, Waypoint};
use ares_core::{PathSpec, RobotConfig, Trajectory};
use ares_planner::{plan, Environment, FieldSize, KeepOutCircle, Planned, PlannerOptions};

fn robot() -> RobotConfig {
    RobotConfig::from_json(include_str!("../../examples/robots/offseason2026.json")).unwrap()
}

fn wp(x: f64, y: f64, h: Option<f64>) -> Waypoint {
    Waypoint { x, y, heading_deg: h }
}

fn spec(w: Vec<Waypoint>) -> PathSpec {
    PathSpec { name: "test".into(), waypoints: w, constraints: PathConstraints::default() }
}

fn run(robot: &RobotConfig, s: &PathSpec, env: &Environment) -> Planned {
    plan(robot, s, env, &PlannerOptions::default()).unwrap_or_else(|e| panic!("{e:?}"))
}

/// What the solver promises at every sample, with a small tolerance for the
/// interior point's convergence.
fn assert_physical(robot: &RobotConfig, t: &Trajectory) {
    let sw = robot.swerve();
    let floor = ares_core::robot::MIN_LOAD_FRACTION * robot.mass_kg * 9.80665 / sw.modules.len() as f64;
    for s in &t.samples {
        for m in &s.modules {
            assert!(m.grip_used <= 1.01, "grip {:.3} at t = {:.3}", m.grip_used, s.t);
            assert!(m.current_a.abs() <= sw.drive_current_limit_a * 1.01, "{:.1} A at t = {:.3}", m.current_a, s.t);
            assert!(m.speed_mps <= robot.max_module_speed() * 1.01, "{:.2} m/s at t = {:.3}", m.speed_mps, s.t);
            assert!(m.load_n >= floor * 0.99, "{:.1} N on a wheel at t = {:.3}, inside the tipping margin", m.load_n, s.t);
        }
    }
}

fn assert_passes(t: &Trajectory, w: &[Waypoint]) {
    for p in w {
        let d = t.samples.iter().map(|s| (s.x - p.x).hypot(s.y - p.y)).fold(f64::MAX, f64::min);
        assert!(d < 1e-4, "missed ({}, {}) by {d}", p.x, p.y);
    }
}

#[test]
fn the_free_path_is_never_slower_than_the_spline() {
    let r = robot();
    let s = spec(vec![wp(1.5, 4.0, Some(0.0)), wp(4.0, 6.5, None), wp(7.0, 6.8, Some(90.0)), wp(8.2, 4.1, Some(180.0))]);
    let p = run(&r, &s, &Environment::default());
    assert!(p.trajectory.duration_s < p.spline_duration_s, "{} vs {}", p.trajectory.duration_s, p.spline_duration_s);
    assert_passes(&p.trajectory, &s.waypoints);
    assert_physical(&r, &p.trajectory);
    let (first, last) = (&p.trajectory.samples[0], p.trajectory.samples.last().unwrap());
    assert!(first.vx.hypot(first.vy) < 1e-6 && last.vx.hypot(last.vy) < 1e-6);
    assert!((last.heading - std::f64::consts::PI).abs() < 1e-4, "{}", last.heading);
}

#[test]
fn a_straight_sprint_matches_stage_one() {
    // Nothing to gain from the shape on a straight line: both stages should
    // agree on the time (stage 2 samples more coarsely).
    let r = robot();
    let p = run(&r, &spec(vec![wp(0.0, 0.0, Some(0.0)), wp(4.0, 0.0, Some(0.0))]), &Environment::default());
    let gap = (p.trajectory.duration_s - p.spline_duration_s).abs() / p.spline_duration_s;
    assert!(gap < 0.03, "{} vs {}", p.trajectory.duration_s, p.spline_duration_s);
    assert_physical(&r, &p.trajectory);
}

#[test]
fn turning_in_place_works() {
    let r = robot();
    let p = run(&r, &spec(vec![wp(2.0, 2.0, Some(0.0)), wp(2.0, 2.0, Some(180.0))]), &Environment::default());
    assert!(p.trajectory.duration_s > 0.1 && p.trajectory.duration_s < 2.0);
    assert_physical(&r, &p.trajectory);
}

#[test]
fn it_goes_around_a_keep_out_circle() {
    let r = robot();
    let env = Environment { field: None, keep_out: vec![KeepOutCircle { x: 3.0, y: 0.0, radius_m: 0.5 }] };
    let p = run(&r, &spec(vec![wp(0.0, 0.0, Some(0.0)), wp(6.0, 0.0, Some(0.0))]), &env);
    // The bumper's center stays at least the circle plus half the bumper away.
    let clearance = p.trajectory.samples.iter().map(|s| (s.x - 3.0).hypot(s.y)).fold(f64::MAX, f64::min);
    assert!(clearance >= 0.5 + r.bumper.width_m / 2.0 - 1e-3, "{clearance}");
    assert_physical(&r, &p.trajectory);
}

#[test]
fn the_walls_keep_the_bumper_in() {
    let r = robot();
    let env = Environment { field: Some(FieldSize { length_m: 16.54, width_m: 8.07 }), keep_out: vec![] };
    // A start against the wall and a curve that would like to swing out.
    let p = run(&r, &spec(vec![wp(0.5, 0.5, Some(0.0)), wp(4.0, 0.6, None), wp(4.0, 4.0, Some(0.0))]), &env);
    let (hl, hw) = (r.bumper.length_m / 2.0, r.bumper.width_m / 2.0);
    for s in &p.trajectory.samples {
        let (c, sn) = (s.heading.cos(), s.heading.sin());
        for (sx, sy) in [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
            let x = s.x + c * sx * hl - sn * sy * hw;
            let y = s.y + sn * sx * hl + c * sy * hw;
            assert!((-1e-4..=16.54 + 1e-4).contains(&x) && (-1e-4..=8.07 + 1e-4).contains(&y), "corner ({x}, {y}) at t = {}", s.t);
        }
    }
    assert_physical(&r, &p.trajectory);
}

#[test]
fn a_high_center_of_mass_is_slower_and_never_lifts_a_wheel() {
    let low = robot();
    let mut high = robot();
    high.cog_height_m = Some(0.6);
    let s = spec(vec![wp(0.0, 0.0, Some(0.0)), wp(4.0, 0.0, Some(0.0))]);
    let (pl, ph) = (run(&low, &s, &Environment::default()), run(&high, &s, &Environment::default()));
    assert!(ph.trajectory.duration_s > pl.trajectory.duration_s, "{} vs {}", ph.trajectory.duration_s, pl.trajectory.duration_s);
    for smp in &ph.trajectory.samples {
        let total: f64 = smp.modules.iter().map(|m| m.load_n).sum();
        assert!((total - high.mass_kg * 9.80665).abs() < 1e-6 * total);
    }
    assert_physical(&high, &ph.trajectory);
}

#[test]
fn a_lower_current_limit_is_slower() {
    let fast = robot();
    let mut slow = robot();
    let ares_core::robot::Drivetrain::Swerve(sw) = &mut slow.drivetrain;
    sw.drive_current_limit_a = 30.0;
    let s = spec(vec![wp(0.0, 0.0, Some(0.0)), wp(4.0, 0.0, Some(0.0))]);
    let (pf, ps) = (run(&fast, &s, &Environment::default()), run(&slow, &s, &Environment::default()));
    assert!(ps.trajectory.duration_s > pf.trajectory.duration_s * 1.1);
    assert_physical(&slow, &ps.trajectory);
}

#[test]
fn load_transfer_off_an_axis_converges() {
    // Diagonal and oblique accelerations with a known center of mass used to
    // leave the interior point wandering until it ran out of iterations.
    for h in [0.2, 0.35] {
        let mut r = robot();
        r.cog_height_m = Some(h);
        for s in [
            spec(vec![wp(1.0, 1.0, Some(0.0)), wp(6.0, 6.0, Some(0.0))]),
            spec(vec![wp(1.0, 1.0, Some(0.0)), wp(6.0, 3.0, Some(0.0))]),
            spec(vec![wp(1.686, 4.589, Some(0.0)), wp(8.168, 5.809, Some(142.8)), wp(8.2, 4.1, Some(180.0))]),
        ] {
            let p = run(&r, &s, &Environment::default());
            assert!(p.trajectory.duration_s <= p.spline_duration_s * 1.001, "h = {h}: {} vs {}", p.trajectory.duration_s, p.spline_duration_s);
            assert_physical(&r, &p.trajectory);
        }
    }
}
