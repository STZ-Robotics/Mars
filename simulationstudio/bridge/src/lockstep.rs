//! Lockstep: the robot code sets the pace of the physics.
//!
//! In real time, robot and physics each run on their own clock and talk over
//! NT4. It works, but every run comes out different (±10% measured with
//! Offseason2026) and a loaded machine degrades the physics instead of going
//! slower. In lockstep the robot sends one step's commands, the physics advances
//! exactly that step, and the robot does not continue until it has the
//! resulting state.
//!
//! The one who waits is MarsLink: with commands carrying `header.data["seq"]`,
//! each physics step blocks in PreUpdate until the command with the next seq,
//! and publishes joints and pose with that same seq. The world runs WITHOUT
//! pausing and with real_time_factor 0, so there are no services or pauses in
//! between. (A first version paused the world and requested each step through
//! /world/<world>/control: the server took ~11 ms to serve each step from the
//! pause and lockstep ran at 0.26x.)
//!
//! Why TCP and not NT4 between the robot and the bridge: NT4 delivers at most
//! every 5 ms (minimum `periodic`), i.e. ≥10 ms per round trip for a 4 ms step.
//! A local socket takes tens of microseconds.
//!
//! Protocol (little-endian), one request → one response:
//!
//! ```text
//! request:   u32 MAGIC | u64 seq | u8 enabled | u32 steps | u32 n | n × f64
//!            (one value per actuator, in the robot-map's order: duty in
//!            [-1, 1] for duty mode, setpoint in MOTOR rad for position
//!            mode --- the same units as /MARS/Glue/out/*. With
//!            `steps` > 1 the same command is held for several steps.)
//! response:  u32 MAGIC | u64 seq | f64 t_sim | f64 x | f64 y | f64 yaw
//!            | u32 n | n × (f64 pos, f64 vel)
//!            (x, y, yaw: the true pose in WPILib's frame; pos and vel in MOTOR
//!            rad and rad/s, like /MARS/Glue/in/*)
//! ```

use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::Receiver;

use gz_msgs::actuators::Actuators;
use gz_msgs::header::{header::Map, Header};
use gz_msgs::int32::Int32;
use gz_msgs::model::Model;
use gz_msgs::pose_v::Pose_V;
use gz_transport::Publisher;

use crate::field::{yaw_from_quaternion, Field};
use crate::robotmap::{Control, RobotMap};

/// "MLS1" in ASCII. If it does not match, the other side does not speak this protocol.
pub const MAGIC: u32 = 0x4D4C_5331;

/// Values of /mars/cmd/match (see topics.toml).
const MATCH_DISABLED: i32 = 0;
const MATCH_TELEOP: i32 = 2;

/// How long to wait for a step's state before declaring the engine hung.
const ENGINE_TIMEOUT: Duration = Duration::from_secs(3);

/// How often to resend a command with no response. The first one of a new
/// gz-transport connection is sometimes lost while discovery finishes; a resend
/// with the same seq does not count as a new step in MarsLink.
const RESEND: Duration = Duration::from_millis(50);

/// The channels lockstep needs, already subscribed with room to spare:
/// `subscribe_channel` uses `try_send`, and with a full channel the NEW message
/// is lost.
pub struct Channels {
    pub joints: Receiver<Model>,
    pub poses: Receiver<Pose_V>,
}

pub struct Lockstep<'a> {
    robot_map: &'a RobotMap,
    field: Field,
    channels: Channels,
    act_pub: &'a mut Publisher<Actuators>,
    match_pub: &'a mut Publisher<Int32>,
    enabled_before: Option<bool>,
    /// The seq that goes to MarsLink. The bridge's own and never reset: if it reset
    /// with the robot, MarsLink would see "old" seqs and would not advance.
    physics_seq: u64,
    last_stamp: f64,
    last_pose: (f64, f64, f64),
    /// Wall time per step: waiting for the physics' state.
    physics_wait: Duration,
}

