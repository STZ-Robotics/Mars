//! A swerve following an Ares trajectory, simulated against one world.
//!
//! Two sides, kept apart on purpose, because tuning is about the gap between
//! them:
//!
//! - **The robot code** ([`RobotCode`]): what the code on the roboRIO holds.
//!   AresLib's path controller (a PID on x, y and heading over the
//!   trajectory's speeds, with the wheel forces fed forward), and CTRE's drive
//!   loop as the Tuner X swerve runs it: `ApplyFieldSpeeds`, module targets
//!   desaturated to the speed at 12 V and optimized to turn less than 90°,
//!   then on each TalonFX at 1 kHz `kS + kV·rps + kP·error` plus the force
//!   feedforward turned into volts with the motor's *nominal* constants. It
//!   steers by its odometry, not by where the robot truly is.
//!
//! - **The world** ([`World`]): what is true. Mass, inertia, center of mass
//!   height, the carpet's grip, the battery (its voltage and internal
//!   resistance, so it sags under load), the motors (a spread on their
//!   torque), worn wheels, the drive's friction, latency, odometry noise and
//!   how far off its start the robot was placed.
//!
//! The physics runs at 1 kHz. Each wheel has a rolling speed of its own and
//! the tire pushes on the carpet with a stiff, saturating friction: up to
//! μ·N, where N moves between the wheels as the robot accelerates (the same
//! load transfer the planner uses). Past it the wheel slips, and then the
//! wheel encoders lie: the odometry the controller steers by drifts away
//! from the truth, which is how a robot with too much gain or too little grip
//! actually misses.

use ares_core::geometry::{wrap_angle, Vec2};
use ares_core::trajectory::Trajectory;
use ares_core::RobotConfig;
use serde::{Deserialize, Serialize};

pub const PHYS_DT: f64 = 0.001;
pub const CONTROL_DT: f64 = 0.02;
const STEPS_PER_CONTROL: usize = 20;
const GRAVITY: f64 = 9.81;
/// Slip speed at which the tire's friction saturates: below it the force
/// grows with the slip, above it the tire slides at μ·N.
const SLIP_SATURATION_MPS: f64 = 0.03;

/// PID gains, as WPILib's PIDController takes them.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pid {
    pub kp: f64,
    #[serde(default)]
    pub ki: f64,
    #[serde(default)]
    pub kd: f64,
}

/// What the robot code holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RobotCode {
    /// AresLib's path controller.
    pub translation: Pid,
    pub rotation: Pid,
    /// The drive TalonFX's Slot0, Voltage output, in rotor rotations per
    /// second (Tuner X's units): volts per rps of error.
    pub drive_kp: f64,
    /// Volts to break static friction.
    pub drive_ks: f64,
    /// Volts per rotor rps.
    pub drive_kv: f64,
    /// `kSpeedAt12Volts`: module speeds are scaled down to fit under it.
    pub speed_at_12v_mps: f64,
    /// The drive's stator current limit (`kSlipCurrent` in Tuner X's file).
    pub stator_limit_a: f64,
    /// The drive's supply current limit (Phoenix 6's default: 70 A).
    #[serde(default = "default_supply_limit")]
    pub supply_limit_a: f64,
    /// Feed the trajectory's wheel forces forward (AresLib). False: speeds
    /// only, what a PathPlanner robot that drops its feedforwards does.
    pub force_ff: bool,
}

impl Default for RobotCode {
    /// Offseason2026's TunerConstants, and PathPlanner's PID in its code.
    fn default() -> Self {
        RobotCode {
            translation: Pid { kp: 5.0, ki: 0.0, kd: 0.0 },
            rotation: Pid { kp: 5.0, ki: 0.0, kd: 0.0 },
            drive_kp: 0.1,
            drive_ks: 0.0,
            drive_kv: 0.124,
            speed_at_12v_mps: 5.85,
            stator_limit_a: 120.0,
            supply_limit_a: 70.0,
            force_ff: true,
        }
    }
}

fn default_supply_limit() -> f64 {
    70.0
}

