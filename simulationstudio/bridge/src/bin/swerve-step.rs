//! Measures why the simulated swerve "feels wrong".
//!
//! Two symptoms people report together --- it slips and it feels heavy --- have
//! different causes and are measured separately:
//!
//!   1. STEERING STEP. Sends all four steering modules to 90 degrees and times
//!      how long they take. A real MK4i gets there in ~0.15 s. If it takes
//!      half a second here, the robot goes through every change of direction
//!      with its wheels pointing elsewhere: that looks like slipping and feels
//!      like an inertia the robot does not have.
//!
//!   2. DRIVE STEP. With the wheels straight, duty 1.0, and the wheel's
//!      surface speed (omega * r) is compared with the chassis'. The
//!      difference is real SLIP: if it is high, the problem is the contact and
//!      not the control.
//!
//! Usage, with the engine running separately:
//!   mars-sim-server worlds/swerve.sdf run
//!   cargo run --bin swerve-step

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use crossbeam_channel::Receiver;
use gz_msgs::actuators::Actuators;
use gz_msgs::int32::Int32;
use gz_msgs::model::Model;
use gz_msgs::pose_v::Pose_V;
use gz_transport::Node;

const T_MATCH: &str = "/mars/cmd/match";
const T_ACTUATORS: &str = "/mars/cmd/actuators";
const T_POSE: &str = "/mars/state/pose";
const T_JOINTS: &str = "/mars/state/joints";

const MATCH_TELEOP: i32 = 2;

/// Wheel radius from `worlds/gen_swerve.py`. Needed to go from the joint's
/// rad/s to surface m/s, which is half of the slip calculation.
const WHEEL_RADIUS: f64 = 0.0508;

/// Indices inside `gz.msgs.Actuators`, in the robot map's order:
/// fl_drive, fl_steer, fr_drive, fr_steer, bl_drive, bl_steer, br_drive, br_steer.
const N_ACT: usize = 8;
const DRIVE: [usize; 4] = [0, 2, 4, 6];
const STEER: [usize; 4] = [1, 3, 5, 7];

