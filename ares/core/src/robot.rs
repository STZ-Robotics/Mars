//! `robot.json`: the one description of the robot.
//!
//! PathPlanner keeps the robot in its settings and Choreo in each project, and
//! both reduce it to a handful of limits. Here it is a file of its own, shared
//! by every project of the same robot, and it carries what a physical model
//! needs: mass, inertia, the motors and their current limits, the grip of the
//! wheels, and the 3D model the app draws. Units are in the field names, so a
//! file read cold leaves no doubt.
//!
//! ```json
//! {
//!   "name": "Offseason2026",
//!   "massKg": 58.0,
//!   "moiKgM2": 7.0,
//!   "bumper": { "lengthM": 0.851, "widthM": 0.851 },
//!   "drivetrain": {
//!     "type": "swerve",
//!     "modules": [{ "name": "fl", "xM": 0.276, "yM": 0.276 }, ...],
//!     "wheelRadiusM": 0.0508,
//!     "driveGearRatio": 5.27,
//!     "driveMotor": "kraken_x60",
//!     "driveCurrentLimitA": 120,
//!     "wheelCof": 0.9
//!   },
//!   "model": { "path": "meshes/robot.stl", "scale": 0.001 },
//!   "cameras": [{ "name": "front", "xM": 0.34, "yM": 0.07, "zM": 0.42, "pitchDeg": -10,
//!                 "horizontalFovDeg": 82, "verticalFovDeg": 56.2 }]
//! }
//! ```

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AresError;
use crate::geometry::Vec2;
use crate::motor::{Motor, MotorKind, NOMINAL_VOLTAGE};

pub const GRAVITY: f64 = 9.80665;

/// No wheel is planned below this fraction of its share of the weight. A
/// trajectory that rides the edge of lifting a wheel is one bump away from
/// tipping, and the edge itself (zero load, zero grip) is a corner the
/// optimizer cannot work from.
pub const MIN_LOAD_FRACTION: f64 = 0.1;

/// The version this code writes. A file with a higher one comes from a newer
/// Ares and is refused instead of half-read.
pub const ROBOT_FORMAT_VERSION: u32 = 1;

