//! Java constants from the project's variables (Choreo's ChoreoVars): the
//! app writes the class (it evaluates the formulas), this puts it in the
//! robot project, where the project's settings say.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// project.json next to the robot: settings the team shares (in the repo).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    #[serde(default)]
    pub vars_java: VarsJava,
    /// The field the project plays on; absent, Rebuilt (2026).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<FieldChoice>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChoice {
    pub key: String,
    pub length_m: f64,
    pub width_m: f64,
    /// "rotational" or "mirrored": how the field is laid out for red.
    pub symmetry: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VarsJava {
    #[serde(default)]
    pub enabled: bool,
    /// Relative to the robot project, e.g. src/main/java/frc/robot/generated/AresVars.java.
    #[serde(default)]
    pub file: String,
}

fn settings_file(robot_path: &str) -> PathBuf {
    Path::new(robot_path).parent().unwrap_or(Path::new(".")).join("project.json")
}

#[tauri::command]
pub fn project_settings_open(robot_path: String) -> ProjectSettings {
    std::fs::read_to_string(settings_file(&robot_path)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

#[tauri::command]
pub fn project_settings_save(robot_path: String, settings: ProjectSettings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n";
    std::fs::write(settings_file(&robot_path), text).map_err(|e| e.to_string())
}

/// The robot project: above the Ares project, or the folder picked by hand.
fn robot_root(robot_path: &str, folder: Option<String>) -> Option<PathBuf> {
    match folder {
        Some(f) if !f.is_empty() => crate::robot_code::find_root(Path::new(&f)),
        _ => crate::robot_code::find_root(Path::new(robot_path)),
    }
}

/// Where the class goes by default: a `generated` package next to the
/// robot's Main (the class that calls RobotBase.startRobot).
#[tauri::command]
pub fn vars_java_default(robot_path: String, folder: Option<String>) -> Option<String> {
    let root = robot_root(&robot_path, folder)?;
    let java = root.join("src/main/java");
    let mut package = None;
    let mut stack = vec![java.clone()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "java") {
                let Ok(text) = std::fs::read_to_string(&p) else { continue };
                if text.contains("RobotBase.startRobot") {
                    package = text.lines().find_map(|l| l.trim().strip_prefix("package ").map(|r| r.trim_end_matches(';').trim().to_string()));
                }
            }
        }
        if package.is_some() {
            break;
        }
    }
    let package = package.unwrap_or_else(|| "frc.robot".into());
    Some(format!("src/main/java/{}/generated/AresVars.java", package.replace('.', "/")))
}

/// The Java package a file under src/main/java is in.
pub fn package_of(file: &str) -> Option<String> {
    let rel = file.replace('\\', "/");
    let inner = rel.strip_prefix("src/main/java/")?;
    let dir = inner.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    Some(dir.replace('/', "."))
}

/// Writes the class at `file` (relative to the robot project, inside it, a
/// .java), only when it changed: an unchanged file does not make Gradle
/// build again. Returns the full path.
#[tauri::command]
pub fn vars_java_write(robot_path: String, folder: Option<String>, file: String, code: String) -> Result<String, String> {
    let root = robot_root(&robot_path, folder).ok_or("No robot project found (a folder with build.gradle): pick it in Settings")?;
    let rel = Path::new(&file);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) || rel.extension().is_none_or(|x| x != "java") {
        return Err(format!("\"{file}\" has to be a .java file inside the robot project"));
    }
    let path = root.join(rel);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(code.as_str()) {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, code).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_finds_the_package_and_writes_only_inside_the_robot_project() {
        let dir = std::env::temp_dir().join(format!("ares-codegen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/main/java/com/team/robot")).unwrap();
        std::fs::create_dir_all(dir.join("src/main/deploy/ares")).unwrap();
        std::fs::write(dir.join("build.gradle"), "").unwrap();
        std::fs::write(dir.join("src/main/java/com/team/robot/Main.java"), "package com.team.robot;\nclass Main { void m() { RobotBase.startRobot(Robot::new); } }").unwrap();
        let rp = dir.join("src/main/deploy/ares/bot.robot.json").to_string_lossy().into_owned();
        let file = vars_java_default(rp.clone(), None).unwrap();
        assert_eq!(file, "src/main/java/com/team/robot/generated/AresVars.java");
        assert_eq!(package_of(&file).as_deref(), Some("com.team.robot.generated"));
        let written = vars_java_write(rp.clone(), None, file.clone(), "class A {}".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&written).unwrap(), "class A {}");
        assert!(vars_java_write(rp.clone(), None, "../evil.java".into(), "x".into()).is_err());
        assert!(vars_java_write(rp.clone(), None, "src/main/java/A.txt".into(), "x".into()).is_err());
        let s = ProjectSettings { vars_java: VarsJava { enabled: true, file }, field: None };
        project_settings_save(rp.clone(), s.clone()).unwrap();
        assert_eq!(project_settings_open(rp), s);
    }
}
