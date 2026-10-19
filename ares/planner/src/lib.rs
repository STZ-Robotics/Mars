//! Ares' trajectory optimizer.
//!
//! Two stages, one answer:
//!
//! 1. The core's time-optimal solver times the spline through the waypoints in
//!    milliseconds. That is already a valid trajectory, and the best one along
//!    that exact curve.
//! 2. That trajectory warm-starts a nonlinear program over the whole thing
//!    (pose, velocity, acceleration and every module's force at every sample),
//!    solved by Sleipnir's interior-point method, the solver Choreo uses. Here
//!    the curve is free: waypoints are constraints, not the shape, so the
//!    optimizer cuts corners, swings wide or rotates early wherever the physics
//!    makes it faster.
//!
//! The model in stage 2 is richer than Choreo's: the motor's current limit and
//! back-EMF along each wheel (Choreo bounds torque but not current, and its
//! force does not fade with speed), load transfer from the center of mass
//! height (so the trailing wheels grip more and the robot cannot tip), and the
//! bumper against the field walls and keep-out circles. Starting from stage 1
//! instead of a straight line is also why it converges in few iterations.

use std::time::{Duration, Instant};

use ares_core::geometry::{wrap_angle, Vec2};
use ares_core::path::{ConstraintKind, WaypointKind};
use ares_core::robot::{GRAVITY, MIN_LOAD_FRACTION};
use ares_core::trajectory::{ModuleSample, PathfindSpan, Sample, Section, TimedEvent, TrajectoryStart};
use ares_core::{AresError, PathSpec, RobotConfig, SolverOptions, Trajectory};
use serde::{Deserialize, Serialize};

mod ffi;
pub mod route;

/// A Stop button for one plan: set it from any thread and the plan returns
/// `PlanError::Cancelled` at its solver's next iteration.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(std::sync::Arc<std::sync::atomic::AtomicI32>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(1, std::sync::atomic::Ordering::Relaxed)
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed) != 0
    }
    /// Whether two tokens are the same button.
    pub fn same(&self, other: &CancelToken) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

/// What surrounds the robot. Shared by every path on the same field.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    /// The bumper stays inside `[0, length] x [0, width]`. None: no walls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<FieldSize>,
    #[serde(default)]
    pub keep_out: Vec<KeepOutCircle>,
    /// Areas every path drives slower through.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slow_zones: Vec<SlowZone>,
    /// Where the pathfinder may not take the robot. Only the "?" segments
    /// (and the robot's pathfinder) obey it; a path the user drew goes where
    /// it was drawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navgrid: Option<NavGrid>,
    /// The field's AprilTags, for the see-AprilTags constraint.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<ares_core::vision::Tag>,
    /// What blocks the cameras' view (the field's 2.5D map). None: estimated from the tags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occluders: Option<Vec<ares_core::vision::Occluder>>,
}

impl Environment {
    /// What the cameras look at: the tags, and the drawn structures (or ones estimated from the
    /// tags when none were drawn).
    pub fn world(&self) -> ares_core::vision::World {
        ares_core::vision::World {
            tags: self.tags.clone(),
            occluders: self.occluders.clone().unwrap_or_else(|| ares_core::vision::estimate_occluders(&self.tags)),
        }
    }
}

/// PathPlanner's navigation grid: square cells over the field, each one open
/// or blocked to the robot's center (so a blocked area already includes the
/// robot's reach). `grid[row][col]`: the row runs along y and the column
/// along x, both from the field's origin, and cell (col, row) covers
/// `[col, col + 1) x [row, row + 1)` cells of `node_size_meters`. Same
/// layout as PathPlanner's `navgrid.json`, so one works for the other.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavGrid {
    pub node_size_meters: f64,
    pub grid: Vec<Vec<bool>>,
}

impl NavGrid {
    /// Whether the robot's center may not be at (x, y). Off the grid is open:
    /// the walls are the field's business.
    pub fn blocked(&self, x: f64, y: f64) -> bool {
        if self.node_size_meters <= 0.0 || x < 0.0 || y < 0.0 {
            return false;
        }
        let (col, row) = ((x / self.node_size_meters) as usize, (y / self.node_size_meters) as usize);
        self.grid.get(row).and_then(|r| r.get(col)).copied().unwrap_or(false)
    }

    pub fn is_empty(&self) -> bool {
        !self.grid.iter().any(|r| r.iter().any(|&b| b))
    }
}

/// An area of the field with its own speed and acceleration caps: every
/// path that passes through it obeys them there, wherever its waypoints are.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowZone {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(flatten)]
    pub shape: ZoneShape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_velocity_mps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_acceleration_mps2: Option<f64>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub exprs: ares_core::path::Exprs,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ZoneShape {
    Circle { x: f64, y: f64, radius_m: f64 },
    /// x, y is the bottom-left corner.
    Rectangle { x: f64, y: f64, width_m: f64, height_m: f64 },
}

