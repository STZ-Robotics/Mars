// subsystem_gen.rs
// Code generator for the MARS subsystem wizard.
// It only generates <Module>.java and <Module>IO.java — the Requests are
// generated later with JavaPoet, which is why they are referenced here but null.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct IOInputField {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub java_type: String, // "double" | "boolean" | "int" | "String" | "Rotation2d" | "Translation2d" | "Pose2d"
    #[serde(rename = "hasUnit")]
    pub has_unit: bool,
    #[serde(rename = "unitValue")]
    pub unit_value: Option<String>,
    #[serde(rename = "unitGroup")]
    pub unit_group: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct ColorCodeEntry {
    pub id: String,
    pub name: String,     // IDLE, ON_TARGET...
    pub severity: String, // OK | WARNING | ERROR
    pub color: String,     // WPI name without the "k", e.g. "DarkGreen"
    pub description: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct SubsystemWizardConfig {
    #[serde(rename = "targetDir")]
    pub target_dir: String,
    #[serde(rename = "javaPackage")]
    pub java_package: String,
    #[serde(rename = "moduleName")]
    pub module_name: String,
    #[serde(rename = "separateFolder")]
    pub separate_folder: bool,
    pub inputs: Vec<IOInputField>,
    #[serde(rename = "useProjectUnits")]
    pub use_project_units: bool,
    #[serde(rename = "outputUnitValue")]
    pub output_unit_value: String,
    #[serde(rename = "outputUnitGroup")]
    pub output_unit_group: String,
    #[serde(rename = "colorCodes")]
    pub color_codes: Vec<ColorCodeEntry>,
}

/// Derives the java package from an absolute path that goes through .../src/main/java/...
#[tauri::command]
pub fn derive_java_package(target_dir: String) -> String {
    let path = Path::new(&target_dir);
    let comps: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();

    if let Some(idx) = comps.iter().position(|c| c == "java") {
        comps[idx + 1..].join(".")
    } else {
        String::new()
    }
}

/// Checks whether the project has the UnitProcessor feature installed.
#[tauri::command]
pub fn check_unit_processor(project_path: String) -> bool {
    Path::new(&project_path)
        .join("workspace-mars")
        .join("features")
        .join("UnitProcessor.json")
        .exists()
}

fn default_value_for(java_type: &str) -> &'static str {
    match java_type {
        "double" => "0",
        "boolean" => "false",
        "int" => "0",
        "String" => "\"\"",
        "Rotation2d" => "Rotation2d.kZero",
        "Translation2d" => "new Translation2d()",
        "Pose2d" => "new Pose2d()",
        _ => "null",
    }
}

fn geometry_import_for(java_type: &str) -> Option<&'static str> {
    match java_type {
        "Rotation2d" => Some("import edu.wpi.first.math.geometry.Rotation2d;"),
        "Translation2d" => Some("import edu.wpi.first.math.geometry.Translation2d;"),
        "Pose2d" => Some("import edu.wpi.first.math.geometry.Pose2d;"),
        _ => None,
    }
}

fn upper_snake(name: &str) -> String {
    // "position" -> "POSITION", "targetAngle" -> "TARGET_ANGLE"
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i != 0 {
            out.push('_');
        }
        out.push(c.to_ascii_uppercase());
    }
    out
}