fn default_version() -> u32 {
    ROBOT_FORMAT_VERSION
}
fn one() -> u32 {
    1
}
fn one_f() -> f64 {
    1.0
}
fn nominal_voltage() -> f64 {
    NOMINAL_VOLTAGE
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RobotConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    pub name: String,
    /// With battery and bumpers: what the wheels carry.
    pub mass_kg: f64,
    /// About the vertical axis through the center of the robot.
    pub moi_kg_m2: f64,
    /// Height of the center of mass above the carpet. With it, the optimizer
    /// moves load between the wheels as the robot accelerates (and refuses to
    /// tip it over); without it, every wheel carries the same weight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cog_height_m: Option<f64>,
    pub bumper: Bumper,
    pub drivetrain: Drivetrain,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// The fixed cameras that see AprilTags: where each one is on the chassis and what it sees.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cameras: Vec<CameraConfig>,
    /// Expressions behind numeric fields, by dotted path
    /// (`"drivetrain.wheelRadiusM"`); see `path::Exprs`.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub exprs: crate::path::Exprs,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bumper {
    /// Along the robot's X (forward).
    pub length_m: f64,
    pub width_m: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Drivetrain {
    Swerve(SwerveConfig),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwerveConfig {
    /// Module positions in the robot frame (X forward, Y left), from the
    /// robot's center.
    pub modules: Vec<ModuleConfig>,
    pub wheel_radius_m: f64,
    /// Motor rotations per wheel rotation.
    pub drive_gear_ratio: f64,
    pub drive_motor: MotorKind,
    #[serde(default = "one")]
    pub drive_motors_per_module: u32,
    /// The drive motors' STATOR limit, as set on the controller. 0 = none.
    pub drive_current_limit_a: f64,
    /// Friction coefficient between the wheel and the carpet: the grip, the
    /// real limit of a swerve's acceleration.
    pub wheel_cof: f64,
    /// What the motors get under load. 12 V is a fresh battery at rest; a
    /// match battery under load is closer to 11.
    #[serde(default = "nominal_voltage")]
    pub battery_voltage: f64,
    /// The fraction of the free speed trajectories may use. Choreo's advice is
    /// about 0.8: the rest is headroom for the feedback controller to catch
    /// up when the robot falls behind. None = all of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_speed_fraction: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleConfig {
    pub name: String,
    pub x_m: f64,
    pub y_m: f64,
}

/// The 3D model the app draws for the robot. Only the look: the physics uses
/// the numbers above.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    /// .stl, .glb or .gltf, relative to the robot.json.
    pub path: String,
    /// File units to meters: 0.001 for an STL exported in millimeters.
    #[serde(default = "one_f")]
    pub scale: f64,
    /// Where the model's origin goes relative to the robot's center, in meters.
    #[serde(default)]
    pub offset_m: [f64; 3],
    /// Roll, pitch, yaw applied to the model, in degrees.
    #[serde(default)]
    pub rotation_deg: [f64; 3],
}

/// A FIXED camera on the robot (bolted to the chassis: it turns with the robot and nothing else; a
/// camera on a turret, an arm or an elevator moves on its own and is not modeled), as WPILib's
/// robot-to-camera `Transform3d`: from the robot's center on
/// the carpet (X forward, Y left, Z up) to the lens, then roll, pitch and yaw about the camera's
/// own X, Y and Z (extrinsic, WPILib's order). WPILib's pitch is positive tilting down: a camera
/// tilted 10 degrees up has `pitchDeg: -10`. The same numbers go in the robot code as they are.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraConfig {
    pub name: String,
    pub x_m: f64,
    pub y_m: f64,
    pub z_m: f64,
    #[serde(default)]
    pub roll_deg: f64,
    #[serde(default)]
    pub pitch_deg: f64,
    #[serde(default)]
    pub yaw_deg: f64,
    /// The whole horizontal and vertical field of view.
    pub horizontal_fov_deg: f64,
    pub vertical_fov_deg: f64,
    /// Farthest a tag is still read reliably.
    #[serde(default = "default_camera_range")]
    pub max_range_m: f64,
    /// The preset it came from ("limelight3g", "ov9281-70"...), for the app to show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn default_camera_range() -> f64 {
    5.0
}

impl RobotConfig {
    pub fn from_json(text: &str) -> Result<Self, AresError> {
        let config: RobotConfig = serde_json::from_str(text)?;
        config.validate()?;
        Ok(config)
    }

    pub fn load(path: &Path) -> Result<Self, AresError> {
        Self::from_json(&std::fs::read_to_string(path)?)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("a RobotConfig always serializes")
    }

    pub fn swerve(&self) -> &SwerveConfig {
        match &self.drivetrain {
            Drivetrain::Swerve(s) => s,
        }
    }

