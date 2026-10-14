//! Raw text files, the app's own file browser, and preferences.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;

use super::paths::{resolve, resolve_editable};

pub fn read_text(sim_dir: &Path, rel: &str) -> Result<String> {
    let p = resolve(sim_dir, rel)?;
    std::fs::read_to_string(&p).with_context(|| format!("could not read {}", p.display()))
}

pub fn write_text(sim_dir: &Path, rel: &str, content: &str) -> Result<()> {
    let p = resolve_editable(sim_dir, rel)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&p, content).with_context(|| format!("could not write {}", p.display()))
}

// --- file browser ------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    pub dir: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    /// Suggested roots: the drives on Windows, `/` and `$HOME` elsewhere.
    pub shortcuts: Vec<Entry>,
}

/// The app's own disk browser.
///
/// The app does not carry `tauri-plugin-dialog`: one more dependency to open
/// a file picker, in an app whose only use of the disk is "pick an .sdf".
/// This does it with `std::fs` and also fits the rest of the chrome, which
/// already imitates an old desktop program.
pub fn browse(dir: Option<&str>, filter: &[String]) -> Result<Listing> {
    let dir = match dir.filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => home_dir(),
    };
    let dir = dir.canonicalize().unwrap_or(dir);

    let mut entries = Vec::new();
    for e in std::fs::read_dir(&dir)
        .with_context(|| format!("could not open {}", dir.display()))?
        .flatten()
    {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = e.path().is_dir();
        if !is_dir && !filter.is_empty() {
            let ext = e
                .path()
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !filter.iter().any(|f| f == &ext) {
                continue;
            }
        }
        entries.push(Entry {
            name,
            path: e.path().display().to_string(),
            is_dir,
            bytes: e.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
    // Folders first and alphabetical within each group: the order of
    // `read_dir` is the file system's, which is no order at all.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(Listing {
        dir: dir.display().to_string(),
        parent: dir.parent().map(|p| p.display().to_string()),
        entries,
        shortcuts: shortcuts(),
    })
}

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

fn shortcuts() -> Vec<Entry> {
    let mut v = Vec::new();
    let mut push = |name: &str, p: PathBuf| {
        if p.is_dir() {
            v.push(Entry {
                name: name.to_string(),
                path: p.display().to_string(),
                is_dir: true,
                bytes: 0,
            });
        }
    };
    let home = home_dir();
    push("Home", home.clone());
    push("Desktop", home.join("Desktop"));
    push("Documents", home.join("Documents"));
    push("Downloads", home.join("Downloads"));
    if cfg!(windows) {
        for letter in 'A'..='Z' {
            let drive = PathBuf::from(format!("{letter}:\\"));
            if drive.is_dir() {
                v.push(Entry {
                    name: format!("{letter}:"),
                    path: drive.display().to_string(),
                    is_dir: true,
                    bytes: 0,
                });
            }
        }
    } else {
        push("Root", PathBuf::from("/"));
    }
    v
}

/// Opens a path in the system's file explorer.
pub fn reveal(sim_dir: &Path, rel: &str) -> Result<()> {
    let p = resolve(sim_dir, rel)?;
    let (program, args): (&str, Vec<String>) = if cfg!(windows) {
        ("explorer", vec![format!("/select,{}", p.display())])
    } else if cfg!(target_os = "macos") {
        ("open", vec!["-R".into(), p.display().to_string()])
    } else {
        (
            "xdg-open",
            vec![p.parent().unwrap_or(&p).display().to_string()],
        )
    };
    // `explorer` returns non-zero codes even when it opens the window: the
    // status is not checked on purpose.
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .with_context(|| format!("could not open {}", p.display()))?;
    Ok(())
}

// --- preferences -------------------------------------------------------

/// Preferences are opaque JSON: what the UI stores is the UI's business.
/// They live in `build/` because they are local state, not something that
/// goes into the repository.
pub fn prefs(sim_dir: &Path) -> serde_json::Value {
    std::fs::read_to_string(sim_dir.join("build/studio-prefs.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn save_prefs(sim_dir: &Path, value: &serde_json::Value) -> Result<()> {
    let dir = sim_dir.join("build");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        dir.join("studio-prefs.json"),
        serde_json::to_string_pretty(value)?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The browser: folders first, and the extension filter applied only to
    /// files.
    ///
    /// Both are invisible until they fail. Without the ordering, the dialog
    /// shows whatever the file system returns, which is no order; without the
    /// filter applying to files only, filtering by `sdf` hides the folders and
    /// you cannot navigate anywhere.
    #[test]
    fn the_browser_sorts_and_filters() {
        let root = std::env::temp_dir().join("mars-studio-test-browse");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("zeta-dir")).unwrap();
        std::fs::create_dir_all(root.join("alpha-dir")).unwrap();
        std::fs::write(root.join("world.sdf"), "x").unwrap();
        std::fs::write(root.join("notes.txt"), "x").unwrap();

        let r = browse(Some(&root.display().to_string()), &["sdf".to_string()]).unwrap();
        let names: Vec<&str> = r.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha-dir", "zeta-dir", "world.sdf"]);
        assert!(r.parent.is_some());

        // Without a filter every file comes out, still behind the folders.
        let all = browse(Some(&root.display().to_string()), &[]).unwrap();
        assert_eq!(all.entries.len(), 4);

        let _ = std::fs::remove_dir_all(&root);
    }
}
