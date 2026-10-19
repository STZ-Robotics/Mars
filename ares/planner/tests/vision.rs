//! The see-AprilTags constraint: the cameras turned to the field's tags.

use ares_core::path::{ConstraintKind, ScopedConstraint, Target, Waypoint};
use ares_core::robot::CameraConfig;
use ares_core::vision::{coverage, tags_from_wpilib_layout, Tag};
use ares_core::{PathSpec, RobotConfig, Trajectory};
use ares_planner::{plan, Environment, FieldSize, PlannerOptions};

fn tags() -> Vec<Tag> {
    tags_from_wpilib_layout(include_str!("../../app/src/field/tags/2026-rebuilt-welded.json")).unwrap()
}

/// The team's robot with one Limelight 3G in front, tilted 15 degrees up.
fn robot() -> RobotConfig {
    let mut r = RobotConfig::from_json(include_str!("../../examples/robots/offseason2026.json")).unwrap();
    r.cameras = vec![CameraConfig {
        name: "front".into(),
        x_m: 0.34,
        y_m: 0.0,
        z_m: 0.42,
        roll_deg: 0.0,
        pitch_deg: -15.0,
        yaw_deg: 0.0,
        horizontal_fov_deg: 82.0,
        vertical_fov_deg: 56.2,
        max_range_m: 5.0,
        model: Some("limelight3g".into()),
    }];
    r
}

fn wp(x: f64, y: f64, h: Option<f64>) -> Waypoint {
    Waypoint { x, y, heading_deg: h, ..Default::default() }
}

fn env() -> Environment {
    Environment { field: Some(FieldSize { length_m: 16.541, width_m: 8.069 }), tags: tags(), ..Default::default() }
}

fn see_tags(from: usize, to: usize, camera: Option<&str>) -> ScopedConstraint {
    ScopedConstraint {
        from: Target::Index(from),
        to: Some(Target::Index(to)),
        enabled: true,
        kind: ConstraintKind::SeeTags { camera: camera.map(str::to_string), min_tags: 1, detour_m: 0.0 },
        exprs: Default::default(),
    }
}

fn seen(r: &RobotConfig, t: &Trajectory) -> f64 {
    let poses: Vec<_> = t.samples.iter().map(|q| (q.x, q.y, q.heading)).collect();
    coverage(r, &env().world(), &poses)
}

fn plan_both(r: &RobotConfig, w: Vec<Waypoint>, c: ScopedConstraint) -> (Trajectory, Trajectory) {
    let plain = PathSpec::new("p", w.clone());
    let mut aimed = PathSpec::new("p", w);
    aimed.scoped.push(c);
    let a = plan(r, &plain, &env(), &PlannerOptions::default()).unwrap().trajectory;
    let b = plan(r, &aimed, &env(), &PlannerOptions::default()).unwrap().trajectory;
    (a, b)
}

fn passes(t: &Trajectory, w: &[Waypoint]) {
    for p in w {
        let d = t.samples.iter().map(|s| (s.x - p.x).hypot(s.y - p.y)).fold(f64::MAX, f64::min);
        assert!(d < 1e-3, "missed ({}, {}) by {d}", p.x, p.y);
    }
}

#[test]
fn aiming_keeps_tags_in_view_where_the_free_path_loses_them() {
    let r = robot();
    // Along the top of the blue side, facing the wall: freely the camera loses the tags for a
    // quarter of the way; aimed, it keeps them nearly all of it.
    let w = vec![wp(2.5, 6.0, Some(-90.0)), wp(5.5, 6.5, None), wp(7.5, 6.0, Some(-90.0))];
    let (free, aimed) = plan_both(&r, w.clone(), see_tags(0, 2, None));
    let (a, b) = (seen(&r, &free), seen(&r, &aimed));
    eprintln!("free {:.0}% in {:.2} s, aimed {:.0}% in {:.2} s", 100.0 * a, free.duration_s, 100.0 * b, aimed.duration_s);
    assert!(b >= 0.9 && b > a + 0.1, "{a} -> {b}");
    passes(&aimed, &w);
    assert!(aimed.notes.iter().any(|n| n.starts_with("AprilTags in view") && n.contains("waypoints 1-3")), "{:?}", aimed.notes);
}

#[test]
fn a_path_that_already_sees_tags_is_not_slowed_down() {
    let r = robot();
    let w = vec![wp(2.0, 1.0, Some(90.0)), wp(4.5, 1.5, None), wp(7.0, 1.0, Some(90.0))];
    let (free, aimed) = plan_both(&r, w, see_tags(0, 2, None));
    assert_eq!(seen(&r, &free), 1.0);
    assert!((aimed.duration_s - free.duration_s).abs() < 1e-9, "{} vs {}", aimed.duration_s, free.duration_s);
}

#[test]
fn a_named_camera_is_the_one_aimed() {
    let mut r = robot();
    let mut back = r.cameras[0].clone();
    back.name = "back".into();
    back.x_m = -0.34;
    back.yaw_deg = 180.0;
    r.cameras.push(back);
    let w = vec![wp(13.5, 1.5, Some(0.0)), wp(13.5, 4.0, None), wp(13.5, 6.5, Some(0.0))];
    let (free, aimed) = plan_both(&r, w, see_tags(0, 2, Some("back")));
    let poses = |t: &Trajectory| t.samples.iter().map(|q| (q.x, q.y, q.heading)).collect::<Vec<_>>();
    let (a, b) = (
        ares_core::vision::coverage_of(&r, &env().world(), &poses(&free), Some("back"), 1),
        ares_core::vision::coverage_of(&r, &env().world(), &poses(&aimed), Some("back"), 1),
    );
    eprintln!("back camera: free {:.0}%, aimed {:.0}%", 100.0 * a, 100.0 * b);
    assert!(b > a, "{a} -> {b}");
    assert!(aimed.notes.iter().any(|n| n.contains("(back)")), "{:?}", aimed.notes);
}

