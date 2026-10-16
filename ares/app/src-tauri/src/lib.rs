//! Ares' backend: the app's door into `ares-core`. Everything physical is
//! computed here, with the same code the solver uses, so what the robot
//! settings page shows is what the planner will assume.

mod project;

use std::fs;
use std::path::{Component, Path, PathBuf};

use ares_core::motor::MotorKind;
use ares_core::path::Waypoint;
use ares_core::robot::GRAVITY;
use ares_core::{solve, PathSpec, RobotConfig, SolverOptions};
use serde::Serialize;

/// A robot mesh weighs a few MB; past this, the wrong file was picked and
/// loading it would leave the webview out of memory.
const MAX_MODEL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MotorInfo {
    id: MotorKind,
    stall_torque_nm: f64,
    stall_current_a: f64,
    free_speed_rpm: f64,
}

#[tauri::command]
fn motors() -> Vec<MotorInfo> {
    MotorKind::ALL
        .iter()
        .map(|&id| {
            let m = id.motor();
            MotorInfo {
                id,
                stall_torque_nm: m.stall_torque,
                stall_current_a: m.stall_current,
                free_speed_rpm: m.free_speed * 30.0 / std::f64::consts::PI,
            }
        })
        .collect()
}

/// What the numbers mean for the robot: computed by the core, shown next to
/// the form so every field has a visible consequence.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Derived {
    /// Wheel surface speed at the motor's free speed.
    free_speed_mps: f64,
    /// What trajectories may use: the free speed times the usable fraction
    /// (Choreo's "floor speed").
    floor_speed_mps: f64,
    /// Choreo's theoretical panel: the launch as grip allows and as the
    /// motors allow; the lesser is `max_accel_mps2`.
    traction_accel_mps2: f64,
    motor_accel_mps2: f64,
    /// Spinning in place: top rate and how fast it gets there.
    max_omega_radps: f64,
    max_alpha_radps2: f64,
    /// Fastest spin in place, with every wheel at free speed.
    max_omega_dps: f64,
    /// What one wheel's drive can push at a standstill (current limit included).
    drive_force_n: f64,
    /// What one wheel can push before it slips, at rest with even load.
    grip_force_n: f64,
    /// The launch: min(grip, drive) over mass.
    max_accel_mps2: f64,
    /// Which of the two sets the launch.
    launch_limited_by: &'static str,
    /// The acceleration that would lift the lightest-loaded wheels, if the
    /// center of mass height is known.
    tip_accel_mps2: Option<f64>,
    /// A box of the bumper's size and the robot's mass, as a starting point.
    moi_estimate_kg_m2: f64,
    /// A 5 m straight sprint from rest to rest, timed by the real solver.
    sprint_5m_s: Option<f64>,
    sprint_5m_top_speed_mps: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    problems: Vec<String>,
    derived: Option<Derived>,
}

fn parse(config: serde_json::Value) -> Result<RobotConfig, Vec<String>> {
    serde_json::from_value::<RobotConfig>(config).map_err(|e| vec![format!("{e}")])
}

