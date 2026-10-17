//! The Tune tab's backend: runs ares-tune off the UI thread, streams its
//! progress as `tune-progress` events, and keeps each finished run in the
//! project's `tuning/` folder.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use ares_core::RobotConfig;
use ares_tune::tune::{run, Progress, TuneConfig};
use tauri::{AppHandle, Emitter};

use crate::project::trajectory_open;

static RUNNING: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Starts a search on the named paths' trajectories. One at a time: a second
/// start stops the first.
#[tauri::command]
pub fn tune_start(app: AppHandle, robot: RobotConfig, robot_path: String, paths: Vec<String>, config: TuneConfig) -> Result<(), String> {
    let mut trajs = Vec::new();
    for name in &paths {
        match trajectory_open(robot_path.clone(), name.clone()) {
            Some(t) => trajs.push(t),
            None => return Err(format!("\"{name}\" has no trajectory: generate it first")),
        }
    }
    if trajs.is_empty() {
        return Err("Pick at least one path to tune on".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = RUNNING.lock().unwrap().replace(cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    std::thread::spawn(move || {
        let last = run(&robot, &trajs, &config, cancel.clone(), |p: &Progress| {
            let _ = app.emit("tune-progress", p);
        });
        let _ = save(&robot_path, &paths, &config, &last);
        let mut running = RUNNING.lock().unwrap();
        if running.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
            *running = None;
        }
    });
    Ok(())
}

#[tauri::command]
pub fn tune_cancel() {
    if let Some(c) = RUNNING.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

fn save(robot_path: &str, paths: &[String], config: &TuneConfig, last: &Progress) -> Result<(), String> {
    let dir = Path::new(robot_path).parent().unwrap_or(Path::new(".")).join("tuning");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let doc = serde_json::json!({
        "savedAt": secs,
        "paths": paths,
        "config": config,
        "baseline": last.baseline,
        "best": last.best,
        "history": last.history,
        "runs": last.runs,
        "elapsedS": last.elapsed_s,
        "cancelled": last.cancelled,
    });
    std::fs::write(dir.join(format!("run-{secs}.json")), serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The saved runs, newest first.
#[tauri::command]
pub fn tune_runs(robot_path: String) -> Vec<serde_json::Value> {
    let dir = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("tuning");
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<serde_json::Value> = entries
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .collect();
    out.sort_by_key(|v| std::cmp::Reverse(v["savedAt"].as_u64().unwrap_or(0)));
    out
}

/// The gains the robot runs with, as Tune applied them: `gains.json` next to
/// the robot, deployed with the project. AresLib reads it at startup unless
/// the robot code sets its gains itself.
#[tauri::command]
pub fn gains_save(robot_path: String, gains: serde_json::Value) -> Result<(), String> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("gains.json");
    let mut doc = gains;
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    doc["format"] = 1.into();
    doc["savedAt"] = secs.into();
    std::fs::write(path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gains_open(robot_path: String) -> Option<serde_json::Value> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("gains.json");
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

/// calibration.json next to the robot: the world the Logs tab found the
/// robot in, which Tune starts from instead of the robot.json's.
#[tauri::command]
pub fn calibration_save(robot_path: String, doc: serde_json::Value) -> Result<(), String> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("calibration.json");
    let mut doc = doc;
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    doc["format"] = 1.into();
    doc["savedAt"] = secs.into();
    std::fs::write(path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn calibration_open(robot_path: String) -> Option<serde_json::Value> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("calibration.json");
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

#[tauri::command]
pub fn calibration_delete(robot_path: String) -> Result<(), String> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("calibration.json");
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// characterization.json next to the robot: the last results of the
/// Characterize tab, which Tune starts from.
#[tauri::command]
pub fn characterization_save(robot_path: String, doc: serde_json::Value) -> Result<(), String> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("characterization.json");
    std::fs::write(path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn characterization_open(robot_path: String) -> Option<serde_json::Value> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("characterization.json");
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

fn tuning_dir(robot_path: &str) -> std::path::PathBuf {
    Path::new(robot_path).parent().unwrap_or(Path::new(".")).join("tuning")
}

/// Deletes one saved Tune run (by when it was saved).
#[tauri::command]
pub fn tune_run_delete(robot_path: String, saved_at: u64) -> Result<(), String> {
    let path = tuning_dir(&robot_path).join(format!("run-{saved_at}.json"));
    std::fs::remove_file(&path).map_err(|e| format!("Could not delete {}: {e}", path.display()))
}

/// Deletes every saved Tune run. Returns how many.
#[tauri::command]
pub fn tune_runs_clear(robot_path: String) -> Result<usize, String> {
    let Ok(entries) = std::fs::read_dir(tuning_dir(&robot_path)) else { return Ok(0) };
    let mut n = 0;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // Only the runs: anything else someone put there stays.
        if name.starts_with("run-") && name.ends_with(".json") {
            std::fs::remove_file(e.path()).map_err(|err| format!("Could not delete {name}: {err}"))?;
            n += 1;
        }
    }
    Ok(n)
}

/// Takes the applied gains off the robot: without gains.json, AresLib uses
/// the code's withGains or its defaults.
#[tauri::command]
pub fn gains_delete(robot_path: String) -> Result<(), String> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("gains.json");
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Forgets part of what Measure saved ("drive", "steer", "wheelRadiusM"), or all of it ("all").
#[tauri::command]
pub fn characterization_forget(robot_path: String, what: String) -> Result<(), String> {
    let path = Path::new(&robot_path).parent().unwrap_or(Path::new(".")).join("characterization.json");
    if what == "all" {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    let Some(mut doc) = characterization_open(robot_path.clone()) else { return Ok(()) };
    if let Some(o) = doc.as_object_mut() {
        o.remove(&what);
    }
    characterization_save(robot_path, doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histories_can_be_deleted() {
        let dir = std::env::temp_dir().join(format!("ares-tuning-delete-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("tuning")).unwrap();
        let rp = dir.join("bot.robot.json").to_string_lossy().into_owned();
        for s in [100, 200, 300] {
            std::fs::write(dir.join(format!("tuning/run-{s}.json")), format!("{{\"savedAt\":{s}}}")).unwrap();
        }
        std::fs::write(dir.join("tuning/notes.txt"), "keep me").unwrap();
        tune_run_delete(rp.clone(), 200).unwrap();
        assert_eq!(tune_runs(rp.clone()).len(), 2);
        assert_eq!(tune_runs_clear(rp.clone()).unwrap(), 2);
        assert!(tune_runs(rp.clone()).is_empty());
        assert!(dir.join("tuning/notes.txt").is_file());

        gains_save(rp.clone(), serde_json::json!({ "translation": { "kp": 1 } })).unwrap();
        gains_delete(rp.clone()).unwrap();
        assert!(gains_open(rp.clone()).is_none());
        gains_delete(rp.clone()).unwrap(); // already gone: fine

        characterization_save(rp.clone(), serde_json::json!({ "drive": { "kS": 0.1 }, "steer": { "kS": 0.2 } })).unwrap();
        characterization_forget(rp.clone(), "drive".into()).unwrap();
        let doc = characterization_open(rp.clone()).unwrap();
        assert!(doc.get("drive").is_none() && doc.get("steer").is_some());
        characterization_forget(rp.clone(), "all".into()).unwrap();
        assert!(characterization_open(rp).is_none());
    }
}