#[test]
fn without_cameras_it_says_so_and_plans_as_usual() {
    let mut r = robot();
    r.cameras.clear();
    let w = vec![wp(2.5, 6.0, Some(-90.0)), wp(5.5, 6.5, None), wp(7.5, 6.0, Some(-90.0))];
    let (free, aimed) = plan_both(&r, w, see_tags(0, 2, None));
    assert!((aimed.duration_s - free.duration_s).abs() < 1e-9);
    assert!(aimed.notes.iter().any(|n| n.contains("needs cameras")), "{:?}", aimed.notes);
}

#[test]
fn it_needs_a_segment() {
    let r = robot();
    let mut s = PathSpec::new("p", vec![wp(2.0, 1.0, Some(90.0)), wp(7.0, 1.0, Some(90.0))]);
    s.scoped.push(see_tags(1, 1, None));
    let e = plan(&r, &s, &env(), &PlannerOptions::default()).unwrap_err().to_string();
    assert!(e.contains("needs a segment"), "{e}");
}

#[test]
fn the_environment_estimates_the_hubs_when_no_map_was_drawn() {
    let w = env().world();
    // The two hubs (tags on four faces); the walls' rows of tags make none.
    assert_eq!(w.occluders.len(), 2, "{:?}", w.occluders);
    let drawn = Environment { occluders: Some(vec![]), ..env() };
    assert!(drawn.world().occluders.is_empty(), "an empty map drawn means nothing blocks");
}

#[test]
fn between_the_hubs_aiming_still_works_and_a_detour_must_pay_for_itself() {
    let r = robot();
    // Down the middle of the field, between the hubs, a short stretch between two fixed
    // headings: aiming at full strength has no time to turn and back, a gentler level does.
    let w = vec![wp(6.5, 2.0, Some(90.0)), wp(6.8, 4.0, None), wp(6.5, 6.0, Some(90.0))];
    let turning = see_tags(0, 2, None);
    let mut detour = see_tags(0, 2, None);
    if let ConstraintKind::SeeTags { detour_m, .. } = &mut detour.kind {
        *detour_m = 1.5;
    }
    let (free, aimed) = plan_both(&r, w.clone(), turning);
    let (_, moved) = plan_both(&r, w.clone(), detour);
    let (f, a, b) = (seen(&r, &free), seen(&r, &aimed), seen(&r, &moved));
    eprintln!("free {:.0}% {:.2} s | turning {:.0}% {:.2} s | detour allowed {:.0}% {:.2} s {:?}", 100.0 * f, free.duration_s, 100.0 * a, aimed.duration_s, 100.0 * b, moved.duration_s, moved.notes);
    assert!(a > f + 0.2, "aiming between the hubs: {f} -> {a}");
    if moved.notes.iter().any(|n| n.starts_with("detoured")) {
        let (gain, extra) = (b - a, moved.duration_s - aimed.duration_s);
        assert!(gain >= 0.05 && (extra <= 0.0 || gain / extra >= 0.15), "a detour that does not pay: +{gain} for +{extra} s");
    } else {
        assert!((moved.duration_s - aimed.duration_s).abs() < 1e-9, "no detour: the same plan as turning");
    }
    passes(&moved, &w);
    assert_eq!(moved.waypoint_times.len(), w.len(), "a hidden waypoint is never one of the user's");
}

#[test]
fn behind_the_hub_turning_does_not_help_and_a_detour_does() {
    let r = robot();
    // Just behind the blue hub, which hides the tags beyond it: no heading sees more from this
    // line, but 0.7 m to the side does, and that is worth the time.
    let w = vec![wp(5.8, 3.0, Some(90.0)), wp(6.0, 4.0, None), wp(5.8, 5.0, Some(90.0))];
    let mut d = see_tags(0, 2, None);
    if let ConstraintKind::SeeTags { detour_m, .. } = &mut d.kind {
        *detour_m = 2.0;
    }
    let (free, aimed) = plan_both(&r, w.clone(), see_tags(0, 2, None));
    let (_, moved) = plan_both(&r, w.clone(), d);
    let (f, a, b) = (seen(&r, &free), seen(&r, &aimed), seen(&r, &moved));
    eprintln!("free {:.0}% | turning {:.0}% | detour {:.0}% in {:.2} s {:?}", 100.0 * f, 100.0 * a, 100.0 * b, moved.duration_s, moved.notes);
    assert!(moved.notes.iter().any(|n| n.starts_with("detoured")), "{:?}", moved.notes);
    assert!(b >= a + 0.15, "{a} -> {b}");
    passes(&moved, &w);
    assert_eq!(moved.waypoint_times.len(), w.len());
}

#[test]
fn on_the_center_line_turning_finds_tags_the_free_path_never_sees() {
    let r = robot();
    let w = vec![wp(8.27, 1.5, Some(90.0)), wp(8.27, 4.0, None), wp(8.27, 6.5, Some(90.0))];
    let (free, aimed) = plan_both(&r, w, see_tags(0, 2, None));
    let (f, a) = (seen(&r, &free), seen(&r, &aimed));
    eprintln!("center line: free {:.0}%, turning {:.0}%", 100.0 * f, 100.0 * a);
    assert!(f < 0.1 && a > 0.7, "{f} -> {a}");
}
