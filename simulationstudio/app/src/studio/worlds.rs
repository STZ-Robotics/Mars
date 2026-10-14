//! Saving, reading, duplicating, importing and deleting worlds.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use super::paths::{resolve, resolve_editable, valid_file_name};
use super::worldgen::{generate_sdf, WorldSpec};

/// Saves the `.sdf` and its `.studio.json`. Returns the world's relative path.
pub fn save_world(sim_dir: &Path, spec: &WorldSpec) -> Result<String> {
    valid_file_name(&spec.file)?;
    if !(spec.step > 0.0 && spec.step <= 0.1) {
        bail!("the physics step must be greater than 0 and at most 0.1 s");
    }
    let rel = format!("worlds/{}.sdf", spec.file);
    let sdf = resolve_editable(sim_dir, &rel)?;
    std::fs::create_dir_all(sdf.parent().unwrap())?;
    std::fs::write(&sdf, generate_sdf(spec))
        .with_context(|| format!("could not write {}", sdf.display()))?;
    std::fs::write(
        sdf.with_extension("studio.json"),
        serde_json::to_string_pretty(spec)?,
    )?;
    Ok(rel)
}

/// Returns the spec of a managed world, or `None` if it is external.
pub fn read_spec(sim_dir: &Path, rel: &str) -> Result<Option<WorldSpec>> {
    let sdf = resolve(sim_dir, rel)?;
    let json = sdf.with_extension("studio.json");
    if !json.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&json)?;
    Ok(Some(
        serde_json::from_str(&text).with_context(|| format!("{} is corrupt", json.display()))?,
    ))
}

pub fn delete_world(sim_dir: &Path, rel: &str) -> Result<()> {
    let sdf = resolve_editable(sim_dir, rel)?;
    if !sdf.is_file() {
        bail!("{rel} does not exist");
    }
    std::fs::remove_file(&sdf)?;
    let _ = std::fs::remove_file(sdf.with_extension("studio.json"));
    Ok(())
}

pub fn duplicate_world(sim_dir: &Path, rel: &str, name: &str) -> Result<String> {
    valid_file_name(name)?;
    let origin = resolve(sim_dir, rel)?;
    let dest_rel = format!("worlds/{name}.sdf");
    let dest = resolve_editable(sim_dir, &dest_rel)?;
    if dest.exists() {
        bail!("{dest_rel} already exists");
    }
    std::fs::copy(&origin, &dest)?;

    // The spec travels with the world if there is one, with the file name
    // corrected: otherwise the copy would open as an external world and the
    // tree would be read-only for no reason.
    if let Some(mut spec) = read_spec(sim_dir, rel)? {
        spec.file = name.to_string();
        std::fs::write(
            dest.with_extension("studio.json"),
            serde_json::to_string_pretty(&spec)?,
        )?;
    }
    Ok(dest_rel)
}

/// Copies an `.sdf` from anywhere on disk into `worlds/`.
///
/// If there is a `meshes/`, `materials/` or `models/` folder next to the
/// source, it travels too: a world whose meshes arrive without their files
/// opens grey and the only trace is in stderr.
pub fn import_world(sim_dir: &Path, origin: &str, name: Option<&str>) -> Result<String> {
    let origin = PathBuf::from(origin);
    if !origin.is_file() {
        bail!("{} is not a file", origin.display());
    }
    let ext = origin
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext != "sdf" && ext != "world" {
        bail!("only .sdf and .world files can be imported");
    }

    let base = match name {
        Some(n) => {
            valid_file_name(n)?;
            n.to_string()
        }
        None => origin
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "imported".into())
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect(),
    };

    let rel = format!("worlds/{base}.sdf");
    let dest = resolve_editable(sim_dir, &rel)?;
    if dest.exists() {
        bail!("{rel} already exists — pick another name");
    }
    std::fs::copy(&origin, &dest)?;

    if let Some(dir) = origin.parent() {
        for extra in ["meshes", "materials", "models"] {
            let from = dir.join(extra);
            if from.is_dir() {
                copy_tree(&from, &sim_dir.join("worlds").join(extra)).ok();
            }
        }
    }
    Ok(rel)
}

/// Copies a directory tree, never overwriting a file that already exists.
pub(super) fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let dest = to.join(e.file_name());
        if e.path().is_dir() {
            copy_tree(&e.path(), &dest)?;
        } else if !dest.exists() {
            std::fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Importing copies the `.sdf` under the requested name, and refuses to
    /// overwrite one that already exists --- losing a world to a re-import
    /// would be silent.
    #[test]
    fn import_copies_and_does_not_overwrite() {
        let root = std::env::temp_dir().join("mars-studio-test-import");
        let _ = std::fs::remove_dir_all(&root);
        let sim = root.join("sim");
        std::fs::create_dir_all(sim.join("worlds")).unwrap();
        let origin = root.join("foreign.sdf");
        std::fs::write(&origin, "<sdf/>").unwrap();

        let rel = import_world(&sim, &origin.display().to_string(), Some("brought")).unwrap();
        assert_eq!(rel, "worlds/brought.sdf");
        assert!(sim.join(&rel).is_file());
        assert!(import_world(&sim, &origin.display().to_string(), Some("brought")).is_err());

        // And only .sdf/.world: anything else is an error, not a copy.
        let other = root.join("thing.txt");
        std::fs::write(&other, "x").unwrap();
        assert!(import_world(&sim, &other.display().to_string(), Some("thing")).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
