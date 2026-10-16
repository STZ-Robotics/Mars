//! On-disk store of the Field 3D's 3D assets (fields and robots).
//!
//! The format is the SAME one AdvantageScope uses: one folder per asset with a
//! `config.json` and one or more `model*.glb`. Following it to the letter makes it
//! possible to install the official packages exactly as they come out of the
//! .zip, without converting or renaming anything, and lets a team that already
//! builds its assets for AdvantageScope reuse them here with no extra work.
//!
//! Packages are COPIED into the store instead of being kept as loose paths: a
//! field is ~20 MB spread over several files, and keeping the path of the
//! Downloads folder leaves the layout broken as soon as the user tidies it up.
//!
//! The DOWNLOAD and the decompression also live here and not in the frontend. It
//! is not a preference: GitHub sends no CORS headers on its release downloads
//! (neither on the 302 nor on the final response), so a `fetch` from the webview
//! always fails with "Failed to fetch". From Rust there is no origin to speak of,
//! and the bytes do not cross the IPC either.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Per-file ceiling inside a package. A well-made field model weighs about
/// 20 MB; much more than this is almost certainly the wrong file.
const MAX_ASSET_FILE_BYTES: u64 = 128 * 1024 * 1024;

/// Extensions copied on install. Everything else in the .zip is ignored on
/// purpose: a third-party package has no business leaving executables or scripts
/// in an app folder.
const ALLOWED_EXTENSIONS: [&str; 6] = ["json", "glb", "gltf", "bin", "png", "jpg"];

#[derive(Serialize)]
pub struct AssetPack {
    /// Folder name; it is the key the layout references the asset by.
    pub folder: String,
    pub path: String,
    /// Raw text of config.json. The frontend parses it: it defines the shape.
    pub config: String,
    /// Names of the .glb files it carries, sorted (model.glb, model_0.glb, ...).
    pub models: Vec<String>,
    pub bytes: u64,
}

fn store_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    base.join("MARS").join("assets3d")
}

/// A name that comes from a third-party .zip is never used as is: without
/// this, an entry called `../../config.json` would write outside the store.
fn safe_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Empty file name".to_string());
    }
    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(part)), None) => Ok(part.to_string_lossy().to_string()),
        _ => Err(format!("Unsafe name: {}", name)),
    }
}

fn has_allowed_extension(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| ALLOWED_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Sorts `model.glb` first and then `model_0`, `model_1`, ... by number.
/// Alphabetical order would put `model_10` before `model_2`, and each model's
/// index is what pairs the game pieces with the config.
fn model_rank(name: &str) -> (u8, u32) {
    let stem = name.trim_end_matches(".glb").trim_end_matches(".gltf");
    match stem.strip_prefix("model_") {
        Some(rest) => (1, rest.parse::<u32>().unwrap_or(u32::MAX)),
        None => (0, 0),
    }
}

fn read_pack(entry: &Path) -> Option<AssetPack> {
    let config = fs::read_to_string(entry.join("config.json")).ok()?;

    let mut models: Vec<String> = Vec::new();
    let mut bytes: u64 = 0;
    for file in fs::read_dir(entry).ok()? {
        let file = match file {
            Ok(f) => f,
            Err(_) => continue,
        };
        let name = file.file_name().to_string_lossy().to_string();
        if let Ok(meta) = file.metadata() {
            if meta.is_file() {
                bytes += meta.len();
            }
        }
        if name.ends_with(".glb") || name.ends_with(".gltf") {
            models.push(name);
        }
    }
    models.sort_by_key(|name| model_rank(name));

    Some(AssetPack {
        folder: entry.file_name()?.to_string_lossy().to_string(),
        path: entry.to_string_lossy().to_string(),
        config,
        models,
        bytes,
    })
}

#[tauri::command]
pub fn asset3d_store_dir() -> Result<String, String> {
    let dir = store_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    }
    Ok(dir.to_string_lossy().to_string())
}

/// Store folders that have a readable `config.json`. The ones that do not are
/// skipped silently: a half-finished install (or a folder the user left there)
/// must not keep the rest from being listed.
#[tauri::command]
pub fn list_asset3d_packs() -> Result<Vec<AssetPack>, String> {
    let dir = store_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut packs: Vec<AssetPack> = fs::read_dir(&dir)
        .map_err(|e| format!("Could not read {}: {}", dir.display(), e))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| read_pack(&entry.path()))
        .collect();

    packs.sort_by(|a, b| a.folder.to_lowercase().cmp(&b.folder.to_lowercase()));
    Ok(packs)
}

/// Unzips an asset .zip into the store.
///
/// The official .zip files carry the files at the root, but one made by hand on
/// Windows usually puts them inside a folder named after the package. Both are
/// accepted: wherever the `config.json` is wins, and everything next to it is
/// the package.
fn extract_zip(bytes: Vec<u8>, fallback_name: &str) -> Result<String, String> {
    extract_zip_into(bytes, fallback_name, &store_dir())
}

