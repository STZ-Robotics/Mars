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

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::AresError;
use crate::geometry::{wrap_angle, Vec2};

/// Expressions behind numeric fields, by field name (`"x"`, `"maxVelocityMps"`),
/// as the user typed them in the app (`hub.x - 0.5`). The app evaluates them
/// against the project's variables and writes the number into the field;
/// Ares' Rust side only ever reads the number and keeps these as they are.
pub type Exprs = BTreeMap<String, String>;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waypoint {
    /// Field coordinates, meters, WPILib's frame (origin at the blue corner).
    pub x: f64,
    pub y: f64,
    /// Where the robot faces when it passes here. None = whatever is smooth
    /// between the neighbours that do say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_deg: Option<f64>,
    /// What the waypoint pins down. Files without it read as Pose when they
    /// have a heading and Translation when they do not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<WaypointKind>,
    /// Samples from here to the next waypoint, overriding the automatic count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intervals: Option<u32>,
    /// The trajectory is split here: the robot code can run the parts
    /// separately (and do something in between).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub split: bool,
    /// The segment to the next waypoint is drawn by hand, PathPlanner style:
    /// a cubic Bézier through this waypoint's `next_control` and the next
    /// one's `prev_control`. The optimizer keeps the robot on that curve and
    /// only optimizes how fast it goes along it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual_next: bool,
    /// Bézier control points, field coordinates (PathPlanner's prevControl
    /// and nextControl). Used by manual segments; missing ones default to a
    /// third of the chord along the automatic tangent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_control: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_control: Option<[f64; 2]>,
    /// The segment to the next waypoint is not planned: the robot pathfinds
    /// there at run time (PathPlanner's pathfindToPose), from wherever it
    /// actually is. Ares shows the likely route and its time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pathfind_next: Option<PathfindOptions>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exprs: Exprs,
}

/// The limits the robot pathfinds with (PathPlanner's PathConstraints).
/// None = what the robot can do.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathfindOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_velocity_mps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_acceleration_mps2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_angular_velocity_dps: Option<f64>,
    /// Enter the pathfind segment moving: the part before does not stop at
    /// the hand-off.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_moving_in: bool,
    /// Leave it moving: the part after starts at speed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_moving_out: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exprs: Exprs,
}

/// Choreo's three waypoint types.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WaypointKind {
    /// Position and heading.
    Pose,
    /// Position only; the optimizer picks the heading.
    Translation,
    /// Neither: it only shapes the initial guess (around an obstacle, say),
    /// and scoped constraints can still target it. Not allowed at the ends.
    Empty,
}

impl Waypoint {
    pub fn kind(&self) -> WaypointKind {
        match self.kind {
            Some(WaypointKind::Pose) if self.heading_deg.is_none() => WaypointKind::Translation,
            Some(k) => k,
            None if self.heading_deg.is_some() => WaypointKind::Pose,
            None => WaypointKind::Translation,
        }
    }

    /// The heading the optimizer must hit, if any.
    pub fn fixed_heading_deg(&self) -> Option<f64> {
        (self.kind() == WaypointKind::Pose).then_some(self.heading_deg).flatten()
    }
}

/// Which waypoint a constraint or an event points at. `First` and `Last`
/// follow the ends as waypoints are added; an index is a specific one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Target {
    First,
    Last,
    Index(usize),
}

impl Target {
    pub fn resolve(self, waypoints: usize) -> usize {
        match self {
            Target::First => 0,
            Target::Last => waypoints.saturating_sub(1),
            Target::Index(i) => i.min(waypoints.saturating_sub(1)),
        }
    }
}

/// A constraint on part of the path: at one waypoint (`to` empty) or over
/// the segments from `from` to `to`, both ends included. Choreo's set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedConstraint {
    pub from: Target,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Target>,
    #[serde(default = "yes", skip_serializing_if = "Clone::clone")]
    pub enabled: bool,
    #[serde(flatten)]
    pub kind: ConstraintKind,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exprs: Exprs,
}

