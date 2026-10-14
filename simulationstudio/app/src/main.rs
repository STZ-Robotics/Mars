//! MARS Simulation Studio: the simulation application.
//!
//! It is a SEPARATE process from mars-desktop, on purpose. mars-desktop is
//! the dashboard and only carries a button that launches this app; everything
//! about Gazebo lives here. That way the simulation can restart, hang or be
//! updated without touching the app the team uses at competition, and the
//! heavy dependencies (the whole conda environment) stay out of the
//! dashboard's bundle.
//!
//! This app does NOT draw the robot: mars-desktop already does that, receiving
//! the poses over NT4 exactly as from a real robot, and so does the Gazebo
//! window, which is the one showing the physics. What it does is everything
//! else: start and supervise the simulation, and be the editor of the worlds
//! and robot maps that feed it.
//!
//! The responsibilities are split into two modules because they are two
//! different risks: `supervisor` launches and kills processes, `studio`
//! writes files. A failure in the editor has no business being able to touch
//! the code that kills.
//!
//! Usage:
//!   mars-sim-app                         opens the window
//!   mars-sim-app --headless [seconds]    starts, waits and stops (for CI)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod studio;
mod supervisor;

use std::sync::Mutex;

use studio::{FieldInfo, Listing, RobotInfo, WorldInfo, WorldSpec};
use supervisor::{Check, Config, Status, Supervisor};
use tauri::{Manager, State};

struct AppState(Mutex<Supervisor>);

/// Takes the supervisor and pulls `sim/` out of it, which is what almost all
/// of `studio` needs. The lock is released before touching the disk: reading
/// twenty SDFs with the supervisor locked would freeze the UI's status poll.
macro_rules! sim_dir {
    ($state:expr) => {{
        let s = $state.0.lock().map_err(|e| e.to_string())?;
        s.sim_dir().to_path_buf()
    }};
}

/// The conda environment's python and `sim/`, which is what the generators
/// need. The python is the environment's and not the system's on purpose:
/// the scripts use tomllib and whatever the environment carries, not what the
/// user happens to have installed.
fn sim_and_python(state: &State<AppState>) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok((s.sim_dir().to_path_buf(), s.conda_env().join("python.exe")))
}

/// `anyhow::Error` -> the string the UI sees, with the chain of contexts.
fn ui_err<T>(r: anyhow::Result<T>) -> Result<T, String> {
    r.map_err(|e| format!("{e:#}"))
}

// --- commands: start and stop ----------------------------------------------

#[derive(serde::Serialize)]
struct Options {
    worlds: Vec<String>,
    robots: Vec<String>,
    sim_dir: String,
    conda_dir: Option<String>,
    /// The crate's. The one the interface writes on screen is MSS_VERSION
    /// (ui/js/constants.js): this one travels anyway so a bug report can say
    /// which binary was running.
    version: String,
}

#[tauri::command]
fn sim_options(state: State<AppState>) -> Result<Options, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(Options {
        worlds: s.worlds(),
        robots: s.robots(),
        sim_dir: s.sim_dir().display().to_string(),
        conda_dir: Some(s.conda_env().display().to_string()),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
fn sim_start(cfg: Config, state: State<AppState>) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    ui_err(s.start(&cfg))
}

#[tauri::command]
fn sim_stop(state: State<AppState>) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    s.stop();
    Ok(())
}

#[tauri::command]
fn sim_status(state: State<AppState>) -> Result<Status, String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.status())
}

#[derive(serde::Serialize)]
struct Logs {
    engine: String,
    window: String,
    bridge: String,
}

#[tauri::command]
fn sim_logs(lines: Option<usize>, state: State<AppState>) -> Result<Logs, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let n = lines.unwrap_or(40).clamp(10, 500);
    // The .err is where each process writes what matters when something
    // fails; the .log carries the normal startup. They are concatenated so
    // the UI does not need two panels per process.
    let pair = |base: &str| format!("{}\n{}", s.log(&format!("{base}.log"), n), s.log(&format!("{base}.err"), n));
    Ok(Logs {
        engine: pair("app-engine"),
        window: pair("app-window"),
        bridge: pair("app-bridge"),
    })
}

