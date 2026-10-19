//! What the robot's cameras see: AprilTags on the field, from a pose.
//!
//! A camera sees a tag when the tag is in front of it, inside both halves of its field of view,
//! within its range, turned toward it (a tag seen nearly edge-on is not read), and nothing on the
//! field stands between them: the field's structures are [`Occluder`]s, a 2.5D map (footprints
//! with a height), so a camera in front of the hub sees the two tags on its face and not the ones
//! on the sides or behind it. No image noise; [`pose_sigma`] models what that does to the pose.
//!
//! [`aims`] is what the planner's "see AprilTags" constraint is built from: along a stretch of
//! the path, which camera should face which tag so that the most tags stay in view.

use serde::{Deserialize, Serialize};

use crate::robot::{CameraConfig, RobotConfig};

/// A tag read edge-on beyond this angle from its face is not detected.
pub const MAX_TAG_ANGLE_DEG: f64 = 70.0;

/// An AprilTag on the field: its center and the direction its face looks (unit vector).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub nx: f64,
    pub ny: f64,
    pub nz: f64,
}

/// A structure on the field that blocks the view: a rectangle (center, size along its own X and
/// Y, turned by `yaw_deg`) from `z_min_m` up to `z_max_m`. A 2.5D map: footprints with a height.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Occluder {
    #[serde(default)]
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub length_m: f64,
    pub width_m: f64,
    #[serde(default)]
    pub yaw_deg: f64,
    #[serde(default)]
    pub z_min_m: f64,
    pub z_max_m: f64,
}

/// What the cameras look at: the tags, and what stands in the way.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct World {
    pub tags: Vec<Tag>,
    pub occluders: Vec<Occluder>,
}

/// The last bit of a sight line left out of the occlusion test: the tag sits on its own
/// structure's face, and the line must not count that face as in the way.
const SURFACE_M: f64 = 0.03;

impl Occluder {
    /// Whether the segment from `a` to `b` (3D, field frame) passes through it, the last
    /// `SURFACE_M` of it excepted.
    pub fn blocks(&self, a: [f64; 3], b: [f64; 3]) -> bool {
        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt();
        if len < 1e-9 {
            return false;
        }
        let t_end = 1.0 - SURFACE_M / len;
        if t_end <= 0.0 {
            return false;
        }
        // Into the rectangle's frame.
        let (c, s) = (self.yaw_deg.to_radians().cos(), self.yaw_deg.to_radians().sin());
        let local = |p: [f64; 3]| {
            let (dx, dy) = (p[0] - self.x, p[1] - self.y);
            (c * dx + s * dy, -s * dx + c * dy)
        };
        let (ax, ay) = local(a);
        let (bx, by) = local(b);
        let (dx, dy) = (bx - ax, by - ay);
        // Liang and Barsky's clipping against the footprint.
        let (mut t0, mut t1) = (0.0_f64, t_end);
        for (p, q) in [
            (-dx, ax + self.length_m / 2.0),
            (dx, self.length_m / 2.0 - ax),
            (-dy, ay + self.width_m / 2.0),
            (dy, self.width_m / 2.0 - ay),
        ] {
            if p.abs() < 1e-12 {
                if q < 0.0 {
                    return false;
                }
            } else {
                let r = q / p;
                if p < 0.0 {
                    t0 = t0.max(r);
                } else {
                    t1 = t1.min(r);
                }
            }
            if t0 > t1 {
                return false;
            }
        }
        // Over that stretch the height is linear: does it cross [z_min, z_max]?
        let (z0, z1) = (a[2] + (b[2] - a[2]) * t0, a[2] + (b[2] - a[2]) * t1);
        z0.min(z1) <= self.z_max_m && z0.max(z1) >= self.z_min_m
    }
}

