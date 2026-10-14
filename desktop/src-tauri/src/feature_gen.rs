// feature_gen.rs
// Generador de paquetes (features) de MARS a partir de la plantilla de feature.
//
// Es la hermana de `create_mars_project`: extrae una plantilla y la reescribe
// con los datos del wizard. La diferencia es que acá
// hay que tocar cuatro archivos coordinados entre si -- MarsFeature.json,
// build.gradle, settings.gradle y el arbol de paquetes java -- porque el
// groupId aparece en los cuatro y si uno queda desfasado el gradle no compila.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Una dependencia elegida en el wizard. `artifacts` ya viene con las
/// coordenadas gradle resueltas ("com.ctre.phoenix6:wpiapi-java:26.1.1"); la
/// version literal "wpilib" es la convencion de los vendordeps de WPILib para
/// "la misma que el GradleRIO activo" y se traduce al interpolar.
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct GradleDependency {
    pub id: String,
    pub label: String,
    #[serde(rename = "mavenUrls", default)]
    pub maven_urls: Vec<String>,
    #[serde(default)]
    pub artifacts: Vec<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct FeatureWizardConfig {
    #[serde(rename = "featureId")]
    pub feature_id: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "groupId")]
    pub group_id: String,
    pub author: String,
    pub description: String,
    #[serde(rename = "marsCoreRequired")]
    pub mars_core_required: String,
    #[serde(rename = "forgeMiniRequired")]
    pub forge_mini_required: String,
    #[serde(rename = "githubUser")]
    pub github_user: String,
    #[serde(rename = "githubRepo")]
    pub github_repo: String,
    #[serde(rename = "workspacePath")]
    pub workspace_path: String,
    #[serde(rename = "folderName")]
    pub folder_name: String,
    #[serde(default)]
    pub dependencies: Vec<GradleDependency>,
    /// Marca el artefacto propio como annotation processor en MarsFeature.json.
    #[serde(rename = "isProcessor", default)]
    pub is_processor: bool,
    #[serde(rename = "initGit", default)]
    pub init_git: bool,
    #[serde(rename = "openEditor", default)]
    pub open_editor: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct CreateFeatureResult {
    pub path: String,
    /// La URL que se pega en Packages > Manual Install.
    #[serde(rename = "installUrl")]
    pub install_url: String,
    #[serde(rename = "mavenUrl")]
    pub maven_url: String,
    #[serde(rename = "docsUrl")]
    pub docs_url: String,
    #[serde(rename = "mainClass")]
    pub main_class: String,
    #[serde(rename = "gitInitialized")]
    pub git_initialized: bool,
    /// Pasos opcionales que fallaron sin invalidar la feature (git, editor).
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Validacion
// ---------------------------------------------------------------------------

fn is_java_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn validate(config: &FeatureWizardConfig) -> Result<(), String> {
    if !is_java_identifier(&config.feature_id) {
        return Err(format!(
            "Feature ID \"{}\" is not usable: it becomes a Java class and a Maven artifact, so it must start with a letter and contain only letters, digits or underscores.",
            config.feature_id
        ));
    }
    if config.group_id.trim().is_empty()
        || config.group_id.split('.').any(|seg| !is_java_identifier(seg))
    {
        return Err(format!(
            "Group ID \"{}\" is not a valid Java package (expected something like com.myteam.myfeature).",
            config.group_id
        ));
    }
    if config.version.trim().is_empty() {
        return Err("Version is required (e.g. 1.0.0).".into());
    }
    if config.workspace_path.trim().is_empty() {
        return Err("Workspace base folder is not configured in settings.".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Parche de build.gradle
// ---------------------------------------------------------------------------

/// Inserta `snippet` justo antes del cierre del bloque que abre `header`.
///
/// Se cuentan llaves en vez de buscar el `}` mas cercano porque tanto
/// `repositories` como `dependencies` contienen bloques y `${...}` anidados.
/// El header se ancla a inicio de linea ("\nrepositories {") para no capturar
/// el `repositories {` indentado que vive dentro de `publishing`.
fn insert_into_block(source: &str, header: &str, snippet: &str) -> Result<String, String> {
    let start = source.find(header).ok_or_else(|| {
        format!(
            "build.gradle has no top-level `{}` block -- the template changed and the wizard can't patch it.",
            header.trim()
        )
    })?;

    let brace = start + header.len() - 1; // el header termina en '{'
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut end = None;

    for i in brace..bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }

    let end = end.ok_or_else(|| format!("build.gradle: `{}` block is never closed.", header.trim()))?;

    let mut out = String::with_capacity(source.len() + snippet.len());
    out.push_str(&source[..end]);
    out.push_str(snippet);
    out.push_str(&source[end..]);
    Ok(out)
}

/// Linea `implementation` para una coordenada gradle. Las coordenadas que
/// terminan en `:wpilib` usan comillas dobles porque hay que interpolar la
/// version del GradleRIO activo -- es lo mismo que hace la plantilla con
/// wpilibNewCommands.
fn implementation_line(coordinate: &str) -> String {
    match coordinate.strip_suffix(":wpilib") {
        Some(base) => format!(
            "    implementation \"{}:${{wpi.versions.wpilibVersion.get()}}\"\n",
            base
        ),
        None => format!("    implementation '{}'\n", coordinate),
    }
}

fn patch_build_gradle(path: &Path, deps: &[GradleDependency]) -> Result<(), String> {
    let original = fs::read_to_string(path)
        .map_err(|e| format!("Could not read build.gradle: {}", e))?;

    // Los repos y coordenadas que la plantilla ya trae (WPILib, Mars,
    // ForgeMini) se saltan: repetirlos no rompe gradle pero ensucia el archivo
    // que el usuario va a editar a mano despues.
    let mut repos = String::new();
    for dep in deps {
        for url in &dep.maven_urls {
            let url = url.trim();
            if url.is_empty() || original.contains(url) || repos.contains(url) {
                continue;
            }
            repos.push_str(&format!("\n    maven {{\n        url = uri(\"{}\")\n    }}\n", url));
        }
    }

    let mut artifacts = String::new();
    for dep in deps {
        let mut lines = String::new();
        for coordinate in &dep.artifacts {
            let coordinate = coordinate.trim();
            // "group:artifact" sin la version: si ya esta declarado, aunque sea
            // en otra version, no lo duplicamos.
            let key: String = coordinate.rsplitn(2, ':').last().unwrap_or(coordinate).to_string();
            if coordinate.is_empty() || original.contains(&key) || artifacts.contains(&key) {
                continue;
            }
            lines.push_str(&implementation_line(coordinate));
        }
        if !lines.is_empty() {
            artifacts.push_str(&format!("\n    // {}\n{}", dep.label, lines));
        }
    }

    let mut patched = original;
    if !repos.is_empty() {
        patched = insert_into_block(&patched, "\nrepositories {", &repos)?;
    }
    if !artifacts.is_empty() {
        patched = insert_into_block(&patched, "\ndependencies {", &artifacts)?;
    }

    fs::write(path, patched).map_err(|e| format!("Could not write build.gradle: {}", e))
}

// ---------------------------------------------------------------------------
// Archivos generados
// ---------------------------------------------------------------------------

fn pages_base(config: &FeatureWizardConfig) -> Option<String> {
    let user = config.github_user.trim();
    let repo = config.github_repo.trim();
    if user.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("https://{}.github.io/{}", user.to_lowercase(), repo))
}

fn mars_feature_json(config: &FeatureWizardConfig, maven_url: &str) -> serde_json::Value {
    serde_json::json!({
        "featureId": config.feature_id,
        "name": config.name,
        "version": config.version,
        "groupId": config.group_id,
        "author": config.author,
        "description": config.description,
        "marsCoreRequired": config.mars_core_required,
        "forgeMiniRequired": config.forge_mini_required,
        "mavenUrls": [maven_url],
        "javaDependencies": [{
            "groupId": config.group_id,
            "artifactId": config.feature_id,
            "version": config.version,
            "isProcessor": config.is_processor,
        }],
    })
}

fn main_class_source(config: &FeatureWizardConfig) -> String {
    format!(
        r#"package {group};

/**
 * {name}
 *
 * <p>{description}</p>
 *
 * <p>Feature ID: {id} &middot; author: {author}</p>
 */
public class {id} {{
}}
"#,
        group = config.group_id,
        name = config.name,
        description = config.description,
        id = config.feature_id,
        author = config.author,
    )
}

fn feature_constants_source(config: &FeatureWizardConfig) -> String {
    format!(
        r#"package {group}.generated;

// AUTO-GENERATED FILE DO NOT EDIT
public final class FeatureConstants {{
    public static final String FEATURE_VERSION = "{version}";
    public static final String FEATURE_NAME = "{id}";
}}
"#,
        group = config.group_id,
        version = config.version,
        id = config.feature_id,
    )
}

fn readme_source(config: &FeatureWizardConfig, pages: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n{}\n\n", config.name, config.description));
    out.push_str(&format!(
        "| | |\n|---|---|\n| Feature ID | `{}` |\n| Group ID | `{}` |\n| Version | `{}` |\n| Author | {} |\n| MARS core | `{}` |\n| ForgeMini | `{}` |\n\n",
        config.feature_id,
        config.group_id,
        config.version,
        config.author,
        config.mars_core_required,
        config.forge_mini_required,
    ));

    out.push_str("## Install this feature in a robot project\n\n");
    match pages {
        Some(base) => out.push_str(&format!(
            "1. Open MARS Desktop and load your robot project.\n2. Go to **Project > Packages > Manual Install** and paste:\n\n   ```\n   {}/MarsFeature.json\n   ```\n\n3. Press **INSTALL FROM URL**. MARS writes the descriptor into `workspace-mars/features/` and runs a Gradle build.\n\n",
            base
        )),
        None => out.push_str(
            "1. Publish the repository first (see below) so the `MarsFeature.json` gets a public URL.\n2. Then paste that URL into **Project > Packages > Manual Install** in MARS Desktop.\n\n",
        ),
    }

    if !config.dependencies.is_empty() {
        out.push_str("### Vendor requirements\n\nThis feature compiles against the vendor libraries below. The robot project that installs it must already have the matching vendordeps, otherwise Gradle will not resolve the transitive dependencies recorded in the published POM:\n\n");
        for dep in &config.dependencies {
            out.push_str(&format!("- **{}**", dep.label));
            if !dep.artifacts.is_empty() {
                out.push_str(&format!(" — `{}`", dep.artifacts.join("`, `")));
            }
            out.push('\n');
        }
        out.push('\n');
    }

    out.push_str("## Publish / update\n\n");
    out.push_str("Publishing is a `git push`: `.github/workflows/publish.yml` builds the jar into `maven/`, generates the Javadoc and deploys both to GitHub Pages.\n\n");
    match pages {
        Some(base) => {
            out.push_str(&format!(
                "1. Create the repository `{}/{}` on GitHub and push this folder to `main`:\n\n   ```bash\n   git add -A\n   git commit -m \"Initial feature\"\n   git push -u origin main\n   ```\n\n",
                config.github_user, config.github_repo
            ));
            out.push_str("2. On GitHub: **Settings > Pages > Build and deployment**, source **Deploy from a branch**, branch **`gh-pages`**, folder **`/(root)`**.\n");
            out.push_str("3. Wait for the *Publish MARS Feature* action to finish (Actions tab).\n");
            out.push_str(&format!(
                "4. To cut a new release, bump `version` in `MarsFeature.json` and push again. The Javadoc and the Maven artifact are regenerated on every push to `main`.\n\n- Docs: {base}/\n- Maven: {base}/maven/\n- Descriptor: {base}/MarsFeature.json\n",
                base = base
            ));
        }
        None => {
            out.push_str("1. Create a repository on GitHub and push this folder to `main`.\n");
            out.push_str("2. **Settings > Pages > Build and deployment**, source **Deploy from a branch**, branch **`gh-pages`**, folder **`/(root)`**.\n");
            out.push_str("3. Set `mavenUrls` in `MarsFeature.json` to `https://<user>.github.io/<repo>/maven/`.\n");
            out.push_str("4. Bump `version` in `MarsFeature.json` for each release and push again.\n");
        }
    }

    out.push_str("\n## Code layout\n\n");
    out.push_str(&format!(
        "- `src/main/java/{}/{}.java` — your entry point.\n",
        config.group_id.replace('.', "/"),
        config.feature_id
    ));
    out.push_str("- `generated/FeatureConstants.java` — rewritten by Gradle on every `compileJava`; don't edit it.\n");
    out.push_str("- `MarsFeature.json` — the descriptor MARS reads. `version` here drives both the Maven artifact and the installer.\n");
    out.push_str("\n---\n\nGenerated with the MARS Desktop feature wizard from the template in [Mars](https://github.com/STZ-Robotics/Mars/tree/main/templates/feature).\n");
    out
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

/// Lee los vendordeps del proyecto abierto. Sirve para que el wizard ofrezca
/// CTRE/PathPlanner/etc. con la version exacta que ya usa el robot en vez de
/// una hardcodeada que envejece cada temporada.
#[tauri::command]
pub fn read_project_vendordeps(project_path: String) -> Result<Vec<serde_json::Value>, String> {
    let dir = PathBuf::from(&project_path).join("vendordeps");
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut deps = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Could not read vendordeps: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "json") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    deps.push(json);
                }
            }
        }
    }
    Ok(deps)
}

