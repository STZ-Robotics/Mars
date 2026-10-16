//! What the user draws, and the smooth path built from it.
//!
//! A [`PathSpec`] is waypoints, optional headings and constraints: the file the
//! editor saves. [`GeometricPath`] is the curve the robot will follow, sampled
//! at a fixed step and with its first and second derivatives, which is what the
//! solver needs.
//!
//! Two choices worth knowing:
//!
//! - **Quintic Hermite segments with zero second derivative at the
//!   waypoints.** The curve is C2: the curvature, and with it the
//!   centripetal force the wheels have to provide, never jumps. A cubic spline
//!   is only C1 and asks the wheels for a step change in force at every
//!   waypoint.
//! - **A generalized arc length** that counts rotation too:
//!   `ds² = dx² + dy² + (ρ·dθ)²`, with ρ the drive radius. A turn in place is
//!   then a path like any other instead of a special case, and the solver
//!   sees translation and rotation competing for the same wheels, which they
//!   do.

use serde::{Deserialize, Serialize};

use crate::error::AresError;
use crate::geometry::{wrap_angle, Vec2};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waypoint {
    /// Field coordinates, meters, WPILib's frame (origin at the blue corner).
    pub x: f64,
    pub y: f64,
    /// Where the robot faces when it passes here. None = whatever is smooth
    /// between the neighbours that do say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_deg: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathConstraints {
    /// Cap on the chassis' speed. None = what the motors and the grip allow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_velocity_mps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_angular_velocity_dps: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSpec {
    pub name: String,
    pub waypoints: Vec<Waypoint>,
    #[serde(default)]
    pub constraints: PathConstraints,
}

/// One sample of the geometric path. Derivatives are with respect to the
/// generalized arc length `s`.
#[derive(Clone, Copy, Debug)]
pub struct PathPoint {
    pub s: f64,
    pub pos: Vec2,
    pub theta: f64,
    pub d_pos: Vec2,
    pub d_theta: f64,
    pub dd_pos: Vec2,
    pub dd_theta: f64,
}

#[derive(Clone, Debug)]
pub struct GeometricPath {
    pub points: Vec<PathPoint>,
    /// The step between points.
    pub ds: f64,
    pub length: f64,
}

struct Segment {
    p0: Vec2,
    p1: Vec2,
    t0: Vec2,
    t1: Vec2,
    th0: f64,
    th1: f64,
}

impl Segment {
    /// Quintic Hermite with zero second derivatives at both ends.
    fn eval(&self, u: f64) -> (Vec2, f64) {
        let u3 = u * u * u;
        let u4 = u3 * u;
        let u5 = u4 * u;
        let h00 = 1.0 - 10.0 * u3 + 15.0 * u4 - 6.0 * u5;
        let h10 = u - 6.0 * u3 + 8.0 * u4 - 3.0 * u5;
        let h11 = -4.0 * u3 + 7.0 * u4 - 3.0 * u5;
        let h01 = 10.0 * u3 - 15.0 * u4 + 6.0 * u5;
        let pos = self.p0 * h00 + self.t0 * h10 + self.t1 * h11 + self.p1 * h01;
        // The same smootherstep for the heading: zero angular velocity AND
        // acceleration at the waypoints, so the rotation is C2 too.
        let theta = self.th0 + (self.th1 - self.th0) * h01;
        (pos, theta)
    }
}

impl PathSpec {
    /// Headings at every waypoint, in radians, unwrapped so each step takes
    /// the short way round.
    fn resolved_headings(&self) -> Vec<f64> {
        let w = &self.waypoints;
        let given: Vec<Option<f64>> = w.iter().map(|p| p.heading_deg.map(f64::to_radians)).collect();
        let Some(first) = given.iter().position(Option::is_some) else {
            return vec![0.0; w.len()];
        };
        // Cumulative chord length, to place unspecified headings between the
        // ones that are given in proportion to the distance travelled.
        let mut chord = vec![0.0; w.len()];
        for i in 1..w.len() {
            chord[i] = chord[i - 1] + Vec2::new(w[i].x - w[i - 1].x, w[i].y - w[i - 1].y).norm();
        }
        let mut out = vec![0.0; w.len()];
        let mut prev: Option<usize> = None;
        for i in 0..w.len() {
            if let Some(h) = given[i] {
                out[i] = h;
                prev = Some(i);
                continue;
            }
            let next = (i + 1..w.len()).find(|&j| given[j].is_some());
            out[i] = match (prev, next) {
                (Some(a), Some(b)) => {
                    let (ha, hb) = (given[a].unwrap(), given[b].unwrap());
                    let span = chord[b] - chord[a];
                    let f = if span > 1e-9 { (chord[i] - chord[a]) / span } else { 0.0 };
                    ha + wrap_angle(hb - ha) * f
                }
                (Some(a), None) => given[a].unwrap(),
                (None, _) => given[first].unwrap(),
            };
        }
        for i in 1..out.len() {
            out[i] = out[i - 1] + wrap_angle(out[i] - out[i - 1]);
        }
        out
    }
}

