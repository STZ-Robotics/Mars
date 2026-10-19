//! What the robot code registers, so the app can say when an auto asks for a
//! command or a condition nobody registered (on the robot that is an alert and
//! a step that does nothing, found at the field).
//!
//! The Ares project lives in the robot project's `src/main/deploy/ares/`, so
//! the robot code is found by walking up from it to a folder with a
//! `build.gradle` and a `src/main/java`. Another folder can be given instead
//! (a project kept elsewhere). The Java is read, not compiled: a name is
//! registered when it appears as the first, literal argument of AresLib's
//! `registerCommand` / `registerCondition`, and
//! `NamedCommands.registerCommand`, or AresLib's `event("...")` trigger.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RobotNames {
    /// The robot project, or None when there is none above the Ares project.
    pub root: Option<String>,
    pub commands: Vec<String>,
    pub conditions: Vec<String>,
    /// Event names the robot reacts to with `ares.event("…")` triggers.
    pub events: Vec<String>,
    pub files: usize,
}

/// The robot project above `start` (or `start` itself).
pub fn find_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    for _ in 0..8 {
        let d = dir?;
        if d.join("build.gradle").is_file() && d.join("src").join("main").join("java").is_dir() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// Every literal first argument of `call(` in `text`: `call ( "name"`.
fn literal_args(text: &str, call: &str, out: &mut Vec<String>) {
    let mut rest = text;
    while let Some(i) = rest.find(call) {
        let after = &rest[i + call.len()..];
        rest = after;
        let after = after.trim_start();
        let Some(after) = after.strip_prefix('(') else { continue };
        let after = after.trim_start();
        let Some(after) = after.strip_prefix('"') else { continue };
        if let Some(end) = after.find('"') {
            let name = &after[..end];
            if !name.is_empty() && !name.contains('\\') {
                out.push(name.to_string());
            }
        }
    }
}

/// The names registered in the Java under `root/src/main/java`.
pub fn scan(root: &Path) -> RobotNames {
    let mut names = RobotNames { root: Some(root.to_string_lossy().into_owned()), ..Default::default() };
    let mut stack = vec![root.join("src").join("main").join("java")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "java") {
                let Ok(text) = fs::read_to_string(&p) else { continue };
                names.files += 1;
                let text = strip_comments(&text);
                // registerCommand covers AresLib and NamedCommands.
                literal_args(&text, "registerCommand", &mut names.commands);
                literal_args(&text, "registerCondition", &mut names.conditions);
                literal_args(&text, ".event", &mut names.events);
            }
        }
    }
    for v in [&mut names.commands, &mut names.conditions, &mut names.events] {
        v.sort();
        v.dedup();
    }
    names
}

/// The text with `//` and `/* */` comments blanked out (strings kept), so a
/// commented-out registration does not count.
fn strip_comments(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut in_str) = (0, false);
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c as char);
            if c == b'\\' && i + 1 < b.len() {
                out.push(b[i + 1] as char);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
            i += 1;
        } else if c == b'"' {
            in_str = true;
            out.push('"');
            i += 1;
        } else if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else {
            out.push(c as char);
            i += 1;
        }
    }
    out
}

