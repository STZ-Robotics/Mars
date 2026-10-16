// source_map.rs
// Resolves a NetworkTables topic to the Java line that publishes it.
//
// The trick is that in a MARS project the topic's name is not opaque: it comes
// from a handful of constructs with literals in the code.
//
//   NetworkIO.set("Arm", "kP", v)         -> /Arm/kP
//   @Signal(key="velocity") double get()  -> /<table>/velocity
//   @Tunable double kP = 0.5;             -> /<table>/kP
//   setEntry("kP", v)                     -> /<table>/kP
//
// where <table> is the string the class passed to IOSubsystem -- i.e. the
// SubsystemBuilder's `.key("Arm")`, or the `super("Arm")` if it extends
// IOSubsystem directly.
//
// It is a regex scan, not a Java parser: it resolves neither constants nor
// concatenations. That is why each result comes with a confidence and the
// frontend shows several candidates instead of jumping blindly.

use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;

#[derive(Serialize, Debug, Clone)]
pub struct SourceMatch {
    /// Path relative to the project's root, for display.
    pub file: String,
    /// Absolute path, to open the editor.
    pub path: String,
    pub line: usize,
    /// Which construct produced the match ("@Tunable", "NetworkIO.set"...).
    pub kind: String,
    pub snippet: String,
    /// 0-100. 100 = literal table and key, exact, in the same call.
    pub confidence: u8,
}

#[derive(Serialize, Debug, Clone)]
pub struct TopicSourceResult {
    pub topic: String,
    pub table: String,
    pub key: String,
    pub matches: Vec<SourceMatch>,
    /// Explanation when the framework publishes the topic and not the project.
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

fn collect_java_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_java_files(&path, out);
        } else if path.extension().map_or(false, |ext| ext == "java") {
            out.push(path);
        }
    }
}