/// Validates a config as it is being edited and, when it is valid, says what
/// it means. Never fails: problems come back as a list for the form.
#[tauri::command]
fn robot_check(config: serde_json::Value) -> Check {
    let robot = match parse(config) {
        Ok(r) => r,
        Err(problems) => return Check { problems, derived: None },
    };
    if let Err(e) = robot.validate() {
        let problems = match e {
            ares_core::AresError::Config(p) => p,
            other => vec![other.to_string()],
        };
        return Check { problems, derived: None };
    }

    let s = robot.swerve();
    let motor = s.motor();
    let n = s.modules.len() as f64;
    let drive_force = s.drive_motors_per_module as f64
        * motor.max_torque(0.0, s.drive_current_limit_a, s.battery_voltage, true)
        * s.drive_gear_ratio
        / s.wheel_radius_m;
    let grip_force = s.wheel_cof * robot.mass_kg * GRAVITY / n;
    let launch = drive_force.min(grip_force) * n / robot.mass_kg;
    let free = robot.free_module_speed();
    let floor = robot.max_module_speed();
    let traction = grip_force * n / robot.mass_kg;
    let motor_accel = drive_force * n / robot.mass_kg;
    let r = robot.drive_radius();

    // Tipping: the robot goes over when the center of pressure leaves the
    // wheels' support polygon, a·h = g·d, with d the distance from the center
    // to the polygon's nearest edge (the worst direction).
    let tip = robot.cog_height_m.filter(|&h| h > 0.0).map(|h| GRAVITY * support_margin(&robot) / h);

    let sprint = solve(
        &robot,
        &PathSpec::new("sprint", vec![
                Waypoint { x: 0.0, y: 0.0, heading_deg: Some(0.0), ..Default::default() },
                Waypoint { x: 5.0, y: 0.0, heading_deg: Some(0.0), ..Default::default() },
            ]),
        &SolverOptions::default(),
    )
    .ok();

    Check {
        problems: vec![],
        derived: Some(Derived {
            free_speed_mps: free,
            floor_speed_mps: floor,
            traction_accel_mps2: traction,
            motor_accel_mps2: motor_accel,
            max_omega_radps: floor / r,
            max_alpha_radps2: drive_force.min(grip_force) * n * r / robot.moi_kg_m2,
            max_omega_dps: (floor / r).to_degrees(),
            drive_force_n: drive_force,
            grip_force_n: grip_force,
            max_accel_mps2: launch,
            launch_limited_by: if drive_force < grip_force { "motor" } else { "grip" },
            tip_accel_mps2: tip,
            moi_estimate_kg_m2: robot.mass_kg
                * (robot.bumper.length_m.powi(2) + robot.bumper.width_m.powi(2))
                / 12.0,
            sprint_5m_s: sprint.as_ref().map(|t| t.duration_s),
            sprint_5m_top_speed_mps: sprint.as_ref().map(|t| t.max_speed()),
        }),
    }
}

/// Distance from the robot's center to the nearest edge of the convex hull of
/// its wheels.
fn support_margin(robot: &RobotConfig) -> f64 {
    let mut pts: Vec<(f64, f64)> = robot.swerve().modules.iter().map(|m| (m.x_m, m.y_m)).collect();
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0);
    // Andrew's monotone chain.
    let mut hull: Vec<(f64, f64)> = Vec::new();
    for pass in 0..2 {
        let start = hull.len();
        let iter: Box<dyn Iterator<Item = &(f64, f64)>> =
            if pass == 0 { Box::new(pts.iter()) } else { Box::new(pts.iter().rev()) };
        for &p in iter {
            while hull.len() >= start + 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
                hull.pop();
            }
            hull.push(p);
        }
        hull.pop();
    }
    (0..hull.len())
        .map(|i| {
            let (a, b) = (hull[i], hull[(i + 1) % hull.len()]);
            let len = (b.0 - a.0).hypot(b.1 - a.1);
            (cross(a, b, (0.0, 0.0)) / len).abs()
        })
        .fold(f64::INFINITY, f64::min)
}

/// Reads a robot.json without validating it: a file with a mistake should
/// open so the mistake can be fixed in the form.
#[tauri::command]
fn robot_open(path: String) -> Result<serde_json::Value, String> {
    let text = fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let robot: RobotConfig = serde_json::from_str(&text).map_err(|e| format!("{path} is not a robot.json: {e}"))?;
    serde_json::to_value(robot).map_err(|e| e.to_string())
}

/// Validates and writes. A model path inside the robot's folder is stored
/// relative to it, so the folder can be moved or committed as a whole.
#[tauri::command]
fn robot_save(path: String, config: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut robot = parse(config).map_err(|p| p.join("; "))?;
    robot.validate().map_err(|e| e.to_string())?;
    let dir = Path::new(&path).parent().unwrap_or(Path::new("."));
    if let Some(model) = robot.model.as_mut() {
        let p = Path::new(&model.path);
        if p.is_absolute() {
            if let Some(rel) = relative_to(p, dir) {
                model.path = rel.to_string_lossy().replace('\\', "/");
            }
        }
    }
    fs::write(&path, robot.to_json() + "\n").map_err(|e| format!("Could not write {path}: {e}"))?;
    serde_json::to_value(robot).map_err(|e| e.to_string())
}