impl GeometricPath {
    /// `rho` weighs rotation against translation in the arc length (use the
    /// drive radius); `step` is the sampling step in meters of that length.
    pub fn build(spec: &PathSpec, rho: f64, step: f64) -> Result<Self, AresError> {
        let w = &spec.waypoints;
        if w.len() < 2 {
            return Err(AresError::Path(format!("it needs at least 2 waypoints, it has {}", w.len())));
        }
        for (i, p) in w.iter().enumerate() {
            if !(p.x.is_finite() && p.y.is_finite() && p.heading_deg.map_or(true, f64::is_finite)) {
                return Err(AresError::Path(format!("waypoint {} has a value that is not a number", i + 1)));
            }
        }
        if !(rho > 0.0 && step > 0.0) {
            return Err(AresError::Path("the drive radius and the step have to be positive".into()));
        }

        let pts: Vec<Vec2> = w.iter().map(|p| Vec2::new(p.x, p.y)).collect();
        let headings = spec.resolved_headings();
        let n = pts.len();
        // Catmull-Rom directions, each segment scaled by its own chord: the
        // classic tangent without the overshoot it gets when neighbouring
        // segments have very different lengths.
        let dir: Vec<Vec2> = (0..n)
            .map(|k| {
                let (a, b) = (if k == 0 { 0 } else { k - 1 }, if k + 1 == n { n - 1 } else { k + 1 });
                let d = (pts[b] - pts[a]).normalized();
                if d == Vec2::ZERO {
                    // A repeated point: borrow whichever neighbour moves.
                    let fwd = if k + 1 < n { (pts[k + 1] - pts[k]).normalized() } else { Vec2::ZERO };
                    let back = if k > 0 { (pts[k] - pts[k - 1]).normalized() } else { Vec2::ZERO };
                    if fwd != Vec2::ZERO { fwd } else { back }
                } else {
                    d
                }
            })
            .collect();
        let segments: Vec<Segment> = (0..n - 1)
            .map(|j| {
                let len = (pts[j + 1] - pts[j]).norm();
                Segment {
                    p0: pts[j],
                    p1: pts[j + 1],
                    t0: dir[j] * len,
                    t1: dir[j + 1] * len,
                    th0: headings[j],
                    th1: headings[j + 1],
                }
            })
            .collect();

        // A dense table of (arc length, segment, u) to invert s -> u.
        const PER_SEGMENT: usize = 1000;
        let mut table: Vec<(f64, usize, f64)> = Vec::with_capacity(segments.len() * PER_SEGMENT + 1);
        let mut total = 0.0;
        let (mut last_pos, mut last_th) = segments[0].eval(0.0);
        table.push((0.0, 0, 0.0));
        for (j, seg) in segments.iter().enumerate() {
            for i in 1..=PER_SEGMENT {
                let u = i as f64 / PER_SEGMENT as f64;
                let (pos, th) = seg.eval(u);
                let d = ((pos - last_pos).norm2() + (rho * (th - last_th)).powi(2)).sqrt();
                total += d;
                table.push((total, j, u));
                last_pos = pos;
                last_th = th;
            }
        }
        if total < 1e-6 {
            return Err(AresError::Path("the waypoints neither move nor turn the robot".into()));
        }

        let count = ((total / step).ceil() as usize).max(4);
        let ds = total / count as f64;
        let mut raw: Vec<(Vec2, f64)> = Vec::with_capacity(count + 1);
        for k in 0..=count {
            let s = (k as f64 * ds).min(total);
            let i = table.partition_point(|e| e.0 < s).clamp(1, table.len() - 1);
            let (s0, j0, u0) = table[i - 1];
            let (s1, j1, u1) = table[i];
            let f = if s1 - s0 > 1e-15 { (s - s0) / (s1 - s0) } else { 0.0 };
            // Across a segment boundary, the end of one segment IS the start
            // of the next: interpolate inside the new one from u = 0.
            let (j, u) = if j0 != j1 { (j1, u1 * f) } else { (j0, u0 + (u1 - u0) * f) };
            raw.push(segments[j].eval(u));
        }

        // Derivatives by finite differences on the uniform grid: second order
        // everywhere, one-sided at the ends. Analytic derivatives would need
        // du/ds, which is 0/0 where a turn in place starts and stops.
        let m = raw.len();
        let pos = |k: usize| raw[k].0;
        let th = |k: usize| raw[k].1;
        let mut points = Vec::with_capacity(m);
        for k in 0..m {
            let (d_pos, d_theta, dd_pos, dd_theta) = if k == 0 {
                (
                    (pos(0) * -3.0 + pos(1) * 4.0 - pos(2)) * (0.5 / ds),
                    (-3.0 * th(0) + 4.0 * th(1) - th(2)) * (0.5 / ds),
                    (pos(0) * 2.0 - pos(1) * 5.0 + pos(2) * 4.0 - pos(3)) * (1.0 / (ds * ds)),
                    (2.0 * th(0) - 5.0 * th(1) + 4.0 * th(2) - th(3)) / (ds * ds),
                )
            } else if k == m - 1 {
                (
                    (pos(k) * 3.0 - pos(k - 1) * 4.0 + pos(k - 2)) * (0.5 / ds),
                    (3.0 * th(k) - 4.0 * th(k - 1) + th(k - 2)) * (0.5 / ds),
                    (pos(k) * 2.0 - pos(k - 1) * 5.0 + pos(k - 2) * 4.0 - pos(k - 3)) * (1.0 / (ds * ds)),
                    (2.0 * th(k) - 5.0 * th(k - 1) + 4.0 * th(k - 2) - th(k - 3)) / (ds * ds),
                )
            } else {
                (
                    (pos(k + 1) - pos(k - 1)) * (0.5 / ds),
                    (th(k + 1) - th(k - 1)) * (0.5 / ds),
                    (pos(k + 1) - pos(k) * 2.0 + pos(k - 1)) * (1.0 / (ds * ds)),
                    (th(k + 1) - 2.0 * th(k) + th(k - 1)) / (ds * ds),
                )
            };
            points.push(PathPoint {
                s: k as f64 * ds,
                pos: pos(k),
                theta: th(k),
                d_pos,
                d_theta,
                dd_pos,
                dd_theta,
            });
        }
        Ok(GeometricPath { points, ds, length: total })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wp(x: f64, y: f64, h: Option<f64>) -> Waypoint {
        Waypoint { x, y, heading_deg: h }
    }

    fn spec(w: Vec<Waypoint>) -> PathSpec {
        PathSpec { name: "t".into(), waypoints: w, constraints: PathConstraints::default() }
    }

    #[test]
    fn passes_through_every_waypoint() {
        let s = spec(vec![wp(0.0, 0.0, None), wp(2.0, 1.0, None), wp(4.0, 0.0, None)]);
        let p = GeometricPath::build(&s, 0.39, 0.01).unwrap();
        for w in &s.waypoints {
            let closest = p.points.iter().map(|q| (q.pos - Vec2::new(w.x, w.y)).norm()).fold(f64::MAX, f64::min);
            assert!(closest < 0.01, "missed ({}, {}) by {closest}", w.x, w.y);
        }
    }

    #[test]
    fn the_arc_length_is_unit_speed() {
        let s = spec(vec![wp(0.0, 0.0, Some(0.0)), wp(3.0, 2.0, Some(90.0)), wp(5.0, 0.0, None)]);
        let rho = 0.39;
        let p = GeometricPath::build(&s, rho, 0.01).unwrap();
        for q in &p.points[1..p.points.len() - 1] {
            let speed = (q.d_pos.norm2() + (rho * q.d_theta).powi(2)).sqrt();
            assert!((speed - 1.0).abs() < 0.02, "|q'| = {speed} at s = {}", q.s);
        }
    }

    #[test]
    fn a_straight_line_has_no_curvature() {
        let p = GeometricPath::build(&spec(vec![wp(0.0, 0.0, None), wp(4.0, 0.0, None)]), 0.39, 0.01).unwrap();
        assert!(p.points.iter().all(|q| q.pos.y.abs() < 1e-9 && q.dd_pos.y.abs() < 1e-6));
        assert!((p.length - 4.0).abs() < 1e-6);
    }

    #[test]
    fn a_turn_in_place_is_a_path_too() {
        let s = spec(vec![wp(1.0, 1.0, Some(0.0)), wp(1.0, 1.0, Some(180.0))]);
        let p = GeometricPath::build(&s, 0.4, 0.01).unwrap();
        assert!((p.length - 0.4 * std::f64::consts::PI).abs() < 1e-3);
        assert!(p.points.iter().all(|q| (q.pos - Vec2::new(1.0, 1.0)).norm() < 1e-9));
    }

    #[test]
    fn headings_take_the_short_way_round() {
        let s = spec(vec![wp(0.0, 0.0, Some(170.0)), wp(2.0, 0.0, Some(-170.0))]);
        let h = s.resolved_headings();
        assert!((h[1] - h[0] - 20f64.to_radians()).abs() < 1e-9, "{h:?}");
    }

    #[test]
    fn unspecified_headings_are_interpolated_by_distance() {
        let s = spec(vec![wp(0.0, 0.0, Some(0.0)), wp(1.0, 0.0, None), wp(4.0, 0.0, Some(80.0))]);
        let h = s.resolved_headings();
        assert!((h[1].to_degrees() - 20.0).abs() < 1e-9, "{h:?}");
    }

    #[test]
    fn rejects_what_cannot_be_a_path() {
        assert!(GeometricPath::build(&spec(vec![wp(0.0, 0.0, None)]), 0.4, 0.01).is_err());
        assert!(GeometricPath::build(&spec(vec![wp(0.0, 0.0, None), wp(0.0, 0.0, None)]), 0.4, 0.01).is_err());
        assert!(GeometricPath::build(&spec(vec![wp(0.0, f64::NAN, None), wp(1.0, 0.0, None)]), 0.4, 0.01).is_err());
    }
}