fn yes() -> bool {
    true
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConstraintKind {
    /// At rest: no linear or angular velocity. Waypoint scope only. With a
    /// wait, the robot stays still that long before moving on (to score,
    /// to intake), and everything after it shifts by that much.
    StopPoint {
        #[serde(default, skip_serializing_if = "is_zero")]
        wait_s: f64,
    },
    MaxVelocity { mps: f64 },
    MaxAcceleration { mps2: f64 },
    MaxAngularVelocity { dps: f64 },
    /// The front (or the back, `flip`) faces a field point, within a tolerance.
    PointAt { x: f64, y: f64, tolerance_deg: f64, #[serde(default)] flip: bool },
    /// Every bumper corner inside a circle.
    KeepInCircle { x: f64, y: f64, radius_m: f64 },
    /// Every bumper corner inside an axis-aligned rectangle (x, y is its
    /// bottom-left corner).
    KeepInRectangle { x: f64, y: f64, width_m: f64, height_m: f64 },
    /// The center within a distance of the line between the scope's ends.
    KeepInLane { tolerance_m: f64 },
    /// The bumper clear of a circle, on this part of the path only.
    KeepOutCircle { x: f64, y: f64, radius_m: f64 },
}

impl ScopedConstraint {
    /// The waypoint range it covers, resolved and ordered.
    pub fn range(&self, waypoints: usize) -> (usize, usize) {
        let a = self.from.resolve(waypoints);
        let b = self.to.map_or(a, |t| t.resolve(waypoints));
        (a.min(b), a.max(b))
    }
}

/// Something to do at a moment of the path: a time offset from a waypoint.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMarker {
    pub name: String,
    pub target: Target,
    /// Seconds after (positive) or before (negative) the waypoint.
    #[serde(default)]
    pub offset_s: f64,
    /// A zone instead of a moment: the event lasts this long (PathPlanner's
    /// zoned events), from start to end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exprs: Exprs,
}

impl Default for EventMarker {
    fn default() -> Self {
        EventMarker { name: String::new(), target: Target::First, offset_s: 0.0, duration_s: None, exprs: Exprs::new() }
    }
}

/// A heading to hit partway along a segment (PathPlanner's rotation
/// targets): at `fraction` of the way from waypoint `segment` to the next.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationTarget {
    pub segment: usize,
    pub fraction: f64,
    pub heading_deg: f64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exprs: Exprs,
}

/// Files from before scoped constraints stopped at both ends implicitly.
pub fn default_scoped() -> Vec<ScopedConstraint> {
    vec![
        ScopedConstraint { from: Target::First, to: None, enabled: true, kind: ConstraintKind::StopPoint { wait_s: 0.0 }, exprs: Exprs::new() },
        ScopedConstraint { from: Target::Last, to: None, enabled: true, kind: ConstraintKind::StopPoint { wait_s: 0.0 }, exprs: Exprs::new() },
    ]
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathConstraints {
    /// Cap on the chassis' speed. None = what the motors and the grip allow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_velocity_mps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_angular_velocity_dps: Option<f64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exprs: Exprs,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSpec {
    pub name: String,
    pub waypoints: Vec<Waypoint>,
    /// Caps on the whole path.
    #[serde(default)]
    pub constraints: PathConstraints,
    /// Constraints on part of it.
    #[serde(default = "default_scoped")]
    pub scoped: Vec<ScopedConstraint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<EventMarker>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rotation_targets: Vec<RotationTarget>,
    /// Starts where another path of the project ends, at its speed: the two
    /// run back to back without stopping. The start pose comes from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continues_from: Option<String>,
}

impl PathSpec {
    /// A path with the given waypoints, stopping at both ends.
    pub fn new(name: impl Into<String>, waypoints: Vec<Waypoint>) -> Self {
        PathSpec {
            name: name.into(),
            waypoints,
            constraints: PathConstraints::default(),
            scoped: default_scoped(),
            events: vec![],
            rotation_targets: vec![],
            continues_from: None,
        }
    }
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
    /// Where each waypoint falls, in the same generalized arc length as `s`.
    pub waypoint_s: Vec<f64>,
}

struct Segment {
    p0: Vec2,
    p1: Vec2,
    t0: Vec2,
    t1: Vec2,
    th0: f64,
    th1: f64,
    /// A manual segment: the Bézier's inner control points.
    bezier: Option<(Vec2, Vec2)>,
}

/// A cubic Bézier at `u`.
pub fn bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: f64) -> Vec2 {
    let v = 1.0 - u;
    p0 * (v * v * v) + p1 * (3.0 * v * v * u) + p2 * (3.0 * v * u * u) + p3 * (u * u * u)
}

