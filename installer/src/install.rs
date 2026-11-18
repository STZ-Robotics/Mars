//! Installing, updating and uninstalling: the order of operations and the
//! record of what was done.
//!
//! The central idea is that **uninstalling deletes exactly what installing
//! created**, not one file more. That is why every installation leaves a record
//! with the list of files and shortcuts. A `remove_dir_all` on the folder the
//! user picked is one line shorter and an excellent way to wipe the desktop of
//! somebody who installed into `C:\`.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::manifest;
use crate::platform::{self, Component, Edition};
use crate::{archive, download, integration};

/// What an installation left on disk. Written by `install` and read by
/// everything else.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallRecord {
    /// Bumped if the format changes incompatibly.
    pub schema: u32,
    pub version: String,
    // The aliases are the Spanish field names this file used in 1.1.3. Without
    // them, an installation made with that build would stop being found and its
    // uninstaller would claim nothing is installed.
    #[serde(alias = "edicion")]
    pub edition: Edition,
    #[serde(alias = "instalado_en")]
    pub installed_at: String,
    #[serde(alias = "carpeta")]
    pub dir: PathBuf,
    #[serde(alias = "componentes")]
    pub components: Vec<String>,
    /// Paths relative to `dir`.
    #[serde(alias = "archivos")]
    pub files: Vec<String>,
    #[serde(alias = "atajos")]
    pub shortcuts: Vec<PathBuf>,
}

const SCHEMA: u32 = 1;

/// Where the record lives.
///
/// In the user data folder rather than the install folder, so a previous
/// installation can be found without knowing where it was put.
fn record_path() -> PathBuf {
    platform::user_data_dir().join("installation.json")
}

/// The name 1.1.3 used. Read as a fallback so an installation made with that
/// build can still be updated and uninstalled.
fn legacy_record_path() -> PathBuf {
    platform::user_data_dir().join("instalacion.json")
}

pub fn read_record() -> Option<InstallRecord> {
    let text = std::fs::read_to_string(record_path())
        .or_else(|_| std::fs::read_to_string(legacy_record_path()))
        .ok()?;
    let record: InstallRecord = serde_json::from_str(&text).ok()?;
    // A record pointing at a folder that no longer exists (deleted by hand) is
    // worse than no record: it would claim the app is installed.
    if !record.dir.exists() {
        return None;
    }
    Some(record)
}

fn write_record(record: &InstallRecord) -> Result<()> {
    let path = record_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(record)?)
        .with_context(|| format!("could not write {}", path.display()))?;
    // Leaving both around would mean two sources of truth the next time.
    let _ = std::fs::remove_file(legacy_record_path());
    Ok(())
}

/// What the interface needs to know when it opens.
#[derive(Debug, Serialize)]
pub struct Status {
    pub installed: Option<InstallRecord>,
    pub os: &'static str,
    pub arch: &'static str,
    pub suggested_dir: PathBuf,
    pub repo: String,
    pub installer_version: &'static str,
    /// On Windows, whether the WebView2 runtime is missing.
    pub needs_webview2: bool,
}

pub fn status() -> Status {
    let installed = read_record();
    Status {
        suggested_dir: installed
            .as_ref()
            .map(|r| r.dir.clone())
            .unwrap_or_else(platform::default_dir),
        installed,
        os: platform::OS,
        arch: platform::ARCH,
        repo: manifest::repo(),
        installer_version: env!("CARGO_PKG_VERSION"),
        needs_webview2: !integration::has_webview2(),
    }
}

/// Options coming from the selection screen.
#[derive(Debug, Clone, Deserialize)]
pub struct Options {
    pub edition: Edition,
    pub dir: PathBuf,
    #[serde(default)]
    pub desktop_shortcut: bool,
}

/// One progress step, exactly as the interface paints it.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    /// "prepare" | "webview2" | "download" | "install" | "shortcuts" | "done" | "warning"
    pub phase: &'static str,
    pub message: String,
    /// 0-100 of the whole installation.
    pub percent: u8,
}