#[tauri::command]
pub async fn create_mars_feature(config: FeatureWizardConfig) -> Result<CreateFeatureResult, String> {
    scaffold_feature(config)
}

/// El cuerpo real, sincronico, para que el test de integracion pueda correrlo
/// sin montar un runtime ni el contexto de Tauri.
fn scaffold_feature(config: FeatureWizardConfig) -> Result<CreateFeatureResult, String> {
    validate(&config)?;

    let folder = if config.folder_name.trim().is_empty() {
        config.feature_id.clone()
    } else {
        config.folder_name.trim().to_string()
    };
    let target = PathBuf::from(config.workspace_path.trim()).join(&folder);

    if target.exists() && fs::read_dir(&target).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(format!("{} already exists and is not empty.", target.display()));
    }

    // 1. Plantilla. Viaja dentro del binario (ver templates.rs): antes se
    //    clonaba con --depth 1 y se le borraba el .git acto seguido, que era
    //    pagar una dependencia de red y del binario `git` para no usar nada del
    //    historial.
    crate::templates::extract(crate::templates::FEATURE, &target)?;

    // 2. Descriptor.
    let pages = pages_base(&config);
    let maven_url = pages
        .as_ref()
        .map(|b| format!("{}/maven/", b))
        .unwrap_or_else(|| "https://YOUR-USER.github.io/YOUR-REPO/maven/".to_string());

    let json = mars_feature_json(&config, &maven_url);
    fs::write(
        target.join("MarsFeature.json"),
        serde_json::to_string_pretty(&json)
            .map_err(|e| format!("Could not serialize MarsFeature.json: {}", e))?,
    )
    .map_err(|e| format!("Could not write MarsFeature.json: {}", e))?;

    // 3. Gradle.
    patch_build_gradle(&target.join("build.gradle"), &config.dependencies)?;
    fs::write(
        target.join("settings.gradle"),
        format!("rootProject.name = '{}'\n", config.feature_id),
    )
    .map_err(|e| format!("Could not write settings.gradle: {}", e))?;

    // 4. Arbol de paquetes. La plantilla trae com/miequipo/mifeature de
    //    ejemplo; se reemplaza entero en vez de renombrarlo para no dejar
    //    carpetas huerfanas con el package viejo.
    let java_root = target.join("src").join("main").join("java");
    if java_root.exists() {
        fs::remove_dir_all(&java_root)
            .map_err(|e| format!("Could not clear the template sources: {}", e))?;
    }
    let package_dir = config
        .group_id
        .split('.')
        .fold(java_root.clone(), |acc, seg| acc.join(seg));
    fs::create_dir_all(package_dir.join("generated"))
        .map_err(|e| format!("Could not create the package folders: {}", e))?;

    fs::write(
        package_dir.join(format!("{}.java", config.feature_id)),
        main_class_source(&config),
    )
    .map_err(|e| format!("Could not write the main class: {}", e))?;
    fs::write(
        package_dir.join("generated").join("FeatureConstants.java"),
        feature_constants_source(&config),
    )
    .map_err(|e| format!("Could not write FeatureConstants.java: {}", e))?;

    // 5. Guia.
    fs::write(target.join("README.md"), readme_source(&config, pages.as_deref()))
        .map_err(|e| format!("Could not write README.md: {}", e))?;

    // 6. Pasos opcionales: que fallen no invalida la feature ya generada.
    let mut warnings = Vec::new();
    let mut git_initialized = false;

    if config.init_git {
        match init_repository(&target, &config) {
            Ok(()) => git_initialized = true,
            Err(e) => warnings.push(e),
        }
    }

    if config.open_editor {
        if let Err(e) = open_in_editor(&target) {
            warnings.push(e);
        }
    }

    Ok(CreateFeatureResult {
        path: target.display().to_string(),
        install_url: pages
            .as_ref()
            .map(|b| format!("{}/MarsFeature.json", b))
            .unwrap_or_default(),
        maven_url,
        docs_url: pages.clone().unwrap_or_default(),
        main_class: format!("{}.{}", config.group_id, config.feature_id),
        git_initialized,
        warnings,
    })
}