impl Segment {
    /// Quintic Hermite with zero second derivatives at both ends, or the
    /// user's Bézier for a manual segment.
    fn eval(&self, u: f64) -> (Vec2, f64) {
        let u3 = u * u * u;
        let u4 = u3 * u;
        let u5 = u4 * u;
        let h00 = 1.0 - 10.0 * u3 + 15.0 * u4 - 6.0 * u5;
        let h10 = u - 6.0 * u3 + 8.0 * u4 - 3.0 * u5;
        let h11 = -4.0 * u3 + 7.0 * u4 - 3.0 * u5;
        let h01 = 10.0 * u3 - 15.0 * u4 + 6.0 * u5;
        let pos = match self.bezier {
            Some((c1, c2)) => bezier(self.p0, c1, c2, self.p1, u),
            None => self.p0 * h00 + self.t0 * h10 + self.t1 * h11 + self.p1 * h01,
        };
        // The same smootherstep for the heading: zero angular velocity AND
        // acceleration at the waypoints, so the rotation is C2 too.
        let theta = self.th0 + (self.th1 - self.th0) * h01;
        (pos, theta)
    }
}

impl PathSpec {
    /// For each segment, its Bézier's inner control points if it is manual.
    /// Missing controls default to a third of the chord along `dir`, the
    /// automatic tangent, so turning a segment manual does not move it much.
    fn bezier_controls(&self, dir: &[Vec2]) -> Vec<Option<(Vec2, Vec2)>> {
        let w = &self.waypoints;
        (0..w.len().saturating_sub(1))
            .map(|j| {
                if !w[j].manual_next {
                    return None;
                }
                let (a, b) = (Vec2::new(w[j].x, w[j].y), Vec2::new(w[j + 1].x, w[j + 1].y));
                let third = (b - a).norm() / 3.0;
                let c1 = w[j].next_control.map_or(a + dir[j] * third, |c| Vec2::new(c[0], c[1]));
                let c2 = w[j + 1].prev_control.map_or(b - dir[j + 1] * third, |c| Vec2::new(c[0], c[1]));
                Some((c1, c2))
            })
            .collect()
    }

    /// The manual segments' Béziers, as (segment, [p0, p1, p2, p3]), with
    /// the same defaults the path uses.
    pub fn manual_curves(&self) -> Vec<(usize, [Vec2; 4])> {
        let w = &self.waypoints;
        let pts: Vec<Vec2> = w.iter().map(|p| Vec2::new(p.x, p.y)).collect();
        let dir = catmull_rom_directions(&pts);
        self.bezier_controls(&dir)
            .into_iter()
            .enumerate()
            .filter_map(|(j, c)| c.map(|(c1, c2)| (j, [pts[j], c1, c2, pts[j + 1]])))
            .collect()
    }