/// Installs (or reinstalls) the ecosystem.
///
/// `emit` receives every step. It is a callback rather than an `AppHandle` so
/// all of this logic can be tested without opening a window.
pub async fn install<F>(options: Options, mut emit: F) -> Result<InstallRecord>
where
    F: FnMut(Progress),
{
    manifest::validate_repo()?;

    let report = |emit: &mut F, phase: &'static str, pct: u8, msg: String| {
        emit(Progress { phase, message: msg, percent: pct });
    };

    report(&mut emit, "prepare", 2, "Checking the latest version…".into());
    let plan = manifest::fetch(options.edition).await?;

    for m in &plan.missing {
        report(
            &mut emit,
            "warning",
            2,
            format!("The release does not publish {m} for this platform: skipping it."),
        );
    }

    // WebView2 before anything else: without it the app installs fine but opens
    // blank, and that symptom leads nobody to suspect the runtime.
    if !integration::has_webview2() {
        report(
            &mut emit,
            "webview2",
            5,
            "Installing Microsoft's WebView2 runtime…".into(),
        );
        integration::install_webview2().await?;
    }

    // An update with MARS still open is refused here, before anything is
    // touched: on Windows its executable is locked, so the old files could not
    // be deleted and the new ones could not be written over them. Going ahead
    // used to remove the shortcuts and the program entry, then fail halfway
    // through the extraction, and leave the user with neither version.
    let previous = read_record();
    if let Some(previous) = &previous {
        ensure_not_running(previous)?;
    }

    let temp = download::temp_dir();
    let total_artifacts = plan.artifacts.len().max(1) as u8;
    let mut files: Vec<String> = Vec::new();
    let mut components: Vec<String> = Vec::new();

    // Everything is downloaded and verified BEFORE the previous version is
    // removed: a dropped connection or a bad checksum then costs a retry, not
    // the installation that was working.
    // 10% for preparing, 60% for downloading, 15% for extracting, 15% for the rest.
    let mut downloaded: Vec<(&manifest::Artifact, PathBuf)> = Vec::new();
    for (i, art) in plan.artifacts.iter().enumerate() {
        let base = 10 + (60 / total_artifacts) * i as u8;
        let span = 60 / total_artifacts;
        let name = component_name(&art.component);

        let archive_path = temp.join(&art.file);
        let mut last_pct = u8::MAX;
        download::file(&art.url, &archive_path, &art.sha256, |done, total| {
            let frac = if total > 0 { done as f64 / total as f64 } else { 0.0 };
            let pct = base + (span as f64 * frac) as u8;
            // Without this filter one event is emitted per stream chunk:
            // thousands of messages to the webview to move a bar by one pixel.
            if pct != last_pct {
                last_pct = pct;
                emit(Progress {
                    phase: "download",
                    message: format!("Downloading {name} — {}", human_size(done, total)),
                    percent: pct,
                });
            }
        })
        .await?;
        downloaded.push((art, archive_path));
    }

    // Reinstalling over another version: clean the old one out first, so files
    // from a previous version do not end up mixed in with the new ones. Checked
    // again because MARS may have been opened while the download ran.
    if let Some(previous) = &previous {
        ensure_not_running(previous)?;
        report(
            &mut emit,
            "prepare",
            70,
            format!("Removing the previous version ({})…", previous.version),
        );
        remove_installation(previous);
    }

    std::fs::create_dir_all(&options.dir)
        .with_context(|| format!("could not create {}", options.dir.display()))?;

    for (i, (art, archive_path)) in downloaded.iter().enumerate() {
        report(
            &mut emit,
            "install",
            72 + (13 / total_artifacts) * i as u8,
            format!("Installing {}…", component_name(&art.component)),
        );
        let created = archive::extract(archive_path, &options.dir)
            .with_context(|| format!("could not extract {}", art.file))?;
        let _ = std::fs::remove_file(archive_path);

        // Without the filter, a file that ships in both archives (the icon)
        // shows up twice: it does not break removal, but the summary lies to
        // the user about how many files were installed.
        for c in created {
            if !files.contains(&c) {
                files.push(c);
            }
        }
        components.push(art.component.clone());
    }

    // The installer copies itself into the destination: that copy is what
    // Windows' "Uninstall" button runs, and by then the original may be in
    // Downloads, on a USB stick, or simply deleted.
    report(&mut emit, "install", 88, "Leaving the uninstaller behind…".into());
    match copy_self(&options.dir) {
        Ok(rel) => files.push(rel),
        Err(e) => report(
            &mut emit,
            "warning",
            88,
            format!("Could not leave the uninstaller behind: {e}"),
        ),
    }

    // macOS quarantines everything downloaded: that has to be cleared before
    // making shortcuts to something that will not open.
    for warning in integration::after_extract(&options.dir) {
        report(&mut emit, "warning", 90, warning);
    }

    report(&mut emit, "shortcuts", 92, "Creating shortcuts…".into());
    let mut shortcuts = Vec::new();
    for comp in platform::components(options.edition) {
        if !components.iter().any(|c| c == comp.id()) {
            continue; // not installed (the release did not ship it)
        }
        let exe = options.dir.join(comp.exe_file());
        if !exe.exists() {
            report(
                &mut emit,
                "warning",
                92,
                format!("The {} archive did not contain {}", comp.name(), comp.exe_file()),
            );
            continue;
        }
        let name = shortcut_name(comp, options.edition);
        let (created, warnings) =
            integration::create_shortcuts(&name, &exe, options.desktop_shortcut);
        shortcuts.extend(created);
        for w in warnings {
            report(&mut emit, "warning", 92, w);
        }
    }

    let record = InstallRecord {
        schema: SCHEMA,
        version: plan.release.version.clone(),
        edition: options.edition,
        installed_at: now_epoch(),
        dir: options.dir.clone(),
        components,
        files,
        shortcuts,
    };
    write_record(&record)?;

    report(&mut emit, "shortcuts", 96, "Registering the program…".into());
    let kb = (total_size(&record) / 1024) as u32;
    let uninstaller = options.dir.join(uninstaller_name());
    if let Err(e) = integration::register_program(
        &record.version,
        record.edition.id(),
        &options.dir,
        &uninstaller,
        kb,
    ) {
        report(
            &mut emit,
            "warning",
            96,
            format!("Could not register the program: {e}"),
        );
    }

    download::clean_temp();
    report(&mut emit, "done", 100, format!("MARS {} installed.", record.version));
    Ok(record)
}

