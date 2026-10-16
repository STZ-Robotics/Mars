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
