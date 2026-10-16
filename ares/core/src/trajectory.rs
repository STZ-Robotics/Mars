//! The solver's result: the robot's state over time, module by module.
//!
//! Every sample carries what each module does --- speed, angle, the force it
//! puts on the carpet and the current its drive motor draws. That is what lets
//! the app show WHY a trajectory is as fast as it is (which wheel is at the
//! edge of its grip, which motor hit its current limit) instead of only how
//! fast it is.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSample {
    pub speed_mps: f64,
    /// The wheel's direction in the robot frame.
    pub angle_rad: f64,
    /// The force the wheel puts on the carpet.
    pub force_n: f64,
    /// Fraction of the available grip in use: 1.0 is the edge of slipping.
    pub grip_used: f64,
    /// The weight on this wheel, in newtons. It moves between the wheels as
    /// the robot accelerates when the center of mass height is known.
    #[serde(default)]
    pub load_n: f64,
    /// What the drive motor draws to produce that force. Signed: negative is
    /// braking.
    pub current_a: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub heading: f64,
    pub vx: f64,
    pub vy: f64,
    pub omega: f64,
    pub ax: f64,
    pub ay: f64,
    pub alpha: f64,
    pub modules: Vec<ModuleSample>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trajectory {
    pub name: String,
    pub robot: String,
    pub duration_s: f64,
    pub samples: Vec<Sample>,
    /// When the robot passes each of the user's waypoints.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waypoint_times: Vec<f64>,
    /// Sample indices where the trajectory is split (at split waypoints).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub splits: Vec<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<TimedEvent>,
    /// Windows the robot pathfinds through instead of following samples.
    /// The samples inside are Ares' estimate of that route, for the preview.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pathfind: Vec<PathfindSpan>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathfindSpan {
    /// Samples [start, end] are the estimate; the robot pathfinds instead.
    pub start_sample: usize,
    pub end_sample: usize,
    /// The waypoints it pathfinds between.
    pub from_waypoint: usize,
    pub to_waypoint: usize,
    /// Where to: the pose it must reach (heading in radians).
    pub goal_x: f64,
    pub goal_y: f64,
    pub goal_heading: f64,
    pub max_velocity_mps: Option<f64>,
    pub max_acceleration_mps2: Option<f64>,
    pub max_angular_velocity_dps: Option<f64>,
    /// How long Ares expects it to take.
    pub estimated_s: f64,
}

/// An event marker resolved to a time on the trajectory.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedEvent {
    pub name: String,
    pub t: f64,
    /// For an event zone: when it ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_t: Option<f64>,
}

impl Trajectory {
    /// The state at time `t`, interpolated between samples (clamped to the
    /// ends). Module states come from the sample just before.
    pub fn sample_at(&self, t: f64) -> Sample {
        let s = &self.samples;
        if t <= s[0].t {
            return s[0].clone();
        }
        if t >= s[s.len() - 1].t {
            return s[s.len() - 1].clone();
        }
        let i = s.partition_point(|q| q.t <= t);
        let (a, b) = (&s[i - 1], &s[i]);
        let f = if b.t > a.t { (t - a.t) / (b.t - a.t) } else { 0.0 };
        let lerp = |x: f64, y: f64| x + (y - x) * f;
        Sample {
            t,
            x: lerp(a.x, b.x),
            y: lerp(a.y, b.y),
            heading: lerp(a.heading, b.heading),
            vx: lerp(a.vx, b.vx),
            vy: lerp(a.vy, b.vy),
            omega: lerp(a.omega, b.omega),
            ax: a.ax,
            ay: a.ay,
            alpha: a.alpha,
            modules: a.modules.clone(),
        }
    }

    pub fn max_speed(&self) -> f64 {
        self.samples.iter().map(|s| s.vx.hypot(s.vy)).fold(0.0, f64::max)
    }
}