#[tauri::command]
fn sim_diagnostics(state: State<AppState>) -> Result<Vec<Check>, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.diagnostics())
}

// --- commands: world and robot libraries -----------------------------------

#[tauri::command]
fn sim_worlds(state: State<AppState>) -> Result<Vec<WorldInfo>, String> {
    Ok(studio::list_worlds(&sim_dir!(state)))
}

#[tauri::command]
fn sim_robots(state: State<AppState>) -> Result<Vec<RobotInfo>, String> {
    Ok(studio::list_robots(&sim_dir!(state)))
}

#[tauri::command]
fn sim_world_spec(path: String, state: State<AppState>) -> Result<Option<WorldSpec>, String> {
    ui_err(studio::read_spec(&sim_dir!(state), &path))
}

#[tauri::command]
fn sim_save_world(spec: WorldSpec, state: State<AppState>) -> Result<String, String> {
    ui_err(studio::save_world(&sim_dir!(state), &spec))
}

/// The SDF a spec would produce, without writing anything. It feeds the
/// editor's preview tab: seeing the XML before saving it is the difference
/// between trusting the generator and checking it.
#[tauri::command]
fn sim_preview_world(spec: WorldSpec) -> Result<String, String> {
    Ok(studio::generate_sdf(&spec))
}

/// What this world's generator declares can be changed, or `null` if the
/// world has none. The options panel comes from here.
#[tauri::command]
fn sim_generator(path: String, state: State<AppState>) -> Result<Option<serde_json::Value>, String> {
    let (dir, python) = sim_and_python(&state)?;
    ui_err(studio::generator_options(&dir, &python, &path))
}

/// Regenerates the world with these values and returns what the script
/// printed.
#[tauri::command]
fn sim_generate_world(
    path: String,
    values: serde_json::Value,
    state: State<AppState>,
) -> Result<String, String> {
    let (dir, python) = sim_and_python(&state)?;
    ui_err(studio::generate_world(&dir, &python, &path, &values))
}

#[tauri::command]
fn sim_duplicate_world(path: String, name: String, state: State<AppState>) -> Result<String, String> {
    ui_err(studio::duplicate_world(&sim_dir!(state), &path, &name))
}

#[tauri::command]
fn sim_delete_world(path: String, state: State<AppState>) -> Result<(), String> {
    ui_err(studio::delete_world(&sim_dir!(state), &path))
}

#[tauri::command]
fn sim_import_world(
    origin: String,
    name: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    ui_err(studio::import_world(
        &sim_dir!(state),
        &origin,
        name.as_deref().filter(|n| !n.is_empty()),
    ))
}

// --- commands: fields ------------------------------------------------------

#[tauri::command]
fn sim_fields(state: State<AppState>) -> Result<Vec<FieldInfo>, String> {
    Ok(studio::list_fields(&sim_dir!(state)))
}

#[tauri::command]
fn sim_install_field(
    origin: String,
    name: String,
    state: State<AppState>,
) -> Result<String, String> {
    ui_err(studio::install_field(&sim_dir!(state), &origin, &name))
}

// --- commands: files -------------------------------------------------------

#[tauri::command]
fn sim_read_text(path: String, state: State<AppState>) -> Result<String, String> {
    ui_err(studio::read_text(&sim_dir!(state), &path))
}

#[tauri::command]
fn sim_write_text(
    path: String,
    content: String,
    state: State<AppState>,
) -> Result<(), String> {
    ui_err(studio::write_text(&sim_dir!(state), &path, &content))
}

#[tauri::command]
fn sim_browse(dir: Option<String>, filter: Option<Vec<String>>) -> Result<Listing, String> {
    ui_err(studio::browse(dir.as_deref(), &filter.unwrap_or_default()))
}

#[tauri::command]
fn sim_reveal(path: String, state: State<AppState>) -> Result<(), String> {
    ui_err(studio::reveal(&sim_dir!(state), &path))
}

// --- commands: preferences -------------------------------------------------

#[tauri::command]
fn sim_prefs(state: State<AppState>) -> Result<serde_json::Value, String> {
    Ok(studio::prefs(&sim_dir!(state)))
}

