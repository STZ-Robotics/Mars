//! File → Open project: a MARS (WPILib) robot project, with Ares inside it.
//!
//! Ares keeps everything in the robot project's `src/main/deploy/ares/`, so a
//! deploy carries it and AresLib finds it on the roboRIO:
//!
//! ```text
//! src/main/deploy/ares/
//!   <robot>.robot.json   the robot
//!   paths/               one .path.json per path (what you draw)
//!   trajectories/        what Generate solved (.traj.json, read by AresLib)
//!   autos/               one .auto.json per auto
//!   field.json           keep-outs, slow zones, the navgrid
//!   navgrid.json         the navgrid, PathPlanner's format
//!   ares-index.json      what AresLib reads first: paths, branches, autos
//!   gains.json           the gains Tune applied
//!   characterization.json  what Measure found
//!   tuning/              every Tune run
//! ```
//!
//! Opening a project with no robot.json there creates one, from what the
//! project already says: PathPlanner's settings.json (mass, inertia, bumper,
//! modules, wheel, gearing, motor, current limit, grip), else Tuner X's
//! TunerConstants, else defaults. PathPlanner's navgrid comes along too.

use std::fs;
use std::path::{Path, PathBuf};

use ares_core::RobotConfig;
use serde::Serialize;
use serde_json::{json, Value};

use crate::robot_code;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub root: String,
    pub ares_dir: String,
    pub robot_path: String,
    /// The robot.json was made just now (and from what).
    pub created: Option<String>,
    pub navgrid_imported: bool,
    pub paths: usize,
    pub autos: usize,
}

fn count(dir: &Path, ext: &str) -> usize {
    fs::read_dir(dir).map(|e| e.flatten().filter(|f| f.file_name().to_string_lossy().ends_with(ext)).count()).unwrap_or(0)
}

/// PathPlanner's motor names to Ares's.
fn motor(pp: &str) -> &'static str {
    let m = pp.to_lowercase();
    if m.contains("kraken") {
        "kraken_x60"
    } else if m.contains("falcon") {
        "falcon500"
    } else if m.contains("neo550") || m.contains("neo 550") {
        "neo550"
    } else if m.contains("neo") || m.contains("vortex") {
        "neo"
    } else if m.contains("cim") {
        "cim"
    } else {
        "kraken_x60"
    }
}

fn module(name: &str, x: f64, y: f64) -> Value {
    json!({ "name": name, "xM": x, "yM": y })
}

/// A robot.json from PathPlanner's settings.json.
fn from_pathplanner(name: &str, s: &Value) -> Option<Value> {
    let f = |k: &str| s.get(k).and_then(Value::as_f64);
    let modules = vec![
        module("fl", f("flModuleX")?, f("flModuleY")?),
        module("fr", f("frModuleX")?, f("frModuleY")?),
        module("bl", f("blModuleX")?, f("blModuleY")?),
        module("br", f("brModuleX")?, f("brModuleY")?),
    ];
    Some(json!({
        "version": 1,
        "name": name,
        "massKg": f("robotMass")?,
        "moiKgM2": f("robotMOI").unwrap_or(6.0),
        "bumper": { "lengthM": f("robotLength").unwrap_or(0.9), "widthM": f("robotWidth").unwrap_or(0.9) },
        "drivetrain": {
            "type": "swerve",
            "modules": modules,
            "wheelRadiusM": f("driveWheelRadius")?,
            "driveGearRatio": f("driveGearing")?,
            "driveMotor": motor(s.get("driveMotorType").and_then(Value::as_str).unwrap_or("krakenX60")),
            "driveMotorsPerModule": 1,
            "driveCurrentLimitA": f("driveCurrentLimit").unwrap_or(60.0),
            "wheelCof": f("wheelCOF").unwrap_or(1.0),
            "batteryVoltage": f("defaultNominalVoltage").unwrap_or(12.0),
        }
    }))
}

