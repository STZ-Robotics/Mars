//! The world and robot libraries: what is on disk, summarized for the UI.

use std::path::Path;

use serde::Serialize;

use super::worldgen::WorldSpec;

/// One row of the world library.
#[derive(Debug, Serialize)]
pub struct WorldInfo {
    /// Path relative to `sim/`. It is the one the supervisor consumes.
    pub path: String,
    pub file: String,
    /// The SDF's `<world name="...">`. It has to be `mars` (see `notes`).
    pub world: String,
    pub models: usize,
    pub includes: usize,
    pub plugins: usize,
    pub lights: usize,
    pub step: Option<f64>,
    pub rtf: Option<f64>,
    pub bytes: u64,
    /// `true` if it has its `.studio.json` next to it: editable from the tree.
    pub managed: bool,
    pub description: Option<String>,
    /// Problems that would keep it from running (they go straight to the UI).
    pub notes: Vec<String>,
}

/// One row of the robot library.
#[derive(Debug, Serialize)]
pub struct RobotInfo {
    pub path: String,
    pub folder: String,
    pub robot: String,
    pub profile: String,
    pub world: String,
    pub model: String,
    pub sdf: Option<String>,
    pub actuators: usize,
    pub encoders: usize,
    pub imu: bool,
    pub notes: Vec<String>,
}

/// What an SDF says about itself, as far as a regex can tell without
/// pretending to be a parser.
struct SdfSummary {
    world: String,
    models: usize,
    includes: usize,
    plugins: usize,
    lights: usize,
    step: Option<f64>,
    rtf: Option<f64>,
}

fn summarize_sdf(text: &str) -> SdfSummary {
    let count = |needle: &str| text.matches(needle).count();
    SdfSummary {
        world: between(text, "<world name=\"", "\"").unwrap_or_default(),
        models: count("<model "),
        includes: count("<include>"),
        plugins: count("<plugin "),
        lights: count("<light "),
        step: number_in(text, "max_step_size"),
        rtf: number_in(text, "real_time_factor"),
    }
}

pub(super) fn between(text: &str, from: &str, to: &str) -> Option<String> {
    let i = text.find(from)? + from.len();
    let rest = &text[i..];
    let j = rest.find(to)?;
    Some(rest[..j].to_string())
}

fn number_in(text: &str, tag: &str) -> Option<f64> {
    between(text, &format!("<{tag}>"), &format!("</{tag}>"))?
        .trim()
        .parse()
        .ok()
}

pub fn list_worlds(sim_dir: &Path) -> Vec<WorldInfo> {
    let mut v: Vec<WorldInfo> = std::fs::read_dir(sim_dir.join("worlds"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "sdf"))
        .map(|e| {
            let abs_path = e.path();
            let file = e.file_name().to_string_lossy().to_string();
            let text = std::fs::read_to_string(&abs_path).unwrap_or_default();
            let s = summarize_sdf(&text);

            let json = abs_path.with_extension("studio.json");
            let managed = json.is_file();
            let description = std::fs::read_to_string(&json)
                .ok()
                .and_then(|t| serde_json::from_str::<WorldSpec>(&t).ok())
                .map(|s| s.description);

            // These three are what keeps an imported world from starting, and
            // all three are invisible until the engine fails.
            let mut notes = Vec::new();
            if s.world.is_empty() {
                notes.push("No <world name=\"...\"> declared.".into());
            } else if s.world != "mars" {
                notes.push(format!(
                    "World is named \"{}\"; the MARS protocol requires \"mars\".",
                    s.world
                ));
            }
            if !text.contains("gz-sim-physics-system") {
                notes.push("No physics system plugin: nothing will move.".into());
            }
            if !text.contains("gz-sim-scene-broadcaster-system") {
                notes.push("No scene broadcaster: the bridge will see no state.".into());
            }

            WorldInfo {
                path: format!("worlds/{file}"),
                file,
                world: s.world,
                models: s.models,
                includes: s.includes,
                plugins: s.plugins,
                lights: s.lights,
                step: s.step,
                rtf: s.rtf,
                bytes: e.metadata().map(|m| m.len()).unwrap_or(0),
                managed,
                description,
                notes,
            }
        })
        .collect();
    v.sort_by(|a, b| a.file.cmp(&b.file));
    v
}

pub fn list_robots(sim_dir: &Path) -> Vec<RobotInfo> {
    let mut v = Vec::new();
    for entry in std::fs::read_dir(sim_dir.join("models"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let map = entry.path().join("robot-map.json");
        if !map.is_file() {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().to_string();
        let text = std::fs::read_to_string(&map).unwrap_or_default();
        let json: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);

        let string = |k: &str| {
            json.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let len = |k: &str| {
            json.get(k)
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0)
        };

        let sdf = json.get("sdf").and_then(|v| v.as_str()).map(String::from);
        let mut notes = Vec::new();
        match &sdf {
            Some(s) if !sim_dir.join(s).is_file() => {
                notes.push(format!("Declared SDF \"{s}\" does not exist."))
            }
            None => notes.push("No \"sdf\" field: check.py cannot verify actuator order.".into()),
            _ => {}
        }
        if len("actuators") == 0 {
            notes.push("No actuators declared.".into());
        }

        v.push(RobotInfo {
            path: format!("models/{folder}/robot-map.json"),
            folder,
            robot: string("robot"),
            profile: string("profile"),
            world: string("world"),
            model: string("model"),
            sdf,
            actuators: len("actuators"),
            encoders: len("encoders"),
            imu: json.get("imu").is_some_and(|v| !v.is_null()),
            notes,
        });
    }
    v.sort_by(|a, b| a.folder.cmp(&b.folder));
    v
}
