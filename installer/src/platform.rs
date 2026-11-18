//! What differs between Windows, Linux and macOS: file names, default paths
//! and which components exist on each one.
//!
//! Everything platform-specific lives here or in `integration.rs`. The rest of
//! the installer works with these values and never asks about the operating
//! system, so adding a platform means touching those two files.

use std::path::PathBuf;

/// System identifier as it appears in a release's file names:
/// `mars-desktop-full-windows-x86_64.zip`.
pub const OS: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

/// Architecture, using the same names Rust does.
pub const ARCH: &str = if cfg!(target_arch = "aarch64") {
    "aarch64"
} else {
    "x86_64"
};

/// Extension of the archive format we know how to open on this platform.
pub const ARCHIVE_EXT: &str = if cfg!(windows) { "zip" } else { "tar.gz" };

/// Executable suffix.
pub const EXE_EXT: &str = if cfg!(windows) { ".exe" } else { "" };

/// The app bundle the macOS archive carries at its root. A bare executable is
/// not an app there: Finder opens it in a Terminal and Launchpad and Spotlight
/// do not list it. The name is a contract with `scripts/package-release.mjs`.
pub const MAC_APP: &str = "MARS Desktop.app";

/// The components of the ecosystem. `id` is what release file names and the
/// install record use.
///
/// There used to be a second one, the Simulation Studio. It is no longer
/// distributed: an installation that has it loses it on its next update, since
/// updating removes everything the install record lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Component {
    /// The dashboard application.
    MarsDesktop,
}

impl Component {
    pub fn id(&self) -> &'static str {
        match self {
            Component::MarsDesktop => "mars-desktop",
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Component::MarsDesktop => "MARS Desktop",
        }
    }

    /// Executable name inside the archive, without extension: the one cargo
    /// produces. Presentable names belong on the shortcuts.
    pub fn binary(&self) -> &'static str {
        match self {
            Component::MarsDesktop => "mars-desktop",
        }
    }

    /// Where the executable lands, relative to the install folder: at its
    /// root, or inside the app bundle on macOS.
    pub fn exe_file(&self) -> String {
        if cfg!(target_os = "macos") {
            format!("{MAC_APP}/Contents/MacOS/{}", self.binary())
        } else {
            format!("{}{}", self.binary(), EXE_EXT)
        }
    }
}

/// Edition chosen on the selection screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edition {
    /// The whole MARS ecosystem.
    Full,
    /// Just the NetworkTables dashboard, with nothing from the framework.
    Tools,
}

impl Edition {
    pub fn id(&self) -> &'static str {
        match self {
            Edition::Full => "full",
            Edition::Tools => "tools",
        }
    }
}

/// Which components an edition ships. Both editions are one build of
/// MARS Desktop each; what differs is what is compiled into it.
pub fn components(_edition: Edition) -> Vec<Component> {
    vec![Component::MarsDesktop]
}

/// Default installation folder.
///
/// Always per-user, never Program Files or /opt: installing without
/// administrator rights is what lets a student do it on the lab computer
/// without asking anyone for a password.
pub fn default_dir() -> PathBuf {
    #[cfg(windows)]
    {
        // %LOCALAPPDATA%\Programs is where VS Code and Discord put their apps.
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Programs")
            .join("MARS")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Applications")
            .join("MARS")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // ~/.local/share, as the XDG spec says.
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("MARS")
    }
}

/// User data folder: preferences, workspaces and 3D asset packs.
///
/// Shared by both editions and NOT removed on uninstall unless explicitly
/// asked for. It is the same one mars-desktop uses (`dirs::config_dir()/MARS`),
/// so reinstalling loses nothing.
pub fn user_data_dir() -> PathBuf {
    dirs::config_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MARS")
}

/// Release file name for a given component and edition.
///
/// This is the contract with `scripts/package-release.mjs` and with the
/// workflow: if it changes here, it changes there. A malformed name shows up
/// as "no build for your platform", which is an honest but useless message.
pub fn archive_name(component: Component, edition: Edition) -> String {
    match component {
        Component::MarsDesktop => format!(
            "mars-desktop-{}-{}-{}.{}",
            edition.id(),
            OS,
            ARCH,
            ARCHIVE_EXT
        ),
    }
}