#[tauri::command]
fn sim_save_prefs(prefs: serde_json::Value, state: State<AppState>) -> Result<(), String> {
    ui_err(studio::save_prefs(&sim_dir!(state), &prefs))
}

// --- windowless mode -------------------------------------------------------

/// Starts, waits and stops. It exists so the supervisor can be verified in
/// CI, where there is no screen: without it the only way to test it would be
/// by hand.
fn headless(seconds: u64) -> Result<(), String> {
    let mut s = Supervisor::discover().map_err(|e| format!("{e:#}"))?;
    // No window by default: there is no screen in CI. With MARS_WITH_WINDOW=1
    // it is included, which is the way to test the FULL path of the Start
    // button without having to press a button.
    s.set_headless(std::env::var("MARS_WITH_WINDOW").is_err());
    println!("[app] sim at {}", s.sim_dir().display());

    let worlds = s.worlds();
    let robots = s.robots();
    println!("[app] {} worlds, {} robot maps", worlds.len(), robots.len());

    // The swerve if it is there, which is the team's robot; otherwise the
    // first one.
    let robot = robots
        .iter()
        .find(|r| r.contains("swerve"))
        .or_else(|| robots.first())
        .ok_or("there is no robot map at all")?
        .clone();
    let world = if robot.contains("swerve") {
        "worlds/swerve.sdf".to_string()
    } else {
        "worlds/testbot.sdf".to_string()
    };

    let cfg = Config {
        world: world.clone(),
        robot_map: robot.clone(),
        nt_host: "127.0.0.1".into(),
        nt_port: 5810,
    };
    println!("[app] starting {world} with {robot}");
    s.start(&cfg).map_err(|e| format!("{e:#}"))?;

    let mut last = s.status();
    for _ in 0..seconds {
        std::thread::sleep(std::time::Duration::from_secs(1));
        last = s.status();
        if !last.running {
            break;
        }
    }

    if let Some(reason) = &last.crashed {
        eprintln!("[app] {reason}");
        eprintln!("--- engine ---\n{}", s.log("app-engine.err", 15));
        eprintln!("--- bridge ---\n{}", s.log("app-bridge.err", 15));
        return Err("the simulation died on its own".into());
    }
    println!(
        "[app] engine pid {:?}, window pid {:?}, bridge pid {:?}, up {} s",
        last.engine_pid, last.window_pid, last.bridge_pid, last.seconds
    );

    s.stop();
    // After stopping, both have to be dead. Checking it is what tells "we
    // asked them to stop" from "they stopped".
    let after = s.status();
    if after.engine_pid.is_some() || after.bridge_pid.is_some() {
        return Err("processes were still alive after stopping".into());
    }

    println!("[app] OK: started, stayed up and stopped cleanly");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--headless") {
        let seconds = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(8);
        if let Err(e) = headless(seconds) {
            eprintln!("FAILED: {e}");
            std::process::exit(1);
        }
        return;
    }

    let supervisor = match Supervisor::discover() {
        Ok(s) => s,
        Err(e) => {
            // Without a supervisor there is no app. Better to die with the
            // reason than to open a window that cannot do anything.
            eprintln!("FAILED: {e:#}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .manage(AppState(Mutex::new(supervisor)))
        .invoke_handler(tauri::generate_handler![
            sim_options,
            sim_start,
            sim_stop,
            sim_status,
            sim_logs,
            sim_diagnostics,
            sim_worlds,
            sim_robots,
            sim_world_spec,
            sim_save_world,
            sim_preview_world,
            sim_generator,
            sim_generate_world,
            sim_duplicate_world,
            sim_delete_world,
            sim_import_world,
            sim_fields,
            sim_install_field,
            sim_read_text,
            sim_write_text,
            sim_browse,
            sim_reveal,
            sim_prefs,
            sim_save_prefs
        ])
        .on_window_event(|window, event| {
            // Closing the window has to kill the simulation. On Windows
            // killing the parent does not kill the children, so without this
            // an orphaned engine and bridge stay behind holding the
            // gz-transport topics: the next start sees two engines publishing
            // and the poses overwrite each other, without any error.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(mut s) = state.0.lock() {
                        s.stop();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("could not start MARS Simulation Studio");
}
