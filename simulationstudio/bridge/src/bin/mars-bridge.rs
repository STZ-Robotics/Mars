//! The bridge: takes the simulation's state to NetworkTables.
//!
//! It does two things at once:
//!
//! - **Telemetry** (always): the engine publishes poses over gz-transport, the
//!   bridge translates them into WPILib's frame and writes them to NT4 for the app.
//! - **Hardware loop** (`vendor` profile only): reads the motor commands the robot
//!   code's glue publishes, hands them to the engine, and returns positions,
//!   velocities and yaw. See src/glue.rs.
//!
//! The NT4 server --like on a real robot-- is not ours: the robot code brings it
//! up. The bridge is one more client, just like the app.
//!
//! Usage:
//!   mars-bridge --robot-map sim/models/testbot/robot-map.json [--nt-host IP]
//!
//! `--nt-host` points at the robot's NT4 server. In desktop simulation it is
//! usually localhost, which is what it assumes by default.
//!
//! With `--lockstep-port PORT` there is no NT4 and no real time: the robot's glue
//! connects over TCP and each request advances the physics one step. The world
//! runs with `run` and real_time_factor 0: MarsLink waits for every command. See
//! src/lockstep.rs.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use gz_msgs::actuators::Actuators;
use gz_msgs::clock::Clock;
use gz_msgs::int32::Int32;
use gz_msgs::model::Model;
use gz_msgs::pose_v::Pose_V;

use mars_sim_bridge::field::{yaw_from_quaternion, Field};
use mars_sim_bridge::glue::{self, Glue};
use mars_sim_bridge::nt4::Nt4;
use mars_sim_bridge::protocol as proto;
use mars_sim_bridge::robotmap::RobotMap;
use mars_sim_bridge::wpistruct;

/// How often the real-time factor is recomputed and published. Faster than this
/// only adds noise: the RTF is a moving average, not an instantaneous reading.
const HEALTH_PERIOD: Duration = Duration::from_millis(500);

/// How often the connection to the NT4 server is retried.
const NT_RETRY: Duration = Duration::from_secs(2);

/// Values of /mars/cmd/match (see topics.toml). The glue only tells enabled from
/// not, so the bridge sends teleop: for the engine the only thing that changes is
/// whether it applies torque or not.
const MATCH_DISABLED: i32 = 0;
const MATCH_TELEOP: i32 = 2;

struct Args {
    robot_map: PathBuf,
    nt_host: String,
    nt_port: u16,
    lockstep_port: Option<u16>,
}