/// The names the robot code registers. `folder`: the robot project to read,
/// when it is not above the Ares project.
#[tauri::command]
pub fn robot_names(robot_path: String, folder: Option<String>) -> RobotNames {
    let root = match folder.filter(|f| !f.trim().is_empty()) {
        Some(f) => find_root(Path::new(&f)),
        None => Path::new(&robot_path).parent().and_then(find_root),
    };
    root.map(|r| scan(&r)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_registrations_and_not_the_commented_ones() {
        let dir = std::env::temp_dir().join(format!("ares-robot-code-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let java = dir.join("src/main/java/frc/robot");
        fs::create_dir_all(&java).unwrap();
        fs::create_dir_all(dir.join("src/main/deploy/ares")).unwrap();
        fs::write(dir.join("build.gradle"), "").unwrap();
        fs::write(
            java.join("RobotContainer.java"),
            r#"
            ares.registerCommand("shoot", superstructure.shoot());
            ares.registerCommand( "intake" , () -> intake.run());
            NamedCommands.registerCommand("score", score());
            ares.registerCondition("hasPiece", indexer::hasPiece);
            ares.event("spinUp").whileTrue(shooter.spin());
            // ares.registerCommand("old", none());
            /* ares.registerCondition("gone", () -> true); */
            String s = "registerCommand(\"inAString\"";
            ares.registerCommand(NAME, other());
            "#,
        )
        .unwrap();
        let names = robot_names(dir.join("src/main/deploy/ares/bot.robot.json").to_string_lossy().into_owned(), None);
        assert_eq!(names.root.as_deref(), Some(dir.to_string_lossy().as_ref()));
        assert_eq!(names.commands, vec!["intake", "score", "shoot"]);
        assert_eq!(names.conditions, vec!["hasPiece"]);
        assert_eq!(names.events, vec!["spinUp"]);
        // A project outside any robot code: nothing found, nothing claimed.
        assert_eq!(robot_names("/tmp/nowhere/bot.robot.json".into(), None).root, None);
        // Or pointed at it by hand.
        assert_eq!(robot_names("/tmp/nowhere/bot.robot.json".into(), Some(dir.to_string_lossy().into_owned())).commands.len(), 3);
    }
}

/// The drive's numbers as the robot code has them: Tuner X's constants and
/// the path controller's PID, read from the Java (best effort: what is not
/// found stays None).
#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RobotTuning {
    pub file: Option<String>,
    pub drive_kp: Option<f64>,
    pub drive_ks: Option<f64>,
    pub drive_kv: Option<f64>,
    pub speed_at_12v_mps: Option<f64>,
    pub slip_current_a: Option<f64>,
    pub drive_friction_v: Option<f64>,
    pub steer_kp: Option<f64>,
    pub steer_ks: Option<f64>,
    pub steer_kv: Option<f64>,
    /// kWheelRadius, in meters (Tuner X writes it in inches).
    pub wheel_radius_m: Option<f64>,
    /// [kP, kI, kD] of the translation and rotation PIDs the auto actually runs.
    pub translation: Option<[f64; 3]>,
    pub rotation: Option<[f64; 3]>,
}

/// The first number after `call` (e.g. `withKP(`) in `text`.
fn number_after(text: &str, call: &str) -> Option<f64> {
    let i = text.find(call)? + call.len();
    let rest = &text[i..];
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e' || c == 'E' || c == '+'))?;
    rest[..end].parse().ok()
}

/// The statement starting at `name` (up to its `;`).
fn statement<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let i = text.find(name)?;
    let rest = &text[i..];
    Some(&rest[..rest.find(';').unwrap_or(rest.len())])
}

fn pid_args(text: &str) -> Option<[f64; 3]> {
    let i = text.find("new PIDConstants(")? + "new PIDConstants(".len();
    let inner = &text[i..i + text[i..].find(')')?];
    let v: Vec<f64> = inner.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    match v.len() {
        1 => Some([v[0], 0.0, 0.0]),
        n if n >= 3 => Some([v[0], v[1], v[2]]),
        _ => None,
    }
}

pub fn read_tuning(root: &Path) -> RobotTuning {
    let mut out = RobotTuning::default();
    let mut stack = vec![root.join("src").join("main").join("java")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().is_none_or(|x| x != "java") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&p) else { continue };
            let text = strip_comments(&raw);
            if let Some(gains) = statement(&text, "driveGains =") {
                out.file = Some(p.to_string_lossy().into_owned());
                out.drive_kp = number_after(gains, "withKP(");
                out.drive_ks = number_after(gains, "withKS(");
                out.drive_kv = number_after(gains, "withKV(");
            }
            if let Some(gains) = statement(&text, "steerGains =") {
                out.steer_kp = number_after(gains, "withKP(");
                out.steer_ks = number_after(gains, "withKS(");
                out.steer_kv = number_after(gains, "withKV(");
            }
            if let Some(s) = statement(&text, "kWheelRadius =") {
                let v = number_after(s, ".of(");
                out.wheel_radius_m = if s.contains("Inches") { v.map(|x| x * 0.0254) } else if s.contains("Centimeters") { v.map(|x| x / 100.0) } else { v };
            }
            if let Some(s) = statement(&text, "kSpeedAt12Volts =") {
                out.speed_at_12v_mps = number_after(s, ".of(");
            }
            if let Some(s) = statement(&text, "kSlipCurrent =") {
                out.slip_current_a = number_after(s, ".of(");
            }
            if let Some(s) = statement(&text, "kDriveFrictionVoltage =") {
                out.drive_friction_v = number_after(s, ".of(");
            }
            // What the auto runs: the PIDs handed to the holonomic controller.
            if let Some(i) = text.find("PPHolonomicDriveController(") {
                let rest = &text[i..];
                out.translation = pid_args(rest);
                if let Some(j) = rest.find("new PIDConstants(") {
                    out.rotation = pid_args(&rest[j + 1..]);
                }
            }
        }
    }
    out
}

