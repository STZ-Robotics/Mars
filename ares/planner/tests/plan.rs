//! Stage 2 against the physics it claims to respect.

use ares_core::path::Waypoint;
use ares_core::{PathSpec, RobotConfig, Trajectory};
use ares_planner::{plan, Environment, FieldSize, KeepOutCircle, Planned, PlannerOptions};

fn robot() -> RobotConfig {
    RobotConfig::from_json(include_str!("../../examples/robots/offseason2026.json")).unwrap()
}

fn wp(x: f64, y: f64, h: Option<f64>) -> Waypoint {
    Waypoint { x, y, heading_deg: h, ..Default::default() }
}

fn spec(w: Vec<Waypoint>) -> PathSpec {
    PathSpec::new("test", w)
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

fn scoped(from: usize, to: Option<usize>, kind: ares_core::path::ConstraintKind) -> ares_core::path::ScopedConstraint {
    use ares_core::path::Target;
    ares_core::path::ScopedConstraint { from: Target::Index(from), to: to.map(Target::Index), enabled: true, kind }
}

#[test]
fn a_keep_out_across_the_straight_line_is_skirted_not_looped() {
    // The editor's case that used to come back as a 25 s lap of the field.
    let mut r = robot();
    r.cog_height_m = Some(0.35);
    let env = Environment {
        field: Some(FieldSize { length_m: 16.535, width_m: 8.069 }),
        keep_out: vec![
            KeepOutCircle { x: 4.707, y: 4.008, radius_m: 0.916 },
            KeepOutCircle { x: 8.264, y: 6.515, radius_m: 0.951 },
        ],
    };
    let s = spec(vec![wp(2.449, 6.846, Some(0.0)), wp(15.108, 6.181, None)]);
    let p = run(&r, &s, &env);
    assert!(p.trajectory.duration_s < 4.0, "{}", p.trajectory.duration_s);
    assert_physical(&r, &p.trajectory);
}

#[test]
fn empty_waypoints_shape_but_do_not_pin() {
    use ares_core::path::WaypointKind;
    let r = robot();
    let mut w = vec![wp(1.0, 1.0, Some(0.0)), wp(3.0, 3.0, None), wp(5.0, 1.0, Some(0.0))];
    w[1].kind = Some(WaypointKind::Empty);
    let p = run(&r, &spec(w), &Environment::default());
    let closest = p.trajectory.samples.iter().map(|q| (q.x - 3.0).hypot(q.y - 3.0)).fold(f64::MAX, f64::min);
    assert!(closest > 0.05, "it went through the empty waypoint as if it were a pin ({closest})");
    assert_physical(&r, &p.trajectory);
}

#[test]
fn an_intermediate_stop_point_stops() {
    use ares_core::path::ConstraintKind;
    let r = robot();
    let mut s = spec(vec![wp(1.0, 1.0, Some(0.0)), wp(4.0, 2.0, None), wp(7.0, 1.0, Some(0.0))]);
    s.scoped.push(scoped(1, None, ConstraintKind::StopPoint { wait_s: 0.0 }));
    let p = run(&r, &s, &Environment::default());
    let t1 = p.trajectory.waypoint_times[1];
    let q = p.trajectory.samples.iter().min_by(|a, b| (a.t - t1).abs().total_cmp(&(b.t - t1).abs())).unwrap();
    assert!(q.vx.hypot(q.vy) < 1e-3, "{}", q.vx.hypot(q.vy));
}

#[test]
fn scoped_speed_and_acceleration_caps_hold_only_where_scoped() {
    use ares_core::path::ConstraintKind;
    let r = robot();
    let mut s = spec(vec![wp(0.0, 0.0, Some(0.0)), wp(4.0, 0.0, None), wp(8.0, 0.0, Some(0.0))]);
    s.scoped.push(scoped(1, Some(2), ConstraintKind::MaxVelocity { mps: 2.0 }));
    s.scoped.push(scoped(0, Some(1), ConstraintKind::MaxAcceleration { mps2: 3.0 }));
    let p = run(&r, &s, &Environment::default());
    let (t1, _) = (p.trajectory.waypoint_times[1], 0);
    for q in &p.trajectory.samples {
        if q.t >= t1 {
            assert!(q.vx.hypot(q.vy) <= 2.0 * 1.01);
        } else {
            assert!(q.ax.hypot(q.ay) <= 3.0 * 1.01);
        }
    }
}

#[test]
fn point_at_keeps_the_front_on_the_target() {
    use ares_core::path::ConstraintKind;
    let r = robot();
    let mut s = spec(vec![wp(1.0, 1.0, None), wp(6.0, 1.0, None)]);
    s.scoped.push(scoped(0, Some(1), ConstraintKind::PointAt { x: 3.5, y: 4.0, tolerance_deg: 5.0, flip: false }));
    let p = run(&r, &s, &Environment::default());
    for q in &p.trajectory.samples {
        let want = (4.0 - q.y).atan2(3.5 - q.x);
        let err = ares_core::geometry::wrap_angle(q.heading - want).abs().to_degrees();
        assert!(err <= 5.5, "{err:.1}° off at t = {:.2}", q.t);
    }
}

#[test]
fn a_lane_keeps_the_center_near_the_line() {
    use ares_core::path::ConstraintKind;
    let r = robot();
    let mut s = spec(vec![wp(1.0, 1.0, Some(0.0)), wp(4.0, 3.0, None), wp(7.0, 1.0, Some(90.0))]);
    s.scoped.push(scoped(0, Some(1), ConstraintKind::KeepInLane { tolerance_m: 0.1 }));
    let p = run(&r, &s, &Environment::default());
    let t1 = p.trajectory.waypoint_times[1];
    for q in p.trajectory.samples.iter().filter(|q| q.t <= t1) {
        // Distance to the line (1,1)-(4,3).
        let (dx, dy) = (3.0, 2.0);
        let off = ((q.x - 1.0) * dy - (q.y - 1.0) * dx).abs() / (dx * dx + dy * dy as f64).sqrt();
        assert!(off <= 0.1 + 1e-3, "{off}");
    }
}

#[test]
fn events_and_splits_land_on_the_trajectory() {
    use ares_core::path::{EventMarker, Target};
    let r = robot();
    let mut w = vec![wp(1.0, 1.0, Some(0.0)), wp(4.0, 2.0, None), wp(7.0, 1.0, Some(0.0))];
    w[1].split = true;
    let mut s = spec(w);
    s.events.push(EventMarker { name: "intake".into(), target: Target::Index(1), offset_s: -0.2 });
    let p = run(&r, &s, &Environment::default());
    let t = &p.trajectory;
    assert_eq!(t.waypoint_times.len(), 3);
    assert_eq!(t.splits.len(), 1);
    assert!((t.samples[t.splits[0]].t - t.waypoint_times[1]).abs() < 1e-9);
    assert_eq!(t.events.len(), 1);
    assert!((t.events[0].t - (t.waypoint_times[1] - 0.2)).abs() < 1e-9);
}

#[test]
fn an_empty_end_is_refused() {
    use ares_core::path::WaypointKind;
    let mut w = vec![wp(1.0, 1.0, Some(0.0)), wp(4.0, 2.0, None)];
    w[1].kind = Some(WaypointKind::Empty);
    assert!(plan(&robot(), &spec(w), &Environment::default(), &PlannerOptions::default()).is_err());
}

#[test]
fn a_wait_at_a_stop_holds_still_and_shifts_the_rest() {
    use ares_core::path::{ConstraintKind, EventMarker, Target};
    let r = robot();
    let base = {
        let mut s = spec(vec![wp(1.0, 1.0, Some(0.0)), wp(4.0, 2.0, None), wp(7.0, 1.0, Some(0.0))]);
        s.scoped.push(scoped(1, None, ConstraintKind::StopPoint { wait_s: 0.0 }));
        s.events.push(EventMarker { name: "after".into(), target: Target::Index(2), offset_s: 0.0 });
        s
    };
    let mut waiting = base.clone();
    waiting.scoped.last_mut().unwrap().kind = ConstraintKind::StopPoint { wait_s: 1.5 };
    let (a, b) = (run(&r, &base, &Environment::default()), run(&r, &waiting, &Environment::default()));
    let (ta, tb) = (&a.trajectory, &b.trajectory);
    assert!((tb.duration_s - ta.duration_s - 1.5).abs() < 1e-6, "{} vs {}", tb.duration_s, ta.duration_s);
    assert!((tb.waypoint_times[1] - ta.waypoint_times[1]).abs() < 1e-6, "arrival should not move");
    assert!((tb.events[0].t - ta.events[0].t - 1.5).abs() < 1e-6);
    // Still for the whole wait.
    let t1 = tb.waypoint_times[1];
    let p1 = tb.sample_at(t1);
    for q in tb.samples.iter().filter(|q| q.t >= t1 - 1e-9 && q.t <= t1 + 1.5 + 1e-9) {
        assert!((q.x - p1.x).abs() < 1e-6 && (q.y - p1.y).abs() < 1e-6 && q.vx.hypot(q.vy) < 1e-3);
    }
    assert_physical(&r, tb);
}