fn init_repository(target: &Path, config: &FeatureWizardConfig) -> Result<(), String> {
    // -b main: el workflow de publicacion solo dispara en `main`.
    let status = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(target)
        .status()
        .map_err(|e| format!("git init failed: {}", e))?;
    if !status.success() {
        return Err("git init failed; the folder was created but is not a repository.".into());
    }

    let _ = Command::new("git").args(["add", "-A"]).current_dir(target).status();

    // El commit necesita user.name/user.email; si no estan configurados falla
    // y solo avisamos -- el arbol ya quedo listo para commitear a mano.
    let committed = Command::new("git")
        .args(["commit", "-m", "Initial commit from MARS-Feature-Template"])
        .current_dir(target)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let user = config.github_user.trim();
    let repo = config.github_repo.trim();
    if !user.is_empty() && !repo.is_empty() {
        let _ = Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                &format!("https://github.com/{}/{}.git", user, repo),
            ])
            .current_dir(target)
            .status();
    }

    if !committed {
        return Err("Repository initialized, but the first commit failed (git user.name / user.email are probably not configured).".into());
    }
    Ok(())
}

fn open_in_editor(target: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let spawned = Command::new("cmd")
        .args(["/C", "code", target.to_str().unwrap_or("")])
        .spawn();

    #[cfg(not(target_os = "windows"))]
    let spawned = Command::new("code").arg(target).spawn();

    spawned
        .map(|_| ())
        .map_err(|_| "Could not launch VS Code (`code` is not on PATH).".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRADLE: &str = "plugins {\n    id 'java-library'\n}\n\nrepositories {\n    mavenCentral()\n\n    maven {\n        url = uri(\"https://STZ-Robotics.github.io/Mars/maven/\")\n    }\n}\n\ndependencies {\n    implementation wpi.java.deps.wpilib()\n    implementation \"edu.wpi.first.wpilibNewCommands:wpilibNewCommands-java:${wpi.versions.wpilibVersion.get()}\"\n}\n\npublishing {\n    repositories {\n        maven {\n            name = 'LocalRepo'\n        }\n    }\n}\n";

    #[test]
    fn inserts_before_the_matching_close_brace() {
        let out = insert_into_block(GRADLE, "\nrepositories {", "\n    MARK\n").unwrap();
        let marked = out.find("MARK").unwrap();
        // Debe caer dentro del bloque top-level, antes de `dependencies`.
        assert!(marked > out.find("mavenCentral()").unwrap());
        assert!(marked < out.find("\ndependencies {").unwrap());
    }

    #[test]
    fn ignores_the_indented_repositories_inside_publishing() {
        let out = insert_into_block(GRADLE, "\nrepositories {", "\n    MARK\n").unwrap();
        assert!(out.find("MARK").unwrap() < out.find("publishing {").unwrap());
    }

    #[test]
    fn dependencies_block_survives_interpolated_braces() {
        let out = insert_into_block(GRADLE, "\ndependencies {", "\n    MARK\n").unwrap();
        let marked = out.find("MARK").unwrap();
        assert!(marked > out.find("wpi.java.deps.wpilib()").unwrap());
        assert!(marked < out.find("publishing {").unwrap());
    }

    #[test]
    fn wpilib_versions_are_interpolated_not_quoted_literally() {
        assert_eq!(
            implementation_line("edu.wpi.first.x:y-java:wpilib"),
            "    implementation \"edu.wpi.first.x:y-java:${wpi.versions.wpilibVersion.get()}\"\n"
        );
        assert_eq!(
            implementation_line("com.ctre.phoenix6:wpiapi-java:26.1.1"),
            "    implementation 'com.ctre.phoenix6:wpiapi-java:26.1.1'\n"
        );
    }

    #[test]
    fn rejects_ids_that_are_not_java_identifiers() {
        let mut config = sample();
        config.feature_id = "My-Feature".into();
        assert!(validate(&config).is_err());

        config.feature_id = "MyFeature".into();
        config.group_id = "com..broken".into();
        assert!(validate(&config).is_err());
    }

    #[test]
    fn pages_urls_lowercase_the_user_but_not_the_repo() {
        let mut config = sample();
        config.github_user = "Imcab".into();
        config.github_repo = "CTREPoseFinderFeature".into();
        assert_eq!(
            pages_base(&config).unwrap(),
            "https://imcab.github.io/CTREPoseFinderFeature"
        );
    }

    /// Corre el generador completo contra la plantilla real. Necesita red y
    /// git, por eso va marcado `#[ignore]`:
    /// `cargo test end_to_end_scaffold -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn end_to_end_scaffold() {
        let workspace = std::env::temp_dir().join(format!("mars-feature-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&workspace);
        fs::create_dir_all(&workspace).unwrap();

        let mut config = sample();
        config.feature_id = "MARSPoseFinderCTRESwerve".into();
        config.name = "PoseFinder CTRE Swerve".into();
        config.group_id = "com.stzteam.features.posefinder".into();
        config.author = "STZ-Robotics".into();
        config.description = "A PoseFinder using pathplanner compatible with CTRE Swerve".into();
        config.github_user = "Imcab".into();
        config.github_repo = "CTREPoseFinderFeature".into();
        config.workspace_path = workspace.to_string_lossy().to_string();
        config.dependencies = vec![
            GradleDependency {
                id: "phoenix6".into(),
                label: "CTRE Phoenix 6".into(),
                maven_urls: vec!["https://maven.ctr-electronics.com/release/".into()],
                artifacts: vec!["com.ctre.phoenix6:wpiapi-java:26.1.1".into()],
            },
            GradleDependency {
                id: "vendordep:WPILibNewCommands.json".into(),
                label: "WPILib-New-Commands".into(),
                maven_urls: vec![],
                // Ya esta en la plantilla: no debe duplicarse.
                artifacts: vec!["edu.wpi.first.wpilibNewCommands:wpilibNewCommands-java:wpilib".into()],
            },
        ];

        let result = scaffold_feature(config).expect("scaffold failed");
        let root = PathBuf::from(&result.path);

        assert_eq!(result.install_url, "https://imcab.github.io/CTREPoseFinderFeature/MarsFeature.json");
        assert!(!root.join(".git").exists(), "the template .git must be dropped");

        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("MarsFeature.json")).unwrap()).unwrap();
        assert_eq!(json["featureId"], "MARSPoseFinderCTRESwerve");
        assert_eq!(json["mavenUrls"][0], "https://imcab.github.io/CTREPoseFinderFeature/maven/");
        assert_eq!(json["javaDependencies"][0]["artifactId"], "MARSPoseFinderCTRESwerve");

        let gradle = fs::read_to_string(root.join("build.gradle")).unwrap();
        assert!(gradle.contains("https://maven.ctr-electronics.com/release/"));
        assert!(gradle.contains("implementation 'com.ctre.phoenix6:wpiapi-java:26.1.1'"));
        assert_eq!(gradle.matches("wpilibNewCommands-java").count(), 1, "the template line must not be duplicated");
        // El repo va dentro de `repositories` y la coordenada dentro de
        // `dependencies`, no al reves ni dentro del `publishing`.
        let repos_at = gradle.find("https://maven.ctr-electronics.com/release/").unwrap();
        let deps_at = gradle.find("
dependencies {").unwrap();
        let impl_at = gradle.find("implementation 'com.ctre.phoenix6:wpiapi-java:26.1.1'").unwrap();
        assert!(repos_at < deps_at && deps_at < impl_at && impl_at < gradle.find("publishing {").unwrap());
        assert_eq!(gradle.matches('{').count(), gradle.matches('}').count(), "braces stayed balanced");

        assert!(fs::read_to_string(root.join("settings.gradle")).unwrap().contains("MARSPoseFinderCTRESwerve"));

        let pkg = root.join("src/main/java/com/stzteam/features/posefinder");
        assert!(pkg.join("MARSPoseFinderCTRESwerve.java").exists());
        assert!(pkg.join("generated/FeatureConstants.java").exists());
        assert!(!root.join("src/main/java/com/miequipo").exists(), "the sample package must be gone");

        let readme = fs::read_to_string(root.join("README.md")).unwrap();
        assert!(readme.contains("https://imcab.github.io/CTREPoseFinderFeature/MarsFeature.json"));
        assert!(readme.contains("gh-pages"));

        let _ = fs::remove_dir_all(&workspace);
    }

    fn sample() -> FeatureWizardConfig {
        FeatureWizardConfig {
            feature_id: "MyFeature".into(),
            name: "My Feature".into(),
            version: "1.0.0".into(),
            group_id: "com.team.feature".into(),
            author: "Team".into(),
            description: "".into(),
            mars_core_required: ">=1.6.0".into(),
            forge_mini_required: ">=1.1.0".into(),
            github_user: "user".into(),
            github_repo: "repo".into(),
            workspace_path: "C:/tmp".into(),
            folder_name: String::new(),
            dependencies: Vec::new(),
            is_processor: false,
            init_git: false,
            open_editor: false,
        }
    }
}
