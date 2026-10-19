//! Ares' own time-optimal solver.
//!
//! Given the geometric path, it finds the fastest way to follow it that every
//! wheel and every motor can actually deliver. It is a time-optimal path
//! parameterization (the reachability formulation of TOPP): along the path the
//! state is just `s` and `ṡ`, and at each point the robot's physics turns into
//! bounds on `s̈` for a given `ṡ`.
//!
//! What it models, per module, at every point:
//!
//! - **Grip.** The force the wheel puts on the carpet, `|f_i| <= μ·N_i`.
//!   Translation, rotation and the centripetal force of a curve all draw from
//!   the same budget, which is what a swerve's wheels really have. With the
//!   center of mass height, `N_i` moves between wheels as the robot
//!   accelerates, and no wheel is planned below `MIN_LOAD_FRACTION` of its
//!   share of the weight, well clear of tipping.
//! - **The motor.** Along the wheel, the force cannot exceed what the drive
//!   motor gives at that speed with its current limit: lots at low speed,
//!   fading to nothing at free speed (back-EMF), and stronger braking than
//!   driving.
//! - **The chassis.** The wrench `(F, τ) = (m·a, I·α)` is split between the
//!   modules with the least-squares distribution, which for a symmetric swerve
//!   is the exact one.
//!
//! PathPlanner applies one maximum acceleration and one maximum velocity to the
//! whole robot; Choreo models torque but not current limits nor back-EMF.
//! Neither knows that a turn and a sprint compete for the same grip.
//!
//! The algorithm, on a uniform grid in `s`, with `x = ṡ²`:
//!
//! 1. For each point, the most `x` it can carry at all (the maximum velocity
//!    curve), by bisection on the feasibility of the `s̈` interval.
//! 2. A backward pass from the end at rest: the most `x` from which the robot
//!    can still brake in time for everything ahead.
//! 3. A forward pass from the start at rest: accelerate as hard as possible,
//!    never above the backward curve.
//!
//! Time comes from `dt = 2·Δs / (ṡ_k + ṡ_{k+1})`.

use crate::error::AresError;
use crate::geometry::{wrap_angle, Vec2};
use crate::motor::Motor;
use crate::path::{GeometricPath, PathPoint, PathSpec};
use crate::robot::{RobotConfig, GRAVITY, MIN_LOAD_FRACTION};
use crate::trajectory::{ModuleSample, Sample, Trajectory};

#[derive(Clone, Copy, Debug)]
pub struct SolverOptions {
    /// The grid step along the path, in meters of generalized arc length.
    /// 1 cm is far below anything that changes the result.
    pub resolution_m: f64,
}

impl Default for SolverOptions {
    fn default() -> Self {
        SolverOptions { resolution_m: 0.01 }
    }
}

struct Model {
    mass: f64,
    moi: f64,
    mu: f64,
    /// The weight on each wheel at rest.
    static_load: f64,
    /// Mass times center of mass height: 0 means no load transfer.
    mh: f64,
    /// qᵢ = S⁻¹pᵢ with S = Σ pᵢpᵢᵀ: the load on wheel i moves by
    /// −m·h·(a_robot · qᵢ) when the robot accelerates.
    load_q: Vec<Vec2>,
    modules: Vec<Vec2>,
    motor: Motor,
    motors: f64,
    current_limit: f64,
    voltage: f64,
    gear: f64,
    wheel_r: f64,
    module_free_speed: f64,
    max_v: Option<f64>,
    max_w: Option<f64>,
}

impl Model {
    fn new(robot: &RobotConfig, spec: &PathSpec) -> Self {
        let s = robot.swerve();
        let n = s.modules.len() as f64;
        Model {
            mass: robot.mass_kg,
            moi: robot.moi_kg_m2,
            mu: s.wheel_cof,
            static_load: robot.mass_kg * GRAVITY / n,
            mh: robot.mass_kg * robot.cog_height_m.unwrap_or(0.0),
            load_q: robot.load_vectors(),
            modules: s.modules.iter().map(|m| m.position()).collect(),
            motor: s.motor(),
            motors: s.drive_motors_per_module as f64,
            current_limit: s.drive_current_limit_a,
            voltage: s.battery_voltage,
            gear: s.drive_gear_ratio,
            wheel_r: s.wheel_radius_m,
            module_free_speed: robot.max_module_speed(),
            max_v: spec.constraints.max_velocity_mps,
            max_w: spec.constraints.max_angular_velocity_dps.map(f64::to_radians),
        }
    }