    /// Every problem at once: fixing a config one error per save is slow.
    pub fn validate(&self) -> Result<(), AresError> {
        let mut p = Vec::new();
        let positive = |p: &mut Vec<String>, name: &str, v: f64| {
            if !(v.is_finite() && v > 0.0) {
                p.push(format!("{name} has to be a positive number, it is {v}"));
            }
        };
        if self.version > ROBOT_FORMAT_VERSION {
            p.push(format!(
                "version {} comes from a newer Ares (this one reads up to {ROBOT_FORMAT_VERSION})",
                self.version
            ));
        }
        if self.name.trim().is_empty() {
            p.push("name is empty".into());
        }
        positive(&mut p, "massKg", self.mass_kg);
        positive(&mut p, "moiKgM2", self.moi_kg_m2);
        if let Some(h) = self.cog_height_m {
            if !(h.is_finite() && h >= 0.0) {
                p.push(format!("cogHeightM cannot be negative, it is {h}"));
            }
        }
        positive(&mut p, "bumper.lengthM", self.bumper.length_m);
        positive(&mut p, "bumper.widthM", self.bumper.width_m);

        let s = self.swerve();
        positive(&mut p, "wheelRadiusM", s.wheel_radius_m);
        positive(&mut p, "driveGearRatio", s.drive_gear_ratio);
        positive(&mut p, "wheelCof", s.wheel_cof);
        positive(&mut p, "batteryVoltage", s.battery_voltage);
        if let Some(f) = s.max_speed_fraction {
            if !(f.is_finite() && f > 0.0 && f <= 1.0) {
                p.push(format!("maxSpeedFraction has to be between 0 and 1, it is {f}"));
            }
        }
        if !(s.drive_current_limit_a.is_finite() && s.drive_current_limit_a >= 0.0) {
            p.push(format!("driveCurrentLimitA cannot be negative, it is {}", s.drive_current_limit_a));
        }
        if s.drive_motors_per_module == 0 {
            p.push("driveMotorsPerModule has to be at least 1".into());
        }
        if s.modules.len() < 3 {
            p.push(format!("a swerve needs at least 3 modules, there are {}", s.modules.len()));
        }
        for m in &s.modules {
            if !(m.x_m.is_finite() && m.y_m.is_finite()) {
                p.push(format!("module {} has a position that is not a number", m.name));
            }
        }
        // All the modules on one line cannot hold a turn about that line.
        if s.modules.len() >= 3 {
            let a = s.modules[0].position();
            let collinear = s.modules.iter().all(|m| {
                let d = m.position() - a;
                let e = s.modules[1].position() - a;
                (d.x * e.y - d.y * e.x).abs() < 1e-6
            });
            if collinear {
                p.push("the modules are all on one line".into());
            }
        }
        for (i, c) in self.cameras.iter().enumerate() {
            let label = if c.name.trim().is_empty() { format!("camera {}", i + 1) } else { format!("camera {}", c.name) };
            if c.name.trim().is_empty() {
                p.push(format!("{label} has no name"));
            }
            if self.cameras.iter().filter(|o| o.name == c.name).count() > 1 && !c.name.trim().is_empty() {
                p.push(format!("two cameras are called {}", c.name));
            }
            for (what, v) in [("xM", c.x_m), ("yM", c.y_m), ("zM", c.z_m), ("rollDeg", c.roll_deg), ("pitchDeg", c.pitch_deg), ("yawDeg", c.yaw_deg)] {
                if !v.is_finite() {
                    p.push(format!("{label}: {what} is not a number"));
                }
            }
            for (what, v) in [("horizontalFovDeg", c.horizontal_fov_deg), ("verticalFovDeg", c.vertical_fov_deg)] {
                if !(v.is_finite() && v > 0.0 && v < 180.0) {
                    p.push(format!("{label}: {what} has to be between 0 and 180, it is {v}"));
                }
            }
            if !(c.max_range_m.is_finite() && c.max_range_m > 0.0) {
                p.push(format!("{label}: maxRangeM has to be a positive number, it is {}", c.max_range_m));
            }
        }
        if let Some(model) = &self.model {
            positive(&mut p, "model.scale", model.scale);
        }
        if p.is_empty() {
            Ok(())
        } else {
            Err(AresError::Config(p))
        }
    }

    /// The fastest a module may roll: the motor's free speed, times the
    /// usable fraction.
    pub fn max_module_speed(&self) -> f64 {
        self.free_module_speed() * self.swerve().max_speed_fraction.unwrap_or(1.0)
    }

    /// The fastest a module can roll at all, at the motor's free speed.
    pub fn free_module_speed(&self) -> f64 {
        let s = self.swerve();
        s.drive_motor.motor().free_speed / s.drive_gear_ratio * s.wheel_radius_m
    }

