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
