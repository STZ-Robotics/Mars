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
use ares_core::trajectory::{ModuleSample, PathfindSpan, Sample, TimedEvent};
use ares_core::{AresError, PathSpec, RobotConfig, SolverOptions, Trajectory};
use serde::{Deserialize, Serialize};

mod ffi;
pub mod route;

/// What surrounds the robot. Shared by every path on the same field.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    /// The bumper stays inside `[0, length] x [0, width]`. None: no walls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<FieldSize>,
    #[serde(default)]
    pub keep_out: Vec<KeepOutCircle>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSize {
    pub length_m: f64,
    pub width_m: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepOutCircle {
    pub x: f64,
    pub y: f64,
    pub radius_m: f64,
}

#[derive(Clone, Debug)]
pub struct PlannerOptions {
    /// The target time between samples. Smaller is more faithful and slower
    /// to solve; 50 ms is twice Choreo's default density.
    pub target_dt_s: f64,
    pub tolerance: f64,
    pub max_iterations: u32,
    pub timeout: Duration,
}

impl Default for PlannerOptions {
    fn default() -> Self {
        PlannerOptions {
            target_dt_s: 0.05,
            tolerance: 1e-7,
            max_iterations: 3000,
            timeout: Duration::from_secs(60),
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
    /// The optimizer did not converge. The status is Sleipnir's.
    Solver { status: i32, reason: &'static str },
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Core(e) => write!(f, "{e}"),
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
pub fn plan(
    robot: &RobotConfig,
    spec: &PathSpec,
    env: &Environment,
    options: &PlannerOptions,
) -> Result<Planned, PlanError> {
    validate(spec)?;
    let n = spec.waypoints.len();
    let cuts: Vec<usize> = (0..n - 1).filter(|&j| spec.waypoints[j].pathfind_next.is_some()).collect();
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
        .map(|&(a, b)| (b > a).then(|| plan_fixed(robot, &sub_spec(spec, a, b, &cuts), env, options)).transpose())
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
                events.extend(t.events.iter().map(|e| TimedEvent { name: e.name.clone(), t: e.t + offset }));
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
            let est = pathfind_estimate(robot, spec, env, &from, &to, &opts).map_err(|e| match e {
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
    let stop = |t: Target| ScopedConstraint { from: t, to: None, enabled: true, kind: ConstraintKind::StopPoint { wait_s: 0.0 } };
    let has_stop = |s: &[ScopedConstraint], t: Target| {
        s.iter().any(|c| c.enabled && matches!(c.kind, ConstraintKind::StopPoint { .. }) && c.from == t && c.to.is_none())
    };
    if a > 0 && cuts.contains(&(a - 1)) && !has_stop(&scoped, Target::First) {
        scoped.push(stop(Target::First));
    }
    if cuts.contains(&b) && !has_stop(&scoped, Target::Last) {
        scoped.push(stop(Target::Last));
    }
    let events = spec
        .events
        .iter()
        .filter(|e| (a..=b).contains(&e.target.resolve(n)))
        .map(|e| ares_core::path::EventMarker { target: local(e.target.resolve(n)), ..e.clone() })
        .collect();
    PathSpec { name: spec.name.clone(), waypoints, constraints: spec.constraints.clone(), scoped, events }
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
) -> Result<Trajectory, PlanError> {
    use ares_core::path::{ScopedConstraint, Target, Waypoint};
    let reach = 0.5 * robot.bumper.length_m.hypot(robot.bumper.width_m);
    let free = free_space(spec, env, reach);
    let (a, b) = (Vec2::new(from.x, from.y), Vec2::new(to.x, to.y));
    let corners = route::shortest_way(&free, a, b)
        .ok_or_else(|| PlanError::Core(AresError::Path("there is no way around the keep-outs".into())))?;
    let mut waypoints = vec![Waypoint { x: a.x, y: a.y, heading_deg: Some(from.heading.to_degrees()), ..Default::default() }];
    waypoints.extend(corners.iter().map(|c| Waypoint { x: c.x, y: c.y, ..Default::default() }));
    waypoints.push(Waypoint { x: b.x, y: b.y, heading_deg: Some(to.heading.to_degrees()), ..Default::default() });
    let mut s = PathSpec::new("pathfind", waypoints);
    s.constraints.max_velocity_mps = opts.max_velocity_mps;
    s.constraints.max_angular_velocity_dps = opts.max_angular_velocity_dps;
    if let Some(a) = opts.max_acceleration_mps2 {
        s.scoped.push(ScopedConstraint {
            from: Target::First,
            to: Some(Target::Last),
            enabled: true,
            kind: ConstraintKind::MaxAcceleration { mps2: a },
        });
    }
    Ok(ares_core::solve(robot, &s, &SolverOptions::default())?)
}

fn plan_fixed(
    robot: &RobotConfig,
    spec: &PathSpec,
    env: &Environment,
    options: &PlannerOptions,
) -> Result<Planned, PlanError> {
    let started = Instant::now();
    validate(spec)?;
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
    let guess: Vec<Sample> = times.iter().map(|&t| warm.sample_at(t)).collect();
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
            WaypointKind::Translation => f |= ffi::WP_POSITION,
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
            ConstraintKind::PointAt { x, y, tolerance_deg, flip } => constraints
                .push(rec(ffi::C_POINT_AT, [x, y, tolerance_deg.to_radians(), if flip { 1.0 } else { 0.0 }, 0.0])),
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
        }
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
        constraints: &constraints,
        guess: [&gx, &gy, &gth, &gvx, &gvy, &gw, &gax, &gay, &gal],
        guess_dt: &guess_dt,
        tolerance: options.tolerance,
        max_iterations: options.max_iterations as i32,
        timeout_s: options.timeout.as_secs_f64(),
    };
    let sol = ffi::solve(&problem);
    // 1 is the stall stop and -9 the iteration cap: both leave an iterate
    // that may well be the answer, which the physics check below decides.
    let maybe_done = sol.status == 0 || sol.status == 1 || sol.status == -9;
    if !maybe_done {
        return Err(PlanError::Solver { status: sol.status, reason: status_reason(sol.status) });
    }

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
        .filter(|(i, w)| w.split && *i > 0 && *i + 1 < spec.waypoints.len())
        .map(|(i, _)| new_index[start[routed.index_of[i]]])
        .collect();
    let events = spec
        .events
        .iter()
        .map(|e| TimedEvent {
            name: e.name.clone(),
            t: (waypoint_times[e.target.resolve(spec.waypoints.len())] + e.offset_s).clamp(0.0, t),
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
    for c in spec.scoped.iter().filter(|c| c.enabled) {
        let (a, b) = c.range(n);
        match c.kind {
            ConstraintKind::StopPoint { .. } if a != b => return bad("a stop point goes on one waypoint, not a segment".into()),
            ConstraintKind::KeepInLane { .. } if a == b => return bad("a lane needs a segment, not one waypoint".into()),
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
    route::Free { obstacles, bounds }
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
        if w.kind() == WaypointKind::Empty {
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
                ConstraintKind::PointAt { x, y, tolerance_deg, flip } => {
                    let (dx, dy) = (x - q.x, y - q.y);
                    let sign = if flip { -1.0 } else { 1.0 };
                    let dist = dx.hypot(dy);
                    dist < 1e-3 || sign * (q.heading.cos() * dx + q.heading.sin() * dy) >= cos_tol(tolerance_deg) * dist - 1e-3
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
    }
}