impl<'a> Lockstep<'a> {
    pub fn new(
        robot_map: &'a RobotMap,
        field: Field,
        channels: Channels,
        act_pub: &'a mut Publisher<Actuators>,
        match_pub: &'a mut Publisher<Int32>,
    ) -> Self {
        Self {
            robot_map,
            field,
            channels,
            act_pub,
            match_pub,
            enabled_before: None,
            physics_seq: 0,
            last_stamp: 0.0,
            last_pose: (0.0, 0.0, 0.0),
            physics_wait: Duration::ZERO,
        }
    }

    /// Serves clients forever, one at a time. A robot that restarts closes the
    /// socket; it listens again and the physics stays where it was.
    pub fn serve(&mut self, port: u16) -> Result<()> {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .with_context(|| format!("could not listen on 127.0.0.1:{port}"))?;
        println!("[lockstep] waiting for the robot on 127.0.0.1:{port}");
        loop {
            let (socket, peer) = listener.accept()?;
            println!("[lockstep] robot connected from {peer}");
            match self.session(socket) {
                Ok(steps) => println!("[lockstep] robot disconnected after {steps} steps"),
                Err(e) => eprintln!("[lockstep] session ended: {e:#}"),
            }
        }
    }

    fn session(&mut self, socket: TcpStream) -> Result<u64> {
        socket.set_nodelay(true)?;
        let mut input = BufReader::new(socket.try_clone()?);
        let mut output = BufWriter::new(socket);
        let n = self.robot_map.actuators.len();
        let mut steps = 0u64;
        let mut report_steps = 0u64;
        self.physics_wait = Duration::ZERO;
        let mut report_t = Instant::now();
        let mut report_t_sim = self.last_stamp;

        loop {
            // --- request ---
            let magic = match read_u32(&mut input) {
                Ok(m) => m,
                // Clean EOF: the robot closed between steps.
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(steps),
                Err(e) => return Err(e.into()),
            };
            if magic != MAGIC {
                bail!("bad magic {magic:#x}: the other side is not a lockstep glue");
            }
            let robot_seq = read_u64(&mut input)?;
            let enabled = read_u8(&mut input)? != 0;
            let count = read_u32(&mut input)?.max(1);
            let received = read_u32(&mut input)? as usize;
            if received != n {
                bail!("the robot sent {received} actuator values; the robot-map has {n}");
            }
            let mut values = vec![0.0; n];
            for v in values.iter_mut() {
                *v = read_f64(&mut input)?;
            }

            // --- steps ---
            self.publish_match(enabled)?;
            let mut joints = None;
            for _ in 0..count {
                joints = Some(self.step(&values)?);
            }
            let joints = joints.expect("count >= 1");

            // --- response ---
            write_u32(&mut output, MAGIC)?;
            write_u64(&mut output, robot_seq)?;
            write_f64(&mut output, self.last_stamp)?;
            write_f64(&mut output, self.last_pose.0)?;
            write_f64(&mut output, self.last_pose.1)?;
            write_f64(&mut output, self.last_pose.2)?;
            write_u32(&mut output, n as u32)?;
            for a in &self.robot_map.actuators {
                let (pos, vel) = joints
                    .joint
                    .iter()
                    .find(|j| j.name == a.joint)
                    .and_then(|j| j.axis1.as_ref())
                    .map(|ax| (ax.position * a.gear_ratio, ax.velocity * a.gear_ratio))
                    .unwrap_or((0.0, 0.0));
                write_f64(&mut output, pos)?;
                write_f64(&mut output, vel)?;
            }
            output.flush()?;

            steps += count as u64;
            report_steps += count as u64;
            if report_t.elapsed() >= Duration::from_secs(2) {
                let wall = report_t.elapsed().as_secs_f64();
                println!(
                    "[lockstep] {steps} steps, {:.2}x real time | {:.2} ms/step waiting on physics, {:.2} ms/step total",
                    (self.last_stamp - report_t_sim) / wall,
                    self.physics_wait.as_secs_f64() * 1e3 / report_steps as f64,
                    wall * 1e3 / report_steps as f64,
                );
                report_t = Instant::now();
                report_t_sim = self.last_stamp;
                report_steps = 0;
                self.physics_wait = Duration::ZERO;
            }
        }
    }