#[tauri::command]
pub fn robot_tuning(robot_path: String, folder: Option<String>) -> RobotTuning {
    let root = match folder.filter(|f| !f.trim().is_empty()) {
        Some(f) => find_root(Path::new(&f)),
        None => Path::new(&robot_path).parent().and_then(find_root),
    };
    root.map(|r| read_tuning(&r)).unwrap_or_default()
}

#[cfg(test)]
mod tuning_tests {
    use super::*;

    #[test]
    fn reads_tuner_x_constants_and_the_path_pids() {
        let dir = std::env::temp_dir().join(format!("ares-robot-tuning-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let java = dir.join("src/main/java/frc/robot");
        fs::create_dir_all(&java).unwrap();
        fs::write(dir.join("build.gradle"), "").unwrap();
        fs::write(java.join("TunerConstants.java"), r#"
            private static final Slot0Configs driveGains =
                new Slot0Configs().withKP(0.1).withKI(0).withKD(0).withKS(0.12).withKV(0.124);
            public static final LinearVelocity kSpeedAt12Volts = MetersPerSecond.of(5.85);
            private static final Current kSlipCurrent = Amps.of(120);
            private static final Voltage kDriveFrictionVoltage = Volts.of(0.2);
            private static final Slot0Configs steerGains = new Slot0Configs().withKP(55).withKI(0).withKD(0.35).withKS(0.29).withKV(2.483);
            private static final Distance kWheelRadius = Inches.of(2);
        "#).unwrap();
        fs::write(java.join("Drive.java"), r#"
            new PPHolonomicDriveController(
                new PIDConstants(5.0, 0.0, 0.0), // translation
                new PIDConstants(4.0, 0.0, 0.1)  // rotation
            ),
        "#).unwrap();
        let t = read_tuning(&dir);
        assert_eq!((t.drive_kp, t.drive_ks, t.drive_kv), (Some(0.1), Some(0.12), Some(0.124)));
        assert_eq!(t.speed_at_12v_mps, Some(5.85));
        assert_eq!(t.slip_current_a, Some(120.0));
        assert_eq!(t.drive_friction_v, Some(0.2));
        assert_eq!((t.steer_kp, t.steer_ks, t.steer_kv), (Some(55.0), Some(0.29), Some(2.483)));
        assert!((t.wheel_radius_m.unwrap() - 0.0508).abs() < 1e-12);
        assert_eq!(t.translation, Some([5.0, 0.0, 0.0]));
        assert_eq!(t.rotation, Some([4.0, 0.0, 0.1]));
    }
}
