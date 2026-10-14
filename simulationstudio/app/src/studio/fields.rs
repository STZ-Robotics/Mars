//! The 3D FRC fields a world can carry as its visual.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use super::paths::valid_file_name;
use super::worlds::copy_tree;

/// A 3D field available to put in a world.
///
/// The format is AdvantageScope's as is --- a folder with `config.json` and
/// `model.glb` --- because it is the same one mars-desktop's 3D Field already
/// consumes. Reusing it means a field downloaded there works here without
/// converting anything.
#[derive(Debug, Serialize)]
pub struct FieldInfo {
    pub name: String,
    /// Path of the `.glb` relative to `sim/`. Empty if it is not in the
    /// project yet (see `installed`).
    pub path: String,
    /// Absolute path of the source folder, to install it from.
    pub origin: String,
    /// `project` if it lives in `sim/fields/`, `mars-desktop` if it is in the
    /// dashboard's assets.
    pub source: String,
    pub installed: bool,
    /// Playing area in meters, from `widthInches`/`heightInches`.
    pub length_m: f64,
    pub width_m: f64,
    pub bytes: u64,
    /// The `coordinateSystem` the config declares. Informational.
    pub coordinate_system: String,
}

/// Where mars-desktop installs the 3D fields (`desktop/src-tauri/src/assets3d.rs`).
fn dashboard_assets_dir() -> Option<PathBuf> {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .ok()
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".local/share"))
        })?;
    let d = base.join("MARS/assets3d");
    d.is_dir().then_some(d)
}