    /// qᵢ = S⁻¹pᵢ, with S = Σ pᵢpᵢᵀ over the module positions: accelerating at
    /// `a` (robot frame) moves −m·h·(a · qᵢ) of load onto wheel i. That is the
    /// least-squares split of the pitch and roll moments, exact for any
    /// symmetric layout.
    pub fn load_vectors(&self) -> Vec<Vec2> {
        let ms = &self.swerve().modules;
        let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
        for m in ms {
            sxx += m.x_m * m.x_m;
            sxy += m.x_m * m.y_m;
            syy += m.y_m * m.y_m;
        }
        let det = sxx * syy - sxy * sxy;
        ms.iter()
            .map(|m| Vec2::new((syy * m.x_m - sxy * m.y_m) / det, (-sxy * m.x_m + sxx * m.y_m) / det))
            .collect()
    }

    /// The farthest module from the center: the lever arm of a rotation.
    pub fn drive_radius(&self) -> f64 {
        self.swerve()
            .modules
            .iter()
            .map(|m| m.position().norm())
            .fold(0.0, f64::max)
    }
}

impl SwerveConfig {
    pub fn motor(&self) -> Motor {
        self.drive_motor.motor()
    }
}

impl ModuleConfig {
    pub fn position(&self) -> Vec2 {
        Vec2::new(self.x_m, self.y_m)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// STZ's Offseason2026, from its TunerConstants and PathPlanner settings.
    pub fn offseason2026() -> RobotConfig {
        let p = 10.875 * 0.0254;
        let module = |name: &str, x: f64, y: f64| ModuleConfig { name: name.into(), x_m: x, y_m: y };
        RobotConfig {
            version: 1,
            name: "Offseason2026".into(),
            mass_kg: 58.0,
            moi_kg_m2: 7.0,
            cog_height_m: None,
            bumper: Bumper { length_m: 0.851, width_m: 0.851 },
            drivetrain: Drivetrain::Swerve(SwerveConfig {
                modules: vec![module("fl", p, p), module("fr", p, -p), module("bl", -p, p), module("br", -p, -p)],
                wheel_radius_m: 0.0508,
                drive_gear_ratio: 5.2734375,
                drive_motor: MotorKind::KrakenX60,
                drive_motors_per_module: 1,
                drive_current_limit_a: 120.0,
                wheel_cof: 0.9,
                battery_voltage: 12.0,
                max_speed_fraction: None,
            }),
            model: None,
            cameras: vec![],
            exprs: Default::default(),
        }
    }

    #[test]
    fn round_trips_through_json() {
        let r = offseason2026();
        assert_eq!(RobotConfig::from_json(&r.to_json()).unwrap(), r);
    }

    #[test]
    fn the_example_file_is_valid() {
        let text = include_str!("../../examples/robots/offseason2026.json");
        let r = RobotConfig::from_json(text).unwrap();
        assert_eq!(r.swerve().modules.len(), 4);
    }

    #[test]
    fn lists_every_problem_at_once() {
        let mut r = offseason2026();
        r.mass_kg = -1.0;
        r.swerve_mut().wheel_cof = 0.0;
        let Err(AresError::Config(problems)) = r.validate() else { panic!("accepted a bad config") };
        assert_eq!(problems.len(), 2, "{problems:?}");
    }

    #[test]
    fn refuses_a_newer_format() {
        let mut r = offseason2026();
        r.version = ROBOT_FORMAT_VERSION + 1;
        assert!(r.validate().is_err());
    }

    #[test]
    fn max_module_speed_is_about_six_meters_per_second() {
        let v = offseason2026().max_module_speed();
        assert!((v - 6.05).abs() < 0.05, "{v}");
    }

    impl RobotConfig {
        pub fn swerve_mut(&mut self) -> &mut SwerveConfig {
            match &mut self.drivetrain {
                Drivetrain::Swerve(s) => s,
            }
        }
    }
}
