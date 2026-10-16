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
    Ok(project_dir(robot_path).join("trajectories").join(format!("{}{TRAJ_EXT}", file_stem(name)?)))
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
    let end = trajectory_open(robot_path.to_string(), prev.clone())
        .and_then(|t| t.samples.last().cloned())
        .ok_or_else(|| format!("\"{prev}\" has no generated trajectory to continue from: generate it first"))?;
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
) -> Result<PlanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut spec = spec;
        let mut options = PlannerOptions::default();
        if let Some(rp) = robot_path.as_ref() {
            options.start_state = link_start(rp, &mut spec)?;
        }
        let env = Environment { field: if field.walls { field_size } else { None }, keep_out: field.keep_out, slow_zones: field.slow_zones };
        let planned = plan(&robot, &spec, &env, &options).map_err(|e| e.to_string())?;
        if let Some(rp) = robot_path {
            let text = serde_json::to_string(&planned.trajectory).map_err(|e| e.to_string())?;
            write(&traj_file(&rp, &spec.name)?, &text)?;
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
    fn names_become_safe_file_names() {
        assert_eq!(file_stem("  Hub run / left  ").unwrap(), "Hub-run---left");
        assert!(file_stem("///").is_err());
    }
}
