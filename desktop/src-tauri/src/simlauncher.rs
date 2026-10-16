//! MARS Simulation Studio launcher.
//!
//! This is ALL mars-desktop knows about the simulation: where its executable is
//! and how to open it. Nothing about Gazebo lives here.
//!
//! The simulation is a separate application on purpose. It drags the whole
//! conda environment along --- Gazebo, its plugins, its dependencies --- and
//! that weight has no business inside the dashboard's bundle, which is what the
//! team uses at competition. It can also hang, update or be reinstalled without
//! touching the app that has to stay alive when it matters.
//!
//! The process is launched and let go: it is not supervised from here. The
//! Studio has its own window, its own life cycle and its own supervisor for the
//! simulation. Closing mars-desktop does not close the simulation, and that is
//! deliberate.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
const EXE: &str = "mars-sim-app.exe";
#[cfg(not(windows))]
const EXE: &str = "mars-sim-app";

/// Finds the MARS Simulation Studio executable.
///
/// It covers the two real scenarios: development, where it lives in its own
/// crate's `target`, and an installation, where it travels next to
/// mars-desktop.
fn find_executable() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MARS_SIM_APP") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // Next to the executable: the installed case.
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
        roots.push(exe);
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }

    for root in roots {
        for dir in root.ancestors() {
            for rel in [
                Path::new(EXE).to_path_buf(),
                Path::new("simulationstudio/app/target/release").join(EXE),
                Path::new("simulationstudio/app/target/debug").join(EXE),
            ] {
                let candidate = dir.join(&rel);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Whether MARS Simulation Studio is installed, and where. The UI uses it so as
/// not to offer a button that can do nothing.
#[tauri::command]
pub fn sim_app_available() -> Option<String> {
    find_executable().map(|p| p.display().to_string())
}

/// How long to wait to see whether the Studio died on startup.
///
/// Its startup checks (finding `sim/` and the conda environment) are disk
/// reads: if they fail, they fail within tens of milliseconds. A second and a
/// half covers them with room to spare and is not noticeable when opening.
const STARTUP_GRACE: Duration = Duration::from_millis(1500);

/// Opens MARS Simulation Studio in its own window.
///
/// It waits a moment before reporting success. The Studio is built with no
/// console (`windows_subsystem = "windows"`) and, if it cannot find `sim/` or
/// the conda environment, it writes the reason to stderr and dies: without this
/// detour `spawn()` returns Ok, nobody sees anything, and the button looks like
/// it does absolutely nothing. That happened, and there is no worse symptom to
/// debug.
#[tauri::command]
pub fn open_sim_app() -> Result<String, String> {
    let exe = find_executable().ok_or_else(|| {
        "MARS Simulation Studio was not found. Build it with `cargo build` in \
         simulationstudio/app, or set MARS_SIM_APP to the path of its executable."
            .to_string()
    })?;

    // The working directory is set to the executable's own so the Studio finds
    // `sim/` by walking up from there. Without this it inherits mars-desktop's,
    // which can be anything depending on where the app was opened from.
    let dir = exe.parent().unwrap_or_else(|| Path::new("."));

    // stderr goes to a file rather than a pipe on purpose: a pipe nobody reads
    // fills up and blocks the Studio, which logs to stderr while it runs.
    let log = std::env::temp_dir().join("mars-sim-app-startup.log");
    let sink = fs::File::create(&log)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());

    let mut child = Command::new(&exe)
        .current_dir(dir)
        .stderr(sink)
        .spawn()
        .map_err(|e| format!("could not open MARS Simulation Studio: {e}"))?;

    let deadline = Instant::now() + STARTUP_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            // Still alive: the window is opening. It is let go and no longer
            // supervised, which is what this launcher has always done.
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Ok(Some(status)) => {
                let reason = fs::read_to_string(&log).unwrap_or_default();
                let reason = reason.trim();
                return Err(if reason.is_empty() {
                    format!(
                        "MARS Simulation Studio closed on startup (exit code {}) without saying why.",
                        status.code().unwrap_or(-1)
                    )
                } else {
                    format!("MARS Simulation Studio could not start:\n\n{reason}")
                });
            }
            // Not being able to ask after the child is no reason to report an
            // error: the process is already launched.
            Err(_) => break,
        }
    }

    Ok(exe.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// If the Studio is built, the launcher has to find it.
    ///
    /// The search walks up the ancestors of the test executable, which in
    /// `desktop/src-tauri/target/debug/deps` passes through the repository root
    /// and from there reaches `simulationstudio/app/target/debug`. It is exactly
    /// the same path the app follows in development, so if this test passes, the
    /// button works.
    #[test]
    fn finds_mars_sim_when_it_is_built() {
        // TWO levels up: the crate sits at `desktop/src-tauri`, so its parent is
        // `desktop/` and only its grandparent is the repository root, which is
        // where the Studio hangs off as a sibling folder.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("src-tauri hangs off desktop/, and desktop/ off the repo root");
        let expected = repo.join("simulationstudio/app/target/debug").join(EXE);

        if !expected.is_file() {
            // With nothing built there is nothing to find, and failing the test
            // over that would hold `cargo test` hostage to build order.
            eprintln!("skipped: {} is not built", expected.display());
            return;
        }

        let found = find_executable().expect("it is built but was not found");
        assert!(
            found.ends_with(EXE),
            "found something that is not the executable: {}",
            found.display()
        );
        assert!(found.is_file());
    }

    /// The environment variable wins over the search.
    #[test]
    fn mars_sim_app_takes_priority() {
        // A path that does not exist must not win: the variable says where to
        // look, it does not promise anything is there. If it won, pointing it
        // wrong would leave the button dead with no way back but unsetting it.
        let before = std::env::var("MARS_SIM_APP").ok();
        std::env::set_var("MARS_SIM_APP", "does/not/exist/anywhere.exe");
        let found = find_executable();
        match before {
            Some(v) => std::env::set_var("MARS_SIM_APP", v),
            None => std::env::remove_var("MARS_SIM_APP"),
        }

        if let Some(p) = found {
            assert!(p.is_file(), "returned a path that does not exist: {}", p.display());
        }
    }
}
