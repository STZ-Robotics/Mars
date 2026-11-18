//! Launching the programs MARS Desktop hands work to: VS Code and git.
//!
//! Two things go wrong when a GUI app starts them, and neither shows on the
//! machine it is developed on:
//!
//! - **macOS.** An app opened from Finder or the Dock does not get the PATH a
//!   terminal has: it gets `/usr/bin:/bin:/usr/sbin:/sbin`, and `code` lives in
//!   `/usr/local/bin`, `/opt/homebrew/bin` or inside the VS Code bundle. Asking
//!   for a bare `code` failed every time unless MARS was launched from a
//!   terminal.
//! - **Windows.** MARS is a GUI program, and a console program it starts (`git`,
//!   `cmd` running `code.cmd`) gets a console window of its own: a black window
//!   flashing up for every git command of the feature wizard.

use std::process::Command;

/// `CREATE_NO_WINDOW`: the child runs without a console window of its own.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command for VS Code's command-line launcher; the caller adds the
/// arguments (a folder, or `-g file:line`).
pub fn vscode() -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `code` is `code.cmd` on Windows, which only cmd knows how to run.
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "code"]).creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(find_vscode_cli().unwrap_or_else(|| "code".into()))
    }
}

/// A `git` command that opens no console window.
pub fn git() -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Where VS Code's `code` launcher is: the PATH first, then the places it is
/// installed in when the PATH an app was given does not include them.
#[cfg(not(windows))]
fn find_vscode_cli() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let on_path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|dir| dir.join("code")).collect())
        .unwrap_or_default();

    const BUNDLE_CLI: &str = "Visual Studio Code.app/Contents/Resources/app/bin/code";
    let mut known: Vec<PathBuf> = vec![
        "/usr/local/bin/code".into(),
        "/opt/homebrew/bin/code".into(),
        PathBuf::from("/Applications").join(BUNDLE_CLI),
        "/usr/bin/code".into(),
        "/snap/bin/code".into(),
        "/usr/share/code/bin/code".into(),
    ];
    if let Some(home) = dirs::home_dir() {
        known.push(home.join("Applications").join(BUNDLE_CLI));
    }

    on_path.into_iter().chain(known).find(|p| p.is_file())
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    /// With a PATH that has none of the usual folders, as an app opened from
    /// Finder gets, the launcher is still found where it is installed.
    #[test]
    fn finds_code_outside_a_bare_path() {
        let dir = std::env::temp_dir().join(format!("mars-vscode-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("code");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();

        let before = std::env::var_os("PATH");
        std::env::set_var("PATH", &dir);
        let found = find_vscode_cli();
        match before {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }

        assert_eq!(found.as_deref(), Some(fake.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