fn parse_args() -> Result<Args> {
    let mut robot_map = None;
    let mut nt_host = "127.0.0.1".to_string();
    let mut nt_port = 5810u16;
    let mut lockstep_port = None;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--robot-map" => robot_map = it.next().map(PathBuf::from),
            "--nt-host" => nt_host = it.next().ok_or_else(|| anyhow!("--nt-host needs a value"))?,
            "--nt-port" => {
                nt_port = it
                    .next()
                    .ok_or_else(|| anyhow!("--nt-port needs a value"))?
                    .parse()
                    .context("--nt-port is not a number")?
            }
            "--lockstep-port" => {
                lockstep_port = Some(
                    it.next()
                        .ok_or_else(|| anyhow!("--lockstep-port needs a value"))?
                        .parse()
                        .context("--lockstep-port is not a number")?,
                )
            }
            other => return Err(anyhow!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        robot_map: robot_map.ok_or_else(|| anyhow!("--robot-map is required"))?,
        nt_host,
        nt_port,
        lockstep_port,
    })
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let robot_map = RobotMap::load(&args.robot_map)?;
    println!(
        "[bridge] robot '{}', profile '{}', protocol {}",
        robot_map.robot, robot_map.profile, proto::PROTOCOL_VERSION
    );

    let field = Field { length_m: proto::FIELD_LENGTH_M, width_m: proto::FIELD_WIDTH_M };

    // --- gz-transport ----------------------------------------------------
    // The FFI's API is synchronous and hands out crossbeam channels, so the main
    // loop lives on this thread and NT4 runs on its own runtime.
    let mut node = gz_transport::Node::new().ok_or_else(|| anyhow!("could not create the gz node"))?;

    if let Some(port) = args.lockstep_port {
        return run_lockstep(&mut node, &robot_map, field, port);
    }

    // A queue of 1 on all of them: only the most recent state matters. A long
    // queue would make the bridge publish old poses when it falls behind, which is
    // worse than skipping some.
    let poses = node
        .subscribe_channel::<Pose_V>(proto::T_MARS_STATE_POSE, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_MARS_STATE_POSE))?;
    let joints = node
        .subscribe_channel::<Model>(proto::T_MARS_STATE_JOINTS, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_MARS_STATE_JOINTS))?;
    let clock = node
        .subscribe_channel::<Clock>(proto::T_WORLD_MARS_CLOCK, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_WORLD_MARS_CLOCK))?;

    // Publishers towards the engine. They are only used in the `vendor` profile,
    // but they are always advertised: gz-transport's discovery is asynchronous and
    // advertising late means losing the first commands.
    let mut act_pub = node
        .advertise::<Actuators>(proto::T_MARS_CMD_ACTUATORS)
        .ok_or_else(|| anyhow!("could not advertise {}", proto::T_MARS_CMD_ACTUATORS))?;
    let mut match_pub = node
        .advertise::<Int32>(proto::T_MARS_CMD_MATCH)
        .ok_or_else(|| anyhow!("could not advertise {}", proto::T_MARS_CMD_MATCH))?;
    println!("[bridge] subscribed to the engine");

    // One cycle per NT4 SESSION. Every time the robot code restarts the connection
    // drops, and here it starts over: reconnect, republish the schemas and
    // resubscribe the glue. The simulation keeps running underneath, unaware.
    let started_at = Instant::now();
    let mut published = 0u64;

    'session: loop {
        // --- NT4 -------------------------------------------------------------
        // It retries forever, and it is not a convenience: the robot code brings up
        // the NT4 server, and it restarts every time the team builds. Dying when it
        // is not there would force restarting the whole simulation --- physics
        // included --- for every robot build.
        //
        // It also allows starting the simulation BEFORE the robot code, which is the
        // natural order when MARS Simulation Studio launches it.
        let rt = tokio::runtime::Runtime::new()?;
        let mut warned = false;
        let nt = loop {
            match rt.block_on(Nt4::connect(&args.nt_host, args.nt_port, "MARS-Sim")) {
                Ok(nt) => break nt,
                Err(e) => {
                    // One notice, not one every two seconds: this may be waiting for
                    // minutes while someone builds.
                    if !warned {
                        warned = true;
                        println!(
                            "[bridge] waiting for the NT4 server at {}:{} ({e}). Robot code brings it up.",
                            args.nt_host, args.nt_port
                        );
                    }
                    std::thread::sleep(NT_RETRY);
                }
            }
        };
        println!("[bridge] NT4 connected to {}:{}", args.nt_host, args.nt_port);

        // The schemas go BEFORE any value: a struct without its published
        // descriptor reaches the app as a blob it cannot decode.
        for s in wpistruct::SCHEMAS {
            nt.set_raw(
                &format!("/.schema/struct:{}", s.name),
                "structschema",
                s.descriptor.as_bytes().to_vec(),
            )?;
        }
        nt.set_string(proto::T_MARS_SIM_STATE, "running")?;

        // --- glue ------------------------------------------------------------
        // Only in the `vendor` profile. In `hal` the hardware loop goes over HALSim
        // WebSocket and the bridge does not touch the actuators.
        let glue = if robot_map.profile == "vendor" {
            let g = Glue::new(&robot_map);
            g.subscribe(&nt)?;
            println!("[bridge] glue active: {} actuators over NT4", g.actuator_count());
            Some(g)
        } else {
            println!("[bridge] profile '{}': no glue, telemetry only", robot_map.profile);
            None
        };
        let mut enabled_before: Option<bool> = None;
    let mut glue_warning = Instant::now();
    let mut glue_seen = false;

        // An error writing to NT4 is almost always the robot code closing in the
        // middle of a write (end of a test, a rebuild). That is no reason to die:
        // it goes back to the start of the session and waits for the server, just
        // like when is_connected() gives false.
        macro_rules! nt_try {
            ($e:expr) => {
                if let Err(e) = $e {
                    if !nt.is_connected() {
                        println!("
[bridge] the NT4 server went away ({e}); waiting for it to come back");
                        continue 'session;
                    }
                    return Err(e);
                }
            };
        }

        // --- lazo principal --------------------------------------------------
        let mut last_health = Instant::now();
        let mut prev_sim = 0.0f64;
        let mut prev_real = 0.0f64;
        // The yaw comes from the pose and the glue consumes it, which runs later in
        // the same cycle. It is kept between iterations so a cycle with no new pose
        // does not send a zero to the robot's gyro.
        let mut current_yaw = 0.0f64;

        loop {
            if !nt.is_connected() {
                // Neither an error nor an exit: the robot code restarts often
                // and the simulation has no reason to die with it. It goes back
                // to the start of the session and waits for it to come back.
                println!("
[bridge] the NT4 server went away; waiting for it to come back");
                continue 'session;
            }

            // The loop runs at the pace of the JOINTS (200 Hz), not of the poses
            // (50 Hz): the encoders are the feedback of the TalonFX's velocity loop,
            // which runs on the robot, and delivering them at 50 Hz adds 20 ms of
            // delay. Measured with Offseason2026: at 50 Hz the same path tracked with
            // 10 cm of RMS against 2 cm for the kinematic sim.
            //
            // The timeout acts as a heartbeat: if the engine stops, instead of
            // blocking forever the bridge says so and marks the state.
            let latest_joint = match joints.recv_timeout(Duration::from_secs(2)) {
                Ok(j) => j,
                Err(_) => {
                    nt_try!(nt.set_string(proto::T_MARS_SIM_STATE, "paused"));
                    eprintln!("[bridge] no joints from the engine for 2 s");
                    continue;
                }
            };

            // The pose arrives at 50 Hz: the most recent one is published when there is
            // a new one, and the yaw is kept between cycles without a pose.
            let mut last_pose = None;
            while let Ok(p) = poses.try_recv() {
                last_pose = Some(p);
            }
            if let Some(msg) = last_pose {
                if let Some(pose) = msg.pose.iter().find(|p| p.name == robot_map.base_link) {
                    if let (Some(pos), Some(rot)) = (pose.position.as_ref(), pose.orientation.as_ref()) {
                        let (x, y) = field.to_wpilib(pos.x, pos.y);
                        let yaw = yaw_from_quaternion(rot.w, rot.x, rot.y, rot.z);
                        current_yaw = yaw;

                        nt_try!(nt.set_raw(
                            proto::T_MARS_SIM_TRUTHPOSE,
                            "struct:Pose2d",
                            wpistruct::pose2d(x, y, yaw),
                        ));
                        nt_try!(nt.set_raw(
                            proto::T_MARS_SIM_TRUTHPOSE3D,
                            "struct:Pose3d",
                            wpistruct::pose3d(x, y, pos.z, rot.w, rot.x, rot.y, rot.z),
                        ));
                        // Redundant with truthPose, but it is WPILib's Field2d convention:
                        // with this the sim shows up in Glass, Shuffleboard and
                        // AdvantageScope without configuring anything.
                        nt_try!(nt.set_double_array(
                            proto::T_SMARTDASHBOARD_FIELD_ROBOT,
                            &[x, y, yaw.to_degrees()],
                        ));
                        published += 1;
                    }
                }
            }

            // --- hardware loop -----------------------------------------------
            if let Some(g) = &glue {
            // The glue's most common failure is SILENT: the robot code does not
            // publish, or publishes under other names, and the robot stands still
            // with nothing explaining it. This explains it.
            if !glue_seen && glue_warning.elapsed() >= Duration::from_secs(3) {
                glue_warning = Instant::now();
                let mut seen = nt.names_with_prefix(glue::OUT_PREFIX);
                if seen.is_empty() {
                    eprintln!(
                        "[bridge] nobody is publishing on {}. Without it the engine holds zero \n                         torque and the robot will not move. Check that MarsSimGlue is \n                         constructed and that update() is being called.",
                        glue::OUT_PREFIX
                    );
                } else {
                    glue_seen = true;
                    seen.sort();
                    println!("
[bridge] glue receiving {} topics:", seen.len());
                    for t in &seen {
                        println!("[bridge]   {t}");
                    }
                }
            }

                // Commands from the robot to the engine. Both arrays go: each actuator
                // contributes to the one its mode calls for and the engine reads that one.
                let cmd = g.commands(&nt);
                let mut msg = Actuators::new();
                msg.normalized = cmd.duty;
                msg.position = cmd.position;
                if !act_pub.publish(&msg) {
                    return Err(anyhow!("publishing actuators failed"));
                }
                let enabled = cmd.enabled;

                // The match state only when it changes: it is a sticky value, not a
                // stream, and republishing it 200 times a second only spends network.
                if enabled_before != Some(enabled) {
                    let mut m = Int32::new();
                    m.data = if enabled { MATCH_TELEOP } else { MATCH_DISABLED };
                    if !match_pub.publish(&m) {
                        return Err(anyhow!("publishing the match state failed"));
                    }
                    println!("
[bridge] robot {}", if enabled { "enabled" } else { "disabled" });
                    enabled_before = Some(enabled);
                }

                // The physics' state back to the robot. The most recent joint is used and
                // the rest discarded: applying a position from several steps ago is worse
                // than skipping it.
                let mut latest = latest_joint;
                while let Ok(j) = joints.try_recv() {
                    latest = j;
                }
                nt_try!(g.publish_state(&nt, &latest, current_yaw));
            } else {
                // Without a glue it still has to be drained: leaving the channel full makes
                // MarsLink write to a saturated mailbox.
                let _ = latest_joint;
                while joints.try_recv().is_ok() {}
            }

            if last_health.elapsed() >= HEALTH_PERIOD {
                last_health = Instant::now();
                if let Ok(c) = clock.try_recv() {
                    let sim = c.sim.as_ref().map_or(0.0, |t| t.sec as f64 + t.nsec as f64 * 1e-9);
                    let real = c.real.as_ref().map_or(0.0, |t| t.sec as f64 + t.nsec as f64 * 1e-9);

                    nt_try!(nt.set_double(proto::T_MARS_SIM_SIMTIME, sim));

                    // RTF as a derivative, not as accumulated sim/real: what matters is
                    // whether the simulation is keeping up NOW. The accumulated ratio
                    // hides a recent drop behind a good start.
                    let d_sim = sim - prev_sim;
                    let d_real = real - prev_real;
                    if d_real > 1e-6 {
                        let rtf = d_sim / d_real;
                        nt_try!(nt.set_double(proto::T_MARS_SIM_REALTIMEFACTOR, rtf));
                        // Below this the robot code runs its 20 ms cycle against slower
                        // physics, and any gain tuned there does not transfer to the real
                        // robot.
                        if rtf < 0.95 {
                            eprintln!("[bridge] real-time factor {rtf:.2}: the simulation is falling behind");
                        }
                    }
                    prev_sim = sim;
                    prev_real = real;
                    nt_try!(nt.set_string(proto::T_MARS_SIM_STATE, "running"));
                }

                let s = started_at.elapsed().as_secs_f64();
                print!("\r[bridge] {published} poses ({:.0} Hz)   ", published as f64 / s);
                use std::io::Write;
                let _ = std::io::stdout().flush();
            }
        }
    }
}

/// Lockstep mode: its own subscriptions, with room to spare, because
/// `subscribe_channel` uses `try_send` and with a full channel it loses the NEW
/// message. See src/lockstep.rs.
fn run_lockstep(
    node: &mut gz_transport::Node,
    robot_map: &RobotMap,
    field: Field,
    port: u16,
) -> Result<()> {
    use mars_sim_bridge::lockstep::{Channels, Lockstep};

    let joints = node
        .subscribe_channel::<Model>(proto::T_MARS_STATE_JOINTS, 256)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_MARS_STATE_JOINTS))?;
    let poses = node
        .subscribe_channel::<Pose_V>(proto::T_MARS_STATE_POSE, 256)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_MARS_STATE_POSE))?;
    let mut act_pub = node
        .advertise::<Actuators>(proto::T_MARS_CMD_ACTUATORS)
        .ok_or_else(|| anyhow!("could not advertise {}", proto::T_MARS_CMD_ACTUATORS))?;
    let mut match_pub = node
        .advertise::<Int32>(proto::T_MARS_CMD_MATCH)
        .ok_or_else(|| anyhow!("could not advertise {}", proto::T_MARS_CMD_MATCH))?;

    // The same breather as normal mode: gz-transport's discovery is asynchronous
    // and the first step cannot go out before the engine sees us.
    std::thread::sleep(Duration::from_millis(800));
    println!("[bridge] lockstep mode");

    Lockstep::new(robot_map, field, Channels { joints, poses }, &mut act_pub, &mut match_pub)
        .serve(port)
}
