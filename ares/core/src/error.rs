use std::fmt;

/// Everything that can go wrong, worded for the person drawing the path: an
/// error here ends up in a toast in the app, not in a log.
#[derive(Debug)]
pub enum AresError {
    /// `robot.json` describes a robot that cannot exist (one message per problem).
    Config(Vec<String>),
    /// The path cannot be built (too few waypoints, NaN, no length).
    Path(String),
    /// The robot cannot follow the path at all. `s_m` is how far along it,
    /// so the app can point at the spot.
    Infeasible { s_m: f64, reason: String },
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for AresError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AresError::Config(problems) => {
                write!(f, "the robot config is not valid: {}", problems.join("; "))
            }
            AresError::Path(msg) => write!(f, "the path cannot be built: {msg}"),
            AresError::Infeasible { s_m, reason } => {
                write!(f, "the robot cannot follow the path at {s_m:.2} m: {reason}")
            }
            AresError::Io(e) => write!(f, "{e}"),
            AresError::Json(e) => write!(f, "invalid JSON: {e}"),
        }
    }
}

impl std::error::Error for AresError {}

impl From<std::io::Error> for AresError {
    fn from(e: std::io::Error) -> Self {
        AresError::Io(e)
    }
}

impl From<serde_json::Error> for AresError {
    fn from(e: serde_json::Error) -> Self {
        AresError::Json(e)
    }
}
