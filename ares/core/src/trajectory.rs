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
    /// That force's components in the field frame: what a follower feeds
    /// forward (it is not always along the wheel: some of it is grip sideways).
    #[serde(default)]
    pub fx_n: f64,
    #[serde(default)]
    pub fy_n: f64,
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
    /// How the robot starts it. Known: at the first sample's pose (reset
    /// odometry there). Unknown: anywhere, pathfinding first. Previous: where
    /// the last path left it (do not reset).
    #[serde(default, skip_serializing_if = "TrajectoryStart::is_known")]
    pub start: TrajectoryStart,
    /// The path it continues, when its start is linked to one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continues_from: Option<String>,
    /// The named parts between splits, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<Section>,
    /// The variant of the path this was generated for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// A fingerprint of what it was generated from (path, field, robot): a
    /// different one means it is out of date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    /// What the planner has to say about it: how well a see-AprilTags span kept tags in view,
    /// or that it had to plan without one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub name: String,
    pub start_sample: usize,
    pub end_sample: usize,
    pub start_t: f64,
    pub end_t: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrajectoryStart {
    #[default]
    Known,
    Unknown,
    Previous,
}

impl TrajectoryStart {
    pub fn is_known(&self) -> bool {
        *self == TrajectoryStart::Known
    }
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
    /// It starts the path from an unknown pose: the estimate's start is only
    /// the likely one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_unknown: bool,
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
    /// The marker's own command (see `EventMarker::command`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<serde_json::Value>,
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
