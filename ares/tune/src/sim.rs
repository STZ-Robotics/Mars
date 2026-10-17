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
    /// AresLib's recovery: knocked off the trajectory, the pathfinder takes the
    /// robot to where the trajectory will be a moment later. None: feedback only.
    #[serde(default = "default_replan")]
    pub replan: Option<Replan>,
}

/// AresLib's `withReplan`, and the pathfinder's limits it drives with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replan {
    /// Off by more than this…
    pub tolerance_m: f64,
    /// …for this long, it finds its way back.
    pub delay_s: f64,
    /// To where the trajectory will be this much later.
    pub rejoin_ahead_s: f64,
    pub max_replans: u32,
    /// A path that ends at rest, ending farther than this from its last
    /// pose, drives there before it is done (0: it just ends).
    #[serde(default = "default_arrive")]
    pub arrive_m: f64,
    pub max_velocity_mps: f64,
    pub max_acceleration_mps2: f64,
    pub max_omega_radps: f64,
    pub max_alpha_radps2: f64,
}

impl Default for Replan {
    /// AresLib's defaults.
    fn default() -> Self {
        Replan {
            tolerance_m: 0.5,
            delay_s: 0.2,
            rejoin_ahead_s: 1.0,
            max_replans: 3,
            arrive_m: 0.1,
            max_velocity_mps: 3.0,
            max_acceleration_mps2: 3.0,
            max_omega_radps: 2.0 * std::f64::consts::PI,
            max_alpha_radps2: 4.0 * std::f64::consts::PI,
        }
    }
}

fn default_arrive() -> f64 {
    0.1
}

fn default_replan() -> Option<Replan> {
    Some(Replan::default())
}

/// A shove from outside: another robot's bump, or its defense. Field frame.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Push {
    /// When, as a fraction of the trajectory's duration.
    pub at: f64,
    pub duration_s: f64,
    pub fx_n: f64,
    pub fy_n: f64,
    /// A hit off the center turns the robot too.
    pub torque_nm: f64,
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
            replan: Some(Replan::default()),
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
    /// Shoves during the run.
    #[serde(default)]
    pub pushes: Vec<Push>,
    /// Vision (Limelight, QuestNav) pulling the odometry toward the truth:
    /// how often, how noisy, and how much of the gap each fix closes. 0 Hz:
    /// wheels and gyro only, and a robot shoved sideways never knows.
    #[serde(default = "default_vision_hz")]
    pub vision_hz: f64,
    #[serde(default = "default_vision_noise")]
    pub vision_noise_m: f64,
    #[serde(default = "default_vision_gain")]
    pub vision_gain: f64,
}

fn default_vision_hz() -> f64 {
    10.0
}
fn default_vision_noise() -> f64 {
    0.03
}
fn default_vision_gain() -> f64 {
    0.2
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
            pushes: vec![],
            vision_hz: default_vision_hz(),
            vision_noise_m: default_vision_noise(),
            vision_gain: default_vision_gain(),
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
    /// Every how many control steps (of 20 ms) the track keeps a point: 5
    /// (0.1 s) to draw, 1 to compare against a log.
    #[serde(default = "default_record_every")]
    pub record_every: usize,
}

fn default_record_every() -> usize {
    5
}

