//! The project on disk: the folder that holds the robot.json.
//!
//! ```text
//! offseason2026/
//!   offseason2026.robot.json
//!   field.json                 keep-out zones, shared by every path
//!   paths/hub-run.path.json    what the user draws
//!   trajectories/hub-run.traj.json   what the planner made of it, for the robot
//! ```
//!
//! Paths and trajectories are separate files on purpose: the path is the
//! source, edited by hand and diffed in git; the trajectory is generated, and
//! the robot code only ever reads that one.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use ares_core::{solve, PathSpec, RobotConfig, SolverOptions, Trajectory};
use ares_planner::{plan, Environment, FieldSize, PlannerOptions};
use serde::{Deserialize, Serialize};

const PATH_EXT: &str = ".path.json";
const TRAJ_EXT: &str = ".traj.json";

/// The field as Ares plans against it. Walls are on unless the file says
/// otherwise; the size comes from the field image's calibration.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDoc {
    #[serde(default = "yes")]
    pub walls: bool,
    #[serde(default)]
    pub keep_out: Vec<ares_planner::KeepOutCircle>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slow_zones: Vec<ares_planner::SlowZone>,
}

fn yes() -> bool {
    true
}

impl Default for FieldDoc {
    fn default() -> Self {
        FieldDoc { walls: true, keep_out: vec![], slow_zones: vec![] }
    }
}

fn project_dir(robot_path: &str) -> PathBuf {
    Path::new(robot_path).parent().unwrap_or(Path::new(".")).to_path_buf()
}

/// A path's name as a file name: what the user typed, minus what a file
/// system or a URL would choke on.
fn file_stem(name: &str) -> Result<String, String> {
    let stem: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if stem.is_empty() {
        Err("A path needs a name".into())
    } else {
        Ok(stem)
    }
}

fn path_file(robot_path: &str, name: &str) -> Result<PathBuf, String> {
    Ok(project_dir(robot_path).join("paths").join(format!("{}{PATH_EXT}", file_stem(name)?)))
}

fn traj_file(robot_path: &str, name: &str) -> Result<PathBuf, String> {
    // "Path@variant" names a variant's trajectory.
    let stem = match name.split_once('@') {
        Some((path, variant)) => format!("{}@{}", file_stem(path)?, file_stem(variant)?),
        None => file_stem(name)?,
    };
    Ok(project_dir(robot_path).join("trajectories").join(format!("{stem}{TRAJ_EXT}")))
}

const AUTO_EXT: &str = ".auto.json";

fn auto_file(robot_path: &str, name: &str) -> Result<PathBuf, String> {
    Ok(project_dir(robot_path).join("autos").join(format!("{}{AUTO_EXT}", file_stem(name)?)))
}

/// A fingerprint of what a trajectory comes from. FNV-1a over the JSON: not
/// cryptographic, only "did anything change".
pub fn source_hash(parts: &[&serde_json::Value]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in p.to_string().bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    format!("{h:016x}")
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    fs::write(path, text).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// Every path in the project, sorted by name. Files that do not parse are
/// listed with their error instead of hidden.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    name: String,
    spec: Option<PathSpec>,
    error: Option<String>,
}