/// A robot.json from Tuner X's TunerConstants (no mass or inertia there: defaults).
fn from_tuner(name: &str, root: &Path) -> Option<Value> {
    let t = robot_code::read_tuning(root);
    let java = find_java(root, "TunerConstants.java").and_then(|p| fs::read_to_string(p).ok())?;
    let inches = |k: &str| -> Option<f64> {
        let i = java.find(k)?;
        let rest = &java[i..];
        let j = rest.find(".of(")? + 4;
        let end = rest[j..].find(')')?;
        let v: f64 = rest[j..j + end].trim().parse().ok()?;
        Some(if rest[..j].contains("Inches") { v * 0.0254 } else { v })
    };
    let gear = {
        let i = java.find("kDriveGearRatio =")?;
        let rest = &java[i + "kDriveGearRatio =".len()..];
        rest[..rest.find(';')?].trim().parse::<f64>().ok()?
    };
    let modules = vec![
        module("fl", inches("kFrontLeftXPos =")?, inches("kFrontLeftYPos =")?),
        module("fr", inches("kFrontRightXPos =")?, inches("kFrontRightYPos =")?),
        module("bl", inches("kBackLeftXPos =")?, inches("kBackLeftYPos =")?),
        module("br", inches("kBackRightXPos =")?, inches("kBackRightYPos =")?),
    ];
    Some(json!({
        "version": 1,
        "name": name,
        "massKg": 55.0,
        "moiKgM2": 6.0,
        "bumper": { "lengthM": 0.85, "widthM": 0.85 },
        "drivetrain": {
            "type": "swerve",
            "modules": modules,
            "wheelRadiusM": t.wheel_radius_m.unwrap_or(0.0508),
            "driveGearRatio": gear,
            "driveMotor": "kraken_x60",
            "driveMotorsPerModule": 1,
            "driveCurrentLimitA": t.slip_current_a.unwrap_or(60.0),
            "wheelCof": 1.0,
            "batteryVoltage": 12.0,
        }
    }))
}

fn find_java(root: &Path, file: &str) -> Option<PathBuf> {
    let mut stack = vec![root.join("src").join("main").join("java")];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().is_some_and(|n| n == file) {
                return Some(p);
            }
        }
    }
    None
}

fn default_robot(name: &str) -> Value {
    let p = 0.276;
    json!({
        "version": 1,
        "name": name,
        "massKg": 55.0,
        "moiKgM2": 6.0,
        "bumper": { "lengthM": 0.85, "widthM": 0.85 },
        "drivetrain": {
            "type": "swerve",
            "modules": [module("fl", p, p), module("fr", p, -p), module("bl", -p, p), module("br", -p, -p)],
            "wheelRadiusM": 0.0508,
            "driveGearRatio": 6.75,
            "driveMotor": "kraken_x60",
            "driveMotorsPerModule": 1,
            "driveCurrentLimitA": 60.0,
            "wheelCof": 1.0,
            "batteryVoltage": 12.0,
        }
    })
}