/// Refuses to go on while a program of the installation is open, saying which
/// one, so the user closes it and tries again with nothing changed yet.
fn ensure_not_running(record: &InstallRecord) -> Result<()> {
    let busy = files_in_use(record);
    if busy.is_empty() {
        return Ok(());
    }
    bail!(
        "MARS is still open ({} in use). Close it, then try again: nothing has been changed.",
        busy.join(", ")
    );
}

/// The installation's programs that something still has open.
///
/// Windows will neither delete nor overwrite the executable of a running
/// process, and opening it for writing fails with a sharing violation, which
/// is how this asks without deleting anything. The running installer is
/// skipped: when it is the uninstaller copy, it is locked by itself and is
/// handled by `schedule_self_delete`.
#[cfg(windows)]
fn files_in_use(record: &InstallRecord) -> Vec<String> {
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    let me = std::env::current_exe().ok();
    record
        .files
        .iter()
        .filter(|rel| {
            let lower = rel.to_ascii_lowercase();
            lower.ends_with(".exe") || lower.ends_with(".dll")
        })
        .filter(|rel| {
            let path = record.dir.join(rel);
            if me.as_deref() == Some(path.as_path()) {
                return false;
            }
            match std::fs::OpenOptions::new().write(true).open(&path) {
                Err(e) => matches!(e.raw_os_error(), Some(ERROR_SHARING_VIOLATION | ERROR_ACCESS_DENIED)),
                Ok(_) => false,
            }
        })
        .cloned()
        .collect()
}

/// Elsewhere an open file can be unlinked and replaced: the running app keeps
/// the old one until it closes, and nothing has to wait.
#[cfg(not(windows))]
fn files_in_use(_: &InstallRecord) -> Vec<String> {
    Vec::new()
}

/// Deletes what an installation registered. Does not touch user data.
fn remove_installation(record: &InstallRecord) {
    integration::remove_shortcuts(&record.shortcuts);
    let _ = integration::unregister_program();

    for rel in &record.files {
        let path = record.dir.join(rel);
        // On Windows the uninstaller is running right now: it cannot be deleted
        // yet, so that is scheduled for afterwards.
        let _ = std::fs::remove_file(&path);
    }

    // Folders that ended up empty, innermost first. Never recursive: if
    // anything we did not put there is left over, it stays.
    let mut dirs: Vec<PathBuf> = record
        .files
        .iter()
        .filter_map(|rel| record.dir.join(rel).parent().map(|p| p.to_path_buf()))
        .filter(|p| p.starts_with(&record.dir) && p != &record.dir)
        .collect();
    dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    dirs.dedup();
    for d in dirs {
        let _ = std::fs::remove_dir(d);
    }
    let _ = std::fs::remove_dir(&record.dir);
}