/// How fast the battery's voltage follows the current drawn: a battery and
/// its wiring are not instantaneous, and a sag computed from the last
/// millisecond's current alone rings.
const BATTERY_TAU_S: f64 = 0.01;
/// The chassis and its suspension do not move load between the wheels
/// instantly: the load transfer follows the acceleration with this lag (and
/// the contact stays stable while it does).
const LOAD_TAU_S: f64 = 0.02;

/// What is true in one simulated world.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub mass_kg: f64,
    pub moi_kg_m2: f64,
    /// 0: every wheel always carries a quarter.
    pub cog_height_m: f64,
    /// The carpet's grip.
    pub mu: f64,
    /// At rest; it sags by `battery_r_ohm` times the current drawn.
    pub battery_v: f64,
    pub battery_r_ohm: f64,
    /// The wheels' true radius (the code believes the robot.json's).
    pub wheel_radius_m: f64,
    /// The motors' torque against the datasheet (1 = as rated).
    pub motor_scale: f64,
    /// Volts lost to friction in each drive (Tuner X's kDriveFrictionVoltage).
    pub drive_friction_v: f64,
    /// Each wheel's rolling inertia, as a mass at the tread (rotor and gears
    /// reflected): what makes a wheel spin up instead of sticking.
    pub wheel_mass_kg: f64,
    /// Between the robot moving and the code knowing it.
    pub latency_s: f64,
    /// Noise on the pose the code steers by, as vision would leave it.
    pub pose_noise_m: f64,
    pub heading_noise_rad: f64,
    /// Where the robot was placed against the trajectory's start.
    pub start_offset_x_m: f64,
    pub start_offset_y_m: f64,
    pub start_offset_rad: f64,
    /// The steering's time constant, and how fast it can turn at most.
    pub steer_tau_s: f64,
    pub steer_rate_radps: f64,
    /// True: the code knows the pose exactly. False: it integrates its wheel
    /// encoders and gyro, and drifts when the wheels slip.
    pub perfect_odometry: bool,
    pub seed: u64,
}