    /// The most force along the wheel the drive can give at `speed`.
    fn drive_force(&self, speed: f64, driving: bool) -> f64 {
        let omega = speed / self.wheel_r * self.gear;
        self.motors * self.motor.max_torque(omega, self.current_limit, self.voltage, driving) * self.gear
            / self.wheel_r
    }

    /// The current one drive motor draws to push `force` along the wheel.
    fn current_for(&self, force: f64) -> f64 {
        force * self.wheel_r / (self.gear * self.motors * self.motor.kt())
    }
}

/// One point of the path, linearized: module `i` pushes `a[i]·s̈ + b[i]·ṡ²`
/// on the carpet, carries `n0 + na[i]·s̈ + nb[i]·ṡ²` of weight and moves at
/// `c[i]·ṡ`.
struct Point {
    a: Vec<Vec2>,
    b: Vec<Vec2>,
    c: Vec<Vec2>,
    na: Vec<f64>,
    nb: Vec<f64>,
    /// The most `ṡ²` the velocity limits allow, before any force is considered.
    x_cap: f64,
    /// A cap on the chassis' acceleration here (scoped MaxAcceleration),
    /// with the acceleration as `a_pos·s̈ + b_pos·ṡ²`.
    acc_cap: Option<f64>,
    a_pos: Vec2,
    b_pos: Vec2,
}

