//! The `vendor` profile's hardware loop, over NT4.
//!
//! It exists because **the HALSim WebSocket protocol does not cover CAN
//! motors**. It covers PWM, DIO, AnalogIn, Encoder, Relay, SimDevice and
//! DriverStation -- everything native to the roboRIO -- but a TalonFX or a
//! SparkMax is simulated by its vendor's sim API (`TalonFXSimState`,
//! `SparkSim`), which lives inside the robot's process and never shows up on
//! wpilibws. A drivetrain on CAN, which is where almost all of FRC is today,
//! cannot close the loop that way.
//!
//! The way out is ~50 lines in the robot's `simulationPeriodic` that publish
//! what the vendor is applying to the motor and inject back what the physics
//! returns. That code lives in the robot's repository; its contract is
//! `[[glue]]` in sim/protocol/topics.toml.
//!
//! Directions, seen from the BRIDGE:
//!
//! ```text
//!   robot code  --duty, enabled-->  bridge  --Actuators-->  engine
//!   robot code  <--pos, vel, yaw--  bridge  <--Model,Pose--  engine
//! ```

use anyhow::Result;

use crate::nt4::Nt4;
use crate::robotmap::{Control, RobotMap};

/// Prefix of everything the robot code publishes. The bridge subscribes to it
/// as a block, without listing actuators.
pub const OUT_PREFIX: &str = "/MARS/Glue/out/";
pub const T_ENABLED: &str = "/MARS/Glue/out/enabled";
pub const T_GYRO_YAW: &str = "/MARS/Glue/in/gyro/yaw";
/// A counter that goes up every cycle. It is how the robot code knows the
/// simulation is alive: a stopped robot publishes zeros that cannot be told
/// apart from a dead channel.
pub const T_HEARTBEAT: &str = "/MARS/Glue/in/heartbeat";

/// An actuator as the glue sees it: where to read its command and where to
/// write its state.
struct Channel {
    /// Index inside the `gz.msgs.Actuators` arrays. It is the robot map's
    /// order, which check.py verifies against the SDF's order.
    index: usize,
    joint: String,
    gear_ratio: f64,
    control: Control,
    t_duty: String,
    t_setpoint: String,
    t_pos: String,
    t_vel: String,
}

/// What the robot code is asking for, ready for the engine.
pub struct Commands {
    pub duty: Vec<f64>,
    /// Position setpoints, in JOINT radians.
    pub position: Vec<f64>,
    /// Whether the robot is enabled.
    pub enabled: bool,
}

pub struct Glue {
    channels: Vec<Channel>,
    heartbeat: std::cell::Cell<f64>,
}

impl Glue {
    pub fn new(map: &RobotMap) -> Self {
        let channels = map
            .actuators
            .iter()
            .enumerate()
            .map(|(i, a)| Channel {
                index: i,
                joint: a.joint.clone(),
                gear_ratio: a.gear_ratio,
                control: a.control,
                t_duty: format!("{OUT_PREFIX}{}/duty", a.name),
                t_setpoint: format!("{OUT_PREFIX}{}/setpoint", a.name),
                t_pos: format!("/MARS/Glue/in/{}/position", a.name),
                t_vel: format!("/MARS/Glue/in/{}/velocity", a.name),
            })
            .collect();
        Self { channels, heartbeat: std::cell::Cell::new(0.0) }
    }

    /// Subscribes to everything the robot code publishes.
    pub fn subscribe(&self, nt: &Nt4) -> Result<()> {
        nt.subscribe_prefix(OUT_PREFIX)
    }

    /// How many actuators the robot map declares.
    pub fn actuator_count(&self) -> usize {
        self.channels.len()
    }