/// Removes MARS from the machine.
///
/// `delete_data` covers preferences, saved layouts and downloaded 3D asset
/// packs. It is separate and defaults to `false` because those are hours of the
/// team's work and an uninstaller has no business taking them along.
pub fn uninstall(delete_data: bool) -> Result<String> {
    let Some(record) = read_record() else {
        bail!("I found no MARS installation registered on this computer.");
    };

    ensure_not_running(&record)?;
    remove_installation(&record);

    let data = platform::user_data_dir();
    if delete_data {
        let _ = std::fs::remove_dir_all(&data);
    } else {
        let _ = std::fs::remove_file(record_path());
        let _ = std::fs::remove_file(legacy_record_path());
    }

    schedule_self_delete(&record.dir);

    Ok(if delete_data {
        format!(
            "MARS {} uninstalled, including the data in {}.",
            record.version,
            data.display()
        )
    } else {
        format!(
            "MARS {} uninstalled. Your preferences and layouts are still in {}.",
            record.version,
            data.display()
        )
    })
}

/// Line ending for a .bat file.
///
/// Written as escapes rather than a literal break inside the string so it does
/// not depend on how whatever editor comes next saves this file: a .bat with
/// Unix line endings works by accident on modern cmd, but fails in strange ways
/// around labels and blocks.
#[cfg(windows)]
const BAT_NEWLINE: &str = "\r\n";

/// The uninstaller cannot delete itself while it runs.
///
/// On Windows the file is locked by its own process; the classic way out is to
/// leave a command that waits for the process to die and only then deletes. On
/// Unix an open file can be unlinked, so nothing special is needed.
#[cfg(windows)]
fn schedule_self_delete(dir: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let Ok(me) = std::env::current_exe() else { return };
    if !me.starts_with(dir) {
        // This is the original installer running, not the copy: nothing is
        // locked and `remove_installation` already handled it.
        return;
    }

    // The commands go in a .bat and not in a `cmd /C "…"` for two reasons:
    //
    // 1. `cmd /C` with nested quotes is a minefield — cmd eats the first and
    //    last pair of quotes — and a path with spaces (%LOCALAPPDATA% always
    //    has them) comes out in pieces. The symptom is that nothing is deleted
    //    and nothing says why.
    // 2. The loop allows retrying: the process can take a moment to release the
    //    file, and a single attempt two seconds later fails silently.
    //
    // The .bat deletes itself at the end (`%~f0`).
    let bat = std::env::temp_dir().join("mars-cleanup.bat");
    let (exe, folder) = (me.display().to_string(), dir.display().to_string());
    let script = [
        "@echo off".to_string(),
        "setlocal".to_string(),
        "for /l %%i in (1,1,15) do (".to_string(),
        format!("  del /f /q \"{exe}\" >nul 2>&1"),
        format!("  if not exist \"{exe}\" goto done"),
        "  ping 127.0.0.1 -n 2 >nul".to_string(),
        ")".to_string(),
        ":done".to_string(),
        format!("rmdir \"{folder}\" >nul 2>&1"),
        "del /f /q \"%~f0\" >nul 2>&1".to_string(),
        String::new(),
    ]
    .join(BAT_NEWLINE);

    if std::fs::write(&bat, script).is_err() {
        return;
    }

    let _ = std::process::Command::new("cmd")
        .arg("/C")
        .arg(&bat)
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn();
}

#[cfg(not(windows))]
fn schedule_self_delete(dir: &Path) {
    if let Ok(me) = std::env::current_exe() {
        if me.starts_with(dir) {
            let _ = std::fs::remove_file(&me);
            let _ = std::fs::remove_dir(dir);
        }
    }
}

fn uninstaller_name() -> String {
    format!("mars-uninstall{}", platform::EXE_EXT)
}

/// Copies the installer into the install folder.
fn copy_self(dir: &Path) -> Result<String> {
    let me = std::env::current_exe().context("I do not know my own executable")?;
    let dest = dir.join(uninstaller_name());
    if me == dest {
        return Ok(uninstaller_name());
    }
    std::fs::copy(&me, &dest)
        .with_context(|| format!("could not copy myself to {}", dest.display()))?;
    Ok(uninstaller_name())
}

fn total_size(record: &InstallRecord) -> u64 {
    record
        .files
        .iter()
        .filter_map(|rel| std::fs::metadata(record.dir.join(rel)).ok())
        .map(|m| m.len())
        .sum()
}

fn component_name(_id: &str) -> &'static str {
    Component::MarsDesktop.name()
}

/// The name shown in the Start Menu.
///
/// The Tools edition is spelled out there because otherwise two computers on
/// the same team running different editions look identical and nobody knows
/// which is which.
fn shortcut_name(comp: Component, edition: Edition) -> String {
    match (comp, edition) {
        (Component::MarsDesktop, Edition::Tools) => "MARS Desktop Tools".to_string(),
        _ => comp.name().to_string(),
    }
}