fn read_field(dir: &Path, source: &str, sim_dir: &Path) -> Option<FieldInfo> {
    let glb = dir.join("model.glb");
    if !glb.is_file() {
        return None;
    }
    let dir_name = dir.file_name()?.to_string_lossy().to_string();

    // config.json is optional: without it the field can still be used, it is
    // just unknown what playing area it covers.
    let cfg: serde_json::Value = std::fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    let inches = |k: &str| cfg.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) * 0.0254;

    let in_project = dir.starts_with(sim_dir);
    Some(FieldInfo {
        name: cfg
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&dir_name)
            .to_string(),
        path: if in_project {
            format!("fields/{dir_name}/model.glb")
        } else {
            String::new()
        },
        origin: dir.display().to_string(),
        source: source.to_string(),
        installed: in_project,
        length_m: inches("widthInches"),
        width_m: inches("heightInches"),
        bytes: glb.metadata().map(|m| m.len()).unwrap_or(0),
        coordinate_system: cfg
            .get("coordinateSystem")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

/// The project's fields first, then the ones mars-desktop has installed.
pub fn list_fields(sim_dir: &Path) -> Vec<FieldInfo> {
    let mut v = Vec::new();
    let mut seen = Vec::new();

    for e in std::fs::read_dir(sim_dir.join("fields"))
        .into_iter()
        .flatten()
        .flatten()
    {
        if let Some(c) = read_field(&e.path(), "project", sim_dir) {
            // Compared by the config's name, not the folder's: installing
            // renames it ("Field3d_2026FRCFieldV1" -> "2026-rebuilt") and
            // comparing folders listed the same field twice.
            seen.push(c.name.clone());
            v.push(c);
        }
    }

    if let Some(assets) = dashboard_assets_dir() {
        for e in std::fs::read_dir(assets).into_iter().flatten().flatten() {
            if let Some(c) = read_field(&e.path(), "mars-desktop", sim_dir) {
                if !seen.contains(&c.name) {
                    v.push(c);
                }
            }
        }
    }

    v.sort_by(|a, b| b.installed.cmp(&a.installed).then(a.name.cmp(&b.name)));
    v
}

/// Copies a field into `sim/fields/<name>/` and leaves it renderable.
///
/// It is copied instead of referenced where it is on purpose: a world that
/// points into `%APPDATA%` does not open on another machine, and worlds are
/// part of the repository.
pub fn install_field(sim_dir: &Path, origin: &str, name: &str) -> Result<String> {
    valid_file_name(name)?;
    let origin = PathBuf::from(origin);
    if !origin.join("model.glb").is_file() {
        bail!("{} has no model.glb", origin.display());
    }
    let dest = sim_dir.join("fields").join(name);
    if dest.exists() {
        bail!("fields/{name} already exists");
    }
    copy_tree(&origin, &dest)?;

    for glb in ["model.glb", "model_0.glb"] {
        let p = dest.join(glb);
        if p.is_file() {
            flatten_metals(&p).with_context(|| format!("could not prepare {}", p.display()))?;
        }
    }
    Ok(format!("fields/{name}/model.glb"))
}

/// Turns off the metalness of the materials in a `.glb`, in place.
///
/// # Why it is needed
///
/// The official field models declare `metallicFactor: 1.0` with a very low
/// roughness on almost every material. A material like that, under a PBR
/// renderer, has no color of its own: it reflects the environment. And OGRE2
/// in this configuration has no environment map, so what it reflects is
/// black. The field loads, the physics runs, and on screen there is a black
/// field-shaped blot. (AdvantageScope solves the same thing by forcing
/// `MeshPhongMaterial`, for the same reason.)
///
/// # Why the patch is at the byte level
///
/// Because reserializing the glTF's JSON --- reading it with serde and writing
/// it back --- produces a structurally valid file that **hangs the Gazebo
/// window indefinitely** (tested: more than eight minutes without opening,
/// against thirty seconds for the original). Why was not investigated; it does
/// not need to be, because the minimal patch is also the correct one:
/// replacing the number with another of the SAME length does not move a
/// single offset in the file.
fn flatten_metals(glb: &Path) -> Result<usize> {
    const HEADER: usize = 12;
    let mut d = std::fs::read(glb)?;
    if d.len() < HEADER + 8 || &d[0..4] != b"glTF" {
        bail!("{} is not a binary glTF", glb.display());
    }

    let json_len = u32::from_le_bytes(d[HEADER..HEADER + 4].try_into()?) as usize;
    if &d[HEADER + 4..HEADER + 8] != b"JSON" {
        bail!("{}: first chunk is not JSON", glb.display());
    }
    let start = HEADER + 8;
    let end = start + json_len;
    if end > d.len() {
        bail!("{}: truncated JSON chunk", glb.display());
    }

    let mut changes = 0;
    changes += replace_number(&mut d[start..end], b"\"metallicFactor\":", "0");
    changes += replace_number(&mut d[start..end], b"\"roughnessFactor\":", "0.7");

    if changes > 0 {
        std::fs::write(glb, &d)?;
    }
    Ok(changes)
}

/// Rewrites every `"<key>":<number>` with `value`, padding with zeros up to
/// the original length.
///
/// `0` -> `0.0000`, `0.7` -> `0.70000`: still valid JSON and exactly the same
/// size, which is the condition that makes the patch safe. If the gap does not
/// even fit `value`, it is left as it was.
fn replace_number(json: &mut [u8], key: &[u8], value: &str) -> usize {
    let mut changes = 0;
    let mut i = 0;
    while let Some(p) = find(&json[i..], key) {
        let start = i + p + key.len();
        let mut end = start;
        while end < json.len() && !matches!(json[end], b',' | b'}') {
            end += 1;
        }
        let gap = end - start;
        if gap >= value.len() {
            let mut new = value.as_bytes().to_vec();
            // The padding has to go AFTER a decimal point, or `0` + `00`
            // would give `000`, which is not a JSON number.
            if !value.contains('.') && gap > value.len() {
                new.push(b'.');
            }
            while new.len() < gap {
                new.push(b'0');
            }
            if json[start..end] != new[..] {
                json[start..end].copy_from_slice(&new);
                changes += 1;
            }
        }
        i = end;
    }
    changes
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The material patch cannot move a single byte of the file: if the
    /// length changes, every offset in the glTF ends up shifted.
    #[test]
    fn flatten_metals_keeps_the_length() {
        let mut json =
            br#"{"materials":[{"pbrMetallicRoughness":{"metallicFactor":1.0,"roughnessFactor":0.2121320366859436}}]}"#
                .to_vec();
        let before = json.len();
        let changes = replace_number(&mut json, b"\"metallicFactor\":", "0")
            + replace_number(&mut json, b"\"roughnessFactor\":", "0.7");

        assert_eq!(json.len(), before, "the patch cannot change the length");
        assert_eq!(changes, 2);
        let text = String::from_utf8(json).unwrap();
        assert!(text.contains("\"metallicFactor\":0.0"), "{text}");
        assert!(text.contains("\"roughnessFactor\":0.7000000000000000"), "{text}");

        // And it is still JSON: the padding goes after the decimal point.
        serde_json::from_str::<serde_json::Value>(&text).expect("the patch broke the JSON");
    }

    /// A gap shorter than the value is left intact instead of corrupted.
    #[test]
    fn flatten_metals_respects_short_gaps() {
        let mut json = br#"{"roughnessFactor":1}"#.to_vec();
        assert_eq!(replace_number(&mut json, b"\"roughnessFactor\":", "0.7"), 0);
        assert_eq!(&json[..], br#"{"roughnessFactor":1}"#);
    }
}