impl ZoneShape {
    pub fn contains(&self, px: f64, py: f64) -> bool {
        match *self {
            ZoneShape::Circle { x, y, radius_m } => (px - x).hypot(py - y) <= radius_m,
            ZoneShape::Rectangle { x, y, width_m, height_m } => px >= x && px <= x + width_m && py >= y && py <= y + height_m,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSize {
    pub length_m: f64,
    pub width_m: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepOutCircle {
    pub x: f64,
    pub y: f64,
    pub radius_m: f64,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub exprs: ares_core::path::Exprs,
}

#[derive(Clone, Debug)]
pub struct PlannerOptions {
    /// The target time between samples. Smaller is more faithful and slower
    /// to solve; 50 ms is twice Choreo's default density.
    pub target_dt_s: f64,
    pub tolerance: f64,
    pub max_iterations: u32,
    pub timeout: Duration,
    /// Start moving at (vx, vy, omega) instead of at rest: a path that
    /// continues another one. A stop on the first waypoint is then ignored.
    pub start_state: Option<[f64; 3]>,
    pub cancel: Option<CancelToken>,
}

impl Default for PlannerOptions {
    fn default() -> Self {
        PlannerOptions {
            target_dt_s: 0.05,
            tolerance: 1e-7,
            max_iterations: 3000,
            timeout: Duration::from_secs(60),
            start_state: None,
            cancel: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Planned {
    pub trajectory: Trajectory,
    /// Stage 1 along the spline, for comparison: how much the free shape won.
    pub spline_duration_s: f64,
    pub iterations: u32,
    pub solve_time: Duration,
}

#[derive(Debug)]
pub enum PlanError {
    Core(AresError),
    /// Stopped by `cancel` before it finished.
    Cancelled,
    /// The optimizer did not converge. The status is Sleipnir's.
    Solver { status: i32, reason: &'static str },
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Core(e) => write!(f, "{e}"),
            PlanError::Cancelled => write!(f, "generation stopped"),
            PlanError::Solver { reason, .. } => write!(f, "the optimizer did not find a trajectory: {reason}"),
        }
    }
}

impl std::error::Error for PlanError {}

impl From<AresError> for PlanError {
    fn from(e: AresError) -> Self {
        PlanError::Core(e)
    }
}

fn status_reason(status: i32) -> &'static str {
    match status {
        1 => "it was stopped",
        -1 => "there are more constraints than the path has freedom to meet",
        -2 | -3 => "the waypoints and obstacles cannot all be met by this robot",
        -4 | -5 | -6 => "the solver got stuck; try moving a waypoint slightly",
        -7 => "the starting guess was not a number",
        -8 => "the solver diverged",
        -9 => "it ran out of iterations",
        -10 => "it ran out of time",
        _ => "an internal error",
    }
}

/// The drive, as force along the wheel versus wheel speed (see ares_nlp.h).
struct Drive {
    f_current: f64,
    f_volt: f64,
    f_emf: f64,
    /// Newtons along the wheel per amp in one drive motor.
    n_per_amp: f64,
}

fn drive(robot: &RobotConfig) -> Drive {
    let s = robot.swerve();
    let m = s.motor();
    let (k, g, r) = (s.drive_motors_per_module as f64 * m.kt(), s.drive_gear_ratio, s.wheel_radius_m);
    Drive {
        f_current: if s.drive_current_limit_a > 0.0 { k * s.drive_current_limit_a * g / r } else { 0.0 },
        f_volt: k * g * s.battery_voltage / (r * m.resistance()),
        f_emf: k * g * g / (r * r * m.kv() * m.resistance()),
        n_per_amp: k * g / r,
    }
}

/// Plans a path. Segments marked for pathfinding split it: the parts in
/// between are planned on their own (stopping at the hand-off), and each
/// pathfind segment gets Ares' estimate of the route the robot will find.
/// An unknown start makes the first segment one of them.
pub fn plan(
    robot: &RobotConfig,
    spec: &PathSpec,
    env: &Environment,
    options: &PlannerOptions,
) -> Result<Planned, PlanError> {
    let mut planned = plan_path(robot, spec, env, options)?;
    let t = &mut planned.trajectory;
    t.start = match spec.waypoints[0].kind() {
        WaypointKind::Unknown => TrajectoryStart::Unknown,
        WaypointKind::Continue => TrajectoryStart::Previous,
        _ => TrajectoryStart::Known,
    };
    t.continues_from = spec.continues_from.clone();
    // Sections: the parts between splits, by the waypoints' arrival times.
    let n = spec.waypoints.len();
    let cuts: Vec<usize> = (1..n.saturating_sub(1)).filter(|&i| spec.waypoints[i].is_split()).collect();
    let index_at = |time: f64| t.samples.partition_point(|q| q.t < time - 1e-9).min(t.samples.len() - 1);
    t.splits = cuts.iter().map(|&i| index_at(t.waypoint_times[i])).collect();
    if !cuts.is_empty() || spec.first_section.is_some() {
        let mut starts = vec![0usize];
        starts.extend(t.splits.iter().copied());
        let last = t.samples.len() - 1;
        t.sections = starts
            .iter()
            .enumerate()
            .map(|(k, &a)| {
                let b = starts.get(k + 1).copied().unwrap_or(last);
                let name = if k == 0 {
                    spec.first_section.clone().unwrap_or_else(|| "part 1".into())
                } else {
                    spec.waypoints[cuts[k - 1]].section.clone().unwrap_or_else(|| format!("part {}", k + 1))
                };
                Section { name, start_sample: a, end_sample: b, start_t: t.samples[a].t, end_t: t.samples[b].t }
            })
            .collect();
    }
    Ok(planned)
}

fn plan_path(
    robot: &RobotConfig,
    spec: &PathSpec,
    env: &Environment,
    options: &PlannerOptions,
) -> Result<Planned, PlanError> {
    validate(spec)?;
    let n = spec.waypoints.len();
    let unknown_start = spec.waypoints[0].kind() == WaypointKind::Unknown;
    let cuts: Vec<usize> =
        (0..n - 1).filter(|&j| spec.waypoints[j].pathfind_next.is_some() || (j == 0 && unknown_start)).collect();
    if cuts.is_empty() {
        return plan_fixed(robot, spec, env, options);
    }
    let started = Instant::now();

    // The fixed parts: waypoint ranges between the cuts.
    let mut groups = Vec::new();
    let mut a = 0;
    for &c in &cuts {
        groups.push((a, c));
        a = c + 1;
    }
    groups.push((a, n - 1));
    let parts: Vec<Option<Planned>> = groups
        .iter()
        .map(|&(a, b)| {
            let first = PlannerOptions { start_state: if a == 0 { options.start_state } else { None }, ..options.clone() };
            (b > a).then(|| plan_fixed(robot, &sub_spec(spec, a, b, &cuts), env, &first)).transpose()
        })
        .collect::<Result<_, _>>()?;

    // Stitch: part, pathfind estimate, part, ...
    let mut samples: Vec<Sample> = Vec::new();
    let mut waypoint_times = vec![0.0; n];
    let (mut splits, mut events, mut pathfind) = (Vec::new(), Vec::new(), Vec::new());
    let (mut spline, mut iterations) = (0.0, 0);
    let append = |samples: &mut Vec<Sample>, add: &[Sample]| {
        let offset = samples.last().map_or(0.0, |s| s.t);
        let skip = usize::from(!samples.is_empty());
        samples.extend(add.iter().skip(skip).map(|s| Sample { t: s.t + offset, ..s.clone() }));
    };
    let at_rest = |w: &ares_core::path::Waypoint, heading: f64| Sample {
        t: 0.0, x: w.x, y: w.y, heading, vx: 0.0, vy: 0.0, omega: 0.0, ax: 0.0, ay: 0.0, alpha: 0.0, modules: vec![],
    };
    for (g, &(a, _)) in groups.iter().enumerate() {
        let start = samples.len().saturating_sub(1);
        let offset = samples.last().map_or(0.0, |s| s.t);
        match &parts[g] {
            Some(p) => {
                let t = &p.trajectory;
                append(&mut samples, &t.samples);
                for (k, wt) in t.waypoint_times.iter().enumerate() {
                    waypoint_times[a + k] = wt + offset;
                }
                splits.extend(t.splits.iter().map(|&k| k + start));
                events.extend(t.events.iter().map(|e| TimedEvent { name: e.name.clone(), t: e.t + offset, end_t: e.end_t.map(|x| x + offset), command: e.command.clone() }));
                spline += p.spline_duration_s;
                iterations += p.iterations;
            }
            None => {
                // A lone waypoint between two pathfind segments: the robot
                // only passes through it.
                let w = &spec.waypoints[a];
                let h = samples.last().map_or(w.fixed_heading_deg().unwrap_or(0.0).to_radians(), |s| s.heading);
                if samples.is_empty() {
                    samples.push(at_rest(w, h));
                }
                waypoint_times[a] = offset;
            }
        }
        if g < cuts.len() {
            // From the end of this part to the start of the next.
            let j = cuts[g];
            let from = samples.last().cloned().unwrap();
            let to = match &parts[g + 1] {
                Some(p) => p.trajectory.samples[0].clone(),
                None => {
                    let w = &spec.waypoints[j + 1];
                    at_rest(w, w.fixed_heading_deg().map_or(from.heading, f64::to_radians))
                }
            };
            let opts = spec.waypoints[j].pathfind_next.clone().unwrap_or_default();
            let est = pathfind_estimate(robot, spec, env, &from, &to, &opts, options.target_dt_s).map_err(|e| match e {
                PlanError::Core(AresError::Path(msg)) => {
                    PlanError::Core(AresError::Path(format!("pathfinding from waypoint {} to {}: {msg}", j + 1, j + 2)))
                }
                other => other,
            })?;
            let span_start = samples.len() - 1;
            append(&mut samples, &est.samples);
            pathfind.push(PathfindSpan {
                start_sample: span_start,
                end_sample: samples.len() - 1,
                from_waypoint: j,
                to_waypoint: j + 1,
                goal_x: to.x,
                goal_y: to.y,
                goal_heading: to.heading,
                max_velocity_mps: opts.max_velocity_mps,
                max_acceleration_mps2: opts.max_acceleration_mps2,
                max_angular_velocity_dps: opts.max_angular_velocity_dps,
                estimated_s: est.duration_s,
                from_unknown: j == 0 && unknown_start,
            });
        }
    }
    // Events were resolved per part; they keep the user's order.
    let duration_s = samples.last().map_or(0.0, |s| s.t);
    Ok(Planned {
        trajectory: Trajectory {
            name: spec.name.clone(),
            robot: robot.name.clone(),
            duration_s,
            samples,
            waypoint_times,
            splits,
            events,
            pathfind,
            start: Default::default(),
            continues_from: None,
            sections: vec![],
            variant: None,
            source_hash: None,
            notes: parts.iter().flatten().flat_map(|p| p.trajectory.notes.clone()).collect(),
        },
        spline_duration_s: spline,
        iterations,
        solve_time: started.elapsed(),
    })
}

/// Waypoints `a..=b` as a path of their own: constraints and events that
/// fall in it, renumbered, and a stop at each end that hands off to a
/// pathfind segment.
fn sub_spec(spec: &PathSpec, a: usize, b: usize, cuts: &[usize]) -> PathSpec {
    use ares_core::path::{ScopedConstraint, Target};
    let n = spec.waypoints.len();
    let mut waypoints: Vec<_> = spec.waypoints[a..=b].to_vec();
    if let Some(last) = waypoints.last_mut() {
        last.manual_next = false;
        last.pathfind_next = None;
    }
    let local = |i: usize| -> Target {
        let k = i - a;
        if k == 0 { Target::First } else if k == b - a { Target::Last } else { Target::Index(k) }
    };
    let mut scoped: Vec<ScopedConstraint> = spec
        .scoped
        .iter()
        .filter_map(|c| {
            let (lo, hi) = c.range(n);
            let (lo, hi) = (lo.max(a), hi.min(b));
            if lo > hi {
                return None;
            }
            // A segment constraint clipped to one waypoint only makes sense
            // for the kinds that work on a point.
            if lo == hi && c.to.is_some() && matches!(c.kind, ConstraintKind::KeepInLane { .. }) {
                return None;
            }
            Some(ScopedConstraint { from: local(lo), to: c.to.map(|_| local(hi)), ..c.clone() })
        })
        .collect();
    let stop = |t: Target| ScopedConstraint { from: t, to: None, enabled: true, kind: ConstraintKind::StopPoint { wait_s: 0.0 }, exprs: Default::default() };
    let has_stop = |s: &[ScopedConstraint], t: Target| {
        s.iter().any(|c| c.enabled && matches!(c.kind, ConstraintKind::StopPoint { .. }) && c.from == t && c.to.is_none())
    };
    // Hand-offs to a pathfind segment stop, unless it says to keep moving.
    let moving_out = |j: usize| spec.waypoints[j].pathfind_next.as_ref().is_some_and(|p| p.keep_moving_out);
    let moving_in = |j: usize| spec.waypoints[j].pathfind_next.as_ref().is_some_and(|p| p.keep_moving_in);
    if a > 0 && cuts.contains(&(a - 1)) && !moving_out(a - 1) && !has_stop(&scoped, Target::First) {
        scoped.push(stop(Target::First));
    }
    if cuts.contains(&b) && !moving_in(b) && !has_stop(&scoped, Target::Last) {
        scoped.push(stop(Target::Last));
    }
    let events = spec
        .events
        .iter()
        .filter(|e| (a..=b).contains(&e.target.resolve(n)))
        .map(|e| ares_core::path::EventMarker { target: local(e.target.resolve(n)), ..e.clone() })
        .collect();
    let rotation_targets = spec
        .rotation_targets
        .iter()
        .filter(|r| r.segment >= a && r.segment < b)
        .map(|r| ares_core::path::RotationTarget { segment: r.segment - a, ..r.clone() })
        .collect();
    PathSpec {
        name: spec.name.clone(),
        waypoints,
        constraints: spec.constraints.clone(),
        scoped,
        events,
        rotation_targets,
        continues_from: if a == 0 { spec.continues_from.clone() } else { None },
        continues_at: if a == 0 { spec.continues_at } else { None },
        condition: None,
        first_section: None,
        variants: vec![],
        folder: None,
    }
}

/// What the robot will probably do when it pathfinds from `from` to `to`:
/// the shortest way around the keep-outs (A*, like PathPlanner's
/// pathfinder), timed by the robot's physics under the pathfinding limits.
/// An estimate: the real route depends on where the robot actually is.
fn pathfind_estimate(
    robot: &RobotConfig,
    spec: &PathSpec,
    env: &Environment,
    from: &Sample,
    to: &Sample,
    opts: &ares_core::path::PathfindOptions,
    _dt: f64,
) -> Result<Trajectory, PlanError> {
    use ares_core::path::{ScopedConstraint, Target, Waypoint};
    let reach = 0.5 * robot.bumper.length_m.hypot(robot.bumper.width_m);
    let mut free = free_space(spec, env, reach);
    // The pathfinder, unlike a drawn path, keeps out of the navgrid's cells.
    free.grid = env.navgrid.clone().filter(|g| !g.is_empty());
    let (a, b) = (Vec2::new(from.x, from.y), Vec2::new(to.x, to.y));
    let corners = route::shortest_way(&free, a, b).ok_or_else(|| {
        PlanError::Core(AresError::Path(if free.grid.is_some() {
            "there is no way around the keep-outs and the navgrid's blocked cells".into()
        } else {
            "there is no way around the keep-outs".into()
        }))
    })?;
    let mut waypoints = vec![Waypoint { x: a.x, y: a.y, heading_deg: Some(from.heading.to_degrees()), ..Default::default() }];
    waypoints.extend(corners.iter().map(|c| Waypoint { x: c.x, y: c.y, ..Default::default() }));
    waypoints.push(Waypoint { x: b.x, y: b.y, heading_deg: Some(to.heading.to_degrees()), ..Default::default() });
    let mut s = PathSpec::new("pathfind", waypoints);
    // Its ends move or stop as the hand-offs say, not by default.
    s.scoped.clear();
    s.constraints.max_velocity_mps = opts.max_velocity_mps;
    s.constraints.max_angular_velocity_dps = opts.max_angular_velocity_dps;
    if let Some(a) = opts.max_acceleration_mps2 {
        s.scoped.push(ScopedConstraint {
            from: Target::First,
            to: Some(Target::Last),
            enabled: true,
            kind: ConstraintKind::MaxAcceleration { mps2: a },
       exprs: Default::default() });
    }
    // Moving hand-offs: in and out at the speed the parts around it have.
    let (v0, v1) = (from.vx.hypot(from.vy), to.vx.hypot(to.vy));
    Ok(ares_core::solve_between(robot, &s, &SolverOptions::default(), v0, v1)?)
}

/// One fixed part (no pathfinding inside). With a see-AprilTags constraint it is planned free
/// first: if that already keeps enough tags in view, nothing is gained by aiming and it stays (it
/// is the fastest). Otherwise the cameras aim, and the plan that keeps more tags in view wins
/// (the faster on a tie). If the optimizer cannot aim them, the free plan stays and the note says so.
fn plan_fixed(
    robot: &RobotConfig,
    spec: &PathSpec,
    env: &Environment,
    options: &PlannerOptions,
) -> Result<Planned, PlanError> {
    let wants = spec.scoped.iter().any(|c| c.enabled && matches!(c.kind, ConstraintKind::SeeTags { .. }));
    if !wants || robot.cameras.is_empty() || env.tags.is_empty() {
        let mut planned = plan_fixed_with(robot, spec, env, options, 0)?;
        if wants {
            planned.trajectory.notes.extend(vision_notes(robot, spec, env, &planned.trajectory));
        }
        return Ok(planned);
    }
    let free = plan_fixed_with(robot, spec, env, options, 0)?;
    let free_seen = worst_span(robot, spec, env, &free.trajectory);
    let mut chosen = free;
    let mut notes = Vec::new();
    if free_seen < 0.999 {
        match plan_aimed(robot, spec, env, options) {
            Ok(aimed) => {
                let aimed_seen = worst_span(robot, spec, env, &aimed.trajectory);
                if aimed_seen > free_seen + 1e-9 || (aimed_seen >= free_seen - 1e-9 && aimed.trajectory.duration_s < chosen.trajectory.duration_s) {
                    chosen = aimed;
                }
            }
            Err(PlanError::Solver { .. }) => {
                notes.push("could not keep the cameras on the AprilTags along this path: planned without the see-AprilTags constraint".to_string());
            }
            Err(e) => return Err(e),
        }
    }
    // Turning was not enough: look beside the blind stretch for a place the tags are seen from.
    let best_seen = worst_span(robot, spec, env, &chosen.trajectory);
    if best_seen < 0.999 {
        if let Some((spec2, inserted, moved)) = detour_spec(robot, spec, env, &chosen.trajectory) {
            match plan_aimed(robot, &spec2, env, options) {
                Ok(mut detoured) => {
                    // Back to the user's waypoints: the hidden one is not theirs.
                    detoured.trajectory.waypoint_times.remove(inserted);
                    let seen = worst_span(robot, spec, env, &detoured.trajectory);
                    // Worth it only if it sees clearly more, and not at any price in time: at
                    // least 5 points of coverage, and 15 points for every second it adds.
                    let gain = seen - best_seen;
                    let extra = detoured.trajectory.duration_s - chosen.trajectory.duration_s;
                    if gain >= DETOUR_MIN_GAIN && (extra <= 0.0 || gain / extra >= DETOUR_GAIN_PER_S) {
                        notes.push(format!(
                            "detoured {:.2} m toward the AprilTags ({:.1} s, was {:.1} s)",
                            moved, detoured.trajectory.duration_s, chosen.trajectory.duration_s
                        ));
                        chosen = detoured;
                    }
                }
                Err(PlanError::Solver { .. }) => {}
                Err(e) => return Err(e),
            }
        }
    }
    notes.extend(vision_notes(robot, spec, env, &chosen.trajectory));
    chosen.trajectory.notes.extend(notes);
    Ok(chosen)
}

/// A detour must add this much of the span with enough tags in view...
const DETOUR_MIN_GAIN: f64 = 0.05;
/// ...and this much per second it costs.
const DETOUR_GAIN_PER_S: f64 = 0.15;

/// How many ways the cameras are aimed before giving up: each asks less (see `plan_fixed_with`).
const AIM_LEVELS: u8 = 3;

/// The path with its cameras aimed, at the first level the optimizer can meet: a short stretch
/// between two fixed headings may have no time to turn to the tags and back at full strength.
fn plan_aimed(robot: &RobotConfig, spec: &PathSpec, env: &Environment, options: &PlannerOptions) -> Result<Planned, PlanError> {
    let mut last = None;
    for level in 1..=AIM_LEVELS {
        match plan_fixed_with(robot, spec, env, options, level) {
            Err(e @ PlanError::Solver { .. }) => last = Some(e),
            other => return other,
        }
    }
    Err(last.expect("at least one level"))
}

/// A copy of the path with one hidden waypoint where the cameras see enough tags, beside the
/// longest blind stretch of a see-AprilTags span that allows a detour: `(spec, its index, how far
/// from the stretch it is)`. None when no span allows one, nothing is blind, the segment is the
/// user's own curve (manual, pathfind, a rotation target on it), or no place nearby sees more.
fn detour_spec(robot: &RobotConfig, spec: &PathSpec, env: &Environment, t: &Trajectory) -> Option<(PathSpec, usize, f64)> {
    use ares_core::path::Target;
    let world = env.world();
    let n = spec.waypoints.len();
    let (c, radius, camera, min_tags) = spec.scoped.iter().filter(|c| c.enabled).find_map(|c| match &c.kind {
        ConstraintKind::SeeTags { detour_m, camera, min_tags } if *detour_m > 0.0 => Some((c, *detour_m, camera.clone(), *min_tags as usize)),
        _ => None,
    })?;
    let (a, b) = c.range(n);
    let (ta, tb) = (*t.waypoint_times.get(a)?, *t.waypoint_times.get(b)?);
    let span: Vec<&Sample> = t.samples.iter().filter(|q| q.t >= ta - 1e-9 && q.t <= tb + 1e-9).collect();
    let blind: Vec<bool> = span
        .iter()
        .map(|q| ares_core::vision::coverage_of(robot, &world, &[(q.x, q.y, q.heading)], camera.as_deref(), min_tags) < 1.0)
        .collect();
    // The longest blind run, and its middle.
    let (mut best, mut run_start) = ((0usize, 0usize), None);
    for (k, &bl) in blind.iter().chain(std::iter::once(&false)).enumerate() {
        match (bl, run_start) {
            (true, None) => run_start = Some(k),
            (false, Some(s)) => {
                if k - s > best.1 - best.0 {
                    best = (s, k);
                }
                run_start = None;
            }
            _ => {}
        }
    }
    if best.1 == best.0 {
        return None;
    }
    let mid = span[(best.0 + best.1) / 2];
    // The segment it is on, inside the span.
    let j = (a..b).rev().find(|&j| t.waypoint_times[j] <= mid.t + 1e-9).unwrap_or(a);
    let w = &spec.waypoints[j];
    if w.manual_next || w.pathfind_next.is_some() || spec.rotation_targets.iter().any(|r| r.segment == j) {
        return None;
    }
    // Places around it: the one that sees the most, then the nearest.
    let reach = 0.5 * robot.bumper.length_m.hypot(robot.bumper.width_m);
    let inside = |x: f64, y: f64| {
        env.field.is_none_or(|f| x > reach && y > reach && x < f.length_m - reach && y < f.width_m - reach)
            && env.keep_out.iter().all(|o| (x - o.x).hypot(y - o.y) > o.radius_m + reach)
            && world.occluders.iter().all(|o| {
                let (cs, sn) = (o.yaw_deg.to_radians().cos(), o.yaw_deg.to_radians().sin());
                let (dx, dy) = (x - o.x, y - o.y);
                (cs * dx + sn * dy).abs() > o.length_m / 2.0 + reach || (-sn * dx + cs * dy).abs() > o.width_m / 2.0 + reach
            })
    };
    let here = ares_core::vision::best_view(robot, &world, mid.x, mid.y, 24).0;
    let mut pick: Option<(usize, f64, f64, f64)> = None;
    for r in [0.35, 0.7, 1.0] {
        for k in 0..12 {
            let th = std::f64::consts::TAU * k as f64 / 12.0;
            let (x, y) = (mid.x + r * radius * th.cos(), mid.y + r * radius * th.sin());
            if !inside(x, y) {
                continue;
            }
            let seen = ares_core::vision::best_view(robot, &world, x, y, 24).0;
            if seen <= here {
                continue;
            }
            let d = r * radius;
            if pick.is_none_or(|p| seen > p.0 || (seen == p.0 && d < p.3)) {
                pick = Some((seen, x, y, d));
            }
        }
    }
    let (_, x, y, d) = pick?;
    let mut out = spec.clone();
    let at = j + 1;
    out.waypoints.insert(at, ares_core::path::Waypoint { x, y, ..Default::default() });
    let shift = |t: Target| match t {
        Target::Index(i) if i >= at => Target::Index(i + 1),
        other => other,
    };
    for sc in &mut out.scoped {
        sc.from = shift(sc.from);
        sc.to = sc.to.map(shift);
    }
    for e in &mut out.events {
        e.target = shift(e.target);
    }
    for r in &mut out.rotation_targets {
        if r.segment >= at {
            r.segment += 1;
        }
    }
    Some((out, at, d))
}

/// The see-AprilTags span that keeps its tags in view least: the fraction of its samples with
/// enough of them.
fn worst_span(robot: &RobotConfig, spec: &PathSpec, env: &Environment, t: &Trajectory) -> f64 {
    let n = spec.waypoints.len();
    spec.scoped
        .iter()
        .filter(|c| c.enabled)
        .filter_map(|c| match &c.kind {
            ConstraintKind::SeeTags { camera, min_tags, .. } => {
                let (a, b) = c.range(n);
                let poses = span_poses(t, a, b)?;
                Some(ares_core::vision::coverage_of(robot, &env.world(), &poses, camera.as_deref(), *min_tags as usize))
            }
            _ => None,
        })
        .fold(1.0, f64::min)
}

fn tb_of(t: &Trajectory, b: usize) -> f64 {
    t.waypoint_times.get(b).copied().unwrap_or(t.duration_s)
}

fn span_poses(t: &Trajectory, a: usize, b: usize) -> Option<Vec<(f64, f64, f64)>> {
    let (ta, tb) = (t.waypoint_times.get(a).copied()?, t.waypoint_times.get(b).copied()?);
    Some(t.samples.iter().filter(|q| q.t >= ta - 1e-9 && q.t <= tb + 1e-9).map(|q| (q.x, q.y, q.heading)).collect())
}

/// How well each see-AprilTags span kept tags in view, or why it could not.
fn vision_notes(robot: &RobotConfig, spec: &PathSpec, env: &Environment, t: &Trajectory) -> Vec<String> {
    if robot.cameras.is_empty() {
        return vec!["the see-AprilTags constraint needs cameras: add them in the Robot tab".into()];
    }
    if env.tags.is_empty() {
        return vec!["the see-AprilTags constraint needs the field's AprilTags".into()];
    }
    let n = spec.waypoints.len();
    spec.scoped
        .iter()
        .filter(|c| c.enabled)
        .filter_map(|c| match &c.kind {
            ConstraintKind::SeeTags { camera, min_tags, .. } => {
                let (a, b) = c.range(n);
                let poses = span_poses(t, a, b)?;
                let world = env.world();
                let seen = ares_core::vision::coverage_of(robot, &world, &poses, camera.as_deref(), *min_tags as usize);
                // How well the robot knows where it is at the end of the span (two sigma), from a
                // pose known to 5 cm at the start of the path.
                let all: Vec<_> = t.samples.iter().map(|q| (q.t, q.x, q.y, q.heading, q.vx.hypot(q.vy))).collect();
                let sigma = ares_core::vision::pose_sigma(robot, &world, &all, 0.05);
                let end = t.samples.iter().rposition(|q| q.t <= tb_of(t, b) + 1e-9).unwrap_or(0);
                let pose_note = sigma.get(end).map(|s| format!(", pose \u{b1}{:.0} cm at waypoint {}", 200.0 * s, b + 1)).unwrap_or_default();
                let enough = if *min_tags > 1 { format!("{min_tags}+ AprilTags") } else { "AprilTags".to_string() };
                Some(format!(
                    "{enough} in view {:.0}% of waypoints {}-{}{}{pose_note}",
                    100.0 * seen,
                    a + 1,
                    b + 1,
                    camera.as_ref().map(|c| format!(" ({c})")).unwrap_or_default()
                ))
            }
            _ => None,
        })
        .collect()
}

fn plan_fixed_with(
    robot: &RobotConfig,
    spec: &PathSpec,
    env: &Environment,
    options: &PlannerOptions,
    vision: u8,
) -> Result<Planned, PlanError> {
    let started = Instant::now();
    validate(spec)?;
    // Continuing another path, it starts moving: a stop on the first
    // waypoint (every path has one by default) does not apply.
    let without_first_stop;
    let spec = if options.start_state.is_some() {
        let n = spec.waypoints.len();
        let mut s = spec.clone();
        s.scoped.retain(|c| !(matches!(c.kind, ConstraintKind::StopPoint { .. }) && c.range(n) == (0, 0)));
        without_first_stop = s;
        &without_first_stop
    } else {
        spec
    };
    let sw = robot.swerve();
    let reach = 0.5 * robot.bumper.length_m.hypot(robot.bumper.width_m);

    // The guess: the user's waypoints, plus hidden corners around keep-outs.
    let free = free_space(spec, env, reach);
    let routed = route::route(spec, &free, robot.drive_radius());
    let work = &routed.spec;

    // Stage 1 on the routed spline.
    let core_options = SolverOptions::default();
    let warm = ares_core::solve(robot, work, &core_options)?;
    let wp_time = warm.waypoint_times.clone();

    // Sampling: about target_dt apart, unless the user set a count.
    let segments = work.waypoints.len() - 1;
    let mut intervals = vec![0i32; segments];
    for (i, w) in spec.waypoints.iter().enumerate().take(spec.waypoints.len() - 1) {
        let (a, b) = (routed.index_of[i], routed.index_of[i + 1]);
        let total = (wp_time[b] - wp_time[a]).max(1e-6);
        for j in a..b {
            let span = (wp_time[j + 1] - wp_time[j]).max(0.0);
            intervals[j] = match w.intervals {
                Some(n) => ((n as f64 * span / total).round() as i32).max(1),
                None => ((span.max(0.05) / options.target_dt_s).ceil() as i32).max(3),
            };
        }
    }
    let mut guess_dt = Vec::with_capacity(segments);
    let mut times = vec![0.0];
    let mut start = vec![0usize];
    for j in 0..segments {
        let n = intervals[j];
        let span = (wp_time[j + 1] - wp_time[j]).max(0.05);
        guess_dt.push(span / n as f64);
        for i in 1..=n {
            times.push(wp_time[j] + (wp_time[j + 1] - wp_time[j]) * i as f64 / n as f64);
        }
        start.push(times.len() - 1);
    }
    let mut guess: Vec<Sample> = times.iter().map(|&t| warm.sample_at(t)).collect();
    // Rotation targets in the warm start too: the heading bends toward each
    // target over its segment, so the solver starts near it instead of a
    // half turn away.
    for r in &spec.rotation_targets {
        if r.segment + 1 >= routed.index_of.len() {
            continue;
        }
        let (s0, s1) = (start[routed.index_of[r.segment]], start[routed.index_of[r.segment + 1]]);
        if s1 <= s0 {
            continue;
        }
        let k = (s0 as f64 + r.fraction.clamp(0.0, 1.0) * (s1 - s0) as f64).round() as usize;
        let delta = wrap_angle(r.heading_deg.to_radians() - guess[k].heading);
        for (i, q) in guess.iter_mut().enumerate().take(s1 + 1).skip(s0) {
            let w = if i <= k { (i - s0) as f64 / (k - s0).max(1) as f64 } else { (s1 - i) as f64 / (s1 - k).max(1) as f64 };
            q.heading += delta * w;
        }
    }
    // See-AprilTags spans: which camera faces which tag along each, from the guess' positions.
    // They become point-at constraints below, and the guess turns to them now so the solver
    // starts aimed. Samples at a waypoint with a fixed heading (and their neighbors) stay free.
    let mut vision_aims: Vec<ares_core::vision::Aim> = Vec::new();
    if vision > 0 && !env.tags.is_empty() && !robot.cameras.is_empty() {
        let world = env.world();
        let n_wp = work.waypoints.len();
        let fixed: Vec<usize> = (0..n_wp).filter(|&j| work.waypoints[j].fixed_heading_deg().is_some()).map(|j| start[j]).collect();
        for c in work.scoped.iter().filter(|c| c.enabled) {
            if let ConstraintKind::SeeTags { camera, min_tags, .. } = &c.kind {
                let (a, b) = c.range(n_wp);
                let (s0, s1) = (start[a], start[b]);
                let poses: Vec<_> = (s0..=s1).map(|k| (guess[k].x, guess[k].y, guess[k].heading)).collect();
                // Each level leaves more room to turn by the fixed headings, keeps only longer aims
                // and widens their tolerance (up to just inside the half field of view).
                let margin = 2 * vision as usize - 1;
                let skip: Vec<bool> = (s0..=s1).map(|k| fixed.iter().any(|&f| k + margin >= f && k <= f + margin)).collect();
                let longest = 2 + 2 * vision as usize;
                for mut aim in ares_core::vision::aims(robot, &world, &poses, &skip, camera.as_deref(), *min_tags as usize) {
                    if aim.to - aim.from + 1 < longest {
                        continue;
                    }
                    let half = 0.5 * robot.cameras[aim.camera].horizontal_fov_deg.to_radians();
                    aim.tolerance_rad = (aim.tolerance_rad * (1.0 + 0.15 * (vision - 1) as f64)).min(0.9 * half);
                    aim.from += s0;
                    aim.to += s0;
                    for (k, h) in (aim.from..=aim.to).zip(&aim.headings) {
                        guess[k].heading = *h;
                    }
                    vision_aims.push(aim);
                }
            }
        }
    }
    let col = |f: fn(&Sample) -> f64| guess.iter().map(f).collect::<Vec<f64>>();
    let (gx, gy, gth) = (col(|s| s.x), col(|s| s.y), col(|s| s.heading));
    let (gvx, gvy, gw) = (col(|s| s.vx), col(|s| s.vy), col(|s| s.omega));
    let (gax, gay, gal) = (col(|s| s.ax), col(|s| s.ay), col(|s| s.alpha));

    // Waypoints: what each kind pins down, and the stop points.
    let n_wp = work.waypoints.len();
    let mut wp_flags = Vec::with_capacity(n_wp);
    let mut wp_values = Vec::with_capacity(3 * n_wp);
    for w in &work.waypoints {
        let mut f = 0;
        match w.kind() {
            WaypointKind::Pose => f |= ffi::WP_POSITION | ffi::WP_HEADING,
            WaypointKind::Translation | WaypointKind::Unknown => f |= ffi::WP_POSITION,
            // Where the previous path ended: its pose, heading included when
            // known.
            WaypointKind::Continue => {
                f |= ffi::WP_POSITION;
                if w.heading_deg.is_some() {
                    f |= ffi::WP_HEADING;
                }
            }
            WaypointKind::Empty => {}
        }
        wp_flags.push(f);
        wp_values.extend([w.x, w.y, w.fixed_heading_deg().unwrap_or(0.0).to_radians()]);
    }
    let mut constraints = Vec::new();
    for c in work.scoped.iter().filter(|c| c.enabled) {
        let (a, b) = c.range(n_wp);
        let (from, to) = (start[a] as i32, start[b] as i32);
        let rec = |kind, p: [f64; 5]| ffi::Constraint { kind, from, to, p: [p[0], p[1], p[2], p[3], p[4], 0.0, 0.0, 0.0] };
        match c.kind {
            ConstraintKind::StopPoint { .. } => {
                for j in a..=b {
                    wp_flags[j] |= ffi::WP_STOP;
                }
            }
            ConstraintKind::MaxVelocity { mps } => constraints.push(rec(ffi::C_MAX_VELOCITY, [mps, 0.0, 0.0, 0.0, 0.0])),
            ConstraintKind::MaxAcceleration { mps2 } => constraints.push(rec(ffi::C_MAX_ACCELERATION, [mps2, 0.0, 0.0, 0.0, 0.0])),
            ConstraintKind::MaxAngularVelocity { dps } => {
                constraints.push(rec(ffi::C_MAX_OMEGA, [dps.to_radians(), 0.0, 0.0, 0.0, 0.0]))
            }
            ConstraintKind::PointAt { x, y, tolerance_deg, flip, offset_deg } => constraints.push(rec(
                ffi::C_POINT_AT,
                [x, y, tolerance_deg.to_radians(), ares_core::path::facing_offset_rad(flip, offset_deg), 0.0],
            )),
            ConstraintKind::KeepInCircle { x, y, radius_m } => constraints.push(rec(ffi::C_KEEP_IN_CIRCLE, [x, y, radius_m, 0.0, 0.0])),
            ConstraintKind::KeepInRectangle { x, y, width_m, height_m } => {
                constraints.push(rec(ffi::C_KEEP_IN_RECT, [x, y, width_m, height_m, 0.0]))
            }
            ConstraintKind::KeepInLane { tolerance_m } => {
                let (wa, wb) = (&work.waypoints[a], &work.waypoints[b]);
                constraints.push(rec(ffi::C_KEEP_IN_LANE, [wa.x, wa.y, wb.x, wb.y, tolerance_m]))
            }
            ConstraintKind::KeepOutCircle { x, y, radius_m } => {
                constraints.push(rec(ffi::C_KEEP_OUT_CIRCLE, [x, y, radius_m, 0.0, 0.0]))
            }
            // Built from the aims above.
            ConstraintKind::SeeTags { .. } => {}
        }
    }
    for aim in &vision_aims {
        constraints.push(ffi::Constraint {
            kind: ffi::C_POINT_AT,
            from: aim.from as i32,
            to: aim.to as i32,
            p: [aim.target[0], aim.target[1], aim.tolerance_rad, aim.offset_rad, 0.0, 0.0, 0.0, 0.0],
        });
    }

    // Continuing another path: its end speed is this one's start, and a stop
    // on the first waypoint would contradict it.
    if let Some([vx, vy, w]) = options.start_state {
        wp_flags[0] &= !ffi::WP_STOP;
        constraints.push(ffi::Constraint { kind: ffi::C_VELOCITY, from: 0, to: 0, p: [vx, vy, w, 0.0, 0.0, 0.0, 0.0, 0.0] });
    }

    // Rotation targets: a heading at a fraction of a segment's samples.
    for r in &spec.rotation_targets {
        if r.segment + 1 >= routed.index_of.len() {
            continue;
        }
        let (s0, s1) = (start[routed.index_of[r.segment]], start[routed.index_of[r.segment + 1]]);
        let k = (s0 as f64 + r.fraction.clamp(0.0, 1.0) * (s1 - s0) as f64).round() as i32;
        constraints.push(ffi::Constraint { kind: ffi::C_HEADING, from: k, to: k, p: [r.heading_deg.to_radians(), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] });
    }

    // Manual segments: the robot stays on the user's curve.
    for (j, pts) in work.manual_curves() {
        constraints.push(ffi::Constraint {
            kind: ffi::C_ON_BEZIER,
            from: start[j] as i32,
            to: start[j + 1] as i32,
            p: [pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y],
        });
    }

    let d = drive(robot);
    let module_xy: Vec<f64> = sw.modules.iter().flat_map(|m| [m.x_m, m.y_m]).collect();
    let circles: Vec<f64> = env.keep_out.iter().flat_map(|c| [c.x, c.y, c.radius_m]).collect();
    let field = env.field.unwrap_or(FieldSize { length_m: 0.0, width_m: 0.0 });

    // Slow zones act on the samples inside them. Which those are depends on
    // the answer, so: guess from the warm start, solve, and if the solution
    // went through other parts of a zone, add them and solve again.
    let zone_caps = |flags: &[Vec<bool>]| -> Vec<ffi::Constraint> {
        let mut out = Vec::new();
        for (z, inside) in env.slow_zones.iter().zip(flags) {
            let mut k = 0;
            while k < inside.len() {
                if !inside[k] {
                    k += 1;
                    continue;
                }
                let a = k.saturating_sub(1);
                while k < inside.len() && inside[k] {
                    k += 1;
                }
                let b = k.min(inside.len() - 1);
                let rec = |kind, v: f64| ffi::Constraint { kind, from: a as i32, to: b as i32, p: [v, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] };
                if let Some(v) = z.max_velocity_mps {
                    out.push(rec(ffi::C_MAX_VELOCITY, v));
                }
                if let Some(acc) = z.max_acceleration_mps2 {
                    out.push(rec(ffi::C_MAX_ACCELERATION, acc));
                }
            }
        }
        out
    };
    let mut zone_flags: Vec<Vec<bool>> = env
        .slow_zones
        .iter()
        .map(|z| (0..gx.len()).map(|k| z.shape.contains(gx[k], gy[k])).collect())
        .collect();
    let mut pass = 0;
    let sol = loop {
        let mut all = constraints.clone();
        all.extend(zone_caps(&zone_flags));
        let problem = ffi::Problem {
            mass_kg: robot.mass_kg,
            moi_kg_m2: robot.moi_kg_m2,
            gravity: GRAVITY,
            cog_height_m: robot.cog_height_m.unwrap_or(0.0),
            min_load_n: MIN_LOAD_FRACTION * robot.mass_kg * GRAVITY / sw.modules.len() as f64,
            wheel_cof: sw.wheel_cof,
            module_xy: &module_xy,
            wheel_free_speed_mps: robot.max_module_speed(),
            f_current_n: d.f_current,
            f_volt_n: d.f_volt,
            f_emf_n_per_mps: d.f_emf,
            bumper_length_m: robot.bumper.length_m,
            bumper_width_m: robot.bumper.width_m,
            intervals: &intervals,
            wp_flags: &wp_flags,
            wp_values: &wp_values,
            max_velocity_mps: spec.constraints.max_velocity_mps.unwrap_or(0.0),
            max_omega_radps: spec.constraints.max_angular_velocity_dps.map_or(0.0, f64::to_radians),
            field_length_m: field.length_m,
            field_width_m: field.width_m,
            circle_xyr: &circles,
            constraints: &all,
            guess: [&gx, &gy, &gth, &gvx, &gvy, &gw, &gax, &gay, &gal],
            guess_dt: &guess_dt,
            cancel: options.cancel.as_ref().map(|c| &*c.0),
            tolerance: options.tolerance,
            max_iterations: options.max_iterations as i32,
            timeout_s: options.timeout.as_secs_f64(),
        };
        let sol = ffi::solve(&problem);
        if sol.status == ffi::CANCELLED {
            return Err(PlanError::Cancelled);
        }
        // 1 is the stall stop and -9 the iteration cap: both leave an iterate
        // that may well be the answer, which the physics check below decides.
        let maybe_done = sol.status == 0 || sol.status == 1 || sol.status == -9;
        if !maybe_done {
            return Err(PlanError::Solver { status: sol.status, reason: status_reason(sol.status) });
        }
        let mut grew = false;
        for (z, flags) in env.slow_zones.iter().zip(zone_flags.iter_mut()) {
            for k in 0..flags.len() {
                if !flags[k] && z.shape.contains(sol.x[k], sol.y[k]) {
                    flags[k] = true;
                    grew = true;
                }
            }
        }
        pass += 1;
        if !grew || pass >= 3 {
            break sol;
        }
    };

    // Back to a Trajectory, with what every module does.
    let m = sw.modules.len();
    let static_load = robot.mass_kg * GRAVITY / m as f64;
    let mh = robot.mass_kg * robot.cog_height_m.unwrap_or(0.0);
    let q = robot.load_vectors();
    let mut t = 0.0;
    let mut samples = Vec::with_capacity(times.len());
    let mut seg = 0;
    let mut in_seg = 0;
    // Headings come back wrapped; unwrap them so they read like the core's.
    let mut heading = sol.theta[0];
    for k in 0..times.len() {
        if k > 0 {
            heading += wrap_angle(sol.theta[k] - sol.theta[k - 1]);
            t += sol.dt[seg];
            in_seg += 1;
            if in_seg == intervals[seg] as usize && seg + 1 < segments {
                seg += 1;
                in_seg = 0;
            }
        }
        let (c, s) = (heading.cos(), heading.sin());
        let modules = (0..m)
            .map(|i| {
                let p = sw.modules[i].position();
                let r = Vec2::new(c * p.x - s * p.y, s * p.x + c * p.y);
                let v = Vec2::new(sol.vx[k] - sol.omega[k] * r.y, sol.vy[k] + sol.omega[k] * r.x);
                let f = Vec2::new(sol.fx[k * m + i], sol.fy[k * m + i]);
                let speed = v.norm();
                let dir = if speed > 1e-3 { v * (1.0 / speed) } else { f.normalized() };
                let qi = Vec2::new(c * q[i].x - s * q[i].y, s * q[i].x + c * q[i].y);
                let load = static_load - mh * (sol.ax[k] * qi.x + sol.ay[k] * qi.y);
                let along = if dir == Vec2::ZERO { 0.0 } else { f.dot(dir) };
                ModuleSample {
                    speed_mps: speed,
                    angle_rad: if dir == Vec2::ZERO { 0.0 } else { wrap_angle(dir.y.atan2(dir.x) - heading) },
                    force_n: f.norm(),
                    fx_n: f.x,
                    fy_n: f.y,
                    grip_used: f.norm() / (sw.wheel_cof * load.max(1e-9)),
                    load_n: load,
                    current_a: along / d.n_per_amp,
                }
            })
            .collect();
        samples.push(Sample {
            t,
            x: sol.x[k],
            y: sol.y[k],
            heading,
            vx: sol.vx[k],
            vy: sol.vy[k],
            omega: sol.omega[k],
            ax: sol.ax[k],
            ay: sol.ay[k],
            alpha: sol.alpha[k],
            modules,
        });
    }

    // Waits at stop points: the robot holds still where it stopped, and the
    // rest of the trajectory moves later. The optimizer never sees them; they
    // are exact here (at rest, nothing changes while it waits).
    let mut waits: Vec<(usize, f64)> = work
        .scoped
        .iter()
        .filter(|c| c.enabled)
        .filter_map(|c| match c.kind {
            ConstraintKind::StopPoint { wait_s } if wait_s > 0.0 => Some((start[c.range(n_wp).0], wait_s)),
            _ => None,
        })
        .collect();
    waits.sort_by_key(|w| w.0);
    // Where each solver sample (its arrival) ends up after the holds.
    let mut new_index = Vec::with_capacity(samples.len());
    if !waits.is_empty() {
        let mut out = Vec::with_capacity(samples.len() + waits.len());
        let mut shift = 0.0;
        let mut w = waits.iter().peekable();
        for (k, mut q) in samples.into_iter().enumerate() {
            q.t += shift;
            new_index.push(out.len());
            let mut hold = 0.0;
            while let Some(&&(wk, ws)) = w.peek() {
                if wk != k {
                    break;
                }
                hold += ws;
                w.next();
            }
            if hold > 0.0 {
                // Arrival: at rest, nothing pushing.
                let mut arrive = q.clone();
                arrive.ax = 0.0;
                arrive.ay = 0.0;
                arrive.alpha = 0.0;
                for m in &mut arrive.modules {
                    m.force_n = 0.0;
                    m.fx_n = 0.0;
                    m.fy_n = 0.0;
                    m.grip_used = 0.0;
                    m.current_a = 0.0;
                }
                out.push(arrive);
                shift += hold;
                q.t += hold;
            }
            out.push(q);
        }
        t += shift;
        samples = out;
    } else {
        new_index = (0..samples.len()).collect();
    }

    // What the robot code needs besides the samples: when each of the user's
    // waypoints is passed (arrives), where to split, when the events fire.
    let waypoint_times: Vec<f64> = routed.index_of.iter().map(|&j| samples[new_index[start[j]]].t).collect();
    let splits = spec
        .waypoints
        .iter()
        .enumerate()
        .filter(|(i, w)| w.is_split() && *i > 0 && *i + 1 < spec.waypoints.len())
        .map(|(i, _)| new_index[start[routed.index_of[i]]])
        .collect();
    let events = spec
        .events
        .iter()
        .map(|e| {
            let start = (waypoint_times[e.target.resolve(spec.waypoints.len())] + e.offset_s).clamp(0.0, t);
            TimedEvent { name: e.name.clone(), t: start, end_t: e.duration_s.map(|d| (start + d.max(0.0)).min(t)), command: e.command.clone() }
        })
        .collect();

    let trajectory = Trajectory {
        name: spec.name.clone(),
        robot: robot.name.clone(),
        duration_s: t,
        samples,
        waypoint_times,
        splits,
        events,
        pathfind: vec![],
        start: Default::default(),
        continues_from: None,
        sections: vec![],
        variant: None,
        source_hash: None,
        notes: Vec::new(),
    };
    if let Err(problem) = check_physics(robot, work, env, &trajectory) {
        if std::env::var("ARES_TRACE").is_ok() {
            eprintln!("rejected: {problem}");
        }
        let reason = if sol.status == 0 { "its answer breaks the physics (a bug: please report the path)" } else { status_reason(sol.status) };
        return Err(PlanError::Solver { status: sol.status, reason });
    }

    Ok(Planned {
        trajectory,
        spline_duration_s: warm.duration_s,
        iterations: sol.iterations.max(0) as u32,
        solve_time: started.elapsed(),
    })
}

/// What a path must be before it is worth solving.
fn validate(spec: &PathSpec) -> Result<(), PlanError> {
    let n = spec.waypoints.len();
    let bad = |msg: String| Err(PlanError::Core(AresError::Path(msg)));
    if n < 2 {
        return bad("it needs at least 2 waypoints".into());
    }
    for end in [0, n - 1] {
        if spec.waypoints[end].kind() == WaypointKind::Empty {
            return bad(format!("the {} waypoint cannot be empty", if end == 0 { "first" } else { "last" }));
        }
    }
    for (i, w) in spec.waypoints.iter().enumerate().skip(1) {
        if w.kind().is_start_only() {
            return bad(format!("waypoint {}: an unknown or continued start can only be the first waypoint", i + 1));
        }
    }
    for c in spec.scoped.iter().filter(|c| c.enabled) {
        let (a, b) = c.range(n);
        match c.kind {
            ConstraintKind::StopPoint { .. } if a != b => return bad("a stop point goes on one waypoint, not a segment".into()),
            ConstraintKind::KeepInLane { .. } if a == b => return bad("a lane needs a segment, not one waypoint".into()),
            ConstraintKind::SeeTags { .. } if a == b => return bad("see AprilTags needs a segment, from one waypoint to another".into()),
            ConstraintKind::MaxVelocity { mps } if mps <= 0.0 => return bad("a max velocity has to be positive".into()),
            ConstraintKind::MaxAcceleration { mps2 } if mps2 <= 0.0 => {
                return bad("a max acceleration has to be positive".into())
            }
            _ => {}
        }
        if matches!(c.kind, ConstraintKind::PointAt { .. }) {
            // Choreo's rule: a point-at on a pose waypoint fights its heading.
            if matches!(c.kind, ConstraintKind::PointAt { .. })
                && (a..=b).any(|j| spec.waypoints[j].kind() == WaypointKind::Pose)
            {
                return bad("a point-at constraint cannot cover a pose waypoint (its heading is already fixed)".into());
            }
        }
    }
    Ok(())
}

/// Where the guess may run: inside the walls (the center, a bumper's reach
/// in) and clear of every keep-out grown by that reach.
fn free_space(spec: &PathSpec, env: &Environment, reach: f64) -> route::Free {
    let grow = reach + 0.05;
    let mut obstacles: Vec<route::Obstacle> = env
        .keep_out
        .iter()
        .map(|c| route::Obstacle { center: Vec2::new(c.x, c.y), radius: c.radius_m + grow })
        .collect();
    for c in spec.scoped.iter().filter(|c| c.enabled) {
        if let ConstraintKind::KeepOutCircle { x, y, radius_m } = c.kind {
            obstacles.push(route::Obstacle { center: Vec2::new(x, y), radius: radius_m + grow });
        }
    }
    let bounds = match env.field {
        Some(f) => [reach, reach, f.length_m - reach, f.width_m - reach],
        None => {
            let xs = spec.waypoints.iter().map(|w| w.x);
            let ys = spec.waypoints.iter().map(|w| w.y);
            let (x0, x1) = xs.fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(v), b.max(v)));
            let (y0, y1) = ys.fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(v), b.max(v)));
            [x0 - 5.0, y0 - 5.0, x1 + 5.0, y1 + 5.0]
        }
    };
    route::Free { obstacles, bounds, grid: None }
}

/// Everything the optimizer promises, checked on what it returned: the
/// dynamics between samples, the waypoints, every wheel's grip, current,
/// speed and load, the walls and the keep-outs. An iterate the solver stopped
/// on is only used if it passes; a converged one is checked anyway, because
/// a trajectory that lies is worse than none.
pub fn check_physics(robot: &RobotConfig, spec: &PathSpec, env: &Environment, t: &Trajectory) -> Result<(), String> {
    const POS_TOL: f64 = 2e-3;
    const VEL_TOL: f64 = 2e-3;
    const LIMIT_TOL: f64 = 1.01;
    let sw = robot.swerve();
    let s = &t.samples;
    for k in 0..s.len() - 1 {
        let (a, b) = (&s[k], &s[k + 1]);
        let h = b.t - a.t;
        let ex = b.x - (a.x + a.vx * h + 0.5 * a.ax * h * h);
        let ey = b.y - (a.y + a.vy * h + 0.5 * a.ay * h * h);
        let ev = (b.vx - (a.vx + a.ax * h)).hypot(b.vy - (a.vy + a.ay * h));
        let ew = b.omega - (a.omega + a.alpha * h);
        if ex.hypot(ey) > POS_TOL || ev > VEL_TOL || ew.abs() > VEL_TOL * 3.0 {
            return Err(format!("dynamics broken between t = {:.3} and {:.3}", a.t, b.t));
        }
    }
    // The samples at the waypoints, through the times stage 2 recorded (or
    // the nearest sample when it did not).
    let at = |i: usize| -> &Sample {
        match t.waypoint_times.get(i) {
            Some(&wt) => s.iter().min_by(|a, b| (a.t - wt).abs().total_cmp(&(b.t - wt).abs())).unwrap(),
            None => &s[0],
        }
    };
    let n = spec.waypoints.len();
    for (i, w) in spec.waypoints.iter().enumerate() {
        if matches!(w.kind(), WaypointKind::Empty | WaypointKind::Unknown) {
            continue;
        }
        let d = s.iter().map(|q| (q.x - w.x).hypot(q.y - w.y)).fold(f64::INFINITY, f64::min);
        if d > POS_TOL {
            return Err(format!("misses waypoint {} by {d:.3} m", i + 1));
        }
    }
    let cos_tol = |deg: f64| deg.to_radians().cos();
    for c in spec.scoped.iter().filter(|c| c.enabled) {
        let (a, b) = c.range(n);
        let (ta, tb) = (at(a).t, at(b).t);
        let span = s.iter().filter(|q| q.t >= ta - 1e-9 && q.t <= tb + 1e-9);
        for q in span {
            let ok = match c.kind {
                ConstraintKind::StopPoint { .. } => q.vx.hypot(q.vy) <= VEL_TOL && q.omega.abs() <= VEL_TOL * 3.0,
                ConstraintKind::MaxVelocity { mps } => q.vx.hypot(q.vy) <= mps * LIMIT_TOL,
                ConstraintKind::MaxAcceleration { mps2 } => q.ax.hypot(q.ay) <= mps2 * LIMIT_TOL,
                ConstraintKind::MaxAngularVelocity { dps } => q.omega.abs() <= dps.to_radians() * LIMIT_TOL,
                ConstraintKind::PointAt { x, y, tolerance_deg, flip, offset_deg } => {
                    let (dx, dy) = (x - q.x, y - q.y);
                    let facing = q.heading + ares_core::path::facing_offset_rad(flip, offset_deg);
                    let dist = dx.hypot(dy);
                    dist < 1e-3 || facing.cos() * dx + facing.sin() * dy >= cos_tol(tolerance_deg) * dist - 1e-3
                }
                _ => true,
            };
            if !ok {
                return Err(format!("breaks a {} constraint at t = {:.3}", constraint_name(&c.kind), q.t));
            }
        }
    }
    let floor = MIN_LOAD_FRACTION * robot.mass_kg * GRAVITY / sw.modules.len() as f64;
    let vmax = robot.max_module_speed();
    for q in s {
        for m in &q.modules {
            if m.grip_used > LIMIT_TOL {
                return Err(format!("asks a wheel for {:.0}% of its grip at t = {:.3}", 100.0 * m.grip_used, q.t));
            }
            if sw.drive_current_limit_a > 0.0 && m.current_a.abs() > sw.drive_current_limit_a * LIMIT_TOL {
                return Err(format!("draws {:.0} A at t = {:.3}", m.current_a.abs(), q.t));
            }
            if m.speed_mps > vmax * LIMIT_TOL {
                return Err(format!("spins a wheel past free speed at t = {:.3}", q.t));
            }
            if robot.cog_height_m.is_some_and(|h| h > 0.0) && m.load_n < floor * 0.98 {
                return Err(format!("nearly lifts a wheel at t = {:.3}", q.t));
            }
        }
        let (c, sn) = (q.heading.cos(), q.heading.sin());
        let (hl, hw) = (robot.bumper.length_m / 2.0, robot.bumper.width_m / 2.0);
        if let Some(f) = env.field {
            for (bx, by) in [(hl, hw), (hl, -hw), (-hl, hw), (-hl, -hw)] {
                let (x, y) = (q.x + c * bx - sn * by, q.y + sn * bx + c * by);
                if x < -POS_TOL || y < -POS_TOL || x > f.length_m + POS_TOL || y > f.width_m + POS_TOL {
                    return Err(format!("the bumper leaves the field at t = {:.3}", q.t));
                }
            }
        }
        for z in &env.slow_zones {
            if z.shape.contains(q.x, q.y) {
                if z.max_velocity_mps.is_some_and(|v| q.vx.hypot(q.vy) > v * LIMIT_TOL) {
                    return Err(format!("goes too fast through a slow zone at t = {:.3}", q.t));
                }
            }
        }
        let qr = 0.25 * robot.bumper.length_m.hypot(robot.bumper.width_m);
        for o in &env.keep_out {
            for (bx, by) in [(0.5 * hl, 0.5 * hw), (0.5 * hl, -0.5 * hw), (-0.5 * hl, 0.5 * hw), (-0.5 * hl, -0.5 * hw)] {
                let (x, y) = (q.x + c * bx - sn * by, q.y + sn * bx + c * by);
                if (x - o.x).hypot(y - o.y) < o.radius_m + qr - POS_TOL {
                    return Err(format!("enters a keep-out at t = {:.3}", q.t));
                }
            }
        }
    }
    Ok(())
}

fn constraint_name(k: &ConstraintKind) -> &'static str {
    match k {
        ConstraintKind::StopPoint { .. } => "stop point",
        ConstraintKind::MaxVelocity { .. } => "max velocity",
        ConstraintKind::MaxAcceleration { .. } => "max acceleration",
        ConstraintKind::MaxAngularVelocity { .. } => "max angular velocity",
        ConstraintKind::PointAt { .. } => "point-at",
        ConstraintKind::KeepInCircle { .. } => "keep-in circle",
        ConstraintKind::KeepInRectangle { .. } => "keep-in rectangle",
        ConstraintKind::KeepInLane { .. } => "keep-in lane",
        ConstraintKind::KeepOutCircle { .. } => "keep-out circle",
        ConstraintKind::SeeTags { .. } => "see AprilTags",
    }
}