#[tauri::command]
pub fn paths_list(robot_path: String) -> Vec<PathEntry> {
    let dir = project_dir(&robot_path).join("paths");
    let Ok(entries) = fs::read_dir(&dir) else { return vec![] };
    let mut out: Vec<PathEntry> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            let stem = file.strip_suffix(PATH_EXT)?.to_string();
            let parsed = fs::read_to_string(e.path())
                .map_err(|err| err.to_string())
                .and_then(|t| serde_json::from_str::<PathSpec>(&t).map_err(|err| err.to_string()));
            Some(match parsed {
                Ok(spec) => PathEntry { name: spec.name.clone(), spec: Some(spec), error: None },
                Err(error) => PathEntry { name: stem, spec: None, error: Some(error) },
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Saves a path under its name. `previous` is the name it had, so a rename
/// moves the file (and its trajectory) instead of leaving a copy behind.
#[tauri::command]
pub fn path_save(robot_path: String, spec: PathSpec, previous: Option<String>) -> Result<(), String> {
    let target = path_file(&robot_path, &spec.name)?;
    if let Some(prev) = previous.filter(|p| file_stem(p).ok() != file_stem(&spec.name).ok()) {
        if target.exists() {
            return Err(format!("There is already a path called \"{}\"", spec.name));
        }
        let old = path_file(&robot_path, &prev)?;
        let _ = fs::remove_file(old);
        let old_traj = traj_file(&robot_path, &prev)?;
        if old_traj.exists() {
            let _ = fs::rename(old_traj, traj_file(&robot_path, &spec.name)?);
        }
    }
    let text = serde_json::to_string_pretty(&spec).map_err(|e| e.to_string())?;
    write(&target, &(text + "\n"))
}

#[tauri::command]
pub fn path_delete(robot_path: String, name: String) -> Result<(), String> {
    let _ = fs::remove_file(traj_file(&robot_path, &name)?);
    fs::remove_file(path_file(&robot_path, &name)?).map_err(|e| e.to_string())
}

/// The project's variables (variables.json). The app owns their meaning;
/// here they are only stored, as written.
#[tauri::command]
pub fn variables_open(robot_path: String) -> serde_json::Value {
    fs::read_to_string(project_dir(&robot_path).join("variables.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({ "variables": [] }))
}

#[tauri::command]
pub fn variables_save(robot_path: String, doc: serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write(&project_dir(&robot_path).join("variables.json"), &(text + "\n"))
}

/// The trajectory last generated for a path, if there is one on disk.
#[tauri::command]
pub fn trajectory_open(robot_path: String, name: String) -> Option<Trajectory> {
    let text = fs::read_to_string(traj_file(&robot_path, &name).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub fn field_open(robot_path: String) -> FieldDoc {
    fs::read_to_string(project_dir(&robot_path).join("field.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn field_save(robot_path: String, field: FieldDoc) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&field).map_err(|e| e.to_string())?;
    write(&project_dir(&robot_path).join("field.json"), &(text + "\n"))
}

/// The most samples the drag preview sends to the UI.
const PREVIEW_SAMPLES: usize = 250;

/// A path whose start continues another one starts where that one's
/// generated trajectory ends: the first waypoint takes its pose, and the
/// returned velocity is where the optimizer starts. Unlinked, nothing
/// changes.
pub fn link_start(robot_path: &str, spec: &mut PathSpec) -> Result<Option<[f64; 3]>, String> {
    let Some(prev) = spec.continues_from.clone() else { return Ok(None) };
    let traj = trajectory_open(robot_path.to_string(), prev.clone())
        .ok_or_else(|| format!("\"{prev}\" has no generated trajectory to continue from: generate it first"))?;
    // From its end, or (a branch) from one of its waypoints, at the state the
    // robot has there.
    let end = match spec.continues_at {
        Some(j) => {
            let t = traj
                .waypoint_times
                .get(j)
                .copied()
                .ok_or_else(|| format!("\"{prev}\" has no waypoint {}", j + 1))?;
            traj.sample_at(t)
        }
        None => traj.samples.last().cloned().ok_or_else(|| format!("\"{prev}\" has an empty trajectory"))?,
    };
    if let Some(w) = spec.waypoints.first_mut() {
        w.x = end.x;
        w.y = end.y;
        w.heading_deg = Some(end.heading.to_degrees());
        if w.kind() != ares_core::path::WaypointKind::Continue {
            w.kind = Some(ares_core::path::WaypointKind::Continue);
        }
    }
    Ok(Some([end.vx, end.vy, end.omega]))
}

/// Stage 1 only: the spline through the waypoints, timed. The editor calls it
/// on every drag, so it sends a light copy: a few hundred samples, without
/// the per-module data (a full one is ~300 KB of JSON per mouse move).
#[tauri::command]
pub fn path_time(robot: RobotConfig, spec: PathSpec, robot_path: Option<String>) -> Result<Trajectory, String> {
    let mut spec = spec;
    if let Some(rp) = robot_path.as_ref() {
        // The guess starts where a continued path ends, too. A missing
        // trajectory is not an error here: the guess just starts at the hint.
        let _ = link_start(rp, &mut spec);
    }
    let mut t = solve(&robot, &spec, &SolverOptions::default()).map_err(|e| e.to_string())?;
    let step = t.samples.len().div_ceil(PREVIEW_SAMPLES).max(1);
    let last = t.samples.len() - 1;
    t.samples = t
        .samples
        .into_iter()
        .enumerate()
        .filter(|(i, _)| i % step == 0 || *i == last)
        .map(|(_, mut s)| {
            s.modules.clear();
            s
        })
        .collect();
    Ok(t)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResult {
    trajectory: Trajectory,
    spline_duration_s: f64,
    iterations: u32,
    solve_ms: f64,
}

/// Both stages, off the UI thread. With `robot_path`, the trajectory is also
/// written where the robot code will look for it.
#[tauri::command]
pub async fn path_plan(
    robot: RobotConfig,
    spec: PathSpec,
    field: FieldDoc,
    field_size: Option<FieldSize>,
    robot_path: Option<String>,
    variant: Option<String>,
) -> Result<PlanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        // What it is generated from, before anything below changes it.
        let json = |v: serde_json::Result<serde_json::Value>| v.unwrap_or(serde_json::Value::Null);
        let hash = source_hash(&[&json(serde_json::to_value(&spec)), &json(serde_json::to_value(&field)), &json(serde_json::to_value(&robot))]);
        let mut spec = spec;
        let mut options = PlannerOptions::default();
        if let Some(rp) = robot_path.as_ref() {
            options.start_state = link_start(rp, &mut spec)?;
        }
        let env = Environment { field: if field.walls { field_size } else { None }, keep_out: field.keep_out, slow_zones: field.slow_zones };
        let mut planned = plan(&robot, &spec, &env, &options).map_err(|e| e.to_string())?;
        planned.trajectory.variant = variant.clone();
        planned.trajectory.source_hash = Some(hash);
        if let Some(rp) = robot_path {
            let text = serde_json::to_string(&planned.trajectory).map_err(|e| e.to_string())?;
            let name = match &variant {
                Some(v) => format!("{}@{v}", spec.name),
                None => spec.name.clone(),
            };
            write(&traj_file(&rp, &name)?, &text)?;
            let _ = index_write(rp);
        }
        Ok(PlanResult {
            trajectory: planned.trajectory,
            spline_duration_s: planned.spline_duration_s,
            iterations: planned.iterations,
            solve_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStatus {
    name: String,
    generated: bool,
    /// Generated from something else than what is there now.
    outdated: bool,
    duration_s: Option<f64>,
}

/// For each path: is there a trajectory, and was it generated from what the
/// path, the field and the robot are now.
#[tauri::command]
pub fn paths_status(robot_path: String, robot: RobotConfig, field: FieldDoc) -> Vec<PathStatus> {
    let json = |v: serde_json::Result<serde_json::Value>| v.unwrap_or(serde_json::Value::Null);
    let (field_json, robot_json) = (json(serde_json::to_value(&field)), json(serde_json::to_value(&robot)));
    paths_list(robot_path.clone())
        .into_iter()
        .filter_map(|e| e.spec)
        .map(|spec| {
            let traj = trajectory_open(robot_path.clone(), spec.name.clone());
            let now = source_hash(&[&json(serde_json::to_value(&spec)), &field_json, &robot_json]);
            PathStatus {
                generated: traj.is_some(),
                outdated: traj.as_ref().is_none_or(|t| t.source_hash.as_deref() != Some(now.as_str())),
                duration_s: traj.as_ref().map(|t| t.duration_s),
                name: spec.name,
            }
        })
        .collect()
}

/// Every auto in the project, sorted by name, as stored.
#[tauri::command]
pub fn autos_list(robot_path: String) -> Vec<serde_json::Value> {
    let dir = project_dir(&robot_path).join("autos");
    let Ok(entries) = fs::read_dir(&dir) else { return vec![] };
    let mut out: Vec<serde_json::Value> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(AUTO_EXT))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str(&t).ok())
        .collect();
    out.sort_by_key(|a| a["name"].as_str().unwrap_or("").to_lowercase());
    out
}

#[tauri::command]
pub fn auto_save(robot_path: String, auto: serde_json::Value, previous: Option<String>) -> Result<(), String> {
    let name = auto["name"].as_str().ok_or("An auto needs a name")?.to_string();
    let target = auto_file(&robot_path, &name)?;
    if let Some(prev) = previous.filter(|p| file_stem(p).ok() != file_stem(&name).ok()) {
        if target.exists() {
            return Err(format!("There is already an auto called \"{name}\""));
        }
        let _ = fs::remove_file(auto_file(&robot_path, &prev)?);
    }
    let text = serde_json::to_string_pretty(&auto).map_err(|e| e.to_string())?;
    write(&target, &(text + "\n"))?;
    let _ = index_write(robot_path);
    Ok(())
}

#[tauri::command]
pub fn auto_delete(robot_path: String, name: String) -> Result<(), String> {
    fs::remove_file(auto_file(&robot_path, &name)?).map_err(|e| e.to_string())?;
    let _ = index_write(robot_path);
    Ok(())
}

/// `ares-index.json`: everything the robot code needs to find its way, in
/// one file. Each path with its trajectory file, sections, variants and the
/// branches that leave it (with their conditions); and every auto as
/// written. Rewritten after every generate and every auto save.
#[tauri::command]
pub fn index_write(robot_path: String) -> Result<(), String> {
    let entries = paths_list(robot_path.clone());
    let specs: Vec<&PathSpec> = entries.iter().filter_map(|e| e.spec.as_ref()).collect();
    let rel = |name: &str| traj_file(&robot_path, name).ok().map(|p| {
        p.strip_prefix(project_dir(&robot_path)).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()
    });
    let paths: Vec<serde_json::Value> = specs
        .iter()
        .map(|s| {
            let traj = trajectory_open(robot_path.clone(), s.name.clone());
            let branches: Vec<serde_json::Value> = specs
                .iter()
                .filter(|c| c.continues_from.as_deref() == Some(s.name.as_str()) && c.continues_at.is_some())
                .map(|c| serde_json::json!({
                    "atWaypoint": c.continues_at,
                    "atTime": traj.as_ref().and_then(|t| t.waypoint_times.get(c.continues_at.unwrap()).copied()),
                    "condition": c.condition,
                    "path": c.name,
                }))
                .collect();
            serde_json::json!({
                "name": s.name,
                "trajectory": rel(&s.name),
                "generated": traj.is_some(),
                "sections": traj.as_ref().map(|t| serde_json::to_value(&t.sections).unwrap_or_default()),
                "variants": s.variants.iter().map(|v| serde_json::json!({ "name": v.name, "trajectory": rel(&format!("{}@{}", s.name, v.name)) })).collect::<Vec<_>>(),
                "continuesFrom": s.continues_from,
                "continuesAt": s.continues_at,
                "condition": s.condition,
                "branches": branches,
            })
        })
        .collect();
    let index = serde_json::json!({ "format": 1, "paths": paths, "autos": autos_list(robot_path.clone()) });
    let text = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    write(&project_dir(&robot_path).join("ares-index.json"), &(text + "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ares_core::path::Waypoint;

    fn temp_project(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("ares-project-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("bot.robot.json").to_string_lossy().into_owned()
    }

    fn spec(name: &str) -> PathSpec {
        PathSpec::new(name, vec![
                Waypoint { x: 1.0, y: 1.0, heading_deg: Some(0.0), ..Default::default() },
                Waypoint { x: 3.0, y: 2.0, heading_deg: None, ..Default::default() },
            ])
    }

    #[test]
    fn save_list_rename_delete() {
        let rp = temp_project("crud");
        path_save(rp.clone(), spec("Hub run"), None).unwrap();
        path_save(rp.clone(), spec("Amp"), None).unwrap();
        let names: Vec<String> = paths_list(rp.clone()).into_iter().map(|p| p.name).collect();
        assert_eq!(names, ["Amp", "Hub run"]);

        path_save(rp.clone(), spec("Hub run 2"), Some("Hub run".into())).unwrap();
        let names: Vec<String> = paths_list(rp.clone()).into_iter().map(|p| p.name).collect();
        assert_eq!(names, ["Amp", "Hub run 2"]);
        assert!(path_save(rp.clone(), spec("Amp"), Some("Hub run 2".into())).is_err(), "rename onto another path");

        path_delete(rp.clone(), "Amp".into()).unwrap();
        assert_eq!(paths_list(rp).len(), 1);
    }

    #[test]
    fn a_broken_file_is_listed_with_its_error() {
        let rp = temp_project("broken");
        write(&project_dir(&rp).join("paths").join(format!("bad{PATH_EXT}")), "{ nope").unwrap();
        let list = paths_list(rp);
        assert_eq!(list.len(), 1);
        assert!(list[0].error.is_some() && list[0].spec.is_none());
    }

    #[test]
    fn a_continued_path_starts_where_the_other_ended() {
        let rp = temp_project("chain");
        let first = PathSpec::new("First", vec![
            Waypoint { x: 1.0, y: 1.0, heading_deg: Some(0.0), ..Default::default() },
            Waypoint { x: 4.0, y: 2.0, heading_deg: Some(90.0), ..Default::default() },
        ]);
        let traj = solve(&crate::tests_robot(), &first, &SolverOptions::default()).unwrap();
        write(&traj_file(&rp, "First").unwrap(), &serde_json::to_string(&traj).unwrap()).unwrap();
        let mut second = spec("Second");
        second.continues_from = Some("First".into());
        let v = link_start(&rp, &mut second).unwrap();
        assert!(v.is_some());
        let w = &second.waypoints[0];
        assert!((w.x - 4.0).abs() < 1e-6 && (w.y - 2.0).abs() < 1e-6);
        assert!((w.heading_deg.unwrap() - 90.0).abs() < 1e-6);
        assert_eq!(w.kind(), ares_core::path::WaypointKind::Continue);
        // Nothing to continue from: a clear error, not a silent start.
        let mut orphan = spec("Orphan");
        orphan.continues_from = Some("Missing".into());
        assert!(link_start(&rp, &mut orphan).is_err());
    }

    #[test]
    fn a_branch_starts_at_its_parents_waypoint_state() {
        let rp = temp_project("branch");
        let parent = PathSpec::new("Parent", vec![
            Waypoint { x: 1.0, y: 1.0, heading_deg: Some(0.0), ..Default::default() },
            Waypoint { x: 4.0, y: 1.0, ..Default::default() },
            Waypoint { x: 7.0, y: 1.0, heading_deg: Some(0.0), ..Default::default() },
        ]);
        let traj = solve(&crate::tests_robot(), &parent, &SolverOptions::default()).unwrap();
        write(&traj_file(&rp, "Parent").unwrap(), &serde_json::to_string(&traj).unwrap()).unwrap();
        let mut child = spec("Child");
        child.continues_from = Some("Parent".into());
        child.continues_at = Some(1);
        let v = link_start(&rp, &mut child).unwrap().unwrap();
        assert!((child.waypoints[0].x - 4.0).abs() < 1e-3, "{}", child.waypoints[0].x);
        assert!(v[0] > 1.0, "a branch leaves moving, at {} m/s", v[0]);
    }

    #[test]
    fn variants_have_their_own_trajectory_files() {
        let rp = temp_project("variant");
        assert!(traj_file(&rp, "Pick up@note 2").unwrap().ends_with("trajectories/Pick-up@note-2.traj.json"));
    }

    #[test]
    fn autos_crud_and_the_index() {
        let rp = temp_project("autos");
        path_save(rp.clone(), spec("Out"), None).unwrap();
        let mut b = spec("Branch");
        b.continues_from = Some("Out".into());
        b.continues_at = Some(0);
        b.condition = Some("hasNote".into());
        path_save(rp.clone(), b, None).unwrap();
        auto_save(rp.clone(), serde_json::json!({ "name": "Four piece", "steps": [{ "type": "path", "path": "Out" }] }), None).unwrap();
        assert_eq!(autos_list(rp.clone()).len(), 1);
        index_write(rp.clone()).unwrap();
        let index: serde_json::Value = serde_json::from_str(&fs::read_to_string(project_dir(&rp).join("ares-index.json")).unwrap()).unwrap();
        let out = index["paths"].as_array().unwrap().iter().find(|p| p["name"] == "Out").unwrap();
        assert_eq!(out["branches"][0]["condition"], "hasNote");
        assert_eq!(index["autos"][0]["name"], "Four piece");
        auto_delete(rp.clone(), "Four piece".into()).unwrap();
        assert!(autos_list(rp).is_empty());
    }

    #[test]
    fn status_says_when_a_trajectory_is_out_of_date() {
        let rp = temp_project("status");
        let s = spec("P");
        path_save(rp.clone(), s.clone(), None).unwrap();
        let robot = crate::tests_robot();
        let field = FieldDoc::default();
        assert!(!paths_status(rp.clone(), robot.clone(), field.clone())[0].generated);
        let json = |v: serde_json::Result<serde_json::Value>| v.unwrap();
        let mut t = solve(&robot, &s, &SolverOptions::default()).unwrap();
        t.source_hash = Some(source_hash(&[&json(serde_json::to_value(&s)), &json(serde_json::to_value(&field)), &json(serde_json::to_value(&robot))]));
        write(&traj_file(&rp, "P").unwrap(), &serde_json::to_string(&t).unwrap()).unwrap();
        let st = &paths_status(rp.clone(), robot.clone(), field.clone())[0];
        assert!(st.generated && !st.outdated);
        let mut moved = s.clone();
        moved.waypoints[1].x += 0.5;
        path_save(rp.clone(), moved, Some("P".into())).unwrap();
        assert!(paths_status(rp, robot, field)[0].outdated);
    }

    #[test]
    fn names_become_safe_file_names() {
        assert_eq!(file_stem("  Hub run / left  ").unwrap(), "Hub-run---left");
        assert!(file_stem("///").is_err());
    }
}