fn human_size(done: u64, total: u64) -> String {
    let mb = |b: u64| b as f64 / 1_048_576.0;
    if total > 0 {
        format!("{:.1} of {:.1} MB", mb(done), mb(total))
    } else {
        format!("{:.1} MB", mb(done))
    }
}

/// A timestamp without dragging in a calendar dependency.
///
/// It is only ever displayed ("installed on…"), so seconds since the epoch is
/// enough and `chrono` would cost more than it adds.
fn now_epoch() -> String {
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{s}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shortcut_spells_out_the_tools_edition() {
        assert_eq!(
            shortcut_name(Component::MarsDesktop, Edition::Full),
            "MARS Desktop"
        );
        assert_eq!(
            shortcut_name(Component::MarsDesktop, Edition::Tools),
            "MARS Desktop Tools"
        );
    }

    /// An install record written by 1.1.3, with the old Spanish field names,
    /// still has to be readable — otherwise its uninstaller would claim nothing
    /// is installed and the files would be orphaned.
    #[test]
    fn reads_a_record_written_by_the_previous_version() {
        let old = r#"{
            "schema": 1,
            "version": "1.1.3",
            "edicion": "full",
            "instalado_en": "1789187921",
            "carpeta": "C:\\MARS",
            "componentes": ["mars-desktop"],
            "archivos": ["mars-desktop.exe"],
            "atajos": ["C:\\MARS Desktop.lnk"]
        }"#;
        let r: InstallRecord = serde_json::from_str(old).expect("the old format must still parse");
        assert_eq!(r.edition, Edition::Full);
        assert_eq!(r.files, vec!["mars-desktop.exe"]);
        assert_eq!(r.shortcuts.len(), 1);
    }

    /// Actually downloads an archive from the release and opens it.
    ///
    /// This covers the stretch where the most can go wrong silently: that the
    /// manifest's checksum matches the published bytes, and that the executable
    /// lands at the ROOT of the install folder, which is where the shortcuts
    /// point.
    ///
    /// It deliberately creates no shortcuts and touches no registry: that would
    /// modify the machine of whoever runs the tests. Everything happens in a
    /// temporary folder that is removed at the end.
    #[tokio::test]
    #[ignore = "needs the network and a published release"]
    async fn downloads_and_extracts_a_real_archive() {
        let plan = manifest::fetch(Edition::Full).await.expect("fetch");
        let art = plan
            .artifacts
            .iter()
            .find(|a| a.component == Component::MarsDesktop.id())
            .expect("the release does not ship mars-desktop");

        let dir = std::env::temp_dir().join("mars-installer-test");
        let _ = std::fs::remove_dir_all(&dir);

        let path = dir.join(&art.file);
        crate::download::file(&art.url, &path, &art.sha256, |_, _| {})
            .await
            .expect("the download or the sha256 failed");

        let created = archive::extract(&path, &dir).expect("could not extract");
        let exe = Component::MarsDesktop.exe_file();
        assert!(
            created.iter().any(|c| c == &exe),
            "the archive has no {exe} at its root, but: {created:?}"
        );
        assert!(dir.join(&exe).is_file());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A program held open, as a running MARS Desktop holds its .exe, stops an
    /// update before anything is removed; once it is closed, nothing is in use.
    #[cfg(windows)]
    #[test]
    fn an_open_program_is_reported_in_use() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join("mars-installer-in-use");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("mars-desktop.exe"), b"MZ").unwrap();
        std::fs::write(dir.join("README.txt"), b"").unwrap();
        let record = InstallRecord {
            schema: SCHEMA,
            version: "1.1.6".into(),
            edition: Edition::Full,
            installed_at: "0".into(),
            dir: dir.clone(),
            components: vec!["mars-desktop".into()],
            files: vec!["mars-desktop.exe".into(), "README.txt".into()],
            shortcuts: vec![],
        };

        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(dir.join("mars-desktop.exe"))
            .unwrap();
        assert_eq!(files_in_use(&record), vec!["mars-desktop.exe".to_string()]);
        let err = ensure_not_running(&record).unwrap_err().to_string();
        assert!(err.contains("mars-desktop.exe") && err.contains("nothing has been changed"), "{err}");

        drop(held);
        assert!(files_in_use(&record).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn human_size_does_not_lie_when_there_is_no_total() {
        assert_eq!(human_size(1_048_576, 2_097_152), "1.0 of 2.0 MB");
        assert_eq!(human_size(1_048_576, 0), "1.0 MB");
    }
}
