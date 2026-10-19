//! The 3D field for the Paths tab's 3D view: the one MARS Desktop installs (its Field 3D's Assets
//! tab keeps them in the config folder's `MARS/assets3d/`), found by the year of the project's
//! field. Read-only: Ares never installs or deletes one.

use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field3dPack {
    /// The pack's folder, where `model.glb` is.
    pub folder: String,
    /// Its `config.json`, AdvantageScope's format, as text.
    pub config: String,
}

/// Where MARS Desktop keeps the 3D assets: the same place its `dirs::config_dir()` gives.
fn store_dir() -> Option<PathBuf> {
    let config = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }?;
    Some(config.join("MARS").join("assets3d"))
}

/// The installed field pack for `year` ("2026"): a folder with a `model.glb` whose config's
/// name, or the folder's own, says that year. None when MARS Desktop has none for it.
#[tauri::command]
pub fn field3d_find(year: String) -> Option<Field3dPack> {
    let dir = store_dir()?;
    let mut entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    entries.sort();
    entries.into_iter().find_map(|folder| {
        let config = std::fs::read_to_string(folder.join("config.json")).ok()?;
        if !folder.join("model.glb").is_file() {
            return None;
        }
        let name = serde_json::from_str::<serde_json::Value>(&config).ok()?.get("name")?.as_str()?.to_string();
        let robot = config.contains("\"isRobot\"") || name.to_lowercase().contains("robot");
        let matches = name.contains(&year) || folder.file_name()?.to_string_lossy().contains(&year);
        (matches && !robot).then(|| Field3dPack { folder: folder.to_string_lossy().to_string(), config })
    })
}