    fn publish_match(&mut self, enabled: bool) -> Result<()> {
        if self.enabled_before == Some(enabled) {
            return Ok(());
        }
        let mut m = Int32::new();
        m.data = if enabled { MATCH_TELEOP } else { MATCH_DISABLED };
        if !self.match_pub.publish(&m) {
            bail!("publishing the match state failed");
        }
        // It changes once per match and travels on a different topic than the
        // command: a short breather so it arrives before the next step.
        std::thread::sleep(Duration::from_millis(20));
        self.enabled_before = Some(enabled);
        Ok(())
    }

    /// One physics step with these values. Returns the joints of THAT step.
    fn step(&mut self, values: &[f64]) -> Result<Model> {
        self.physics_seq += 1;
        let seq = self.physics_seq;

        let mut msg = Actuators::new();
        msg.normalized = vec![0.0; values.len()];
        msg.position = vec![0.0; values.len()];
        for (i, a) in self.robot_map.actuators.iter().enumerate() {
            match a.control {
                Control::Duty => msg.normalized[i] = values[i].clamp(-1.0, 1.0),
                Control::Position => msg.position[i] = values[i] / a.gear_ratio,
            }
        }
        let mut header = Header::new();
        let mut entry = Map::new();
        entry.key = "seq".into();
        entry.value = vec![seq.to_string()];
        header.data.push(entry);
        msg.header = Some(header).into();

        let t0 = Instant::now();
        let deadline = t0 + ENGINE_TIMEOUT;
        let joints = 'wait: loop {
            if !self.act_pub.publish(&msg) {
                bail!("publishing actuators failed");
            }
            let resend_at = (Instant::now() + RESEND).min(deadline);
            loop {
                match self.channels.joints.recv_deadline(resend_at) {
                    Ok(j) => match seq_of(&j.header) {
                        Some(s) if s == seq => break 'wait j,
                        // From an earlier step, or from before entering lockstep.
                        _ => continue,
                    },
                    Err(_) => break,
                }
            }
            if Instant::now() >= deadline {
                return Err(anyhow!(
                    "no physics state for step {seq}: is mars-sim-server running the world \
                     with `run`, and is MarsLink built with lockstep support?"
                ));
            }
        };
        self.last_stamp = stamp(&joints.header);

        // The pose comes out in the same PostUpdate as the joints, with the same seq.
        let pose_deadline = Instant::now() + Duration::from_millis(20);
        while let Ok(p) = self.channels.poses.recv_deadline(pose_deadline) {
            let is_this_one = seq_of(&p.header) == Some(seq);
            if let Some(base) = p.pose.iter().find(|q| q.name == self.robot_map.base_link) {
                if let (Some(pos), Some(rot)) = (base.position.as_ref(), base.orientation.as_ref()) {
                    let (x, y) = self.field.to_wpilib(pos.x, pos.y);
                    self.last_pose = (x, y, yaw_from_quaternion(rot.w, rot.x, rot.y, rot.z));
                }
            }
            if is_this_one {
                break;
            }
        }
        self.physics_wait += t0.elapsed();
        Ok(joints)
    }
}

fn seq_of(h: &gz_msgs::protobuf::MessageField<Header>) -> Option<u64> {
    h.as_ref()?
        .data
        .iter()
        .find(|d| d.key == "seq")
        .and_then(|d| d.value.first())
        .and_then(|v| v.parse().ok())
}

fn stamp(h: &gz_msgs::protobuf::MessageField<Header>) -> f64 {
    h.as_ref()
        .and_then(|h| h.stamp.as_ref())
        .map(|t| t.sec as f64 + t.nsec as f64 * 1e-9)
        .unwrap_or(-1.0)
}

fn read_u8(r: &mut impl Read) -> std::io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}
fn read_u32(r: &mut impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn read_u64(r: &mut impl Read) -> std::io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}
fn read_f64(r: &mut impl Read) -> std::io::Result<f64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(f64::from_le_bytes(b))
}
fn write_u32(w: &mut impl Write, v: u32) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
fn write_u64(w: &mut impl Write, v: u64) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
fn write_f64(w: &mut impl Write, v: f64) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