    /// Headings at every waypoint, in radians, unwrapped so each step takes
    /// the short way round.
    fn resolved_headings(&self) -> Vec<f64> {
        let w = &self.waypoints;
        let given: Vec<Option<f64>> = w.iter().map(|p| p.fixed_heading_deg().map(f64::to_radians)).collect();
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

/// Catmull-Rom directions at each point, each segment scaled by its own
/// chord: the classic tangent without the overshoot it gets when
/// neighbouring segments have very different lengths.
fn catmull_rom_directions(pts: &[Vec2]) -> Vec<Vec2> {
    let n = pts.len();
    (0..n)
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
        .collect()
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
        let dir = catmull_rom_directions(&pts);
        let controls = spec.bezier_controls(&dir);
        // Where a manual segment meets an automatic one, the automatic one
        // leaves (or arrives) along the Bézier's tangent: no kink.
        let mut dir = dir;
        for (j, c) in controls.iter().enumerate() {
            if let Some((c1, c2)) = c {
                let out = (*c1 - pts[j]).normalized();
                let inn = (pts[j + 1] - *c2).normalized();
                if out != Vec2::ZERO {
                    dir[j] = out;
                }
                if inn != Vec2::ZERO {
                    dir[j + 1] = inn;
                }
            }
        }
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
                    bezier: controls[j],
                }
            })
            .collect();

        // A dense table of (arc length, segment, u) to invert s -> u.
        const PER_SEGMENT: usize = 1000;
        let mut table: Vec<(f64, usize, f64)> = Vec::with_capacity(segments.len() * PER_SEGMENT + 1);
        let mut total = 0.0;
        let (mut last_pos, mut last_th) = segments[0].eval(0.0);
        table.push((0.0, 0, 0.0));
        let mut waypoint_s = vec![0.0];
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
            waypoint_s.push(total);
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
        Ok(GeometricPath { points, ds, length: total, waypoint_s })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wp(x: f64, y: f64, h: Option<f64>) -> Waypoint {
        Waypoint { x, y, heading_deg: h, ..Default::default() }
    }

    fn spec(w: Vec<Waypoint>) -> PathSpec {
        PathSpec::new("t", w)
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

#[cfg(test)]
mod format_tests {
    use super::*;

    #[test]
    fn reads_what_the_editor_writes_and_writes_it_back() {
        let text = r#"{
          "name": "p",
          "waypoints": [
            {"x": 1, "y": 2, "headingDeg": 0, "kind": "pose"},
            {"x": 3, "y": 4, "kind": "empty", "intervals": 12, "split": true},
            {"x": 5, "y": 6, "kind": "translation"}
          ],
          "constraints": {},
          "scoped": [
            {"type": "stopPoint", "from": "first"},
            {"type": "maxVelocity", "mps": 2, "from": {"index": 1}, "to": "last"},
            {"type": "pointAt", "x": 8, "y": 4, "toleranceDeg": 5, "flip": true, "from": "first", "to": "last", "enabled": false}
          ],
          "events": [{"name": "intake", "target": {"index": 1}, "offsetS": -0.25}]
        }"#;
        let spec: PathSpec = serde_json::from_str(text).unwrap();
        assert_eq!(spec.waypoints[1].kind(), WaypointKind::Empty);
        assert_eq!(spec.waypoints[1].intervals, Some(12));
        assert_eq!(spec.scoped[1].from, Target::Index(1));
        assert_eq!(spec.scoped[1].to, Some(Target::Last));
        assert!(!spec.scoped[2].enabled);
        assert_eq!(spec.scoped[2].kind, ConstraintKind::PointAt { x: 8.0, y: 4.0, tolerance_deg: 5.0, flip: true });
        let back: PathSpec = serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(back, spec);
    }

    #[test]
    fn old_files_stop_at_both_ends() {
        let spec: PathSpec = serde_json::from_str(r#"{"name": "old", "waypoints": [{"x": 0, "y": 0}, {"x": 1, "y": 0, "headingDeg": 90}]}"#).unwrap();
        assert_eq!(spec.scoped, default_scoped());
        assert_eq!(spec.waypoints[1].kind(), WaypointKind::Pose);
        assert_eq!(spec.waypoints[0].kind(), WaypointKind::Translation);
    }
}
