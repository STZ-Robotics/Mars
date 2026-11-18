//! Desktop integration: shortcuts, the installed-programs entry, and the
//! WebView2 runtime.
//!
//! This is the part that differs most between systems and the part that fails
//! most silently, so nothing in here is fatal: if a shortcut cannot be created
//! the installed app still works and the installer says so. The one thing that
//! does have to work is WebView2 on Windows, because without it the app opens
//! a blank window.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// A shortcut that was created, so it can be removed on uninstall.
pub type Shortcut = PathBuf;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// Without this, every powershell call flashes a black console on top of
    /// the installer. There are three or four per installation.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn powershell(script: &str) -> Result<()> {
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .context("could not run powershell")?;
        if !out.status.success() {
            anyhow::bail!(
                "powershell failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    /// The user's Start Menu folder (not the all-users one: we do not want to
    /// need administrator rights).
    fn start_menu() -> Option<PathBuf> {
        dirs::data_dir().map(|d| d.join("Microsoft/Windows/Start Menu/Programs/MARS"))
    }

    fn desktop() -> Option<PathBuf> {
        dirs::desktop_dir()
    }

    /// Creates a `.lnk` with WScript.Shell, the same COM object Explorer uses.
    /// Writing the .lnk format by hand would be a library of its own.
    fn create_lnk(dest: &Path, target: &Path, description: &str) -> Result<()> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let workdir = target.parent().unwrap_or(Path::new("."));
        // PowerShell single quotes are escaped by doubling them; a path with an
        // apostrophe (C:\Users\D'Angelo\...) would break the script.
        let q = |p: &Path| p.display().to_string().replace('\'', "''");
        powershell(&format!(
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{}'); \
             $s.TargetPath = '{}'; \
             $s.WorkingDirectory = '{}'; \
             $s.Description = '{}'; \
             $s.IconLocation = '{}'; \
             $s.Save()",
            q(dest),
            q(target),
            q(workdir),
            description.replace('\'', "''"),
            q(target),
        ))
    }

    pub fn create_shortcuts(
        name: &str,
        target: &Path,
        on_desktop: bool,
    ) -> (Vec<Shortcut>, Vec<String>) {
        let mut created = Vec::new();
        let mut warnings = Vec::new();

        if let Some(dir) = start_menu() {
            let lnk = dir.join(format!("{name}.lnk"));
            match create_lnk(&lnk, target, name) {
                Ok(()) => created.push(lnk),
                Err(e) => warnings.push(format!("could not create the Start Menu shortcut: {e}")),
            }
        }
        if on_desktop {
            if let Some(dir) = desktop() {
                let lnk = dir.join(format!("{name}.lnk"));
                match create_lnk(&lnk, target, name) {
                    Ok(()) => created.push(lnk),
                    Err(e) => warnings.push(format!("could not create the desktop shortcut: {e}")),
                }
            }
        }
        (created, warnings)
    }

    /// Puts MARS in Windows' "Installed apps", with its uninstall button
    /// pointing at the copy of the installer left on disk.
    pub fn register_program(
        version: &str,
        edition: &str,
        dir: &Path,
        uninstaller: &Path,
        size_kb: u32,
    ) -> Result<()> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\MARS")
            .context("could not write the installed-programs entry")?;

        key.set_value(
            "DisplayName",
            &format!(
                "MARS Desktop ({})",
                if edition == "tools" { "Tools" } else { "Full" }
            ),
        )?;
        key.set_value("DisplayVersion", &version.to_string())?;
        key.set_value("Publisher", &"STZ Robotics".to_string())?;
        key.set_value("InstallLocation", &dir.display().to_string())?;
        key.set_value("DisplayIcon", &uninstaller.display().to_string())?;
        // The quotes are mandatory: without them a path with spaces (and
        // %LOCALAPPDATA% usually has them) is split into two arguments.
        key.set_value(
            "UninstallString",
            &format!("\"{}\" --uninstall", uninstaller.display()),
        )?;
        key.set_value("EstimatedSize", &size_kb)?;
        key.set_value("NoModify", &1u32)?;
        key.set_value("NoRepair", &1u32)?;
        Ok(())
    }

    /// Windows marks nothing that needs cleaning up after extraction.
    pub fn after_extract(_: &Path) -> Vec<String> {
        Vec::new()
    }

    pub fn unregister_program() -> Result<()> {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // Not existing is not an error: uninstalling twice has to be harmless.
        let _ = hkcu.delete_subkey_all(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\MARS");
        Ok(())
    }

    /// `true` if the WebView2 runtime is present.
    ///
    /// Without it a Tauri app opens a blank window and says nothing at all.
    /// Windows 11 ships it; Windows 10 does not always.
    pub fn has_webview2() -> bool {
        use winreg::enums::*;
        use winreg::RegKey;
        const CLIENT: &str =
            r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
        const CLIENT_WOW: &str =
            r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

        let has = |root: RegKey, path: &str| -> bool {
            root.open_subkey(path)
                .and_then(|k| k.get_value::<String, _>("pv"))
                .map(|v| !v.is_empty() && v != "0.0.0.0")
                .unwrap_or(false)
        };

        // Per-machine (on 64-bit it lands under WOW6432Node) or per-user. Any
        // of the three will do.
        has(RegKey::predef(HKEY_LOCAL_MACHINE), CLIENT_WOW)
            || has(RegKey::predef(HKEY_LOCAL_MACHINE), CLIENT)
            || has(RegKey::predef(HKEY_CURRENT_USER), CLIENT)
    }

    /// Downloads and installs the WebView2 runtime with Microsoft's official
    /// bootstrapper.
    ///
    /// The link is Microsoft's permanent one (fwlink), not a versioned URL: it
    /// always hands over the current installer.
    pub async fn install_webview2() -> Result<()> {
        let dest = crate::download::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
        crate::download::file(
            "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
            &dest,
            "",
            |_, _| {},
        )
        .await
        .context("could not download the WebView2 installer")?;

        let status = Command::new(&dest)
            // Silent and per-user: no UAC, like the rest of the installation.
            .args(["/silent", "/install"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .context("could not run the WebView2 installer")?;

        if !status.success() {
            anyhow::bail!(
                "the WebView2 installer exited with code {}. \
                 It can be installed by hand from \
                 https://developer.microsoft.com/microsoft-edge/webview2/",
                status.code().unwrap_or(-1)
            );
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use super::*;

    fn applications() -> Option<PathBuf> {
        dirs::data_dir().map(|d| d.join("applications"))
    }

    /// A `.desktop` file per the freedesktop spec. It is the exact equivalent
    /// of the .lnk: GNOME, KDE and any launcher read it.
    fn create_desktop_entry(dest: &Path, name: &str, target: &Path) -> Result<()> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let contents = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name={name}\n\
             Comment=MARS — FRC robotics tooling\n\
             Exec=\"{}\"\n\
             Path={}\n\
             Icon={}\n\
             Terminal=false\n\
             Categories=Development;Engineering;\n",
            target.display(),
            target.parent().unwrap_or(Path::new(".")).display(),
            target
                .parent()
                .unwrap_or(Path::new("."))
                .join("icon.png")
                .display(),
        );
        std::fs::write(dest, contents)
            .with_context(|| format!("could not write {}", dest.display()))?;

        // Without the execute bit GNOME marks the launcher as untrusted and it
        // has to be allowed by hand from the context menu.
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(dest) {
            let mut p = meta.permissions();
            p.set_mode(p.mode() | 0o755);
            let _ = std::fs::set_permissions(dest, p);
        }
        Ok(())
    }

    pub fn create_shortcuts(
        name: &str,
        target: &Path,
        on_desktop: bool,
    ) -> (Vec<Shortcut>, Vec<String>) {
        let mut created = Vec::new();
        let mut warnings = Vec::new();
        let file = format!("{}.desktop", name.to_lowercase().replace(' ', "-"));

        if let Some(dir) = applications() {
            let path = dir.join(&file);
            match create_desktop_entry(&path, name, target) {
                Ok(()) => created.push(path),
                Err(e) => warnings.push(format!("could not create the launcher: {e}")),
            }
        }
        if on_desktop {
            if let Some(dir) = dirs::desktop_dir() {
                let path = dir.join(&file);
                match create_desktop_entry(&path, name, target) {
                    Ok(()) => created.push(path),
                    Err(e) => warnings.push(format!("could not create the desktop launcher: {e}")),
                }
            }
        }
        (created, warnings)
    }

    pub fn after_extract(_: &Path) -> Vec<String> {
        Vec::new()
    }

    /// Linux has no installed-programs registry: the `.desktop` file and the
    /// folder are all there is, and `install.rs` already handles those.
    pub fn register_program(_: &str, _: &str, _: &Path, _: &Path, _: u32) -> Result<()> {
        Ok(())
    }
    pub fn unregister_program() -> Result<()> {
        Ok(())
    }
    /// On Linux the webview is WebKitGTK and comes from the package manager.
    pub fn has_webview2() -> bool {
        true
    }
    pub async fn install_webview2() -> Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    /// On macOS there is nothing to create: the app is a bundle inside
    /// ~/Applications, which is where Launchpad and Spotlight find apps. A
    /// `.desktop` file does not exist and a Finder alias would need AppleScript
    /// for something that adds nothing.
    pub fn create_shortcuts(_: &str, _: &Path, _: bool) -> (Vec<Shortcut>, Vec<String>) {
        (Vec::new(), Vec::new())
    }

    /// Clears Gatekeeper's quarantine from what was just installed.
    ///
    /// macOS tags everything downloaded from the internet with
    /// `com.apple.quarantine`, and an unsigned binary under quarantine WILL NOT
    /// OPEN: it says "cannot be checked for malicious software" and the user
    /// has to go to Settings to allow it. Since the installer is what
    /// downloaded the files, it can clear the tag itself; that is exactly the
    /// consent Gatekeeper is asking for.
    ///
    /// This does NOT replace signing and notarising the app, which is the right
    /// thing once there is an Apple developer account. Until then, it is the
    /// difference between opening and not opening.
    pub fn after_extract(dir: &Path) -> Vec<String> {
        match std::process::Command::new("xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(dir)
            .status()
        {
            Ok(s) if s.success() => Vec::new(),
            Ok(s) => vec![format!(
                "could not clear Gatekeeper's quarantine (xattr exited with {}). \
                 If macOS refuses to open the app, right-click it and choose Open.",
                s.code().unwrap_or(-1)
            )],
            Err(e) => vec![format!("could not run xattr: {e}")],
        }
    }

    pub fn register_program(_: &str, _: &str, _: &Path, _: &Path, _: u32) -> Result<()> {
        Ok(())
    }
    pub fn unregister_program() -> Result<()> {
        Ok(())
    }
    /// The macOS webview is WKWebView, part of the system.
    pub fn has_webview2() -> bool {
        true
    }
    pub async fn install_webview2() -> Result<()> {
        Ok(())
    }
}

pub use imp::{
    after_extract, create_shortcuts, has_webview2, install_webview2, register_program,
    unregister_program,
};

/// Removes the shortcuts an installation registered.
pub fn remove_shortcuts(shortcuts: &[PathBuf]) {
    for s in shortcuts {
        let _ = std::fs::remove_file(s);
    }
    // On Windows the Start Menu "MARS" folder is left behind: it goes if it
    // ended up empty.
    for s in shortcuts {
        if let Some(parent) = s.parent() {
            if parent.file_name().is_some_and(|n| n == "MARS") {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
}