fn main() -> Result<()> {
    let mut node = Node::new().ok_or_else(|| anyhow!("could not create the node"))?;
    let poses = node
        .subscribe_channel::<Pose_V>(T_POSE, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {T_POSE}"))?;
    let joints = node
        .subscribe_channel::<Model>(T_JOINTS, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {T_JOINTS}"))?;
    let mut match_pub = node
        .advertise::<Int32>(T_MATCH)
        .ok_or_else(|| anyhow!("could not advertise {T_MATCH}"))?;
    let mut act_pub = node
        .advertise::<Actuators>(T_ACTUATORS)
        .ok_or_else(|| anyhow!("could not advertise {T_ACTUATORS}"))?;

    // Discovery is bidirectional: publishing before it latches on sends the
    // messages into the void, without any error.
    std::thread::sleep(Duration::from_millis(1500));
    if !match_pub.publish(&Int32 { data: MATCH_TELEOP, ..Default::default() }) {
        bail!("publishing to {T_MATCH} failed");
    }

    // --- 1. steering step -----------------------------------------------------
    let target = std::f64::consts::FRAC_PI_2;
    println!("[step] steer: 0 -> 90 deg on all four modules");
    let mut cmd = Actuators {
        normalized: vec![0.0; N_ACT],
        position: vec![0.0; N_ACT],
        ..Default::default()
    };
    for i in STEER {
        cmd.position[i] = target;
    }

    let start = Instant::now();
    let mut t10 = None;
    let mut t90 = None;
    let mut t_settled = None;
    let mut peak: f64 = 0.0;
    while start.elapsed() < Duration::from_secs(3) {
        if !act_pub.publish(&cmd) {
            bail!("publishing to {T_ACTUATORS} failed");
        }
        if let Ok(msg) = joints.recv_timeout(Duration::from_millis(20)) {
            let a = angle(&msg, "fl_steer_joint").unwrap_or(0.0);
            let t = start.elapsed().as_secs_f64();
            peak = peak.max(a);
            if t10.is_none() && a >= 0.1 * target {
                t10 = Some(t);
            }
            if t90.is_none() && a >= 0.9 * target {
                t90 = Some(t);
            }
            // Settled: within 2%, which is a degree and a half.
            if t_settled.is_none() && (a - target).abs() <= 0.02 * target {
                t_settled = Some(t);
            }
        }
    }
    let final_ = blocking_angle(&joints, "fl_steer_joint")?;
    println!(
        "[step]   t10 = {}  t90 = {}  settled(2%) = {}",
        opt(t10),
        opt(t90),
        opt(t_settled)
    );
    println!(
        "[step]   final = {:.1} deg (target 90.0), overshoot = {:.1} deg",
        final_.to_degrees(),
        (peak - target).max(0.0).to_degrees()
    );
    println!("[step]   a real MK4i steering module gets there in about 0.15 s");

    // --- 2. drive step --------------------------------------------------------
    println!("[step] steer back to 0, then drive at full duty");
    for i in STEER {
        cmd.position[i] = 0.0;
    }
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until {
        let _ = act_pub.publish(&cmd);
        std::thread::sleep(Duration::from_millis(5));
    }

    for i in DRIVE {
        cmd.normalized[i] = 1.0;
    }
    let (x0, ts0) = chassis_x(&poses)?;
    let start = Instant::now();
    let mut samples: Vec<(f64, f64, f64)> = Vec::new(); // t, v_chassis, v_wheel
    let mut x_prev = x0;
    let mut t_prev = 0.0;
    let mut v_max: f64 = 0.0;
    let mut z_high: f64 = 0.0;
    while start.elapsed() < Duration::from_millis(1500) {
        let _ = act_pub.publish(&cmd);
        std::thread::sleep(Duration::from_millis(20));
        let (x, ts) = chassis_x(&poses)?;
        z_high = z_high.max(chassis_z(&poses)?);
        let t = ts - ts0;
        let w = velocity(&joints, "fl_drive_joint")?;
        // Two reads of the same message give dt = 0: without this filter the
        // division spreads some dx over zero and spits out an infinity.
        if t - t_prev > 1e-6 {
            let v = (x - x_prev) / (t - t_prev);
            // With the field's hitboxes in place, the HUB is 2.7 m from the
            // spawn point: at full throttle it is reached in under a second.
            // Cutting on impact keeps the acceleration measurement clean, which
            // is what this phase is about --- the next one tests the crash.
            if v_max > 1.0 && v < 0.5 * v_max {
                println!("[step]   hit something at x = {x:.2} m, stopping the run");
                break;
            }
            v_max = v_max.max(v);
            samples.push((t, v, w * WHEEL_RADIUS));
        }
        x_prev = x;
        t_prev = t;
    }
    let _ = match_pub.publish(&Int32 { data: 0, ..Default::default() });

    println!();
    println!("  {:>6} {:>12} {:>12} {:>10}", "t (s)", "chassis m/s", "wheel m/s", "slip");
    for (t, v, vw) in samples.iter().step_by(5) {
        let slip = if vw.abs() > 1e-3 { (vw - v) / vw } else { 0.0 };
        println!("  {t:>6.2} {v:>12.2} {vw:>12.2} {:>9.0}%", slip * 100.0);
    }
    // --- 3. the wall ----------------------------------------------------------
    // Keeps going at full throttle until the chassis stops advancing. Without
    // the field's hitboxes the robot drives straight off: the floor's <plane>
    // is infinite and the field mesh has no collision at all.
    println!();
    println!("[step] full duty until something stops it (field limit test)");
    let start = Instant::now();
    let mut x_max = x0;
    let mut z_max: f64 = z_high;
    let mut still = 0;
    while start.elapsed() < Duration::from_secs(6) {
        let _ = act_pub.publish(&cmd);
        std::thread::sleep(Duration::from_millis(50));
        let (x, _) = chassis_x(&poses)?;
        z_max = z_max.max(chassis_z(&poses)?);
        if x - x_max < 0.01 {
            still += 1;
            if still >= 6 {
                break;
            }
        } else {
            still = 0;
        }
        x_max = x_max.max(x);
    }
    let _ = match_pub.publish(&Int32 { data: 0, ..Default::default() });
    // The driver station wall is at x = 8.45 and the tower reaches in to 7.13;
    // a 0.72 m chassis stops before that.
    // With the chassis at z = 0.20, climbing a 16.5 cm ramp puts it at 0.36.
    println!("[step]   highest the chassis got: z = {z_max:.3} m (0.200 on flat carpet)");
    println!(
        "[step]   stopped at x = {x_max:.2} m  ({})",
        if x_max < 8.27 {
            "inside the field"
        } else {
            "OUT OF THE FIELD -- nothing stopped it"
        }
    );

    // --- 4. letting off the throttle ------------------------------------------
    // What most resembles "it feels heavy": how long it takes to stop on its
    // own. A real swerve in coast rolls; one that digs in when the stick is
    // released feels like dragging a weight it does not have.
    println!();
    println!("[step] back to full duty, then release to zero and let it coast");
    let _ = match_pub.publish(&Int32 { data: MATCH_TELEOP, ..Default::default() });
    for i in DRIVE {
        cmd.normalized[i] = -1.0;   // backwards: the HUB is in front
    }
    let until = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < until {
        let _ = act_pub.publish(&cmd);
        std::thread::sleep(Duration::from_millis(5));
    }
    for i in DRIVE {
        cmd.normalized[i] = 0.0;
    }
    let (mut x_last, mut t_last) = chassis_x(&poses)?;
    let mut v0: f64 = 0.0;
    let mut history: Vec<(f64, f64)> = Vec::new();
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(2500) {
        let _ = act_pub.publish(&cmd);
        std::thread::sleep(Duration::from_millis(20));
        let (x, ts) = chassis_x(&poses)?;
        if ts - t_last > 1e-6 {
            let v = (x - x_last).abs() / (ts - t_last);
            if history.is_empty() {
                v0 = v;
            }
            history.push((ts, v));
            if v < 0.05 * v0.max(0.1) {
                break;
            }
        }
        x_last = x;
        t_last = ts;
    }
    println!("  {:>6} {:>12}", "t (s)", "chassis m/s");
    if let Some((t_first, _)) = history.first() {
        for (ts, v) in history.iter().step_by(4) {
            println!("  {:>6.2} {v:>12.2}", ts - t_first);
        }
    }
    if let (Some((t_first, _)), Some((t_end, v_end))) = (history.first(), history.last()) {
        println!(
            "[step]   released at {v0:.2} m/s, down to {v_end:.2} m/s in {:.2} s  ->  {:.1} m/s^2",
            t_end - t_first,
            (v0 - v_end) / (t_end - t_first).max(1e-6)
        );
        println!("[step]   a real swerve coasting loses about 1 m/s^2; in brake mode, 3 to 5");
    }
    let _ = match_pub.publish(&Int32 { data: 0, ..Default::default() });

    // Up to the MAXIMUM speed, not up to the last sample: the last one may
    // already be the braking against whatever got in the way, and a crash
    // sample inside the average halves it without making clear where that
    // comes from.
    let top = samples
        .iter()
        .enumerate()
        .max_by(|a, b| a.1 .1.total_cmp(&b.1 .1))
        .map(|(i, _)| i);
    if let (Some(i), Some((t0, v0, _))) = (top, samples.first()) {
        let (t1, v1, _) = samples[i];
        println!();
        println!(
            "[step]   average acceleration {:.2} m/s^2 over {:.2} s, up to {v1:.2} m/s",
            (v1 - v0) / (t1 - t0).max(1e-6),
            t1 - t0
        );
        println!("[step]   traction limit on carpet is about 9-11 m/s^2 for a 53 kg chassis");
    }
    Ok(())
}

fn opt(v: Option<f64>) -> String {
    v.map(|x| format!("{x:.3}s")).unwrap_or_else(|| "never".into())
}

fn angle(msg: &Model, joint: &str) -> Option<f64> {
    msg.joint
        .iter()
        .find(|j| j.name == joint)
        .and_then(|j| j.axis1.as_ref())
        .map(|a| a.position)
}

fn blocking_angle(rx: &Receiver<Model>, joint: &str) -> Result<f64> {
    for _ in 0..200 {
        if let Ok(msg) = rx.recv_timeout(Duration::from_secs(2)) {
            if let Some(a) = angle(&msg, joint) {
                return Ok(a);
            }
        }
    }
    bail!("no state for {joint} on {T_JOINTS}")
}

fn velocity(rx: &Receiver<Model>, joint: &str) -> Result<f64> {
    for _ in 0..200 {
        if let Ok(msg) = rx.recv_timeout(Duration::from_secs(2)) {
            if let Some(v) = msg
                .joint
                .iter()
                .find(|j| j.name == joint)
                .and_then(|j| j.axis1.as_ref())
                .map(|a| a.velocity)
            {
                return Ok(v);
            }
        }
    }
    bail!("no state for {joint} on {T_JOINTS}")
}

/// The chassis' Z, for the ramp test.
fn chassis_z(rx: &Receiver<Pose_V>) -> Result<f64> {
    for _ in 0..500 {
        let msg = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| anyhow!("no poses on {T_POSE}: {e}"))?;
        if let Some(p) = msg.pose.iter().find(|p| p.name == "chassis") {
            if let Some(v) = p.position.as_ref() {
                return Ok(v.z);
            }
        }
    }
    bail!("no pose for link 'chassis' ever arrived on {T_POSE}")
}

/// The chassis' X and the SIMULATION instant it was measured at.
///
/// The time comes from the message's stamp and not the wall clock on purpose.
/// Differentiating a position against the wall clock brings into the
/// calculation everything that happens in between --- a sample arriving late,
/// or two reads of the same message --- and that showed up as 12 m/s^2 spikes
/// and speeds above the motor's free speed. The physics made no such jumps:
/// the sampling did.
fn chassis_x(rx: &Receiver<Pose_V>) -> Result<(f64, f64)> {
    for _ in 0..500 {
        let msg = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| anyhow!("no poses on {T_POSE}: {e}"))?;
        let t = msg
            .header
            .as_ref()
            .and_then(|h| h.stamp.as_ref())
            .map(|s| s.sec as f64 + s.nsec as f64 * 1e-9);
        if let Some(p) = msg.pose.iter().find(|p| p.name == "chassis") {
            if let (Some(v), Some(t)) = (p.position.as_ref(), t) {
                return Ok((v.x, t));
            }
        }
    }
    bail!("no pose for link 'chassis' ever arrived on {T_POSE}")
}