/// Structures estimated from the tags, for a field whose map nobody drew: tags within 1.6 m of
/// each other that face at least two ways (the hub has tags on all four faces) are one structure,
/// as big as the box around them and 0.6 m taller than its highest tag. A row of tags on a wall
/// faces one way and makes none. Rough on purpose: draw the real ones in the Field tab.
pub fn estimate_occluders(tags: &[Tag]) -> Vec<Occluder> {
    let n = tags.len();
    let mut group: Vec<usize> = (0..n).collect();
    fn root(g: &mut [usize], i: usize) -> usize {
        let mut r = i;
        while g[r] != r {
            r = g[r];
        }
        g[i] = r;
        r
    }
    for i in 0..n {
        for j in i + 1..n {
            if (tags[i].x - tags[j].x).hypot(tags[i].y - tags[j].y) < 1.6 {
                let (a, b) = (root(&mut group, i), root(&mut group, j));
                group[a] = b;
            }
        }
    }
    let mut clusters: std::collections::BTreeMap<usize, Vec<&Tag>> = Default::default();
    for i in 0..n {
        let r = root(&mut group, i);
        clusters.entry(r).or_default().push(&tags[i]);
    }
    clusters
        .values()
        .filter(|c| c.len() >= 3)
        // At least two faces more than 60 degrees apart.
        .filter(|c| c.iter().any(|a| c.iter().any(|b| a.nx * b.nx + a.ny * b.ny < 0.5)))
        .map(|c| {
            let (x0, x1) = c.iter().fold((f64::MAX, f64::MIN), |(lo, hi), t| (lo.min(t.x), hi.max(t.x)));
            let (y0, y1) = c.iter().fold((f64::MAX, f64::MIN), |(lo, hi), t| (lo.min(t.y), hi.max(t.y)));
            let top = c.iter().map(|t| t.z).fold(f64::MIN, f64::max);
            let mut ids: Vec<u32> = c.iter().map(|t| t.id).collect();
            ids.sort_unstable();
            Occluder {
                name: format!("structure of tags {}-{}", ids[0], ids[ids.len() - 1]),
                x: (x0 + x1) / 2.0,
                y: (y0 + y1) / 2.0,
                length_m: (x1 - x0).max(0.1),
                width_m: (y1 - y0).max(0.1),
                yaw_deg: 0.0,
                z_min_m: 0.0,
                z_max_m: top + 0.6,
            }
        })
        .collect()
}

/// The tags of a WPILib AprilTag layout (`2026-rebuilt-welded.json` and the like): each tag's
/// face looks along its pose's X axis.
pub fn tags_from_wpilib_layout(json: &str) -> Result<Vec<Tag>, serde_json::Error> {
    #[derive(Deserialize)]
    struct Layout {
        tags: Vec<LayoutTag>,
    }
    #[derive(Deserialize)]
    struct LayoutTag {
        #[serde(rename = "ID")]
        id: u32,
        pose: LayoutPose,
    }
    #[derive(Deserialize)]
    struct LayoutPose {
        translation: Xyz,
        rotation: LayoutRotation,
    }
    #[derive(Deserialize)]
    struct Xyz {
        x: f64,
        y: f64,
        z: f64,
    }
    #[derive(Deserialize)]
    struct LayoutRotation {
        quaternion: Quaternion,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "UPPERCASE")]
    struct Quaternion {
        w: f64,
        x: f64,
        y: f64,
        z: f64,
    }
    let layout: Layout = serde_json::from_str(json)?;
    Ok(layout
        .tags
        .into_iter()
        .map(|t| {
            let Quaternion { w, x, y, z } = t.pose.rotation.quaternion;
            // The rotated X axis: the first column of the quaternion's matrix.
            Tag {
                id: t.id,
                x: t.pose.translation.x,
                y: t.pose.translation.y,
                z: t.pose.translation.z,
                nx: 1.0 - 2.0 * (y * y + z * z),
                ny: 2.0 * (x * y + w * z),
                nz: 2.0 * (x * z - w * y),
            }
        })
        .collect())
}

type M3 = [[f64; 3]; 3];

fn mul(a: &M3, b: &M3) -> M3 {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    r
}