/// Returns what follows an annotation on the line, skipping its parentheses,
/// plus the explicit key if it carries one.
///
/// `@Tunable(key = "gainP") double kP = 0.5;` -> (" double kP = 0.5;", Some("gainP"))
fn after_annotation(line: &str, annotation: &str) -> Option<(String, Option<String>)> {
    let at = line.find(annotation)?;
    let rest = &line[at + annotation.len()..];

    if !rest.trim_start().starts_with('(') {
        return Some((rest.to_string(), None));
    }

    let open = rest.find('(')?;
    let mut depth = 0usize;
    let mut close = None;
    for (i, ch) in rest[open..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + i);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    let args = &rest[open..=close];
    let key = Regex::new(r#"key\s*=\s*"([^"]+)""#)
        .ok()
        .and_then(|re| re.captures(args).map(|c| c[1].to_string()));

    Some((rest[close + 1..].to_string(), key))
}

/// Name of the member that follows the annotation: the method for `@Signal`,
/// the field for `@Tunable`. It can be on the same line or on the next ones.
fn member_name(lines: &[&str], index: usize, rest_of_line: &str, is_method: bool) -> Option<String> {
    let pattern = if is_method {
        Regex::new(r"(\w+)\s*\(").ok()?
    } else {
        Regex::new(r"(\w+)\s*(?:=|;)").ok()?
    };

    if let Some(caps) = pattern.captures(rest_of_line) {
        return Some(caps[1].to_string());
    }
    // The annotation was alone on its line: look at the next ones.
    for candidate in lines.iter().skip(index + 1).take(3) {
        if candidate.trim().is_empty() || candidate.trim_start().starts_with('@') {
            continue;
        }
        if let Some(caps) = pattern.captures(candidate) {
            return Some(caps[1].to_string());
        }
        break;
    }
    None
}

fn snippet_of(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() > 160 {
        trimmed.chars().take(157).collect::<String>() + "..."
    } else {
        trimmed.to_string()
    }
}

/// Topics MARS's jar publishes, not the project. Without this the user presses
/// "go to" on `/Arm/Status/Hex` and does not understand why there is nothing.
fn framework_note(table: &str, key: &str) -> Option<String> {
    if key.starts_with("Status/") {
        return Some(format!(
            "Published by ModularSubsystem (MARS core), not by your code. The jump below goes to the class that owns the \"{}\" table.",
            table
        ));
    }
    if table == "WatchDog" {
        return Some(
            "Published by MARSWatchdog (MARS core). It has no publishing line in your project."
                .to_string(),
        );
    }
    None
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

struct Patterns {
    builder_key: Regex,
    super_key: Regex,
    networkio_full: Regex,
    networkio_table: Regex,
    set_entry: Regex,
}

impl Patterns {
    fn new() -> Self {
        Patterns {
            builder_key: Regex::new(r#"\.key\s*\(\s*"([^"]+)"\s*\)"#).unwrap(),
            super_key: Regex::new(r#"super\s*\(\s*"([^"]+)"\s*\)"#).unwrap(),
            networkio_full: Regex::new(r#"NetworkIO\s*\.\s*set\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)""#).unwrap(),
            networkio_table: Regex::new(r#"NetworkIO\s*\.\s*set\s*\(\s*"([^"]+)"\s*,"#).unwrap(),
            set_entry: Regex::new(r#"setEntry\s*\(\s*"([^"]+)"#).unwrap(),
        }
    }
}

/// Splits `/Arm/Status/Hex` into table `Arm` and key `Status/Hex`.
fn split_topic(topic: &str) -> (String, String) {
    let cleaned = topic.trim().trim_start_matches('/');
    match cleaned.split_once('/') {
        Some((table, key)) => (table.to_string(), key.to_string()),
        None => (cleaned.to_string(), String::new()),
    }
}

#[tauri::command]
pub fn find_topic_source(project_path: String, topic: String) -> Result<TopicSourceResult, String> {
    let root = PathBuf::from(&project_path);
    let java_root = root.join("src").join("main").join("java");
    if !java_root.exists() {
        return Err(format!(
            "{} does not look like a robot project (no src/main/java).",
            root.display()
        ));
    }

    let (table, key) = split_topic(&topic);
    let leaf = key.rsplit('/').next().unwrap_or(&key).to_string();

    let mut files = Vec::new();
    collect_java_files(&java_root, &mut files);

    let p = Patterns::new();
    let mut matches: Vec<SourceMatch> = Vec::new();

    for path in &files {
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let lines: Vec<&str> = content.lines().collect();
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let absolute = path.to_string_lossy().to_string();

        // Step 1: which NT tables this file declares, and on which line.
        let mut tables: BTreeSet<String> = BTreeSet::new();
        let mut table_line: Option<usize> = None;
        for (i, line) in lines.iter().enumerate() {
            for caps in p.builder_key.captures_iter(line).chain(p.super_key.captures_iter(line)) {
                let declared = caps[1].to_string();
                if declared == table && table_line.is_none() {
                    table_line = Some(i + 1);
                }
                tables.insert(declared);
            }
        }
        let owns_table = tables.contains(&table);

        // A function and not a closure: further down `matches` has to be read to
        // know whether this file already contributed something, and a closure
        // capturing it mutably would keep it borrowed for the whole block.
        macro_rules! push {
            ($line_no:expr, $kind:expr, $confidence:expr, $text:expr) => {
                matches.push(SourceMatch {
                    file: relative.clone(),
                    path: absolute.clone(),
                    line: $line_no,
                    kind: ($kind).to_string(),
                    snippet: snippet_of($text),
                    confidence: $confidence,
                })
            };
        }

        // Paso 2: construcciones que publican.
        for (i, line) in lines.iter().enumerate() {
            let line_no = i + 1;

            // NetworkIO.set("Tabla", "Key", ...) -- el caso exacto.
            for caps in p.networkio_full.captures_iter(line) {
                let (t, k) = (&caps[1], &caps[2]);
                if t == table && k == key {
                    push!(line_no, "NetworkIO.set", 100, line);
                } else if t == table && k == leaf {
                    push!(line_no, "NetworkIO.set", 90, line);
                } else if k == key || k == leaf {
                    push!(line_no, "NetworkIO.set (other table)", 45, line);
                }
            }

            // NetworkIO.set("WatchDog/ElapsedSeconds", variableName, ...):
            // the table is literal but the key is built at run time.
            if p.networkio_full.captures(line).is_none() {
                if let Some(caps) = p.networkio_table.captures(line) {
                    let prefix = &caps[1];
                    let full = format!("{}/{}", table, key);
                    if full.starts_with(&format!("{}/", prefix)) || prefix == table {
                        push!(line_no, "NetworkIO.set (runtime key)", 70, line);
                    }
                }
            }

            // setEntry("Key", ...) inside an IOSubsystem: the table is the class's
            // own.
            if let Some(caps) = p.set_entry.captures(line) {
                let k = &caps[1];
                if k == key || k == leaf {
                    push!(line_no, "setEntry", if owns_table { 85 } else { 55 }, line);
                }
            }

            // @Signal / @Tunable: the key is the annotation's or, if it carries
            // none, the method's/field's name.
            for (annotation, is_method) in [("@Signal", true), ("@Tunable", false)] {
                if !line.contains(annotation) {
                    continue;
                }
                let Some((rest, explicit)) = after_annotation(line, annotation) else { continue };
                let resolved = match explicit.clone() {
                    Some(k) => Some(k),
                    None => member_name(&lines, i, &rest, is_method),
                };
                let Some(resolved) = resolved else { continue };

                if resolved == key || resolved == leaf {
                    let mut confidence: u8 = 50;
                    if owns_table {
                        confidence += 40;
                    }
                    if explicit.is_some() {
                        confidence += 5;
                    }
                    push!(line_no, annotation, confidence, line);
                }
            }
        }

        // Step 3: even if no line publishes this key, the class that owns the table
        // is almost always where the user wants to go. For the framework's
        // Status/* it is the only useful answer.
        if let Some(decl_line) = table_line {
            let already_here = matches.iter().any(|m| m.path == absolute && m.confidence >= 50);
            if !already_here {
                let confidence = if key.starts_with("Status/") { 80 } else { 30 };
                let text = lines.get(decl_line - 1).copied().unwrap_or("");
                push!(decl_line, "owns the NT table", confidence, text);
            }
        }
    }

    matches.sort_by(|a, b| {
        b.confidence
            .cmp(&a.confidence)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
    });
    matches.dedup_by(|a, b| a.path == b.path && a.line == b.line);
    matches.truncate(20);

    let note = framework_note(&table, &key);
    Ok(TopicSourceResult {
        topic,
        table,
        key,
        matches,
        note,
    })
}

/// Opens the file in VS Code at the exact line. `-g` is what makes it jump to
/// the line instead of only opening the file.
#[tauri::command]
pub async fn open_in_editor(path: String, line: Option<usize>) -> Result<(), String> {
    let target = match line {
        Some(n) => format!("{}:{}", path, n),
        None => path.clone(),
    };

    #[cfg(target_os = "windows")]
    let status = tokio::process::Command::new("cmd")
        .args(["/C", "code", "-g", &target])
        .status()
        .await;

    #[cfg(not(target_os = "windows"))]
    let status = tokio::process::Command::new("code")
        .args(["-g", &target])
        .status()
        .await;

    match status {
        Ok(s) if s.success() => Ok(()),
        _ => Err(format!(
            "Could not open VS Code (is `code` on your PATH?). The location is {}",
            target
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_project(files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "mars-srcmap-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (name, content) in files {
            let path = root.join("src/main/java").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        root
    }

    const ARM: &str = r#"package frc.robot.arm;

public class Arm extends ModularSubsystem<ArmData, ArmIO> {
    @Tunable double kP = 0.5;
    @Tunable(key = "maxVolts") private double limit = 12.0;

    public Arm() {
        super(SubsystemBuilder.<ArmData, ArmIO>setup()
            .key("Arm")
            .hardware(io, new ArmData()));
    }

    @Signal(onChange = true)
    public double velocity() { return inputs.velocity; }

    @Signal(key = "atTarget")
    public boolean isThere() { return true; }

    public void publish() {
        NetworkIO.set("Arm", "customKey", 1.0);
        setEntry("viaEntry", 2.0);
    }
}
"#;

    #[test]
    fn finds_a_tunable_field_by_its_name() {
        let root = write_project(&[("frc/robot/arm/Arm.java", ARM)]);
        let result = find_topic_source(root.to_string_lossy().to_string(), "/Arm/kP".into()).unwrap();
        let top = &result.matches[0];
        assert_eq!(top.kind, "@Tunable");
        assert_eq!(top.line, 4);
        assert_eq!(top.confidence, 90, "key match + the file owns the Arm table");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_explicit_annotation_key_wins_over_the_member_name() {
        let root = write_project(&[("frc/robot/arm/Arm.java", ARM)]);

        let by_key = find_topic_source(root.to_string_lossy().to_string(), "/Arm/maxVolts".into()).unwrap();
        assert_eq!(by_key.matches[0].line, 5);
        assert_eq!(by_key.matches[0].kind, "@Tunable");

        // The field's name is NOT the topic when there is an explicit key.
        let by_field = find_topic_source(root.to_string_lossy().to_string(), "/Arm/limit".into()).unwrap();
        assert!(by_field.matches.iter().all(|m| m.kind == "owns the NT table"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn signal_methods_resolve_by_name_and_by_key() {
        let root = write_project(&[("frc/robot/arm/Arm.java", ARM)]);

        let by_method = find_topic_source(root.to_string_lossy().to_string(), "/Arm/velocity".into()).unwrap();
        assert_eq!(by_method.matches[0].kind, "@Signal");
        assert_eq!(by_method.matches[0].line, 13);

        let by_key = find_topic_source(root.to_string_lossy().to_string(), "/Arm/atTarget".into()).unwrap();
        assert_eq!(by_key.matches[0].kind, "@Signal");
        assert_eq!(by_key.matches[0].line, 16);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_literal_networkio_call_outranks_everything() {
        let root = write_project(&[("frc/robot/arm/Arm.java", ARM)]);
        let result = find_topic_source(root.to_string_lossy().to_string(), "/Arm/customKey".into()).unwrap();
        assert_eq!(result.matches[0].kind, "NetworkIO.set");
        assert_eq!(result.matches[0].confidence, 100);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn set_entry_uses_the_table_the_class_owns() {
        let root = write_project(&[("frc/robot/arm/Arm.java", ARM)]);
        let result = find_topic_source(root.to_string_lossy().to_string(), "/Arm/viaEntry".into()).unwrap();
        assert_eq!(result.matches[0].kind, "setEntry");
        assert_eq!(result.matches[0].confidence, 85);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn framework_status_topics_point_at_the_owning_class() {
        let root = write_project(&[("frc/robot/arm/Arm.java", ARM)]);
        let result = find_topic_source(root.to_string_lossy().to_string(), "/Arm/Status/Hex".into()).unwrap();
        assert!(result.note.as_ref().unwrap().contains("ModularSubsystem"));
        assert_eq!(result.matches[0].kind, "owns the NT table");
        assert_eq!(result.matches[0].line, 9, "the .key(\"Arm\") line");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn watchdog_topics_are_reported_as_framework_owned() {
        let root = write_project(&[("frc/robot/arm/Arm.java", ARM)]);
        let result = find_topic_source(
            root.to_string_lossy().to_string(),
            "/WatchDog/ElapsedSeconds/Arm".into(),
        )
        .unwrap();
        assert!(result.note.as_ref().unwrap().contains("MARSWatchdog"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn splits_multi_segment_keys() {
        assert_eq!(split_topic("/Arm/Status/Hex"), ("Arm".into(), "Status/Hex".into()));
        assert_eq!(split_topic("Arm/kP"), ("Arm".into(), "kP".into()));
        assert_eq!(split_topic("/Loose"), ("Loose".into(), "".into()));
    }
}