impl Default for SimOptions {
    fn default() -> Self {
        SimOptions { abort_m: 0.5, settle_s: 0.5, record: false, record_every: 5 }
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
    /// Shoves: the farthest one put the robot off the trajectory, the
    /// longest it took to be back within 5 cm, how often it replanned, and
    /// how much later than planned it finished.
    pub max_pushed_m: f64,
    pub recovery_s: f64,
    pub replans: u32,
    pub overrun_s: f64,
    /// Where each shove happened (x, y of the robot, and the force), to draw.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub push_marks: Vec<[f32; 4]>,
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
    // Wall time is not the trajectory's: while the robot finds its way back
    // after a shove, the trajectory's clock waits, and then jumps ahead.
    let max_wall = end + opts.settle_s + 6.0;
    let (mut sum_pos2, mut sum_head2, mut samples) = (0.0, 0.0, 0usize);
    let mut out = RunResult { min_bus_v: world.battery_v, ..Default::default() };
    let mut traj_t = 0.0f64;
    let mut settled = 0.0f64;
    let mut recovering: Option<Recovery> = None;
    let mut rec_pids = [PidState::default(); 3];
    let mut off_since: Option<f64> = None;
    // Per shove: when it hit, and whether the robot is back yet.
    let pushes: Vec<(f64, &Push)> = world.pushes.iter().map(|p| (p.at * end, p)).collect();
    let mut open_push: Vec<Option<f64>> = vec![None; pushes.len()];
    let mut tick = 0usize;
    let mut arrived = false;
    // Where the code believed the robot was at the last control step.
    let mut believed = (x, y, th);

    loop {
        let t = tick as f64 * CONTROL_DT;
        tick += 1;
        let r = sample(traj, traj_t);

        // --- How it is doing (truth against the trajectory) -------------
        let pos_err = (r.x - x).hypot(r.y - y);
        let head_err = wrap_angle(r.heading - th).abs();
        let pushed = pushes.iter().any(|(at, p)| t >= *at && t < at + p.duration_s);
        if recovering.is_none() && traj_t <= end + 1e-9 {
            sum_pos2 += pos_err * pos_err;
            sum_head2 += head_err * head_err;
            samples += 1;
            if pushes.is_empty() {
                out.max_pos_m = out.max_pos_m.max(pos_err);
            }
        }
        // Shoves: from the hit until the robot is back within 5 cm.
        for (k, (at, p)) in pushes.iter().enumerate() {
            if open_push[k].is_none() && t >= *at && t < at + CONTROL_DT {
                open_push[k] = Some(*at);
                out.push_marks.push([x as f32, y as f32, p.fx_n as f32, p.fy_n as f32]);
            }
        }
        if open_push.iter().any(|o| o.is_some()) {
            out.max_pushed_m = out.max_pushed_m.max(pos_err);
        }
        for o in open_push.iter_mut() {
            if let Some(at) = *o {
                if t > at + 0.05 && !pushed && recovering.is_none() && pos_err < 0.05 {
                    out.recovery_s = out.recovery_s.max(t - at);
                    *o = Some(f64::NAN);
                }
            }
        }
        if opts.record && (tick - 1) % opts.record_every.max(1) == 0 {
            out.track.push([x as f32, y as f32, th as f32]);
        }
        // Lost: off by more than abort_m with no recovery left, or far off
        // whatever happens, or never finishing.
        let can_recover = code.replan.as_ref().is_some_and(|rp| out.replans < rp.max_replans);
        if (pos_err > opts.abort_m && !can_recover && recovering.is_none() && !pushed) || pos_err > 3.0 || t > max_wall {
            out.aborted = true;
            // Worse the earlier it went: something for a search to climb.
            out.cost = 10.0 + 5.0 * (1.0 - (traj_t / end.max(1e-6)).min(1.0));
            out.odometry_drift_m = (ox - x).hypot(oy - y);
            return out;
        }
        // Arrival: a path that ends at rest, ending off its last pose (as the
        // code believes), drives there before it is done.
        if traj_t >= end && recovering.is_none() && !arrived {
            arrived = true;
            if let Some(rp) = code.replan.as_ref().filter(|rp| rp.arrive_m > 0.0) {
                let last = sample(traj, end);
                let (bx, by, bh) = believed;
                if c_speed(&last) < 0.05 && (last.x - bx).hypot(last.y - by) > rp.arrive_m {
                    recovering = Some(Recovery::new((bx, by, bh), &last, 0.0, end, t, rp));
                    rec_pids = [PidState::default(); 3];
                    out.replans += 1;
                    settled = 0.0;
                }
            }
        }
        if traj_t >= end && recovering.is_none() {
            if settled >= opts.settle_s {
                out.final_pos_m = pos_err;
                out.final_heading_rad = head_err;
                // Within a control step of the plan is on time.
                out.overrun_s = (t - end - opts.settle_s - CONTROL_DT).max(0.0);
                break;
            }
            settled += CONTROL_DT;
        }

        // --- The robot code, every 20 ms ----------------------------------
        // A vision fix now and then pulls the odometry toward the truth.
        if world.vision_hz > 0.0 && !world.perfect_odometry {
            let every = (1.0 / (world.vision_hz * CONTROL_DT)).round().max(1.0) as usize;
            if tick % every == 0 {
                let (vxm, vym) = (x + world.vision_noise_m * rng.gauss(), y + world.vision_noise_m * rng.gauss());
                ox += world.vision_gain.clamp(0.0, 1.0) * (vxm - ox);
                oy += world.vision_gain.clamp(0.0, 1.0) * (vym - oy);
            }
        }
        let (mx, my, mth) = {
            let (px, py, ph) = if world.perfect_odometry { (x, y, th) } else { (ox, oy, th) };
            history.push_back((px, py, ph));
            while history.len() > lag / STEPS_PER_CONTROL + 1 {
                history.pop_front();
            }
            let (hx, hy, hh) = history[0];
            (hx + world.pose_noise_m * rng.gauss(), hy + world.pose_noise_m * rng.gauss(), hh + world.heading_noise_rad * rng.gauss())
        };
        believed = (mx, my, mth);

        if std::env::var("ARES_SIM_TRACE").is_ok() && tick % 3 == 1 {
            eprintln!("t {t:.2} traj {traj_t:.2} err {pos_err:.3} believed {:.3} drift {:.3} v {:.2} wheels {:?} rec {} replans {}",
                (r.x - mx).hypot(r.y - my), (ox - x).hypot(oy - y), vx.hypot(vy),
                wheel.iter().map(|v| (v * 10.0).round() / 10.0).collect::<Vec<_>>(), recovering.is_some(), out.replans);
        }
        // FollowPath: knocked well off (by what the code believes), it hands
        // over to the pathfinder, toward where the trajectory will be.
        if recovering.is_none() {
            if let Some(rp) = &code.replan {
                let off = (r.x - mx).hypot(r.y - my);
                if off > rp.tolerance_m && out.replans < rp.max_replans {
                    let since = *off_since.get_or_insert(t);
                    if t - since >= rp.delay_s && traj_t < end {
                        let rejoin = (traj_t + rp.rejoin_ahead_s).min(end);
                        let goal = sample(traj, rejoin);
                        let speeds = (c_speed(&goal), goal.omega);
                        recovering = Some(Recovery::new((mx, my, mth), &goal, speeds.0, rejoin, t, rp));
                        rec_pids = [PidState::default(); 3];
                        out.replans += 1;
                        off_since = None;
                    }
                } else {
                    off_since = None;
                }
            }
        }

        // What to drive: the trajectory, or the way back to it.
        let (cvx, cvy, cw, fx_ff, fy_ff): (f64, f64, f64, Option<&Vec<f64>>, Option<&Vec<f64>>) = if let Some(rec) = &mut recovering {
            let (rx, ry, rh, rvx, rvy, rw) = rec.reference(t);
            let cvx = rvx + rec_pids[0].calculate(&code.translation, rx - mx);
            let cvy = rvy + rec_pids[1].calculate(&code.translation, ry - my);
            let cw = rw + rec_pids[2].calculate(&code.rotation, wrap_angle(rh - mth));
            let done = rec.finished(t, (mx, my, mth));
            if done {
                traj_t = rec.rejoin;
                recovering = None;
            }
            (cvx, cvy, cw, None, None)
        } else {
            let cvx = r.vx + pids[0].calculate(&code.translation, r.x - mx);
            let cvy = r.vy + pids[1].calculate(&code.translation, r.y - my);
            let cw = r.omega + pids[2].calculate(&code.rotation, wrap_angle(r.heading - mth));
            traj_t += CONTROL_DT;
            (cvx, cvy, cw, Some(&r.fx), Some(&r.fy))
        };
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
            ff_volts[i] = match (fx_ff, fy_ff) {
                (Some(fx), Some(fy)) if code.force_ff && i < fx.len() => {
                    // The wheel's force, into the robot frame, along the wheel.
                    let (frx, fry) = (c * fx[i] + s * fy[i], -s * fx[i] + c * fy[i]);
                    let along = frx * angle.cos() + fry * angle.sin();
                    along * r_code / gear / motors / kt_nom * res_nom
                }
                _ => 0.0,
            };
        }

        // --- The world, at 1 kHz -------------------------------------------
        for step in 0..STEPS_PER_CONTROL {
            let now = t + step as f64 * PHYS_DT;
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
            for (at, p) in &pushes {
                if now >= *at && now < at + p.duration_s {
                    fx += p.fx_n;
                    fy += p.fy_n;
                    torque += p.torque_nm;
                }
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
    // A shove the robot never came back from counts until the end.
    for o in &open_push {
        if let Some(at) = *o {
            if !at.is_nan() {
                out.recovery_s = out.recovery_s.max(end + opts.settle_s + out.overrun_s - at);
            }
        }
    }
    if !pushes.is_empty() {
        out.max_pos_m = out.max_pos_m.max(out.max_pushed_m);
    }
    // Shoves add what they cost: how long the robot was off, and how much
    // later the path ended. Without shoves both are zero.
    out.cost = out.rms_pos_m + 0.25 * out.max_pos_m + out.final_pos_m + 0.15 * (out.rms_heading_rad + out.final_heading_rad)
        + 0.1 * out.recovery_s + 0.2 * out.overrun_s;
    out
}

fn c_speed(r: &Reference) -> f64 {
    r.vx.hypot(r.vy)
}

/// A trapezoid profile from speed `v0` to `v1` over `d`, as WPILib's: up to
/// `vmax` at `a`, cruise, down.
#[derive(Clone, Copy)]
struct Trapezoid {
    v0: f64,
    v1: f64,
    vp: f64,
    a: f64,
    t_acc: f64,
    t_cruise: f64,
    t_dec: f64,
    d: f64,
}

impl Trapezoid {
    fn new(d: f64, v0: f64, v1: f64, vmax: f64, a: f64) -> Trapezoid {
        let (v0, v1) = (v0.clamp(0.0, vmax), v1.clamp(0.0, vmax));
        let vp = ((2.0 * a * d + v0 * v0 + v1 * v1) / 2.0).sqrt().min(vmax).max(v0.max(v1).min(vmax));
        let d_acc = ((vp * vp - v0 * v0) / (2.0 * a)).max(0.0);
        let d_dec = ((vp * vp - v1 * v1) / (2.0 * a)).max(0.0);
        let cruise = (d - d_acc - d_dec).max(0.0);
        Trapezoid { v0, v1, vp, a, t_acc: (vp - v0).max(0.0) / a, t_cruise: if vp > 1e-9 { cruise / vp } else { 0.0 }, t_dec: (vp - v1).max(0.0) / a, d }
    }

    fn total(&self) -> f64 {
        self.t_acc + self.t_cruise + self.t_dec
    }

    /// Distance and speed at `t`.
    fn at(&self, t: f64) -> (f64, f64) {
        if t <= 0.0 {
            return (0.0, self.v0);
        }
        if t < self.t_acc {
            return (self.v0 * t + 0.5 * self.a * t * t, self.v0 + self.a * t);
        }
        let d_acc = self.v0 * self.t_acc + 0.5 * self.a * self.t_acc * self.t_acc;
        let t2 = t - self.t_acc;
        if t2 < self.t_cruise {
            return (d_acc + self.vp * t2, self.vp);
        }
        let t3 = (t2 - self.t_cruise).min(self.t_dec);
        let d = d_acc + self.vp * self.t_cruise + self.vp * t3 - 0.5 * self.a * t3 * t3;
        if t2 - self.t_cruise >= self.t_dec {
            return (self.d, self.v1);
        }
        (d.min(self.d), self.vp - self.a * t3)
    }
}

/// AresLib's StraightPathfinder (DriveAlong) taking the robot back to the
/// trajectory: a straight profiled line and a profiled turn, from where the
/// code believes the robot is.
struct Recovery {
    from: (f64, f64, f64),
    dir: (f64, f64),
    line: Trapezoid,
    turn: Trapezoid,
    turn_sign: f64,
    goal: (f64, f64, f64),
    end_speed: f64,
    started: f64,
    rejoin: f64,
}

impl Recovery {
    fn new(from: (f64, f64, f64), goal: &Reference, end_speed: f64, rejoin: f64, now: f64, rp: &Replan) -> Recovery {
        let (dx, dy) = (goal.x - from.0, goal.y - from.1);
        let d = dx.hypot(dy);
        let dir = if d > 1e-6 { (dx / d, dy / d) } else { (1.0, 0.0) };
        let turn_by = wrap_angle(goal.heading - from.2);
        Recovery {
            from,
            dir,
            line: Trapezoid::new(d, 0.0, end_speed, rp.max_velocity_mps, rp.max_acceleration_mps2),
            turn: Trapezoid::new(turn_by.abs(), 0.0, 0.0, rp.max_omega_radps, rp.max_alpha_radps2),
            turn_sign: turn_by.signum(),
            goal: (goal.x, goal.y, goal.heading),
            end_speed,
            started: now,
            rejoin,
        }
    }

    /// Where to be and how fast, field frame.
    fn reference(&self, now: f64) -> (f64, f64, f64, f64, f64, f64) {
        let tau = now - self.started;
        let (s, v) = self.line.at(tau);
        let (a, w) = self.turn.at(tau);
        (self.from.0 + self.dir.0 * s, self.from.1 + self.dir.1 * s, self.from.2 + self.turn_sign * a, self.dir.0 * v, self.dir.1 * v, self.turn_sign * w)
    }

    fn finished(&self, now: f64, at: (f64, f64, f64)) -> bool {
        let tau = now - self.started;
        let done = self.line.total().max(self.turn.total());
        if tau < done {
            return false;
        }
        if self.end_speed > 0.05 {
            return true;
        }
        let there = (at.0 - self.goal.0).hypot(at.1 - self.goal.1) < 0.05 && wrap_angle(at.2 - self.goal.2).abs() < 3f64.to_radians();
        there || tau > done + 0.5
    }
}