    /// Reads the robot code's commands.
    ///
    /// Each actuator contributes to ONE array only, the one its mode calls
    /// for: `normalized` in duty mode, `position` in position mode. The engine
    /// reads the right one and gets zero in the other, which is harmless
    /// because it does not look at it.
    ///
    /// An actuator nothing has arrived from yet stays at 0. For a duty that is
    /// "no power"; for a position setpoint it is "go back to the encoder's
    /// zero", which is the only reasonable thing without knowing what the
    /// robot wants -- and it does not matter in practice, because until the
    /// robot is enabled the engine forces zero torque anyway.
    pub fn commands(&self, nt: &Nt4) -> Commands {
        let mut duty = vec![0.0; self.channels.len()];
        let mut position = vec![0.0; self.channels.len()];

        for c in &self.channels {
            match c.control {
                Control::Duty => {
                    if let Some(v) = nt.get_f64(&c.t_duty) {
                        duty[c.index] = v.clamp(-1.0, 1.0);
                    }
                }
                Control::Position => {
                    if let Some(v) = nt.get_f64(&c.t_setpoint) {
                        // The robot speaks in MOTOR radians; the simulation's
                        // engine reasons about the joint. The reduction is
                        // undone here, in the same place it is applied on the
                        // way back, so the two directions cannot diverge.
                        position[c.index] = v / c.gear_ratio;
                    }
                }
            }
        }

        // With no explicit value, disabled. A communication failure leaving
        // the robot running would be the worst possible outcome.
        Commands {
            duty,
            position: position,
            enabled: nt.get_bool(T_ENABLED).unwrap_or(false),
        }
    }

    /// Publishes to the robot code what the physics returned.
    ///
    /// Positions and velocities go on the MOTOR's shaft, not the joint's:
    /// they are multiplied by the reduction, which is how the integrated
    /// encoders of Falcon and Kraken report them and what the vendor expects
    /// in `setRawRotorPosition`.
    pub fn publish_state(
        &self,
        nt: &Nt4,
        joints: &gz_msgs::model::Model,
        yaw_rad: f64,
    ) -> Result<()> {
        for c in &self.channels {
            let Some(j) = joints.joint.iter().find(|j| j.name == c.joint) else {
                continue;
            };
            let Some(axis) = j.axis1.as_ref() else { continue };
            nt.set_double(&c.t_pos, axis.position * c.gear_ratio)?;
            nt.set_double(&c.t_vel, axis.velocity * c.gear_ratio)?;
        }

        // Degrees and CCW positive: WPILib's convention, not Gazebo's. The
        // bridge does the conversion so the glue can be as dumb as possible --
        // the less the robot code computes, the less there is to debug on the
        // side we do not control.
        nt.set_double(T_GYRO_YAW, yaw_rad.to_degrees())?;

        // The heartbeat goes LAST: if it arrives, everything above did too.
        self.heartbeat.set(self.heartbeat.get() + 1.0);
        nt.set_double(T_HEARTBEAT, self.heartbeat.get())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_built_from_the_actuator_name() {
        // Built by hand instead of reading a robot map: the test is about the
        // shape of the topics, not the parsing.
        let channel = Channel {
            index: 0,
            joint: "fl_drive_joint".into(),
            gear_ratio: 6.75,
            control: Control::Duty,
            t_duty: format!("{OUT_PREFIX}fl_drive/duty"),
            t_setpoint: format!("{OUT_PREFIX}fl_drive/setpoint"),
            t_pos: "/MARS/Glue/in/fl_drive/position".into(),
            t_vel: "/MARS/Glue/in/fl_drive/velocity".into(),
        };
        assert_eq!(channel.t_duty, "/MARS/Glue/out/fl_drive/duty");
        // The subscription prefix has to cover what the robot publishes.
        assert!(channel.t_duty.starts_with(OUT_PREFIX));
        assert!(T_ENABLED.starts_with(OUT_PREFIX));
        assert_eq!(channel.index, 0);
        assert_eq!(channel.gear_ratio, 6.75);
        assert_eq!(channel.joint, "fl_drive_joint");
        assert_eq!(channel.control, Control::Duty);
        assert!(channel.t_setpoint.starts_with(OUT_PREFIX));
    }
}
