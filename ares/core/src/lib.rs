//! Ares' core: everything that is not drawing.
//!
//! - [`robot`]: `robot.json`, the one description of the robot every part of
//!   Ares reads (physics, limits, the 3D model).
//! - [`motor`]: the DC motor model, the same table MarsLink simulates with.
//! - [`path`]: what the user draws (waypoints, headings, constraints) and the
//!   smooth geometric path built from it.
//! - [`solver`]: Ares' own time-optimal solver: how fast the robot can follow
//!   that path, wheel by wheel, motor by motor.
//! - [`trajectory`]: the result, sampled in time, with what every module does.
//!
//! All units are SI (meters, seconds, radians, newtons, amps) unless a field's
//! name says otherwise, as in `headingDeg`.

pub mod error;
pub mod geometry;
pub mod motor;
pub mod path;
pub mod robot;
pub mod solver;
pub mod trajectory;

pub use error::AresError;
pub use path::{PathConstraints, PathSpec, Waypoint};
pub use robot::RobotConfig;
pub use solver::{solve, SolverOptions};
pub use trajectory::Trajectory;