/// The destination is passed separately so the extraction can be tested
/// against a temporary folder instead of the user's real store.
fn extract_zip_into(bytes: Vec<u8>, fallback_name: &str, root: &Path) -> Result<String, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("That file is not a readable .zip ({}).", e))?;

    // First the config.json is found, to know which is the package's root.
    let mut prefix: Option<String> = None;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with("config.json") {
            prefix = Some(name[..name.len() - "config.json".len()].to_string());
            break;
        }
    }
    let prefix = prefix.ok_or_else(|| {
        "That archive has no config.json, so it is not an AdvantageScope asset.".to_string()
    })?;

    let folder = if prefix.is_empty() {
        sanitize_folder(fallback_name)
    } else {
        sanitize_folder(prefix.trim_end_matches('/').rsplit('/').next().unwrap_or(fallback_name))
    };

    let target_dir = root.join(&folder);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Could not create {}: {}", target_dir.display(), e))?;

    let mut written = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");

        // Only the config.json's level: packages are flat, and descending
        // recursively would only open the door to writing whole trees from a .zip of
        // unknown origin.
        if !name.starts_with(&prefix) {
            continue;
        }
        let leaf = &name[prefix.len()..];
        if leaf.is_empty() || leaf.contains('/') || !has_allowed_extension(leaf) {
            continue;
        }
        if entry.size() > MAX_ASSET_FILE_BYTES {
            continue;
        }
        let leaf = safe_name(leaf)?;

        let mut buffer = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Could not read {} from the archive: {}", leaf, e))?;

        let target = target_dir.join(&leaf);
        fs::write(&target, buffer)
            .map_err(|e| format!("Could not write {}: {}", target.display(), e))?;
        written += 1;
    }

    if written == 0 {
        return Err("The archive had no usable files.".to_string());
    }
    Ok(folder)
}

/// The name ends up being a folder on disk, so it cannot carry separators or
/// characters Windows rejects.
fn sanitize_folder(name: &str) -> String {
    let cleaned: String = name
        .trim_end_matches(".zip")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();

    // A name made only of dots CANNOT be let through: "." is the store's own
    // folder and ".." is the one above, so a malicious .zip named like that would
    // write outside the store even though every loose file does go through
    // `safe_name`.
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') {
        "Asset".to_string()
    } else {
        cleaned
    }
}