/// Opens (or sets up) the Ares project inside a robot project.
#[tauri::command]
pub fn project_open(root: String) -> Result<OpenedProject, String> {
    let root = PathBuf::from(&root);
    // Picked a folder inside the project (or the ares folder itself): go up to it.
    let root = robot_code::find_root(&root).ok_or_else(|| {
        format!("{} is not a robot project: there is no build.gradle with a src/main/java above it", root.display())
    })?;
    let ares = root.join("src").join("main").join("deploy").join("ares");
    for d in ["paths", "trajectories", "autos"] {
        fs::create_dir_all(ares.join(d)).map_err(|e| format!("Could not create {}: {e}", ares.join(d).display()))?;
    }
    let existing = fs::read_dir(&ares)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.to_string_lossy().ends_with(".robot.json"));
    let mut created = None;
    let robot_path = match existing {
        Some(p) => p,
        None => {
            let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "robot".into());
            let pp = fs::read_to_string(root.join("src/main/deploy/pathplanner/settings.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
            let (doc, from) = match pp.as_ref().and_then(|s| from_pathplanner(&name, s)) {
                Some(d) => (d, "PathPlanner's settings.json"),
                None => match from_tuner(&name, &root) {
                    Some(d) => (d, "TunerConstants (mass, inertia and bumper are guesses: check them)"),
                    None => (default_robot(&name), "defaults (check every value)"),
                },
            };
            let robot = RobotConfig::from_json(&doc.to_string()).map_err(|e| format!("The robot read from {from} is not valid: {e}"))?;
            let slug: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' }).collect();
            let path = ares.join(format!("{slug}.robot.json"));
            fs::write(&path, robot.to_json() + "\n").map_err(|e| format!("Could not write {}: {e}", path.display()))?;
            created = Some(from.to_string());
            path
        }
    };
    // PathPlanner's navgrid, when Ares has none yet.
    let mut navgrid_imported = false;
    let field = ares.join("field.json");
    let pp_grid = root.join("src/main/deploy/pathplanner/navgrid.json");
    let has_grid = fs::read_to_string(&field).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_some_and(|f| f.get("navgrid").is_some());
    if !has_grid && pp_grid.is_file() {
        if let Ok(g) = crate::project::navgrid_import(pp_grid.to_string_lossy().into_owned()) {
            let mut doc = crate::project::field_open(robot_path.to_string_lossy().into_owned());
            doc.navgrid = Some(g);
            let size = ares_planner::FieldSize { length_m: 16.541, width_m: 8.0692 };
            if crate::project::field_save(robot_path.to_string_lossy().into_owned(), doc, Some(size)).is_ok() {
                navgrid_imported = true;
            }
        }
    }
    Ok(OpenedProject {
        root: root.to_string_lossy().into_owned(),
        ares_dir: ares.to_string_lossy().into_owned(),
        robot_path: robot_path.to_string_lossy().into_owned(),
        created,
        navgrid_imported,
        paths: count(&ares.join("paths"), ".path.json"),
        autos: count(&ares.join("autos"), ".auto.json"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ares-open-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/main/java/frc/robot")).unwrap();
        fs::write(dir.join("build.gradle"), "").unwrap();
        dir
    }

    #[test]
    fn a_project_with_pathplanner_gets_its_robot_from_it() {
        let dir = project("pp");
        fs::create_dir_all(dir.join("src/main/deploy/pathplanner")).unwrap();
        fs::write(dir.join("src/main/deploy/pathplanner/settings.json"), r#"{
            "robotWidth": 0.9017, "robotLength": 0.9017, "robotMass": 57.0, "robotMOI": 7.0,
            "driveWheelRadius": 0.0508, "driveGearing": 5.2734375, "driveMotorType": "krakenX60FOC",
            "driveCurrentLimit": 70.0, "wheelCOF": 1.0, "defaultNominalVoltage": 12.0,
            "flModuleX": 0.276225, "flModuleY": 0.276225, "frModuleX": 0.276225, "frModuleY": -0.276225,
            "blModuleX": -0.276225, "blModuleY": 0.276225, "brModuleX": -0.276225, "brModuleY": -0.276225 }"#).unwrap();
        fs::write(dir.join("src/main/deploy/pathplanner/navgrid.json"), r#"{"field_size":{"x":16.54,"y":8.07},"nodeSizeMeters":0.3,"grid":[[false,true]]}"#).unwrap();
        let p = project_open(dir.join("src/main/java").to_string_lossy().into_owned()).unwrap();
        assert!(p.created.as_deref().unwrap().contains("PathPlanner"));
        assert!(p.navgrid_imported);
        let r = RobotConfig::load(Path::new(&p.robot_path)).unwrap();
        assert_eq!(r.mass_kg, 57.0);
        assert_eq!(r.swerve().drive_current_limit_a, 70.0);
        assert_eq!(r.swerve().modules.len(), 4);
        assert!(Path::new(&p.ares_dir).join("autos").is_dir());
        // Opened again, the same robot: nothing made twice.
        let again = project_open(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(again.robot_path, p.robot_path);
        assert!(again.created.is_none());
    }

    #[test]
    fn without_pathplanner_it_reads_tuner_constants() {
        let dir = project("tuner");
        fs::write(dir.join("src/main/java/frc/robot/TunerConstants.java"), r#"
            private static final Current kSlipCurrent = Amps.of(70);
            private static final double kDriveGearRatio = 6.12;
            private static final Distance kWheelRadius = Inches.of(2);
            private static final Distance kFrontLeftXPos = Inches.of(11);
            private static final Distance kFrontLeftYPos = Inches.of(11);
            private static final Distance kFrontRightXPos = Inches.of(11);
            private static final Distance kFrontRightYPos = Inches.of(-11);
            private static final Distance kBackLeftXPos = Inches.of(-11);
            private static final Distance kBackLeftYPos = Inches.of(11);
            private static final Distance kBackRightXPos = Inches.of(-11);
            private static final Distance kBackRightYPos = Inches.of(-11);
        "#).unwrap();
        let p = project_open(dir.to_string_lossy().into_owned()).unwrap();
        assert!(p.created.as_deref().unwrap().contains("TunerConstants"));
        let r = RobotConfig::load(Path::new(&p.robot_path)).unwrap();
        assert_eq!(r.swerve().drive_gear_ratio, 6.12);
        assert!((r.swerve().modules[1].y_m + 11.0 * 0.0254).abs() < 1e-9);
    }

    #[test]
    fn not_a_robot_project_says_so() {
        let dir = std::env::temp_dir().join(format!("ares-open-none-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(project_open(dir.to_string_lossy().into_owned()).unwrap_err().contains("not a robot project"));
    }
}

#[cfg(test)]
mod real {
    /// ARES_OPEN_PROJECT=<a robot project> cargo test -p ares-app open_a_real_project -- --ignored --nocapture
    #[test]
    #[ignore]
    fn open_a_real_project() {
        let Ok(root) = std::env::var("ARES_OPEN_PROJECT") else { return };
        let p = super::project_open(root).unwrap();
        println!("{p:#?}");
        println!("{}", std::fs::read_to_string(&p.robot_path).unwrap());
    }
}