fn rz(t: f64) -> M3 {
    let (c, s) = (t.cos(), t.sin());
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

fn ry(t: f64) -> M3 {
    let (c, s) = (t.cos(), t.sin());
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}

fn rx(t: f64) -> M3 {
    let (c, s) = (t.cos(), t.sin());
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}

/// Where a camera is on the field and how it is turned, with the robot at (x, y, heading).
pub struct CameraPose {
    pub position: [f64; 3],
    /// Columns: the camera's forward, left and up, in field coordinates.
    pub rotation: M3,
}

pub fn camera_pose(c: &CameraConfig, x: f64, y: f64, heading: f64) -> CameraPose {
    let (ch, sh) = (heading.cos(), heading.sin());
    let position = [x + ch * c.x_m - sh * c.y_m, y + sh * c.x_m + ch * c.y_m, c.z_m];
    // WPILib's Rotation3d(roll, pitch, yaw): about X, then Y, then Z, all fixed axes.
    let own = mul(&rz(c.yaw_deg.to_radians()), &mul(&ry(c.pitch_deg.to_radians()), &rx(c.roll_deg.to_radians())));
    CameraPose { position, rotation: mul(&rz(heading), &own) }
}

/// Whether the camera, posed as given, detects the tag.
pub fn sees(c: &CameraConfig, pose: &CameraPose, t: &Tag) -> bool {
    let d = [t.x - pose.position[0], t.y - pose.position[1], t.z - pose.position[2]];
    let dist = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    if dist < 1e-6 || dist > c.max_range_m {
        return false;
    }
    // Into the camera's frame: the transpose of its rotation.
    let r = &pose.rotation;
    let v = [0, 1, 2].map(|j| r[0][j] * d[0] + r[1][j] * d[1] + r[2][j] * d[2]);
    if v[0] <= 0.0 {
        return false;
    }
    if v[1].atan2(v[0]).abs() > c.horizontal_fov_deg.to_radians() / 2.0 {
        return false;
    }
    if v[2].atan2(v[0]).abs() > c.vertical_fov_deg.to_radians() / 2.0 {
        return false;
    }
    // The tag's face has to look back at the camera.
    let facing = -(t.nx * d[0] + t.ny * d[1] + t.nz * d[2]) / dist;
    facing >= MAX_TAG_ANGLE_DEG.to_radians().cos()
}

/// Whether the camera sees the tag and nothing on the field stands between them.
pub fn visible(c: &CameraConfig, pose: &CameraPose, t: &Tag, occluders: &[Occluder]) -> bool {
    sees(c, pose, t) && !occluders.iter().any(|o| o.blocks(pose.position, [t.x, t.y, t.z]))
}

/// Each camera's detected tags, with the robot at (x, y, heading): `(camera index, tag id)`.
pub fn detections(robot: &RobotConfig, world: &World, x: f64, y: f64, heading: f64) -> Vec<(usize, u32)> {
    let mut out = Vec::new();
    for (i, c) in robot.cameras.iter().enumerate() {
        let pose = camera_pose(c, x, y, heading);
        out.extend(world.tags.iter().filter(|t| visible(c, &pose, t, &world.occluders)).map(|t| (i, t.id)));
    }
    out
}

/// Along a stretch of path, one camera facing one tag: the planner keeps the camera's axis
/// within `tolerance_rad` of the tag (a point-at, seen from the robot's center).
#[derive(Clone, Debug, PartialEq)]
pub struct Aim {
    /// Samples, both included.
    pub from: usize,
    pub to: usize,
    pub camera: usize,
    pub tag: u32,
    pub target: [f64; 2],
    /// The camera's yaw on the robot: the side that faces the target.
    pub offset_rad: f64,
    pub tolerance_rad: f64,
    /// The heading that aims it, at each sample of the stretch: for the solver's first guess.
    pub headings: Vec<f64>,
}

fn wrap(a: f64) -> f64 {
    let t = std::f64::consts::TAU;
    (a + std::f64::consts::PI).rem_euclid(t) - std::f64::consts::PI
}

/// How many tags the allowed cameras detect, with the robot at (x, y, heading).
fn seen(robot: &RobotConfig, world: &World, cameras: &[usize], x: f64, y: f64, heading: f64) -> usize {
    cameras
        .iter()
        .map(|&i| {
            let c = &robot.cameras[i];
            let pose = camera_pose(c, x, y, heading);
            world.tags.iter().filter(|t| visible(c, &pose, t, &world.occluders)).count()
        })
        .sum()
}

/// The most tags the cameras can see from (x, y), turning to the best of `steps` headings, and
/// that heading. For the field's vision map and for looking where to detour.
pub fn best_view(robot: &RobotConfig, world: &World, x: f64, y: f64, steps: usize) -> (usize, f64) {
    let all: Vec<usize> = (0..robot.cameras.len()).collect();
    let steps = steps.max(1);
    (0..steps)
        .map(|k| {
            let h = std::f64::consts::TAU * k as f64 / steps as f64;
            (seen(robot, world, &all, x, y, h), h)
        })
        .fold((0, 0.0), |best, v| if v.0 > best.0 { v } else { best })
}

/// How well the robot knows where it is along a path, as one standard deviation (m) at each
/// pose `(t, x, y, heading, speed)`: the odometry drifts 2% of the distance driven, and every
/// sample with tags in view pulls it back as the robot's pose estimator does, with a measurement
/// sigma of 0.04 m x distance^2 / tags (clamped to [0.02, 4] m, worse above 2 m/s).
pub fn pose_sigma(robot: &RobotConfig, world: &World, poses: &[(f64, f64, f64, f64, f64)], start_sigma: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity(poses.len());
    let mut sigma = start_sigma;
    let mut last: Option<(f64, f64)> = None;
    for &(_, x, y, h, v) in poses {
        if let Some((px, py)) = last {
            sigma += ODOMETRY_DRIFT * (x - px).hypot(y - py);
        }
        last = Some((x, y));
        let mut d2 = 0.0;
        let mut n = 0usize;
        for (i, c) in robot.cameras.iter().enumerate() {
            let pose = camera_pose(c, x, y, h);
            for t in world.tags.iter().filter(|t| visible(c, &pose, t, &world.occluders)) {
                let _ = i;
                d2 += (t.x - pose.position[0]).powi(2) + (t.y - pose.position[1]).powi(2) + (t.z - pose.position[2]).powi(2);
                n += 1;
            }
        }
        if n > 0 {
            let mean_d2 = d2 / n as f64;
            let measured = (0.04 * mean_d2 / n as f64).clamp(0.02, 4.0) * (1.0 + (v / 2.0).max(0.0));
            sigma = 1.0 / (1.0 / (sigma * sigma) + 1.0 / (measured * measured)).sqrt();
        }
        out.push(sigma);
    }
    out
}

/// The odometry's drift, as a fraction of the distance driven.
pub const ODOMETRY_DRIFT: f64 = 0.02;

/// Which camera should face which tag at each pose `(x, y, heading)` of a stretch. The goal is
/// `min_tags` in view: among the aims that reach it, the one that turns least from the given
/// heading (and the one already held, while it still reaches it); where none does, the one that
/// sees the most. A target already within tolerance is not turned to at all. `skip` marks samples
/// left free (a pose waypoint already fixes its heading there). Only `camera` when it is named.
/// Short stretches are dropped, and the first sample after a change of target is left free, so
/// the robot has room to turn from one aim to the next.
pub fn aims(robot: &RobotConfig, world: &World, poses: &[(f64, f64, f64)], skip: &[bool], camera: Option<&str>, min_tags: usize) -> Vec<Aim> {
    let tags = &world.tags;
    let cameras: Vec<usize> = (0..robot.cameras.len()).filter(|&i| camera.is_none_or(|n| robot.cameras[i].name == n)).collect();
    if cameras.is_empty() || tags.is_empty() {
        return Vec::new();
    }
    let goal = min_tags.max(1);
    let tolerance = |c: usize| 0.35 * robot.cameras[c].horizontal_fov_deg.to_radians();
    // Per sample: the chosen (camera, tag, heading), or none.
    let mut picks: Vec<Option<(usize, u32, f64)>> = Vec::with_capacity(poses.len());
    let mut last: Option<(usize, u32)> = None;
    for (k, &(x, y, h)) in poses.iter().enumerate() {
        if skip.get(k).copied().unwrap_or(false) {
            picks.push(None);
            last = None;
            continue;
        }
        // (reaches the goal, score, held, turn, camera, tag, heading)
        let mut best: Option<(bool, usize, bool, f64, usize, u32, f64)> = None;
        for &ci in &cameras {
            let c = &robot.cameras[ci];
            for t in tags {
                let d = (t.x - x).hypot(t.y - y);
                if d > c.max_range_m || d < 0.3 {
                    continue;
                }
                // The smallest turn that brings the tag within tolerance of the camera's axis.
                let exact = h + wrap((t.y - y).atan2(t.x - x) - c.yaw_deg.to_radians() - h);
                let delta = exact - h;
                let tol = tolerance(ci);
                let heading = if delta.abs() <= tol { h } else { exact - delta.signum() * 0.8 * tol };
                let score = seen(robot, world, &cameras, x, y, heading);
                if score == 0 {
                    continue;
                }
                let cand = (score >= goal, score, last == Some((ci, t.id)), (heading - h).abs(), ci, t.id, heading);
                let better = match best {
                    None => true,
                    Some(b) => {
                        if cand.0 != b.0 {
                            cand.0
                        } else if cand.0 {
                            // Both reach it: the one held, then the smaller turn, then more tags.
                            (cand.2 && !b.2) || (cand.2 == b.2 && (cand.3 < b.3 - 1e-9 || ((cand.3 - b.3).abs() <= 1e-9 && cand.1 > b.1)))
                        } else {
                            // Neither does: more tags, then the one held, then the smaller turn.
                            cand.1 > b.1 || (cand.1 == b.1 && ((cand.2 && !b.2) || (cand.2 == b.2 && cand.3 < b.3)))
                        }
                    }
                };
                if better {
                    best = Some(cand);
                }
            }
        }
        let pick = best.map(|b| (b.4, b.5, b.6));
        last = pick.map(|(c, t, _)| (c, t));
        picks.push(pick);
    }
    // Runs of the same target become aims.
    let mut out = Vec::new();
    let mut k = 0;
    while k < picks.len() {
        let Some((c, t, _)) = picks[k] else {
            k += 1;
            continue;
        };
        let mut end = k;
        while end + 1 < picks.len() && picks[end + 1].is_some_and(|(c2, t2, _)| (c2, t2) == (c, t)) {
            end += 1;
        }
        // The first sample after another aim is left free to turn in.
        let from = if out.last().is_some_and(|a: &Aim| a.to + 1 == k) { k + 1 } else { k };
        if end >= from + 2 {
            let cam = &robot.cameras[c];
            let tag = tags.iter().find(|q| q.id == t).expect("picked from the list");
            out.push(Aim {
                from,
                to: end,
                camera: c,
                tag: t,
                target: [tag.x, tag.y],
                offset_rad: cam.yaw_deg.to_radians(),
                // Margin for the camera sitting off the robot's center and the tag's own size.
                tolerance_rad: tolerance(c),
                headings: picks[from..=end].iter().map(|p| p.expect("a run").2).collect(),
            });
        }
        k = end + 1;
    }
    out
}

/// The fraction of poses at which the cameras detect at least one tag.
pub fn coverage(robot: &RobotConfig, world: &World, poses: &[(f64, f64, f64)]) -> f64 {
    coverage_of(robot, world, poses, None, 1)
}

/// The fraction of poses at which `camera` (or any) detects at least `min_tags` tags.
pub fn coverage_of(robot: &RobotConfig, world: &World, poses: &[(f64, f64, f64)], camera: Option<&str>, min_tags: usize) -> f64 {
    if poses.is_empty() {
        return 0.0;
    }
    let cams: Vec<usize> = (0..robot.cameras.len()).filter(|&i| camera.is_none_or(|n| robot.cameras[i].name == n)).collect();
    poses.iter().filter(|&&(x, y, h)| seen(robot, world, &cams, x, y, h) >= min_tags.max(1)).count() as f64 / poses.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::robot::tests::offseason2026;

    fn camera(yaw_deg: f64) -> CameraConfig {
        CameraConfig {
            name: format!("cam{yaw_deg}"),
            x_m: 0.3,
            y_m: 0.0,
            z_m: 0.5,
            roll_deg: 0.0,
            pitch_deg: 0.0,
            yaw_deg,
            horizontal_fov_deg: 80.0,
            vertical_fov_deg: 56.0,
            max_range_m: 5.0,
            model: None,
        }
    }

    fn world(tags: &[Tag]) -> World {
        World { tags: tags.to_vec(), occluders: vec![] }
    }

    /// A tag at (x, y), 0.5 m up, facing the direction `facing_deg`.
    fn tag(id: u32, x: f64, y: f64, facing_deg: f64) -> Tag {
        let f = facing_deg.to_radians();
        Tag { id, x, y, z: 0.5, nx: f.cos(), ny: f.sin(), nz: 0.0 }
    }

    #[test]
    fn a_tag_ahead_and_facing_is_seen() {
        let c = camera(0.0);
        let t = tag(1, 3.0, 0.0, 180.0);
        assert!(sees(&c, &camera_pose(&c, 0.0, 0.0, 0.0), &t));
    }

    #[test]
    fn not_behind_not_outside_the_fov_not_too_far_not_edge_on() {
        let c = camera(0.0);
        let at_origin = camera_pose(&c, 0.0, 0.0, 0.0);
        assert!(!sees(&c, &at_origin, &tag(1, -3.0, 0.0, 0.0)), "behind");
        assert!(!sees(&c, &at_origin, &tag(2, 1.0, 3.0, -90.0)), "outside the 80 degree FOV");
        assert!(!sees(&c, &at_origin, &tag(3, 8.0, 0.0, 180.0)), "past its range");
        assert!(!sees(&c, &at_origin, &tag(4, 3.0, 0.0, 90.0)), "edge-on");
        assert!(!sees(&c, &at_origin, &tag(5, 3.0, 0.0, 0.0)), "facing away");
    }

    #[test]
    fn the_robot_heading_and_the_camera_yaw_both_turn_it() {
        let t = tag(1, 0.0, 3.0, -90.0);
        let front = camera(0.0);
        let left = camera(90.0);
        assert!(!sees(&front, &camera_pose(&front, 0.0, 0.0, 0.0), &t));
        assert!(sees(&front, &camera_pose(&front, 0.0, 0.0, std::f64::consts::FRAC_PI_2), &t));
        assert!(sees(&left, &camera_pose(&left, 0.0, 0.0, 0.0), &t));
    }

    #[test]
    fn wpilib_pitch_down_is_positive() {
        // A tag 2 m ahead on the floor: a camera pitched 40 degrees down sees it, one pitched up does not.
        let mut c = camera(0.0);
        let t = Tag { id: 1, x: 2.3, y: 0.0, z: 0.0, nx: -0.7071, ny: 0.0, nz: 0.7071 };
        c.pitch_deg = 40.0;
        assert!(sees(&c, &camera_pose(&c, 0.0, 0.0, 0.0), &t));
        c.pitch_deg = -40.0;
        assert!(!sees(&c, &camera_pose(&c, 0.0, 0.0, 0.0), &t));
    }

    #[test]
    fn aims_turn_a_camera_to_the_tags_with_the_smallest_turn() {
        let mut robot = offseason2026();
        robot.cameras = vec![camera(0.0), camera(180.0)];
        // Two tags on a wall at x = 0 facing +x; the robot drives along y at x = 3 heading +y,
        // where neither camera sees them.
        let tags = [tag(1, 0.0, 2.0, 0.0), tag(2, 0.0, 2.6, 0.0)];
        let poses: Vec<_> = (0..10).map(|i| (3.0, 1.0 + 0.2 * i as f64, std::f64::consts::FRAC_PI_2)).collect();
        assert_eq!(coverage(&robot, &world(&tags), &poses), 0.0);
        let a = aims(&robot, &world(&tags), &poses, &[false; 10], None, 1);
        assert!(!a.is_empty());
        // Every pose aimed as planned sees a tag.
        for aim in &a {
            for (k, h) in (aim.from..=aim.to).zip(&aim.headings) {
                let (x, y, _) = poses[k];
                assert!(!detections(&robot, &world(&tags), x, y, *h).is_empty(), "aimed sample {k} sees nothing");
                // With a camera on each end, one of them is always within about a quarter turn
                // (the front one while the tags are ahead, the back one once they are behind):
                // never the long way round.
                assert!(wrap(h - std::f64::consts::FRAC_PI_2).abs() <= 2.0 * std::f64::consts::FRAC_PI_3, "turned {h}");
            }
        }
    }

    #[test]
    fn a_named_camera_is_the_only_one_aimed_and_skipped_samples_stay_free() {
        let mut robot = offseason2026();
        robot.cameras = vec![camera(0.0), camera(180.0)];
        let tags = [tag(1, 0.0, 2.0, 0.0)];
        let poses: Vec<_> = (0..8).map(|i| (3.0, 1.0 + 0.2 * i as f64, 0.0)).collect();
        let mut skip = [false; 8];
        skip[0] = true;
        let a = aims(&robot, &world(&tags), &poses, &skip, Some("cam180"), 1);
        assert!(a.iter().all(|x| x.camera == 1 && x.from >= 1));
    }

    #[test]
    fn reads_wpilibs_layout_with_each_face_pointing_out() {
        let tags = tags_from_wpilib_layout(include_str!("../../app/src/field/tags/2026-rebuilt-welded.json")).unwrap();
        assert_eq!(tags.len(), 32);
        // Tag 1 is turned 180 degrees: its face looks toward -X.
        let t1 = tags.iter().find(|t| t.id == 1).unwrap();
        assert!((t1.nx + 1.0).abs() < 1e-9 && t1.ny.abs() < 1e-9, "{t1:?}");
        for t in &tags {
            assert!(((t.nx * t.nx + t.ny * t.ny + t.nz * t.nz).sqrt() - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn no_cameras_or_no_tags_no_aims() {
        let robot = offseason2026();
        assert!(aims(&robot, &world(&[tag(1, 0.0, 0.0, 0.0)]), &[(1.0, 0.0, 0.0)], &[false], None, 1).is_empty());
    }

    /// The 2026 hub's front, sides and back: a box around its tags, as the estimate makes it.
    fn hub() -> (Vec<Tag>, Vec<Occluder>) {
        let tags = tags_from_wpilib_layout(include_str!("../../app/src/field/tags/2026-rebuilt-welded.json")).unwrap();
        let hub_ids = [18, 19, 20, 21, 24, 25, 26, 27];
        let hub: Vec<Tag> = tags.into_iter().filter(|t| hub_ids.contains(&t.id)).collect();
        let occ = estimate_occluders(&hub);
        (hub, occ)
    }

    #[test]
    fn the_hub_is_estimated_from_its_tags_and_a_wall_row_is_not() {
        let (hub, occ) = hub();
        assert_eq!(occ.len(), 1, "{occ:?}");
        let o = &occ[0];
        assert!(o.length_m > 0.9 && o.length_m < 1.4 && o.width_m > 0.9 && o.width_m < 1.4, "{o:?}");
        assert!(o.z_max_m > 1.5, "{o:?}");
        assert!(hub.iter().all(|t| (t.x - o.x).abs() <= o.length_m / 2.0 + 1e-9 && (t.y - o.y).abs() <= o.width_m / 2.0 + 1e-9));
        // Three tags in a row on one wall face the same way: no structure.
        let wall = [tag(1, 0.0, 1.0, 0.0), tag(2, 0.0, 1.5, 0.0), tag(3, 0.0, 2.0, 0.0)];
        assert!(estimate_occluders(&wall).is_empty());
    }

    #[test]
    fn in_front_of_the_hub_only_its_face_is_seen() {
        let (hub, occ) = hub();
        let mut robot = offseason2026();
        let mut c = camera(0.0);
        c.horizontal_fov_deg = 100.0;
        robot.cameras = vec![c];
        // Two meters in front of the blue hub's face (tags 25 and 26 face -X), facing it.
        let face: Vec<&Tag> = hub.iter().filter(|t| t.id == 25 || t.id == 26).collect();
        let x = face[0].x - 2.5;
        let y = (face[0].y + face[1].y) / 2.0;
        let open = World { tags: hub.clone(), occluders: vec![] };
        let real = World { tags: hub.clone(), occluders: occ };
        let without: Vec<u32> = detections(&robot, &open, x, y, 0.0).into_iter().map(|d| d.1).collect();
        let with: Vec<u32> = detections(&robot, &real, x, y, 0.0).into_iter().map(|d| d.1).collect();
        assert!(with.contains(&25) && with.contains(&26), "{with:?}");
        assert!(with.iter().all(|id| *id == 25 || *id == 26), "the hub hides the rest: {with:?}");
        assert!(without.len() >= with.len());
    }

    #[test]
    fn an_occluder_blocks_through_its_height_only() {
        let o = Occluder { name: "box".into(), x: 2.0, y: 0.0, length_m: 1.0, width_m: 1.0, yaw_deg: 0.0, z_min_m: 0.0, z_max_m: 1.0 };
        assert!(o.blocks([0.0, 0.0, 0.5], [4.0, 0.0, 0.5]), "straight through");
        assert!(!o.blocks([0.0, 0.0, 1.5], [4.0, 0.0, 1.5]), "over it");
        assert!(!o.blocks([0.0, 2.0, 0.5], [4.0, 2.0, 0.5]), "beside it");
        assert!(!o.blocks([0.0, 0.0, 0.5], [1.5, 0.0, 0.5]), "a tag on its face is not hidden by it");
        let turned = Occluder { yaw_deg: 45.0, ..o.clone() };
        assert!(turned.blocks([0.0, 0.0, 0.5], [4.0, 0.0, 0.5]));
    }

    #[test]
    fn the_pose_drifts_without_tags_and_tightens_with_them() {
        let mut robot = offseason2026();
        robot.cameras = vec![camera(0.0)];
        let blind = World::default();
        let poses: Vec<_> = (0..11).map(|i| (0.1 * i as f64, 0.5 * i as f64, 0.0, 0.0, 1.0)).collect();
        let s = pose_sigma(&robot, &blind, &poses, 0.05);
        assert!((s[10] - (0.05 + ODOMETRY_DRIFT * 5.0)).abs() < 1e-9, "{s:?}");
        let seeing = World { tags: vec![tag(1, 8.0, 0.0, 180.0)], occluders: vec![] };
        let s2 = pose_sigma(&robot, &seeing, &poses, 0.5);
        // Blind (the tag out of range) it drifts like the odometry; once the tag is within 5 m
        // every sample pulls it in, more the closer it gets.
        assert!((s2[5] - (0.5 + ODOMETRY_DRIFT * 2.5)).abs() < 1e-9, "{s2:?}");
        assert!(s2[10] < s2[5] - 0.2 && s2.windows(2).skip(6).all(|w| w[1] < w[0]), "{s2:?}");
    }

    #[test]
    fn the_best_view_turns_to_the_tags() {
        let mut robot = offseason2026();
        robot.cameras = vec![camera(0.0)];
        let w = World { tags: vec![tag(1, 0.0, 3.0, -90.0)], occluders: vec![] };
        let (n, h) = best_view(&robot, &w, 0.0, 0.0, 24);
        assert_eq!(n, 1);
        assert!((h - std::f64::consts::FRAC_PI_2).abs() < 0.6, "{h}");
    }
}