/// Installs a .zip the user already has on disk.
#[tauri::command]
pub fn install_asset3d_zip(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Could not open {}: {}", path, e))?;
    if meta.len() > MAX_ASSET_FILE_BYTES {
        return Err(format!(
            "That archive is too large ({:.1} MB).",
            meta.len() as f64 / 1_048_576.0
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {}: {}", path, e))?;
    let fallback = Path::new(&path)
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Asset".to_string());
    extract_zip(bytes, &fallback)
}

/// Downloads a package and installs it.
///
/// Only https URLs are accepted: the destination comes from a fixed catalog in
/// the frontend, but checking it here is what keeps a hand-edited layout from
/// turning this command into a downloader of anything over http.
#[tauri::command]
pub async fn download_asset3d(url: String, fallback_name: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("Only https downloads are allowed.".to_string());
    }

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Download failed: {}. Check the internet connection.", e))?;
    if !response.status().is_success() {
        return Err(format!("Download failed (HTTP {}).", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("The download was interrupted: {}", e))?;
    if bytes.len() as u64 > MAX_ASSET_FILE_BYTES {
        return Err("The downloaded archive is larger than the limit.".to_string());
    }

    // Decompression blocks, so it is moved off the async thread: it is ~20 MB
    // and it would leave the window frozen while unzipping.
    tauri::async_runtime::spawn_blocking(move || extract_zip(bytes.to_vec(), &fallback_name))
        .await
        .map_err(|e| format!("Install failed: {}", e))?
}

/// Copies an already extracted asset folder (the one left after unzipping, or
/// AdvantageScope's `userAssets` one) into the store. It is the fast path: the
/// bytes do not go through the IPC.
#[tauri::command]
pub fn import_asset3d_folder(source: String) -> Result<String, String> {
    let source = PathBuf::from(&source);
    if !source.join("config.json").exists() {
        return Err("That folder has no config.json - pick the folder that contains it.".to_string());
    }

    let folder = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "Could not read the folder name.".to_string())?;
    let folder = safe_name(&folder)?;

    let target_dir = store_dir().join(&folder);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Could not create {}: {}", target_dir.display(), e))?;

    let mut copied = 0usize;
    for entry in fs::read_dir(&source)
        .map_err(|e| format!("Could not read {}: {}", source.display(), e))?
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // Only the first level: packages are flat and descending recursively
        // would only open the door to copying whole trees by accident.
        if !meta.is_file() || meta.len() > MAX_ASSET_FILE_BYTES {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !has_allowed_extension(&name) {
            continue;
        }
        fs::copy(entry.path(), target_dir.join(&name))
            .map_err(|e| format!("Could not copy {}: {}", name, e))?;
        copied += 1;
    }

    if copied == 0 {
        return Err("No usable files were found in that folder.".to_string());
    }
    Ok(folder)
}

#[tauri::command]
pub fn delete_asset3d_pack(folder: String) -> Result<(), String> {
    let folder = safe_name(&folder)?;
    let target = store_dir().join(&folder);
    if !target.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&target).map_err(|e| format!("Could not remove {}: {}", target.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Builds a .zip in memory with the given entries.
    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            for (name, data) in entries {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mars-assets3d-test-{}", tag));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn installs_a_flat_zip() {
        // The official .zip files carry the files at the root.
        let root = temp_root("plano");
        let data = zip_with(&[
            ("config.json", br#"{"name":"X"}"#),
            ("model.glb", b"glb"),
        ]);

        let folder = extract_zip_into(data, "Field3d_Prueba", &root).unwrap();
        assert_eq!(folder, "Field3d_Prueba");
        assert!(root.join(&folder).join("config.json").exists());
        assert!(root.join(&folder).join("model.glb").exists());
    }

    #[test]
    fn installs_a_zip_with_a_folder_inside() {
        // The one made by hand on Windows puts everything under a folder; the
        // package's name comes from there and not from the file's name.
        let root = temp_root("folder");
        let data = zip_with(&[
            ("Robot_Mio/config.json", br#"{"name":"X"}"#),
            ("Robot_Mio/model.glb", b"glb"),
        ]);

        let folder = extract_zip_into(data, "download", &root).unwrap();
        assert_eq!(folder, "Robot_Mio");
        assert!(root.join("Robot_Mio").join("model.glb").exists());
    }

    #[test]
    fn rejects_a_zip_without_config() {
        let root = temp_root("sin-config");
        let data = zip_with(&[("model.glb", b"glb")]);
        let error = extract_zip_into(data, "X", &root).unwrap_err();
        assert!(error.contains("config.json"), "{}", error);
    }

    #[test]
    fn ignores_what_is_not_an_asset() {
        // A third-party package has no business leaving executables or
        // subfolders in an app folder.
        let root = temp_root("filtro");
        let data = zip_with(&[
            ("config.json", br#"{"name":"X"}"#),
            ("model.glb", b"glb"),
            ("malo.exe", b"MZ"),
            ("sub/otro.glb", b"glb"),
        ]);

        let folder = extract_zip_into(data, "X", &root).unwrap();
        let dir = root.join(&folder);
        assert!(dir.join("model.glb").exists());
        assert!(!dir.join("malo.exe").exists());
        assert!(!dir.join("sub").exists());
    }

    #[test]
    fn the_folder_name_cannot_escape_the_store() {
        // Separators are replaced, so what remains is a single path component
        // and it cannot get out of the store.
        assert_eq!(sanitize_folder("../../etc"), ".._.._etc");
        assert_eq!(sanitize_folder(".."), "Asset");
        assert_eq!(sanitize_folder("."), "Asset");
        assert_eq!(sanitize_folder("Field3d_2026FRCFieldV1.zip"), "Field3d_2026FRCFieldV1");
        assert_eq!(sanitize_folder(""), "Asset");
        assert!(safe_name("../config.json").is_err());
        assert!(safe_name("a/b.glb").is_err());
        assert_eq!(safe_name("model.glb").unwrap(), "model.glb");
    }

    #[test]
    fn models_sort_by_number_and_not_alphabetically() {
        // Each model's index is what pairs the game pieces with the config;
        // in alphabetical order, model_10 would sneak in before model_2.
        let mut names = vec![
            "model_10.glb".to_string(),
            "model_2.glb".to_string(),
            "model.glb".to_string(),
            "model_1.glb".to_string(),
        ];
        names.sort_by_key(|n| model_rank(n));
        assert_eq!(names, vec!["model.glb", "model_1.glb", "model_2.glb", "model_10.glb"]);
    }

    /// Really downloads the KitBot (~2 MB) from the official catalog.
    ///
    /// It is marked `ignore` because it needs internet and cannot run in a pit
    /// without a network; run it by hand with `cargo test -- --ignored`. It exists
    /// because the download path CANNOT be tested from the frontend: GitHub sends
    /// no CORS headers and a `fetch` from the webview always fails.
    #[test]
    #[ignore]
    fn downloads_a_real_package() {
        let url = concat!(
            "https://github.com/Mechanical-Advantage/AdvantageScopeAssets",
            "/releases/download/default-assets-v2/Robot_2026FRCKitBotV2.zip",
        );

        let bytes = tauri::async_runtime::block_on(async {
            let response = reqwest::get(url).await.expect("the download failed");
            assert!(response.status().is_success(), "HTTP {}", response.status());
            response.bytes().await.expect("could not read the body")
        });

        assert!(bytes.len() > 100_000, "the .zip arrived empty: {} bytes", bytes.len());

        let root = temp_root("download");
        let folder = extract_zip_into(bytes.to_vec(), "Robot_2026FRCKitBotV2", &root).unwrap();
        let dir = root.join(&folder);
        assert!(dir.join("config.json").exists());
        assert!(dir.join("model.glb").exists());
    }

    #[test]
    fn only_downloads_over_https() {
        let error = tauri::async_runtime::block_on(download_asset3d(
            "http://example.invalid/asset.zip".to_string(),
            "X".to_string(),
        ))
        .unwrap_err();
        assert!(error.contains("https"), "{}", error);
    }
}