fn solve3(g: [[f64; 3]; 3], w: [f64; 3]) -> [f64; 3] {
    let det = |m: [[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d = det(g);
    let mut out = [0.0; 3];
    for (col, slot) in out.iter_mut().enumerate() {
        let mut m = g;
        for row in 0..3 {
            m[row][col] = w[row];
        }
        *slot = det(m) / d;
    }
    out
}

/// The least-squares split of a chassis wrench `(Fx, Fy, τ)` between modules
/// at `r` (field frame, from the center).
fn distribute(r: &[Vec2], w: [f64; 3]) -> Vec<Vec2> {
    let n = r.len() as f64;
    let g02: f64 = r.iter().map(|p| -p.y).sum();
    let g12: f64 = r.iter().map(|p| p.x).sum();
    let g22: f64 = r.iter().map(|p| p.norm2()).sum();
    let l = solve3([[n, 0.0, g02], [0.0, n, g12], [g02, g12, g22]], w);
    r.iter().map(|p| Vec2::new(l[0] - p.y * l[2], l[1] + p.x * l[2])).collect()
}

fn linearize(model: &Model, p: &PathPoint) -> Point {
    let r: Vec<Vec2> = model.modules.iter().map(|m| m.rotate(p.theta)).collect();
    let c: Vec<Vec2> = r.iter().map(|ri| p.d_pos + ri.perp() * p.d_theta).collect();
    let a = distribute(&r, [model.mass * p.d_pos.x, model.mass * p.d_pos.y, model.moi * p.d_theta]);
    let b = distribute(&r, [model.mass * p.dd_pos.x, model.mass * p.dd_pos.y, model.moi * p.dd_theta]);
    let q: Vec<Vec2> = model.load_q.iter().map(|q| q.rotate(p.theta)).collect();
    let na = q.iter().map(|q| -model.mh * p.d_pos.dot(*q)).collect();
    let nb = q.iter().map(|q| -model.mh * p.dd_pos.dot(*q)).collect();

    let mut x_cap = f64::INFINITY;
    for ci in &c {
        let n2 = ci.norm2();
        if n2 > 1e-12 {
            x_cap = x_cap.min(model.module_free_speed.powi(2) / n2);
        }
    }
    if let Some(v) = model.max_v {
        let n2 = p.d_pos.norm2();
        if n2 > 1e-12 {
            x_cap = x_cap.min(v * v / n2);
        }
    }
    if let Some(w) = model.max_w {
        let n2 = p.d_theta * p.d_theta;
        if n2 > 1e-12 {
            x_cap = x_cap.min(w * w / n2);
        }
    }
    if !x_cap.is_finite() {
        x_cap = 1e6;
    }
    Point { a, b, c, na, nb, x_cap, acc_cap: None, a_pos: p.d_pos, b_pos: p.dd_pos }
}

/// `[lo, hi]` intersected with `|A·s + B| <= radius`, or None if empty.
fn clip_disc(lo: &mut f64, hi: &mut f64, a: Vec2, b: Vec2, radius: f64) -> bool {
    let qa = a.norm2();
    let qb = 2.0 * a.dot(b);
    let qc = b.norm2() - radius * radius;
    if qa < 1e-12 {
        // s̈ does not reach this wheel: the constraint holds for every s̈ or none.
        return qc <= 1e-9 * (1.0 + radius * radius);
    }
    let disc = qb * qb - 4.0 * qa * qc;
    if disc < 0.0 {
        return false;
    }
    let root = disc.sqrt();
    *lo = lo.max((-qb - root) / (2.0 * qa));
    *hi = hi.min((-qb + root) / (2.0 * qa));
    true
}

/// `[lo, hi]` intersected with the cone `|A·s + B| <= C·s + D` and the floor
/// `C·s + D >= floor`: the grip of a wheel whose load depends on `s̈`, and the
/// least load it may carry. The set is convex, so an interval.
fn clip_cone(lo: &mut f64, hi: &mut f64, a: Vec2, b: Vec2, c: f64, d: f64, floor: f64) -> bool {
    if c.abs() < 1e-12 {
        return d >= floor && clip_disc(lo, hi, a, b, d);
    }
    if !clip_linear(lo, hi, c, d, floor, f64::INFINITY) {
        return false;
    }
    let qa = a.norm2() - c * c;
    let qb = 2.0 * (a.dot(b) - c * d);
    let qc = b.norm2() - d * d;
    if qa.abs() < 1e-12 {
        // qb·s + qc <= 0
        return clip_linear(lo, hi, qb, qc, f64::NEG_INFINITY, 0.0);
    }
    let disc = qb * qb - 4.0 * qa * qc;
    if qa > 0.0 {
        if disc < 0.0 {
            return false;
        }
        let root = disc.sqrt();
        *lo = lo.max((-qb - root) / (2.0 * qa));
        *hi = hi.min((-qb + root) / (2.0 * qa));
        return true;
    }
    // qa < 0: the load grows faster than the force; the feasible branch is the
    // one where the load is positive.
    if disc < 0.0 {
        return true;
    }
    let root = disc.sqrt();
    let (r1, r2) = ((-qb + root) / (2.0 * qa), (-qb - root) / (2.0 * qa));
    let (r_lo, r_hi) = (r1.min(r2), r1.max(r2));
    if c > 0.0 {
        *lo = lo.max(r_hi);
    } else {
        *hi = hi.min(r_lo);
    }
    true
}

/// `[lo, hi]` intersected with `min <= p·s + q <= max`.
fn clip_linear(lo: &mut f64, hi: &mut f64, p: f64, q: f64, min: f64, max: f64) -> bool {
    if p.abs() < 1e-12 {
        let tol = 1e-9 * (1.0 + max.abs() + min.abs());
        return q >= min - tol && q <= max + tol;
    }
    let (e0, e1) = ((min - q) / p, (max - q) / p);
    *lo = lo.max(e0.min(e1));
    *hi = hi.min(e0.max(e1));
    true
}

/// The `s̈` the robot can do at this point with `ṡ² = x`, or None if it cannot
/// be there at that speed at all.
fn interval(model: &Model, pt: &Point, x: f64) -> Option<(f64, f64)> {
    let x = x.max(0.0);
    let sd = x.sqrt();
    let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
    for i in 0..pt.a.len() {
        let (a, b) = (pt.a[i], pt.b[i] * x);
        let (c, d) = (model.mu * pt.na[i], model.mu * (model.static_load + pt.nb[i] * x));
        if !clip_cone(&mut lo, &mut hi, a, b, c, d, model.mu * model.static_load * MIN_LOAD_FRACTION) {
            return None;
        }
        let cn = pt.c[i].norm();
        let speed = cn * sd;
        if cn > 1e-9 {
            let u = pt.c[i] * (1.0 / cn);
            let (f_drive, f_brake) = (model.drive_force(speed, true), model.drive_force(speed, false));
            if !clip_linear(&mut lo, &mut hi, u.dot(a), u.dot(b), -f_brake, f_drive) {
                return None;
            }
        } else if !clip_disc(&mut lo, &mut hi, a, b, model.drive_force(0.0, true)) {
            return None;
        }
    }
    if let Some(cap) = pt.acc_cap {
        if !clip_disc(&mut lo, &mut hi, pt.a_pos, pt.b_pos * x, cap) {
            return None;
        }
    }
    let tol = 1e-9 * (1.0 + lo.abs().min(1e9) + hi.abs().min(1e9));
    (lo <= hi + tol).then_some((lo, hi.max(lo)))
}

/// The most `ṡ²` this point can carry.
fn max_velocity_curve(model: &Model, pt: &Point) -> f64 {
    if interval(model, pt, pt.x_cap).is_some() {
        return pt.x_cap;
    }
    let (mut lo, mut hi) = (0.0, pt.x_cap);
    for _ in 0..60 {
        let mid = 0.5 * (lo + hi);
        if interval(model, pt, mid).is_some() {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

pub fn solve(robot: &RobotConfig, spec: &PathSpec, options: &SolverOptions) -> Result<Trajectory, AresError> {
    solve_between(robot, spec, options, 0.0, 0.0)
}

/// `solve`, starting at `v_start` and ending at `v_end` m/s along the path
/// instead of at rest (capped by what the robot can do there).
pub fn solve_between(
    robot: &RobotConfig,
    spec: &PathSpec,
    options: &SolverOptions,
    v_start: f64,
    v_end: f64,
) -> Result<Trajectory, AresError> {
    robot.validate()?;
    for (name, v) in [
        ("maxVelocityMps", spec.constraints.max_velocity_mps),
        ("maxAngularVelocityDps", spec.constraints.max_angular_velocity_dps),
    ] {
        if let Some(v) = v {
            if !(v.is_finite() && v > 0.0) {
                return Err(AresError::Path(format!("{name} has to be positive, it is {v}")));
            }
        }
    }

    let path = GeometricPath::build(spec, robot.drive_radius(), options.resolution_m)?;
    let model = Model::new(robot, spec);
    let mut pts: Vec<Point> = path.points.iter().map(|p| linearize(&model, p)).collect();
    apply_scoped(spec, &path, &mut pts);
    let n = pts.len() - 1;
    let ds = path.ds;
    let mvc: Vec<f64> = pts.iter().map(|p| max_velocity_curve(&model, p)).collect();
    let lower = |k: usize, x: f64| interval(&model, &pts[k], x.min(mvc[k])).map_or(0.0, |iv| iv.0);

    // Backward: from rest at the end, the fastest the robot can be at each
    // point and still brake for everything ahead. The step is implicit in x_k,
    // so it is iterated to a fixed point; it converges in two or three.
    let mut beta = vec![0.0_f64; n + 1];
    let speed2 = |v: f64, k: usize| {
        let d = path.points[k].d_pos.norm2();
        if d > 1e-12 { v * v / d } else { 0.0 }
    };
    beta[n] = speed2(v_end, n).min(mvc[n]);
    for k in (0..n).rev() {
        let mut xk = mvc[k].min(beta[k + 1]);
        for _ in 0..4 {
            xk = mvc[k].min(beta[k + 1] - 2.0 * ds * lower(k, xk)).max(0.0);
        }
        beta[k] = xk;
    }

    // Forward: from rest, as hard as the robot can, never above `beta`.
    let mut alpha = vec![0.0_f64; n + 1];
    alpha[0] = speed2(v_start, 0).min(mvc[0]).min(beta[0]);
    for k in 0..n {
        let x = alpha[k].min(mvc[k]);
        let Some((_, hi)) = interval(&model, &pts[k], x) else {
            return Err(AresError::Infeasible {
                s_m: path.points[k].s,
                reason: "the wheels cannot hold the path here at any speed".into(),
            });
        };
        alpha[k + 1] = beta[k + 1].min(x + 2.0 * ds * hi).max(0.0);
        // Zero speed is only allowed where a stop point asks for it.
        if k + 1 < n && alpha[k + 1] <= 1e-12 && pts[k + 1].x_cap > 0.0 {
            return Err(AresError::Infeasible {
                s_m: path.points[k + 1].s,
                reason: "the robot stalls: no grip or torque is left to keep moving".into(),
            });
        }
    }

    let mut times = vec![0.0; n + 1];
    for k in 0..n {
        let v = alpha[k].sqrt() + alpha[k + 1].sqrt();
        times[k + 1] = times[k] + if v > 0.0 { 2.0 * ds / v } else { 0.0 };
    }

    let samples = (0..=n)
        .map(|k| {
            let j = k.min(n - 1);
            let sdd = (alpha[j + 1] - alpha[j]) / (2.0 * ds);
            let x = alpha[k];
            let sd = x.sqrt();
            let (p, pt) = (&path.points[k], &pts[k]);
            let vel = p.d_pos * sd;
            let acc = p.d_pos * sdd + p.dd_pos * x;
            let modules = (0..pt.a.len())
                .map(|i| {
                    let v = pt.c[i] * sd;
                    let f = pt.a[i] * sdd + pt.b[i] * x;
                    let speed = v.norm();
                    let dir = if speed > 1e-6 { v * (1.0 / speed) } else { pt.c[i].normalized() };
                    let along = if dir == Vec2::ZERO { f.norm() } else { f.dot(dir) };
                    let load = model.static_load + pt.na[i] * sdd + pt.nb[i] * x;
                    ModuleSample {
                        speed_mps: speed,
                        angle_rad: if dir == Vec2::ZERO { 0.0 } else { wrap_angle(dir.y.atan2(dir.x) - p.theta) },
                        force_n: f.norm(),
                        fx_n: f.x,
                        fy_n: f.y,
                        grip_used: f.norm() / (model.mu * load.max(1e-9)),
                        load_n: load,
                        current_a: model.current_for(along),
                    }
                })
                .collect();
            Sample {
                t: times[k],
                x: p.pos.x,
                y: p.pos.y,
                heading: p.theta,
                vx: vel.x,
                vy: vel.y,
                omega: p.d_theta * sd,
                ax: acc.x,
                ay: acc.y,
                alpha: p.d_theta * sdd + p.dd_theta * x,
                modules,
            }
        })
        .collect();

    Ok(Trajectory {
        name: spec.name.clone(),
        robot: robot.name.clone(),
        duration_s: times[n],
        waypoint_times: path.waypoint_s.iter().map(|ws| times[((ws / ds).round() as usize).min(n)]).collect(),
        splits: vec![],
        events: vec![],
        pathfind: vec![],
        start: Default::default(),
        continues_from: None,
        sections: vec![],
        variant: None,
        source_hash: None,
        notes: Vec::new(),
        samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::Waypoint;
    use crate::robot::tests::offseason2026;

    fn wp(x: f64, y: f64, h: Option<f64>) -> Waypoint {
        Waypoint { x, y, heading_deg: h, ..Default::default() }
    }

    fn spec(w: Vec<Waypoint>) -> PathSpec {
        PathSpec::new("test", w)
    }

    fn run(robot: &RobotConfig, s: &PathSpec) -> Trajectory {
        solve(robot, s, &SolverOptions::default()).unwrap()
    }

    /// Nothing the solver returns may ask more of a wheel or a motor than it has.
    fn assert_physical(robot: &RobotConfig, t: &Trajectory) {
        let limit = robot.swerve().drive_current_limit_a;
        for s in &t.samples {
            for m in &s.modules {
                assert!(m.grip_used <= 1.03, "grip {:.3} at t = {:.3}", m.grip_used, s.t);
                assert!(m.current_a.abs() <= limit * 1.03, "{:.1} A at t = {:.3}", m.current_a, s.t);
                assert!(m.speed_mps <= robot.max_module_speed() * 1.001);
            }
        }
    }

    #[test]
    fn a_straight_sprint_is_grip_limited_and_starts_and_ends_at_rest() {
        let robot = offseason2026();
        let t = run(&robot, &spec(vec![wp(0.0, 0.0, None), wp(4.0, 0.0, None)]));
        let (first, last) = (&t.samples[0], t.samples.last().unwrap());
        assert!(first.vx.abs() < 1e-9 && last.vx.abs() < 1e-6);
        assert!((last.x - 4.0).abs() < 1e-6);
        // The bang-bang bound at full grip is 2·sqrt(d / μg). The motor fades
        // near the top, so a bit more, but not much.
        let bound = 2.0 * (4.0 / (0.9 * GRAVITY)).sqrt();
        assert!(t.duration_s >= bound - 0.01 && t.duration_s <= bound * 1.15, "{} vs {bound}", t.duration_s);
        assert_physical(&robot, &t);
    }

    #[test]
    fn a_curve_never_asks_for_more_than_the_grip() {
        let robot = offseason2026();
        let t = run(
            &robot,
            &spec(vec![wp(0.0, 0.0, None), wp(2.0, 0.5, None), wp(3.0, 2.0, None), wp(2.0, 4.0, None)]),
        );
        let mu_g = 0.9 * GRAVITY;
        for s in &t.samples {
            assert!(s.ax.hypot(s.ay) <= mu_g * 1.03, "{} m/s² at t = {}", s.ax.hypot(s.ay), s.t);
        }
        assert_physical(&robot, &t);
    }

    #[test]
    fn turning_in_place_is_a_trajectory_like_any_other() {
        let robot = offseason2026();
        let t = run(&robot, &spec(vec![wp(2.0, 2.0, Some(0.0)), wp(2.0, 2.0, Some(180.0))]));
        let last = t.samples.last().unwrap();
        assert!((last.heading - std::f64::consts::PI).abs() < 1e-6);
        assert!(t.samples.iter().all(|s| (s.x - 2.0).abs() < 1e-9 && (s.y - 2.0).abs() < 1e-9));
        assert!(t.duration_s > 0.1 && t.duration_s < 2.0, "{}", t.duration_s);
        assert_physical(&robot, &t);
    }

    #[test]
    fn rotating_while_driving_costs_time() {
        let robot = offseason2026();
        let straight = run(&robot, &spec(vec![wp(0.0, 0.0, Some(0.0)), wp(4.0, 0.0, Some(0.0))]));
        let spinning = run(&robot, &spec(vec![wp(0.0, 0.0, Some(0.0)), wp(4.0, 0.0, Some(180.0))]));
        assert!(spinning.duration_s > straight.duration_s);
        assert_physical(&robot, &spinning);
    }

    #[test]
    fn the_velocity_cap_is_respected() {
        let robot = offseason2026();
        let mut s = spec(vec![wp(0.0, 0.0, None), wp(6.0, 0.0, None)]);
        s.constraints.max_velocity_mps = Some(2.0);
        let t = run(&robot, &s);
        assert!(t.max_speed() <= 2.0 * 1.001, "{}", t.max_speed());
    }

    #[test]
    fn a_lower_current_limit_is_slower() {
        let fast = offseason2026();
        let mut slow = offseason2026();
        slow.swerve_mut().drive_current_limit_a = 30.0;
        let s = spec(vec![wp(0.0, 0.0, None), wp(4.0, 0.0, None)]);
        let (tf, ts) = (run(&fast, &s), run(&slow, &s));
        assert!(ts.duration_s > tf.duration_s * 1.1, "{} vs {}", ts.duration_s, tf.duration_s);
        assert_physical(&slow, &ts);
    }

    #[test]
    fn a_high_center_of_mass_moves_load_backward_and_never_tips() {
        let low = offseason2026();
        let mut high = offseason2026();
        high.cog_height_m = Some(0.6);
        let s = spec(vec![wp(0.0, 0.0, Some(0.0)), wp(4.0, 0.0, Some(0.0))]);
        let (tl, th) = (run(&low, &s), run(&high, &s));
        assert!(th.duration_s > tl.duration_s, "{} vs {}", th.duration_s, tl.duration_s);
        let launch = &th.samples[1];
        // Accelerating forward: the rear wheels (bl, br) carry more.
        assert!(launch.modules[2].load_n > launch.modules[0].load_n);
        for smp in &th.samples {
            let floor = crate::robot::MIN_LOAD_FRACTION * high.mass_kg * GRAVITY / 4.0;
            assert!(smp.modules.iter().all(|m| m.load_n >= floor * 0.99), "a wheel within the tipping margin");
            let total: f64 = smp.modules.iter().map(|m| m.load_n).sum();
            assert!((total - high.mass_kg * GRAVITY).abs() < 1e-6 * total);
        }
        assert_physical(&high, &th);
    }

    #[test]
    fn scoped_caps_and_an_intermediate_stop() {
        use crate::path::{ConstraintKind, ScopedConstraint, Target};
        let robot = offseason2026();
        let mut s = spec(vec![wp(0.0, 0.0, Some(0.0)), wp(4.0, 0.0, None), wp(8.0, 0.0, Some(0.0))]);
        s.scoped.push(ScopedConstraint { from: Target::Index(1), to: None, enabled: true, kind: ConstraintKind::StopPoint { wait_s: 0.0 }, exprs: Default::default() });
        s.scoped.push(ScopedConstraint {
            from: Target::Index(1), to: Some(Target::Last), enabled: true, kind: ConstraintKind::MaxVelocity { mps: 1.5 },
       exprs: Default::default() });
        let t = run(&robot, &s);
        let mid = t.samples.iter().min_by(|a, b| (a.x - 4.0).abs().total_cmp(&(b.x - 4.0).abs())).unwrap();
        assert!(mid.vx.abs() < 1e-6, "{}", mid.vx);
        assert!(t.samples.iter().filter(|q| q.x > 4.01).all(|q| q.vx.abs() <= 1.5 * 1.001));
        assert!(t.samples.iter().filter(|q| q.x < 3.5).any(|q| q.vx > 2.0), "the cap leaked into the first half");
    }

    #[test]
    fn same_input_same_trajectory() {
        let robot = offseason2026();
        let s = spec(vec![wp(0.0, 0.0, Some(0.0)), wp(3.0, 1.0, Some(45.0)), wp(5.0, 3.0, None)]);
        assert_eq!(run(&robot, &s), run(&robot, &s));
    }

    #[test]
    fn the_distribution_is_exact_for_a_square_swerve() {
        let p = 0.3;
        let r = [Vec2::new(p, p), Vec2::new(p, -p), Vec2::new(-p, p), Vec2::new(-p, -p)];
        let f = distribute(&r, [4.0, -8.0, 2.0]);
        let sum = f.iter().fold(Vec2::ZERO, |acc, v| acc + *v);
        let torque: f64 = r.iter().zip(&f).map(|(ri, fi)| ri.x * fi.y - ri.y * fi.x).sum();
        assert!((sum.x - 4.0).abs() < 1e-9 && (sum.y + 8.0).abs() < 1e-9 && (torque - 2.0).abs() < 1e-9);
    }
}

/// The scoped constraints stage 1 can honor along the spline: speed, turn
/// rate and acceleration caps over their range, and stops at intermediate
/// waypoints. The rest (point-at, keep-in, lanes) only the optimizer sees;
/// stage 1 is its starting guess.
fn apply_scoped(spec: &PathSpec, path: &GeometricPath, pts: &mut [Point]) {
    use crate::path::ConstraintKind as K;
    let n = spec.waypoints.len();
    let last = pts.len() - 1;
    let index_of = |s: f64| ((s / path.ds).round() as usize).min(last);
    for c in spec.scoped.iter().filter(|c| c.enabled) {
        let (a, b) = c.range(n);
        let (ka, kb) = (index_of(path.waypoint_s[a]), index_of(path.waypoint_s[b]));
        for k in ka..=kb {
            let (p, pt) = (&path.points[k], &mut pts[k]);
            match c.kind {
                K::StopPoint { .. } => pt.x_cap = 0.0,
                K::MaxVelocity { mps } if p.d_pos.norm2() > 1e-12 => pt.x_cap = pt.x_cap.min(mps * mps / p.d_pos.norm2()),
                K::MaxAngularVelocity { dps } if p.d_theta.abs() > 1e-9 => {
                    let w = dps.to_radians();
                    pt.x_cap = pt.x_cap.min(w * w / (p.d_theta * p.d_theta));
                }
                K::MaxAcceleration { mps2 } => pt.acc_cap = Some(pt.acc_cap.map_or(mps2, |c| c.min(mps2))),
                _ => {}
            }
        }
    }
}
