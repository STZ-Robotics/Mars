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
use ares_core::path::GeometricPath;
use ares_core::robot::GRAVITY;
use ares_core::trajectory::{ModuleSample, Sample};
use ares_core::{AresError, PathSpec, RobotConfig, SolverOptions, Trajectory};
use serde::{Deserialize, Serialize};

mod ffi;

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

pub fn plan(
    robot: &RobotConfig,
    spec: &PathSpec,
    env: &Environment,
    options: &PlannerOptions,
) -> Result<Planned, PlanError> {
    let started = Instant::now();

    // Stage 1: the spline, timed.
    let core_options = SolverOptions::default();
    let warm = ares_core::solve(robot, spec, &core_options)?;
    let path = GeometricPath::build(spec, robot.drive_radius(), core_options.resolution_m)?;
    let wp_time: Vec<f64> = path
        .waypoint_s
        .iter()
        .map(|s| warm.samples[((s / path.ds).round() as usize).min(warm.samples.len() - 1)].t)
        .collect();

    // Sampling: each segment gets intervals at about target_dt.
    let segments = spec.waypoints.len() - 1;
    let mut intervals = Vec::with_capacity(segments);
    let mut guess_dt = Vec::with_capacity(segments);
    let mut times = vec![0.0];
    for j in 0..segments {
        let span = (wp_time[j + 1] - wp_time[j]).max(0.05);
        let n = ((span / options.target_dt_s).ceil() as i32).max(3);
        intervals.push(n);
        guess_dt.push(span / n as f64);
        for i in 1..=n {
            times.push(wp_time[j] + (wp_time[j + 1] - wp_time[j]) * i as f64 / n as f64);
        }
    }
    let mut guess: Vec<Sample> = times.iter().map(|&t| warm.sample_at(t)).collect();
    push_out_of_keep_outs(&mut guess, robot, env);
    let col = |f: fn(&Sample) -> f64| guess.iter().map(f).collect::<Vec<f64>>();
    let (gx, gy, gth) = (col(|s| s.x), col(|s| s.y), col(|s| s.heading));
    let (gvx, gvy, gw) = (col(|s| s.vx), col(|s| s.vy), col(|s| s.omega));
    let (gax, gay, gal) = (col(|s| s.ax), col(|s| s.ay), col(|s| s.alpha));

    // Waypoints: every one fixes the position; a given heading fixes it too;
    // the ends are at rest.
    let last = spec.waypoints.len() - 1;
    let mut wp_flags = Vec::new();
    let mut wp_values = Vec::new();
    for (j, w) in spec.waypoints.iter().enumerate() {
        let mut f = ffi::WP_POSITION;
        // Unspecified headings at the ends would leave the start free to spin
        // the robot in place; the spline's heading is what the user sees.
        let heading = match w.heading_deg {
            Some(h) => Some(h.to_radians()),
            None if j == 0 || j == last => Some(guess[if j == 0 { 0 } else { guess.len() - 1 }].heading),
            None => None,
        };
        if heading.is_some() {
            f |= ffi::WP_HEADING;
        }
        if j == 0 || j == last {
            f |= ffi::WP_STOP;
        }
        wp_flags.push(f);
        wp_values.extend([w.x, w.y, heading.unwrap_or(0.0)]);
    }

    let sw = robot.swerve();
    let d = drive(robot);
    let module_xy: Vec<f64> = sw.modules.iter().flat_map(|m| [m.x_m, m.y_m]).collect();
    let circles: Vec<f64> = env.keep_out.iter().flat_map(|c| [c.x, c.y, c.radius_m]).collect();
    let field = env.field.unwrap_or(FieldSize { length_m: 0.0, width_m: 0.0 });

    let problem = ffi::Problem {
        mass_kg: robot.mass_kg,
        moi_kg_m2: robot.moi_kg_m2,
        gravity: GRAVITY,
        cog_height_m: robot.cog_height_m.unwrap_or(0.0),
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
        guess: [&gx, &gy, &gth, &gvx, &gvy, &gw, &gax, &gay, &gal],
        guess_dt: &guess_dt,
        tolerance: options.tolerance,
        max_iterations: options.max_iterations as i32,
        timeout_s: options.timeout.as_secs_f64(),
    };
    let sol = ffi::solve(&problem);
    if sol.status < 0 || sol.status == 1 {
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

    Ok(Planned {
        trajectory: Trajectory { name: spec.name.clone(), robot: robot.name.clone(), duration_s: t, samples },
        spline_duration_s: warm.duration_s,
        iterations: sol.iterations.max(0) as u32,
        solve_time: started.elapsed(),
    })
}

/// Moves the warm start's positions out of the keep-out circles.
///
/// The spline knows nothing about obstacles, and an interior-point method
/// started inside one, dead on its center, has no side to prefer. Each sample
/// that is too close goes radially out (sideways from the path if it sits on
/// the center), with a smooth falloff so the guess stays a curve. Velocities
/// are left alone: the solver fixes them in a few iterations.
fn push_out_of_keep_outs(guess: &mut [Sample], robot: &RobotConfig, env: &Environment) {
    let reach = 0.5 * robot.bumper.length_m.hypot(robot.bumper.width_m);
    for c in &env.keep_out {
        let need = c.radius_m + reach + 0.05;
        // Which side to go around: the side where the path already bends, or
        // left of travel if it goes straight through.
        let mut side = 0.0;
        for s in guess.iter() {
            let d = Vec2::new(s.x - c.x, s.y - c.y);
            let v = Vec2::new(s.vx, s.vy);
            side += v.x * d.y - v.y * d.x;
        }
        let side = if side >= 0.0 { 1.0 } else { -1.0 };
        let n = guess.len();
        for k in 1..n - 1 {
            let s = &mut guess[k];
            let d = Vec2::new(s.x - c.x, s.y - c.y);
            let dist = d.norm();
            if dist >= need {
                continue;
            }
            let dir = if dist > 1e-6 && (d.x * s.vy - d.y * s.vx).abs() > 1e-6 * dist {
                d * (1.0 / dist)
            } else {
                let v = Vec2::new(s.vx, s.vy).normalized();
                let left = if v == Vec2::ZERO { Vec2::new(0.0, 1.0) } else { v.perp() };
                left * side
            };
            let target = Vec2::new(c.x, c.y) + dir * need;
            s.x = target.x;
            s.y = target.y;
        }
    }
}