impl World {
    /// The robot as its robot.json describes it, on a nominal carpet.
    pub fn nominal(robot: &RobotConfig) -> World {
        let s = robot.swerve();
        World {
            mass_kg: robot.mass_kg,
            moi_kg_m2: robot.moi_kg_m2,
            cog_height_m: robot.cog_height_m.unwrap_or(0.0),
            mu: s.wheel_cof,
            battery_v: 12.5,
            battery_r_ohm: 0.015,
            wheel_radius_m: s.wheel_radius_m,
            motor_scale: 1.0,
            drive_friction_v: 0.2,
            wheel_mass_kg: 1.5,
            latency_s: 0.0,
            pose_noise_m: 0.0,
            heading_noise_rad: 0.0,
            start_offset_x_m: 0.0,
            start_offset_y_m: 0.0,
            start_offset_rad: 0.0,
            steer_tau_s: 0.02,
            steer_rate_radps: 24.0,
            perfect_odometry: false,
            seed: 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimOptions {
    /// Off the trajectory by more than this, the run stops: the gains are
    /// unstable (PathFollowingTuner's ABORT_ERROR_METERS).
    pub abort_m: f64,
    /// Held at the last sample after the end, before the final error.
    pub settle_s: f64,
    /// Keep the robot's true path every 0.1 s, to draw it.
    pub record: bool,
}

impl Default for SimOptions {
    fn default() -> Self {
        SimOptions { abort_m: 0.5, settle_s: 0.5, record: false }
    }
}

/// How well one run followed its trajectory.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    /// Meters equivalent, lower is better: PathFollowingTuner's
    /// rms + 0.25·max + final + 0.15·(rms heading + final heading).
    pub cost: f64,
    pub rms_pos_m: f64,
    pub max_pos_m: f64,
    pub final_pos_m: f64,
    pub rms_heading_rad: f64,
    pub final_heading_rad: f64,
    pub aborted: bool,
    /// The worst a wheel slipped (m/s between its tread and the carpet).
    pub max_slip_mps: f64,
    /// How far the odometry ended from the truth.
    pub odometry_drift_m: f64,
    /// The lowest the battery sagged to.
    pub min_bus_v: f64,
    /// x, y, heading every 0.1 s, when recorded.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub track: Vec<[f32; 3]>,
}

/// The trajectory's state at `t`, sampled as AresLib samples it: the
/// acceleration held between samples (exact for pose and speeds), the wheel
/// forces blended.
pub struct Reference {
    pub x: f64,
    pub y: f64,
    pub heading: f64,
    pub vx: f64,
    pub vy: f64,
    pub omega: f64,
    pub fx: Vec<f64>,
    pub fy: Vec<f64>,
}

pub fn sample(traj: &Trajectory, t: f64) -> Reference {
    let s = &traj.samples;
    let last = s.len() - 1;
    let at = |k: usize| {
        let q = &s[k];
        Reference {
            x: q.x, y: q.y, heading: q.heading, vx: q.vx, vy: q.vy, omega: q.omega,
            fx: q.modules.iter().map(|m| m.fx_n).collect(), fy: q.modules.iter().map(|m| m.fy_n).collect(),
        }
    };
    if t <= s[0].t {
        return at(0);
    }
    if t >= s[last].t {
        let mut r = at(last);
        // Held at rest after the end.
        r.vx = 0.0;
        r.vy = 0.0;
        r.omega = 0.0;
        return r;
    }
    let k = s.partition_point(|q| q.t <= t).saturating_sub(1).min(last - 1);
    let (a, b) = (&s[k], &s[k + 1]);
    let tau = t - a.t;
    let f = if b.t > a.t { (tau / (b.t - a.t)).clamp(0.0, 1.0) } else { 0.0 };
    let tau2 = tau * tau;
    Reference {
        x: a.x + a.vx * tau + 0.5 * a.ax * tau2,
        y: a.y + a.vy * tau + 0.5 * a.ay * tau2,
        heading: a.heading + a.omega * tau + 0.5 * a.alpha * tau2,
        vx: a.vx + a.ax * tau,
        vy: a.vy + a.ay * tau,
        omega: a.omega + a.alpha * tau,
        fx: a.modules.iter().zip(&b.modules).map(|(p, q)| p.fx_n + (q.fx_n - p.fx_n) * f).collect(),
        fy: a.modules.iter().zip(&b.modules).map(|(p, q)| p.fy_n + (q.fy_n - p.fy_n) * f).collect(),
    }
}

/// WPILib's PIDController, to the letter: error = setpoint − measurement,
/// the derivative from the previous error (0 at first, so the first call
/// kicks), the integral clamped so its term stays within ±1.
#[derive(Clone, Copy, Default)]
struct PidState {
    prev_error: f64,
    total: f64,
}

impl PidState {
    fn calculate(&mut self, g: &Pid, error: f64) -> f64 {
        let derivative = (error - self.prev_error) / CONTROL_DT;
        self.prev_error = error;
        if g.ki != 0.0 {
            self.total = (self.total + error * CONTROL_DT).clamp(-1.0 / g.ki.abs(), 1.0 / g.ki.abs());
        }
        g.kp * error + g.ki * self.total + g.kd * derivative
    }
}

/// xorshift64*: noise that is the same on every run of the same seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545F4914F6CDD1D) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn gauss(&mut self) -> f64 {
        let (u, v) = (self.next().max(1e-12), self.next());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

/// One run: the trajectory followed by `code` in `world`.
pub fn simulate(robot: &RobotConfig, traj: &Trajectory, code: &RobotCode, world: &World, opts: &SimOptions) -> RunResult {
    let sw = robot.swerve();
    let n = sw.modules.len();
    let pos: Vec<Vec2> = sw.modules.iter().map(|m| m.position()).collect();
    let q = robot.load_vectors();
    let motor = sw.motor();
    let gear = sw.drive_gear_ratio;
    let motors = sw.drive_motors_per_module.max(1) as f64;
    // The code's beliefs: the robot.json's wheel and the datasheet motor.
    let r_code = sw.wheel_radius_m;
    let (kt_nom, res_nom, kv_motor) = (motor.kt(), motor.resistance(), motor.kv());
    // The truth.
    let r_true = world.wheel_radius_m;
    let kt_true = motor.kt() * world.motor_scale;
    let m = world.mass_kg;
    let mut rng = Rng(world.seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);

    let start = sample(traj, 0.0);
    let (mut x, mut y, mut th) = (start.x + world.start_offset_x_m, start.y + world.start_offset_y_m, start.heading + world.start_offset_rad);
    // A path that continues another starts moving: as the trajectory does.
    let (mut vx, mut vy, mut w) = (start.vx, start.vy, start.omega);
    let (mut ax_r, mut ay_r) = (0.0, 0.0);
    // Wheels start where the trajectory has them.
    let mut steer: Vec<f64> = traj.samples[0].modules.iter().map(|q| q.angle_rad).collect();
    steer.resize(n, 0.0);
    let mut wheel: Vec<f64> = traj.samples[0].modules.iter().map(|q| q.speed_mps).collect();
    wheel.resize(n, 0.0);
    // The stiffest the tire may be and the explicit chassis update stay
    // stable at 1 kHz.
    let k_max = 0.2 * m / (n as f64 * PHYS_DT);
    // The odometry the code steers by.
    let (mut ox, mut oy) = (x, y);
    // The pose history, for latency.
    let lag = (world.latency_s / PHYS_DT).round() as usize;
    let mut history: std::collections::VecDeque<(f64, f64, f64)> = std::collections::VecDeque::with_capacity(lag + 2);

    let mut pids = [PidState::default(); 3];
    let mut target_angle = steer.clone();
    let mut target_rps = vec![0.0; n];
    let mut ff_volts = vec![0.0; n];
    let mut supply_a = 0.0f64;
    let mut supply_filtered = 0.0f64;

    let end = traj.duration_s;
    let total = end + opts.settle_s;
    let ticks = (total / CONTROL_DT).ceil() as usize;
    let (mut sum_pos2, mut sum_head2, mut samples) = (0.0, 0.0, 0usize);
    let mut out = RunResult { min_bus_v: world.battery_v, ..Default::default() };

    for tick in 0..=ticks {
        let t = tick as f64 * CONTROL_DT;
        let r = sample(traj, t);

        // --- How it is doing (truth against the trajectory) -------------
        let pos_err = (r.x - x).hypot(r.y - y);
        let head_err = wrap_angle(r.heading - th).abs();
        if t <= end + 1e-9 {
            sum_pos2 += pos_err * pos_err;
            sum_head2 += head_err * head_err;
            samples += 1;
            out.max_pos_m = out.max_pos_m.max(pos_err);
        }
        if opts.record && tick % 5 == 0 {
            out.track.push([x as f32, y as f32, th as f32]);
        }
        if pos_err > opts.abort_m {
            out.aborted = true;
            // Worse the earlier it went: something for a search to climb.
            out.cost = 10.0 + 5.0 * (1.0 - (t / end.max(1e-6)).min(1.0));
            out.odometry_drift_m = (ox - x).hypot(oy - y);
            return out;
        }
        if std::env::var("ARES_SIM_TRACE").is_ok() && tick % 5 == 0 {
            eprintln!("t {t:.2} ref v {:.2} true v {:.2} err {pos_err:.3} bus {:.1} supply {supply_a:.0} wheel {:?} steer {:?}",
                r.vx.hypot(r.vy), vx.hypot(vy), world.battery_v - world.battery_r_ohm * supply_filtered.max(0.0),
                wheel.iter().map(|v| (v * 100.0).round() / 100.0).collect::<Vec<_>>(), steer.iter().map(|v| (v * 100.0).round() / 100.0).collect::<Vec<_>>());
        }
        if tick == ticks {
            out.final_pos_m = pos_err;
            out.final_heading_rad = head_err;
            break;
        }

        // --- The robot code, every 20 ms ----------------------------------
        let (mx, my, mth) = {
            let (px, py, ph) = if world.perfect_odometry { (x, y, th) } else { (ox, oy, th) };
            history.push_back((px, py, ph));
            while history.len() > lag / STEPS_PER_CONTROL + 1 {
                history.pop_front();
            }
            let (hx, hy, hh) = history[0];
            (hx + world.pose_noise_m * rng.gauss(), hy + world.pose_noise_m * rng.gauss(), hh + world.heading_noise_rad * rng.gauss())
        };
        let cvx = r.vx + pids[0].calculate(&code.translation, r.x - mx);
        let cvy = r.vy + pids[1].calculate(&code.translation, r.y - my);
        let cw = r.omega + pids[2].calculate(&code.rotation, wrap_angle(r.heading - mth));
        // ApplyFieldSpeeds, blue perspective: into the robot frame by the
        // heading the code believes.
        let (c, s) = (mth.cos(), mth.sin());
        let (rvx, rvy) = (c * cvx + s * cvy, -s * cvx + c * cvy);
        let mut speeds: Vec<(f64, f64)> = pos.iter().map(|p| (rvx - cw * p.y, rvy + cw * p.x)).collect();
        let fastest = speeds.iter().map(|v| v.0.hypot(v.1)).fold(0.0, f64::max);
        if fastest > code.speed_at_12v_mps {
            let k = code.speed_at_12v_mps / fastest;
            speeds.iter_mut().for_each(|v| { v.0 *= k; v.1 *= k; });
        }
        for i in 0..n {
            let (sx, sy) = speeds[i];
            let mut speed = sx.hypot(sy);
            let mut angle = if speed > 1e-6 { sy.atan2(sx) } else { target_angle[i] };
            // Never turn more than 90°: drive backwards instead.
            if wrap_angle(angle - steer[i]).abs() > std::f64::consts::FRAC_PI_2 {
                angle = wrap_angle(angle + std::f64::consts::PI);
                speed = -speed;
            }
            target_angle[i] = angle;
            target_rps[i] = speed / (2.0 * std::f64::consts::PI * r_code) * gear;
            ff_volts[i] = if code.force_ff && i < r.fx.len() {
                // The wheel's force, into the robot frame, along the wheel.
                let (frx, fry) = (c * r.fx[i] + s * r.fy[i], -s * r.fx[i] + c * r.fy[i]);
                let along = frx * angle.cos() + fry * angle.sin();
                along * r_code / gear / motors / kt_nom * res_nom
            } else {
                0.0
            };
        }

        // --- The world, at 1 kHz -------------------------------------------
        for _ in 0..STEPS_PER_CONTROL {
            supply_filtered += (supply_a - supply_filtered) * PHYS_DT / BATTERY_TAU_S;
            let bus = (world.battery_v - world.battery_r_ohm * supply_filtered.max(0.0)).clamp(6.0, world.battery_v);
            out.min_bus_v = out.min_bus_v.min(bus);
            supply_a = 0.0;
            let (ct, st) = (th.cos(), th.sin());
            let (mut fx, mut fy, mut torque) = (0.0, 0.0, 0.0);
            let (mut odo_vx, mut odo_vy) = (0.0, 0.0);
            for i in 0..n {
                // Steering.
                let err = wrap_angle(target_angle[i] - steer[i]);
                let rate = (err / world.steer_tau_s).clamp(-world.steer_rate_radps, world.steer_rate_radps);
                steer[i] = wrap_angle(steer[i] + rate * PHYS_DT);

                // The TalonFX's loop, on what its encoder says.
                let rps = wheel[i] / (2.0 * std::f64::consts::PI * r_true) * gear;
                let ks = if target_rps[i].abs() > 1e-6 { code.drive_ks * target_rps[i].signum() } else { 0.0 };
                let volts = (ks + code.drive_kv * target_rps[i] + code.drive_kp * (target_rps[i] - rps) + ff_volts[i]).clamp(-bus, bus);
                let omega_m = rps * 2.0 * std::f64::consts::PI;
                let mut current = ((volts - omega_m / kv_motor) / motor.resistance()).clamp(-code.stator_limit_a, code.stator_limit_a);
                // Supply current is the stator current times the duty cycle;
                // the TalonFX caps it too.
                let duty = (volts / bus).abs();
                if duty * current.abs() > code.supply_limit_a && duty > 1e-6 {
                    current = current.signum() * code.supply_limit_a / duty;
                }
                // Signed: braking puts current back.
                supply_a += current * volts / bus * motors;
                let friction = if omega_m.abs() > 0.5 { world.drive_friction_v / motor.resistance() * kt_true * omega_m.signum() } else { 0.0 };
                let f_motor = (kt_true * current - friction) * motors * gear / r_true;

                // The tire on the carpet.
                let a = th + steer[i];
                let (d, nrm) = (Vec2::new(a.cos(), a.sin()), Vec2::new(-a.sin(), a.cos()));
                let p = Vec2::new(ct * pos[i].x - st * pos[i].y, st * pos[i].x + ct * pos[i].y);
                let vg = Vec2::new(vx - w * p.y, vy + w * p.x);
                let (u, l) = (vg.dot(d), vg.dot(nrm));
                let load = (m * GRAVITY / n as f64 - m * world.cog_height_m * (ax_r * q[i].x + ay_r * q[i].y)).max(0.0);
                let grip = world.mu * load;
                let k = (grip / SLIP_SATURATION_MPS).min(k_max);
                // The wheel's speed, implicit in the stiff contact.
                let mut w_new = (world.wheel_mass_kg * wheel[i] + PHYS_DT * (f_motor + k * u)) / (world.wheel_mass_kg + PHYS_DT * k);
                let (mut f_long, mut f_lat) = (k * (w_new - u), -k * l);
                let f = f_long.hypot(f_lat);
                if f > grip {
                    // Sliding: the tire gives μ·N and the wheel spins (or
                    // locks) on its own.
                    let scale = if f > 0.0 { grip / f } else { 0.0 };
                    f_long *= scale;
                    f_lat *= scale;
                    w_new = wheel[i] + PHYS_DT * (f_motor - f_long) / world.wheel_mass_kg;
                }
                out.max_slip_mps = out.max_slip_mps.max((w_new - u).abs());
                wheel[i] = w_new;
                let fi = d * f_long + nrm * f_lat;
                fx += fi.x;
                fy += fi.y;
                torque += p.x * fi.y - p.y * fi.x;
                // What the encoders say, robot frame.
                let s_angle = steer[i];
                odo_vx += wheel[i] * s_angle.cos() + w * pos[i].y;
                odo_vy += wheel[i] * s_angle.sin() - w * pos[i].x;
            }
            let (ax, ay, alpha) = (fx / m, fy / m, torque / world.moi_kg_m2);
            vx += ax * PHYS_DT;
            vy += ay * PHYS_DT;
            w += alpha * PHYS_DT;
            x += vx * PHYS_DT;
            y += vy * PHYS_DT;
            th += w * PHYS_DT;
            let f = PHYS_DT / LOAD_TAU_S;
            ax_r += (ct * ax + st * ay - ax_r) * f;
            ay_r += (-st * ax + ct * ay - ay_r) * f;
            // Odometry: the wheels' average motion, turned by the gyro.
            let (ovx, ovy) = (odo_vx / n as f64, odo_vy / n as f64);
            ox += (ct * ovx - st * ovy) * PHYS_DT;
            oy += (st * ovx + ct * ovy) * PHYS_DT;
        }
    }

    let k = samples.max(1) as f64;
    out.rms_pos_m = (sum_pos2 / k).sqrt();
    out.rms_heading_rad = (sum_head2 / k).sqrt();
    out.odometry_drift_m = (ox - x).hypot(oy - y);
    out.cost = out.rms_pos_m + 0.25 * out.max_pos_m + out.final_pos_m + 0.15 * (out.rms_heading_rad + out.final_heading_rad);
    out
}
