//! The DC motor model.
//!
//! The table is MarsLink's (`simulationstudio/engine/systems/MarsLink.cc`) on
//! purpose, names included: a trajectory planned with one motor and simulated
//! with another would be judged against a robot that does not exist. Change
//! one, change both.
//!
//! PathPlanner and Choreo model the drive as a maximum velocity and a maximum
//! torque. A real motor gives less torque the faster it spins (back-EMF), and a
//! TalonFX caps the current well below stall. Both shape the fastest
//! trajectory: the robot accelerates hard at low speed, then fades as it
//! approaches free speed.

use serde::{Deserialize, Serialize};

pub const NOMINAL_VOLTAGE: f64 = 12.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MotorKind {
    KrakenX60,
    Falcon500,
    Neo,
    Neo550,
    Cim,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motor {
    /// N*m
    pub stall_torque: f64,
    /// A
    pub stall_current: f64,
    /// rad/s
    pub free_speed: f64,
    /// A
    pub free_current: f64,
}

const fn rpm(v: f64) -> f64 {
    v * std::f64::consts::PI / 30.0
}

impl MotorKind {
    pub const ALL: [MotorKind; 5] = [
        MotorKind::KrakenX60,
        MotorKind::Falcon500,
        MotorKind::Neo,
        MotorKind::Neo550,
        MotorKind::Cim,
    ];

    pub fn motor(self) -> Motor {
        let (stall_torque, stall_current, free_rpm, free_current) = match self {
            MotorKind::KrakenX60 => (7.09, 366.0, 6000.0, 2.0),
            MotorKind::Falcon500 => (4.69, 257.0, 6380.0, 1.5),
            MotorKind::Neo => (3.28, 181.0, 5676.0, 1.3),
            MotorKind::Neo550 => (1.08, 111.0, 11000.0, 1.1),
            MotorKind::Cim => (2.41, 131.0, 5330.0, 2.7),
        };
        Motor { stall_torque, stall_current, free_speed: rpm(free_rpm), free_current }
    }
}

impl Motor {
    pub fn resistance(&self) -> f64 {
        NOMINAL_VOLTAGE / self.stall_current
    }

    /// N*m per A.
    pub fn kt(&self) -> f64 {
        self.stall_torque / self.stall_current
    }

    /// rad/s per V.
    pub fn kv(&self) -> f64 {
        self.free_speed / (NOMINAL_VOLTAGE - self.free_current * self.resistance())
    }

    /// The most torque the motor can give at `omega` (rad/s, its magnitude),
    /// with the current capped at `current_limit` (0 = no cap) and `voltage`
    /// available.
    ///
    /// `driving` is the direction of the torque: true pushes along the motion
    /// (back-EMF fights it, and it fades to zero at free speed), false brakes
    /// against it (back-EMF helps, so braking stays strong at speed).
    pub fn max_torque(&self, omega: f64, current_limit: f64, voltage: f64, driving: bool) -> f64 {
        let back_emf = omega.abs() / self.kv();
        let available = if driving { voltage - back_emf } else { voltage + back_emf };
        let mut current = (available / self.resistance()).max(0.0);
        if current_limit > 0.0 {
            current = current.min(current_limit);
        }
        self.kt() * current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stall_and_free_speed_match_the_datasheet() {
        let m = MotorKind::KrakenX60.motor();
        assert!((m.max_torque(0.0, 0.0, NOMINAL_VOLTAGE, true) - 7.09).abs() < 1e-9);
        // Nothing left to push with at free speed (up to the free current).
        assert!(m.max_torque(m.free_speed, 0.0, NOMINAL_VOLTAGE, true) < 0.05);
    }

    #[test]
    fn the_current_limit_caps_the_torque() {
        let m = MotorKind::KrakenX60.motor();
        let t = m.max_torque(0.0, 60.0, NOMINAL_VOLTAGE, true);
        assert!((t - m.kt() * 60.0).abs() < 1e-9);
    }

    #[test]
    fn braking_does_not_fade_with_speed() {
        let m = MotorKind::Neo.motor();
        let w = 0.9 * m.free_speed;
        assert!(m.max_torque(w, 0.0, NOMINAL_VOLTAGE, false) > m.max_torque(w, 0.0, NOMINAL_VOLTAGE, true));
    }

    #[test]
    fn names_are_marslink_names() {
        let names: Vec<String> = MotorKind::ALL
            .iter()
            .map(|m| serde_json::to_string(m).unwrap().trim_matches('"').to_string())
            .collect();
        assert_eq!(names, ["kraken_x60", "falcon500", "neo", "neo550", "cim"]);
    }
}