/// Where the model file really is: relative paths are relative to the
/// robot.json; an unsaved robot only has absolute ones.
#[tauri::command]
fn resolve_model_path(robot_path: Option<String>, model_path: String) -> String {
    let p = Path::new(&model_path);
    match robot_path {
        Some(r) if !p.is_absolute() => {
            let dir = Path::new(&r).parent().unwrap_or(Path::new("."));
            dir.join(p).to_string_lossy().into_owned()
        }
        _ => model_path,
    }
}

/// `path` relative to `base`, when it is inside it (no `..` games across
/// drives or up out of the robot's folder).
fn relative_to(path: &Path, base: &Path) -> Option<PathBuf> {
    let rel = path.strip_prefix(base).ok()?;
    rel.components().all(|c| matches!(c, Component::Normal(_))).then(|| rel.to_path_buf())
}

/// A robot.json passed on the command line (`ares robot.json`, or opened
/// from the file manager), so it opens instead of the last one.
#[tauri::command]
fn startup_robot() -> Option<String> {
    std::env::args().skip(1).find(|a| a.ends_with(".json") && Path::new(a).is_file())
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    if meta.len() > MAX_MODEL_BYTES {
        return Err(format!(
            "File is too large ({:.1} MB); the limit is {} MB.",
            meta.len() as f64 / 1_048_576.0,
            MAX_MODEL_BYTES / 1_048_576
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The example robot, for tests across the app's modules.
#[cfg(test)]
pub(crate) fn tests_robot() -> RobotConfig {
    RobotConfig::from_json(include_str!("../../../examples/robots/offseason2026.json")).unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            motors,
            robot_check,
            robot_open,
            robot_save,
            resolve_model_path,
            startup_robot,
            read_binary_file,
            project::paths_list,
            project::path_save,
            project::path_delete,
            project::field_open,
            project::field_save,
            project::navgrid_import,
            project::navgrid_export,
            project::path_time,
            project::path_plan,
            project::trajectory_open,
            project::variables_open,
            project::variables_save,
            project::autos_list,
            project::auto_save,
            project::auto_delete,
            project::index_write,
            project::paths_status,
            project::plan_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ares");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../examples/robots/offseason2026.json")).unwrap()
    }

    #[test]
    fn the_example_robot_checks_out_and_is_grip_limited() {
        let c = robot_check(example());
        assert!(c.problems.is_empty(), "{:?}", c.problems);
        let d = c.derived.unwrap();
        assert_eq!(d.launch_limited_by, "grip");
        assert!(d.sprint_5m_s.unwrap() > 1.0 && d.sprint_5m_s.unwrap() < 3.0);
        assert!(d.tip_accel_mps2.is_none());
    }

    #[test]
    fn a_broken_config_comes_back_as_problems_not_an_error() {
        let mut v = example();
        v["massKg"] = serde_json::json!(-3);
        v["drivetrain"]["wheelCof"] = serde_json::json!(0);
        let c = robot_check(v);
        assert_eq!(c.problems.len(), 2, "{:?}", c.problems);
        assert!(c.derived.is_none());
    }

    #[test]
    fn tipping_needs_the_center_of_mass_height() {
        let mut v = example();
        v["cogHeightM"] = serde_json::json!(0.3);
        let tip = robot_check(v).derived.unwrap().tip_accel_mps2.unwrap();
        // Square 0.55 m wheelbase: a·h = g·(half wheelbase) → about 9 m/s².
        assert!((tip - GRAVITY * 0.276225 / 0.3).abs() < 0.01, "{tip}");
    }

    #[test]
    fn model_paths_inside_the_folder_become_relative() {
        assert_eq!(
            relative_to(Path::new("/team/robots/meshes/bot.stl"), Path::new("/team/robots")),
            Some(PathBuf::from("meshes/bot.stl"))
        );
        assert_eq!(relative_to(Path::new("/elsewhere/bot.stl"), Path::new("/team/robots")), None);
    }
}
