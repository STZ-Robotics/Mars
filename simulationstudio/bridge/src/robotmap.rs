//! Reading the robot map.
//!
//! It is the only per-robot input: the protocol manifest is fixed and
//! compiled in, but the map changes with every chassis, so it is passed on
//! the command line and read at run time.
//!
//! The schema is documented in sim/protocol/robot-map.example.json and
//! validated by sim/protocol/check.py, which checks things that cannot be seen
//! from here -- like the actuator order matching the SDF's.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct RobotMap {
    pub protocol: String,
    pub robot: String,
    pub world: String,
    /// Name of the model inside the world.
    pub model: String,
    pub profile: String,
    /// Link that represents the robot's body; it is the one published as the
    /// pose. Defaults to `chassis`, which is how the repository's worlds name it.
    #[serde(default = "default_base_link")]
    pub base_link: String,
    pub actuators: Vec<Actuator>,
    #[serde(default)]
    pub encoders: Vec<Encoder>,
}

fn default_base_link() -> String {
    "chassis".to_string()
}

/// How the engine interprets this actuator's command. It has to match the
/// `control` attribute of the <actuator> in the SDF; check.py verifies it.
#[derive(Debug, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Control {
    /// Raw duty -1..1. What a motor without its own loop applies.
    Duty,
    /// Position setpoint; the engine closes the loop. What a TalonFX does.
    Position,
}

impl Default for Control {
    fn default() -> Self {
        Self::Duty
    }
}

#[derive(Debug, Deserialize)]
pub struct Actuator {
    pub name: String,
    pub joint: String,
    #[serde(default)]
    pub inverted: bool,
    #[serde(rename = "gearRatio", default = "one")]
    pub gear_ratio: f64,
    #[serde(default)]
    pub control: Control,
}

#[derive(Debug, Deserialize)]
pub struct Encoder {
    pub name: String,
    pub joint: String,
    #[serde(rename = "countsPerRevolution", default = "one")]
    pub counts_per_revolution: f64,
}

fn one() -> f64 {
    1.0
}

impl RobotMap {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("could not read {}", path.display()))?;
        let map: RobotMap = serde_json::from_str(&text)
            .with_context(|| format!("{} is not in the expected format", path.display()))?;

        // The real handshake goes through /mars/meta/hello against the engine,
        // but this catches the most common case earlier: an old robot map left
        // over from a previous version of the protocol.
        if map.protocol != crate::protocol::PROTOCOL_VERSION {
            bail!(
                "{}: protocol {} but the bridge speaks {}",
                path.display(),
                map.protocol,
                crate::protocol::PROTOCOL_VERSION
            );
        }
        if map.world != crate::protocol::WORLD {
            bail!(
                "{}: world '{}' but the manifest says '{}'",
                path.display(),
                map.world,
                crate::protocol::WORLD
            );
        }

        Ok(map)
    }
}
