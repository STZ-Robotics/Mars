//! The project and feature templates, carried inside the binary.
//!
//! Both used to be `git clone`d from GitHub every time the wizard ran, with the
//! `.git` deleted immediately afterwards -- so the clone was never about
//! history, only about getting the files. Paying for that with a network round
//! trip and a dependency on the `git` binary meant the most common first action
//! a new team takes ("create a project") failed on a bad connection, which at a
//! competition is most of them.
//!
//! It also meant the template could change under an app that was already
//! installed. That matters more than it sounds: `feature_gen` rewrites
//! `MarsFeature.json`, `build.gradle`, `settings.gradle` and the java package
//! tree by exact expectations about what the template contains. Renaming a
//! package in the template repository would have left every installed wizard
//! producing a project that does not compile, with nothing to warn anyone.
//! Embedded, the two versions cannot disagree.
//!
//! The tables come from `build.rs`; see it for what goes in.

use std::fs;
use std::path::Path;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/templates.rs"));
}

pub use embedded::{FEATURE, PROJECT};

/// Writes a template into `target`, creating it and its parents.
///
/// `target` is expected to be empty or absent; callers check that first,
/// because "the folder already has something in it" is a question for the user
/// and not for this.
pub fn extract(files: &[(&str, &[u8])], target: &Path) -> Result<(), String> {
    for (rel, bytes) in files {
        let dest = target.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {}", parent.display(), e))?;
        }
        fs::write(&dest, bytes)
            .map_err(|e| format!("Could not write {}: {}", dest.display(), e))?;
        make_executable_if_script(&dest, bytes);
    }
    Ok(())
}

/// Restores the executable bit on scripts.
///
/// A file written by `fs::write` is 644, and `gradlew` at 644 is
/// "Permission denied" on the first command anybody types in a new project.
/// The bit cannot come from the embedded bytes -- and on a Windows checkout it
/// is not in the working tree either -- so it is inferred from the one thing
/// that travels: a file that starts with `#!` is a script and has to be
/// runnable. That keeps working for whatever script a template gains later.
#[cfg(unix)]
fn make_executable_if_script(path: &Path, bytes: &[u8]) {
    use std::os::unix::fs::PermissionsExt;
    if bytes.starts_with(b"#!") {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
    }
}

#[cfg(not(unix))]
fn make_executable_if_script(_path: &Path, _bytes: &[u8]) {
    // Windows decides by extension; there is no bit to set.
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The templates are enumerated at build time, and the thing that can go
    /// wrong silently is a directory walk that skips dotfiles: `.wpilib/` is
    /// what tells the WPILib extension the folder is a robot project, and
    /// `.gitignore` is what keeps `build/` out of a team's first commit. A
    /// template missing those still extracts, still compiles, and is wrong.
    #[test]
    fn the_project_template_carries_its_hidden_files() {
        let names: Vec<&str> = PROJECT.iter().map(|(n, _)| *n).collect();
        for expected in [
            ".gitignore",
            ".wpilib/wpilib_preferences.json",
            ".vscode/settings.json",
            "build.gradle",
            "settings.gradle",
            "gradlew",
            "vendordeps/Mars.json",
            "src/main/java/frc/robot/Robot.java",
        ] {
            assert!(names.contains(&expected), "the project template lost {expected}");
        }
    }

    /// Same for the feature template, plus the four files the wizard rewrites
    /// in lockstep: if one of them moves, `feature_gen` silently stops patching
    /// it and the generated gradle does not build.
    #[test]
    fn the_feature_template_carries_what_the_wizard_rewrites() {
        let names: Vec<&str> = FEATURE.iter().map(|(n, _)| *n).collect();
        for expected in [
            "MarsFeature.json",
            "build.gradle",
            "settings.gradle",
            "gradlew",
            ".github/workflows/publish.yml",
            "src/main/java/com/yourteam/yourfeature/FeatureMain.java",
        ] {
            assert!(names.contains(&expected), "the feature template lost {expected}");
        }
    }

    /// gradlew has to keep its shebang, because that is what the extractor uses
    /// to decide the file is a script and give it back its executable bit.
    #[test]
    fn gradlew_is_recognisable_as_a_script() {
        for (label, table) in [("project", PROJECT), ("feature", FEATURE)] {
            let (_, bytes) = table
                .iter()
                .find(|(n, _)| *n == "gradlew")
                .unwrap_or_else(|| panic!("the {label} template has no gradlew"));
            assert!(
                bytes.starts_with(b"#!"),
                "the {label} template's gradlew lost its shebang; it would extract unrunnable",
            );
        }
    }

    /// A round trip through the real filesystem: every file lands, with its
    /// bytes, under the folders it is supposed to be under.
    #[test]
    fn extracting_writes_the_whole_tree() {
        let target = std::env::temp_dir().join(format!("mars-template-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&target);

        extract(PROJECT, &target).expect("extraction failed");

        for (rel, bytes) in PROJECT {
            let written = fs::read(target.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
            assert_eq!(&written, bytes, "{rel} came out different");
        }

        let _ = fs::remove_dir_all(&target);
    }
}
