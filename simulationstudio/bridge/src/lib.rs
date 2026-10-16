//! MARS simulation bridge.
//!
//! Translates between gz-transport (the engine), HALSim WebSocket (the robot
//! code) and NT4 (the app). The contract is in sim/protocol/.

pub mod field;
pub mod glue;
pub mod lockstep;
pub mod nt4;
pub mod robotmap;
pub mod wpistruct;

/// Constants generated from `sim/protocol/topics.toml` at compile time.
///
/// Topic names, protocol version and field dimensions. See build.rs: renaming a
/// topic in the manifest breaks the build here, which is exactly what you want
/// from a single source of truth.
pub mod protocol {
    include!(concat!(env!("OUT_DIR"), "/protocol.rs"));
}
