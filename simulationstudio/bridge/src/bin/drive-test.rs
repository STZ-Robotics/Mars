//! Test of the full actuator loop against the testbot.
//!
//! What it exercises, end to end:
//!   Rust publishes /mars/cmd/match and /mars/cmd/actuators
//!     -> MarsLink receives them and applies torque with the motor's DC model
//!     -> the physics moves the robot
//!     -> MarsLink publishes /mars/state/pose and /mars/state/joints
//!     -> Rust reads it and checks the chassis moved forward
//!
//! Usage, with the engine running separately:
//!   mars-sim-server worlds/testbot.sdf run
//!   cargo run --bin drive-test

use anyhow::{anyhow, bail, Result};
use std::time::{Duration, Instant};

// The types hang from one module per .proto, not from the crate's root.
use gz_msgs::actuators::Actuators;
use gz_msgs::int32::Int32;
use gz_msgs::model::Model;
use gz_msgs::pose_v::Pose_V;
use gz_transport::Node;

/// Topics from sim/protocol/topics.toml.
const T_MATCH: &str = "/mars/cmd/match";
const T_ACTUATORS: &str = "/mars/cmd/actuators";
const T_POSE: &str = "/mars/state/pose";
const T_JOINTS: &str = "/mars/state/joints";

/// Values of /mars/cmd/match. 0 = disabled, 2 = teleop.
const MATCH_TELEOP: i32 = 2;

/// How far the chassis has to move for the test to pass. Four Krakens at full
/// power move 44 kg much further than this in two seconds; the threshold is
/// low on purpose so it does not turn brittle if the model's friction or mass
/// gets tuned.
const MIN_TRAVEL_M: f64 = 0.20;

fn main() -> Result<()> {
    let mut node = Node::new().ok_or_else(|| anyhow!("could not create the node"))?;

    // A queue of 1: only the most recent state matters. A long queue would
    // have us read old poses and measure the travel late.
    let poses = node
        .subscribe_channel::<Pose_V>(T_POSE, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {T_POSE}"))?;
    let joints = node
        .subscribe_channel::<Model>(T_JOINTS, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {T_JOINTS}"))?;
    println!("[drive] subscribed to {T_POSE} and {T_JOINTS}");

    let mut match_pub = node
        .advertise::<Int32>(T_MATCH)
        .ok_or_else(|| anyhow!("could not advertise {T_MATCH}"))?;
    let mut act_pub = node
        .advertise::<Actuators>(T_ACTUATORS)
        .ok_or_else(|| anyhow!("could not advertise {T_ACTUATORS}"))?;
    println!("[drive] publishing to {T_MATCH} and {T_ACTUATORS}");

    // Discovery is asynchronous and bidirectional: it is not enough for us to
    // see the engine, the engine has to see us. Publishing before it latches
    // on sends the messages into the void, without error.
    std::thread::sleep(Duration::from_millis(1500));

    let x0 = chassis_x(&poses)?;
    println!("[drive] initial x = {x0:.4}");

    // Enable first: MarsLink forces zero torque while match is disabled, just
    // like a real robot with the Driver Station off.
    let enabled = Int32 { data: MATCH_TELEOP, ..Default::default() };
    if !match_pub.publish(&enabled) {
        bail!("publishing to {T_MATCH} failed");
    }

    let full_forward = Actuators {
        normalized: vec![1.0; 4],
        ..Default::default()
    };

    // Republished in a loop instead of once because the real bridge sends
    // commands at 200 Hz; testing the single-message case would hide a
    // watchdog failure the day one is added.
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until {
        if !act_pub.publish(&full_forward) {
            bail!("publishing to {T_ACTUATORS} failed");
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    let x1 = chassis_x(&poses)?;
    let travel = x1 - x0;
    println!("[drive] final x   = {x1:.4}  (moved {travel:.4} m)");

    // The joints have to have turned: if the chassis moved but the wheels did
    // not, something pushed it and the actuator loop is not what got tested.
    let (joint, vel) = joint_velocity(&joints)?;
    println!("[drive] {joint} turning at {vel:.2} rad/s");

    // Stop before leaving, or the robot keeps accelerating on the last command.
    let disabled = Int32 { data: 0, ..Default::default() };
    let _ = match_pub.publish(&disabled);

    if travel < MIN_TRAVEL_M {
        bail!("the robot did not move ({travel:.4} m < {MIN_TRAVEL_M} m)");
    }
    if vel.abs() < 1.0 {
        bail!("the wheels are not turning ({vel:.2} rad/s): torque never reached the joints");
    }

    println!("[drive] OK: commands, torque, physics and telemetry all verified");
    Ok(())
}

/// The chassis' X position according to /mars/state/pose.
fn chassis_x(rx: &crossbeam_channel::Receiver<Pose_V>) -> Result<f64> {
    let timeout = Duration::from_secs(5);
    for _ in 0..500 {
        let msg = rx
            .recv_timeout(timeout)
            .map_err(|e| anyhow!("no poses on {T_POSE}: {e}"))?;
        if let Some(p) = msg.pose.iter().find(|p| p.name == "chassis") {
            if let Some(v) = p.position.as_ref() {
                return Ok(v.x);
            }
        }
    }
    bail!("no pose for link 'chassis' ever arrived on {T_POSE}")
}

/// Name and velocity of the first joint in /mars/state/joints.
fn joint_velocity(rx: &crossbeam_channel::Receiver<Model>) -> Result<(String, f64)> {
    let timeout = Duration::from_secs(5);
    for _ in 0..500 {
        let msg = rx
            .recv_timeout(timeout)
            .map_err(|e| anyhow!("no joints on {T_JOINTS}: {e}"))?;
        if let Some(j) = msg.joint.first() {
            if let Some(axis) = j.axis1.as_ref() {
                return Ok((j.name.clone(), axis.velocity));
            }
        }
    }
    bail!("no joint with axis1 ever arrived on {T_JOINTS}")
}
