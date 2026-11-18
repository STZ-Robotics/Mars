#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! MARS Installer — installs, updates and uninstalls the MARS ecosystem.
//!
//! It is a windowed application, not a script: installing downloads tens of
//! megabytes, can fail on a school proxy, and has one real decision to make
//! (Full or Tools). A bar that moves and an error message you can read are
//! worth more than any silent automation.
//!
//! How the work is split:
//!
//! - `platform`    — what differs between Windows, Linux and macOS.
//! - `manifest`    — where the files come from (GitHub releases).
//! - `download`    — fetching them with progress and verifying the sha256.
//! - `archive`     — opening the .zip / .tar.gz.
//! - `integration` — shortcuts, installed-programs entry, WebView2.
//! - `install`     — the order of all that, and the record of what was done.
//!
//! This file only exposes those modules as commands and starts the window.

mod archive;
mod download;
mod install;
mod integration;
mod manifest;
mod platform;

use install::{InstallRecord, Options, Progress, Status};
use serde::Serialize;
use tauri::{Emitter, Manager};

/// Name of the event the window follows progress with.
const PROGRESS_EVENT: &str = "installer://progress";

/// How the installer was opened.
///
/// Windows calls the uninstaller with `--uninstall` from "Installed apps". It
/// is the same executable: the only thing that changes is the screen it opens
/// on.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Install,
    Uninstall,
}

struct Startup(Mode);

#[tauri::command]
fn initial_mode(startup: tauri::State<'_, Startup>) -> Mode {
    startup.0
}

#[tauri::command]
fn install_status() -> Status {
    install::status()
}

/// Checks the latest release without downloading anything. The selection screen
/// uses it to show version and size before committing.
#[tauri::command]
async fn check_release(edition: platform::Edition) -> Result<manifest::DownloadPlan, String> {
    let mut plan = manifest::fetch(edition).await.map_err(describe)?;
    // Comparing versions is a matter of numbers, not text: "1.9" is not greater
    // than "1.10" however much it looks that way alphabetically.
    plan.is_newer =
        install::read_record().map(|r| manifest::is_newer(&plan.release.version, &r.version));
    Ok(plan)
}

#[tauri::command]
async fn install(app: tauri::AppHandle, options: Options) -> Result<InstallRecord, String> {
    // The callback emits to the front end; if the window is gone, emitting
    // fails and is ignored: an installation in flight is not aborted just
    // because nobody is watching.
    let app2 = app.clone();
    install::install(options, move |p: Progress| {
        let _ = app2.emit(PROGRESS_EVENT, p);
    })
    .await
    .map_err(describe)
}

#[tauri::command]
fn uninstall(delete_data: bool) -> Result<String, String> {
    install::uninstall(delete_data).map_err(describe)
}

/// Launches a freshly installed app and closes the installer.
#[tauri::command]
fn launch_installed(app: tauri::AppHandle, component: String) -> Result<(), String> {
    let record = install::read_record().ok_or("no installation is registered")?;
    // MARS Desktop is the only component; `component` stays in the signature
    // so the front end's call does not change.
    let _ = component;
    let comp = platform::Component::MarsDesktop;
    let exe = record.dir.join(comp.exe_file());
    if !exe.is_file() {
        return Err(format!("could not find {}", exe.display()));
    }
    std::process::Command::new(&exe)
        // The working directory is set to the executable's own so it finds
        // whatever travels beside it.
        .current_dir(exe.parent().unwrap_or(&record.dir))
        .spawn()
        .map_err(|e| format!("could not open {}: {e}", comp.name()))?;

    // It closes itself: sitting behind the app it just launched helps nobody.
    app.exit(0);
    Ok(())
}

/// Opens the install folder in the system file browser.
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Opens a link in the browser.
///
/// It is only ever called with the release URL the GitHub API returned, but the
/// scheme is checked anyway: a `file://` or a `javascript:` here would make no
/// sense and would have consequences.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("I will not open a link that is not https: {url}"));
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// anyhow chains causes; without this the front end shows only the last line,
/// which tends to be the least useful one ("file not found", without saying
/// which file).
fn describe(e: anyhow::Error) -> String {
    let mut text = e.to_string();
    for cause in e.chain().skip(1) {
        text.push_str(&format!("\n  cause: {cause}"));
    }
    text
}

fn main() {
    let mode = if std::env::args().any(|a| a == "--uninstall" || a == "/uninstall") {
        Mode::Uninstall
    } else {
        Mode::Install
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Startup(mode))
        .setup(|app| {
            // Leftovers from an interrupted installation: if they stayed, the
            // next download would find them half-fetched.
            download::clean_temp();
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_mode,
            install_status,
            check_release,
            install,
            uninstall,
            launch_installed,
            open_folder,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error starting MARS Installer");
}