fn field_label(name: &str) -> String {
    // "targetAngle" -> "Target Angle" (para NetworkTables)
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i != 0 {
            out.push(' ');
        }
        if i == 0 {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn unit_annotation(unit_value: &Option<String>, unit_group: &Option<String>) -> Option<String> {
    match (unit_value, unit_group) {
        (Some(v), Some(g)) if !v.is_empty() && !g.is_empty() => {
            Some(format!("@Unit(value = \"{}\", group = \"{}\")\n    ", v, g))
        }
        _ => None,
    }
}

fn generate_io_file(cfg: &SubsystemWizardConfig) -> String {
    let module = &cfg.module_name;
    let mut imports: Vec<String> = vec![
        "import com.stzteam.features.marsprocessor.Fallback;".to_string(),
    ];

    let any_unit = cfg.use_project_units
        && (cfg.inputs.iter().any(|f| f.has_unit)
            || (!cfg.output_unit_value.is_empty() && !cfg.output_unit_group.is_empty()));
    if any_unit {
        imports.push("import com.stzteam.features.unitprocessor.Unit;".to_string());
    }

    imports.push("import com.stzteam.mars.models.singlemodule.Data;".to_string());
    imports.push("import com.stzteam.mars.models.singlemodule.IO;".to_string());

    let mut geo_imports: Vec<&str> = cfg
        .inputs
        .iter()
        .filter_map(|f| geometry_import_for(&f.java_type))
        .collect();
    geo_imports.sort();
    geo_imports.dedup();
    for gi in geo_imports {
        imports.push(gi.to_string());
    }

    let mut fields = String::new();
    for f in &cfg.inputs {
        let unit = if f.has_unit && cfg.use_project_units {
            unit_annotation(&f.unit_value, &f.unit_group).unwrap_or_default()
        } else {
            String::new()
        };
        fields.push_str(&format!(
            "    {}public {} {} = {};\n\n",
            unit,
            f.java_type,
            f.name,
            default_value_for(&f.java_type)
        ));
    }

    let apply_output_unit = if cfg.use_project_units
        && !cfg.output_unit_value.is_empty()
        && !cfg.output_unit_group.is_empty()
    {
        format!(
            "@Unit(value = \"{}\", group = \"{}\") ",
            cfg.output_unit_value, cfg.output_unit_group
        )
    } else {
        String::new()
    };

    format!(
        r#"package {package};

{imports}

@Fallback
public interface {module}IO extends IO<{module}IO.{module}Inputs> {{

  public static class {module}Inputs extends Data<{module}Inputs> {{

{fields}  }}

  public void applyOutput({apply_output_unit}double volts);

    // TODO -> add the specific hardware methods for this IO here
    // (e.g., setPosition, resetPosition, stopAll...). The wizard only generates
    // the minimum contract (inputs + applyOutput).
}}
"#,
        package = cfg.java_package,
        imports = imports.join("\n"),
        module = module,
        fields = fields,
        apply_output_unit = apply_output_unit,
    )
}

fn generate_subsystem_file(cfg: &SubsystemWizardConfig) -> String {
    let module = &cfg.module_name;
    let module_upper = upper_snake(module);

    let mut color_block = String::new();
    for c in &cfg.color_codes {
        color_block.push_str(&format!(
            "  public static final ModuleColorCode {name} =\n      ModuleColorCode.solid(\"{name}\", Severity.{sev}, Color.k{color}, \"{desc}\");\n",
            name = c.name,
            sev = c.severity,
            color = c.color,
            desc = c.description.replace('"', "\\\"")
        ));
    }

    let mut telemetry_lines = String::new();
    telemetry_lines.push_str(&format!(
        "      NetworkIO.set(KeyManager.{}_KEY, \"Timestamp\", data.timestamp);\n",
        module_upper
    ));
    for f in &cfg.inputs {
        telemetry_lines.push_str(&format!(
            "      NetworkIO.set(KeyManager.{}_KEY, \"{}\", data.{});\n",
            module_upper,
            field_label(&f.name),
            f.name
        ));
    }

    format!(
        r#"package {package};

import com.stzteam.forgemini.io.NetworkIO;
import com.stzteam.mars.diagnostics.ModuleColorCode;
import com.stzteam.mars.diagnostics.StatusColorCode.Severity;
import com.stzteam.mars.models.SubsystemBuilder;
import com.stzteam.mars.models.Telemetry;
import com.stzteam.mars.models.singlemodule.ModularSubsystem;
import edu.wpi.first.wpilibj.util.Color;
import frc.robot.configuration.KeyManager;
import {package}.{module}IO.{module}Inputs;

public class {module} extends ModularSubsystem<{module}Inputs, {module}IO> {{

{color_block}
  public {module}({module}IO io) {{

    super(
        SubsystemBuilder.<{module}Inputs, {module}IO>setup()
            .key(null) //TODO -> KeyManager.{module_upper}_KEY
            .hardware(io, new {module}Inputs())
            // TODO -> {module}RequestFactory is generated with JavaPoet when building the project.
            // Replace this null with {module}RequestFactory.idle() once it exists.
            .request(null)
            .telemetry(new {module}Telemetry()));

    this.setDefaultCommand(runRequest(() -> null));
  }}
    
  @Override
  public void absolutePeriodic({module}Inputs inputs) {{}}

  public static class {module}Telemetry extends Telemetry<{module}Inputs> {{

    @Override
    public void telemeterize({module}Inputs data) {{
{telemetry_lines}    }}
  }}

  @Override
  public void simulationPeriodic() {{}}
}}
"#,
        package = cfg.java_package,
        module = module,
        module_upper = module_upper,
        color_block = color_block,
        telemetry_lines = telemetry_lines,
    )
}

#[tauri::command]
pub fn generate_mars_subsystem(config: SubsystemWizardConfig) -> Result<String, String> {
    if config.module_name.trim().is_empty() {
        return Err("Module name cannot be empty.".into());
    }
    if config.target_dir.trim().is_empty() {
        return Err("Select destination folder.".into());
    }

    let base = PathBuf::from(&config.target_dir);
    let out_dir = if config.separate_folder {
        base.join(config.module_name.to_lowercase())
    } else {
        base
    };

    fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Could not create the destination folder: {}", e))?;

    let subsystem_path = out_dir.join(format!("{}.java", config.module_name));
    let io_path = out_dir.join(format!("{}IO.java", config.module_name));

    if subsystem_path.exists() || io_path.exists() {
        return Err(format!(
            "{} or {} already exists in that folder. Choose another name or folder.",
            subsystem_path.display(),
            io_path.display()
        ));
    }

    fs::write(&subsystem_path, generate_subsystem_file(&config))
        .map_err(|e| format!("Error writting {}: {}", config.module_name, e))?;
    fs::write(&io_path, generate_io_file(&config))
        .map_err(|e| format!("Error writting {}IO: {}", config.module_name, e))?;

    Ok(format!(
        "Generating:\n{}\n{}",
        subsystem_path.display(),
        io_path.display()
    ))
}