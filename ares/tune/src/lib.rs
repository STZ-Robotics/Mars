//! Ares's tuner: how well a path is followed, simulated against many worlds,
//! and a search for the gains that follow it best in all of them.

pub mod sim;
pub mod tune;
pub mod calibrate;

pub use sim::{simulate, Pid, RobotCode, RunResult, SimOptions, World};
