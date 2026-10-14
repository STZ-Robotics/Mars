//! Paths that come from the UI, resolved against `sim/`.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

/// Resolves a relative path against `sim/` and refuses to leave it.
///
/// The UI sends paths as text. Without this check, a `../../..` in a text
/// field turns "save world" into "write anywhere".
pub fn resolve(sim_dir: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.replace('\\', "/");
    if rel.is_empty() {
        bail!("empty path");
    }
    let p = Path::new(&rel);
    if p.is_absolute() {
        bail!("{rel}: expected a path relative to sim/");
    }
    for c in p.components() {
        use std::path::Component::*;
        match c {
            Normal(_) | CurDir => {}
            ParentDir => bail!("{rel}: going above sim/ is not allowed"),
            _ => bail!("{rel}: path not allowed"),
        }
    }
    Ok(sim_dir.join(p))
}

/// Same as `resolve`, but it also has to land in one of the editable
/// directories. Reading anything in `sim/` is harmless; writing into `build/`
/// or `bridge/src/` is not.
pub fn resolve_editable(sim_dir: &Path, rel: &str) -> Result<PathBuf> {
    let normal = rel.replace('\\', "/");
    let ok = ["worlds/", "models/", "gui/", "protocol/"]
        .iter()
        .any(|d| normal.starts_with(d));
    if !ok {
        bail!("{rel}: only worlds/, models/, gui/ and protocol/ can be written to");
    }
    resolve(sim_dir, &normal)
}

pub fn valid_file_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("the name cannot be empty");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("'{name}': use only letters, digits, dash and underscore");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A path from the UI cannot write outside sim/.
    #[test]
    fn cannot_escape_sim() {
        let sim = Path::new("/tmp/sim");
        assert!(resolve(sim, "../../etc/passwd").is_err());
        assert!(resolve(sim, "/etc/passwd").is_err());
        assert!(resolve(sim, "worlds/ok.sdf").is_ok());
    }

    /// And only into the authoring directories: `build/` is written by the
    /// simulation processes, not by the editor.
    #[test]
    fn writes_only_into_authoring_directories() {
        let sim = Path::new("/tmp/sim");
        assert!(resolve_editable(sim, "worlds/a.sdf").is_ok());
        assert!(resolve_editable(sim, "models/x/robot-map.json").is_ok());
        assert!(resolve_editable(sim, "build/mars-sim-server.exe").is_err());
        assert!(resolve_editable(sim, "bridge/src/lib.rs").is_err());
    }
}
