//! Starts and kills the simulation's processes.
//!
//! There are three: the engine (`mars-sim-server`), the world window
//! (`mars-sim-gui`) and the bridge (`mars-bridge`). None of them can be
//! launched "bare": they need the conda environment on the PATH to find their
//! DLLs, the gz-sim and gz-gui plugin paths, OGRE's RenderSystem path, and the
//! right working directory so the worlds' relative paths resolve. All of that
//! lives here.
//!
//! The world window is Gazebo's GUI with our panel configuration. It does not
//! load the world: it CONNECTS to the engine over gz-transport, so it can be
//! closed and reopened without touching the physics.
//!
//! # Killing for real
//!
//! On Windows killing the parent does NOT kill the children. If this app
//! closes without going through `stop`, a `mars-sim-server` and a
//! `mars-bridge` stay alive eating CPU and, worse, holding the gz-transport
//! topics: the next start finds two engines publishing on `/mars/state/pose`
//! and the poses overwrite each other without any error.
//!
//! That is why it kills in three places: in `stop`, in `Drop`, and in the
//! window's close event. All three are needed and none covers the others.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Which simulation to start.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Path of the world, relative to `sim/`. E.g. `worlds/swerve.sdf`.
    pub world: String,
    /// Path of the robot map, relative to `sim/`. E.g. `models/swerve/robot-map.json`.
    pub robot_map: String,
    /// NT4 server the bridge connects to. In desktop simulation it is brought
    /// up by the robot code, almost always on localhost.
    #[serde(default = "default_host")]
    pub nt_host: String,
    #[serde(default = "default_port")]
    pub nt_port: u16,
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    5810
}

/// What the UI needs to know to draw the panel.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub running: bool,
    pub engine_pid: Option<u32>,
    pub window_pid: Option<u32>,
    pub bridge_pid: Option<u32>,
    pub seconds: u64,
    /// Why it died, if it died on its own. `None` while it runs or if we
    /// stopped it ourselves.
    pub crashed: Option<String>,
}

/// One row of the Diagnostics page.
///
/// Everything that "Start" needs in order to work is checked separately and
/// says how to fix itself. It is the alternative to the user finding out a
/// binary is missing when the engine dies without saying why.
#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: String,
    /// `ok` | `warn` | `fail`
    pub status: String,
    pub detail: String,
    /// What to do if it is not `ok`. Empty when there is nothing to do.
    pub fix: String,
}

impl Check {
    fn new(name: &str, ok: bool, detail: String, fix: &str) -> Self {
        Self {
            name: name.into(),
            status: if ok { "ok" } else { "fail" }.into(),
            detail,
            fix: if ok { String::new() } else { fix.into() },
        }
    }

    /// A warning does not prevent starting: the simulation runs, with less.
    fn warning(name: &str, ok: bool, detail: String, fix: &str) -> Self {
        let mut c = Self::new(name, ok, detail, fix);
        if !ok {
            c.status = "warn".into();
        }
        c
    }
}

/// What to do when one of the compiled binaries is missing.
///
/// It says both things because there are two ways to get here and the code
/// cannot know which one is the user's: in an installation the binaries
/// TRAVEL inside `sim/build/`, there are no sources to compile, and if they
/// are missing the package came out incomplete --- the fix is to reinstall; in
/// the repository they are built by hand.
const BINARY_FIX: &str = "Reinstall MARS, or build it from the repository with sim\\build.ps1";

pub struct Supervisor {
    /// The repository's `sim/` directory.
    sim_dir: PathBuf,
    /// The prefix of the `mars-sim` conda environment.
    conda_env: PathBuf,
    engine: Option<Child>,
    window: Option<Child>,
    bridge: Option<Child>,
    started: Option<Instant>,
    crashed: Option<String>,
    /// In CI there is no screen: opening the window there can only fail.
    headless: bool,
}

impl Supervisor {
    /// Locates `sim/` and the conda environment.
    ///
    /// The search order covers the two scenarios that matter: development,
    /// where `sim/` is in the repository and the executable in `target/debug`,
    /// and an installation, where `sim/` travels next to the executable.
    pub fn discover() -> Result<Self> {
        let sim_dir = Self::find_sim_dir()
            .context("could not find the sim/ directory. Set MARS_SIM_DIR if it lives elsewhere")?;
        let conda_env = Self::find_conda_env().context(
            "could not find the 'mars-sim' conda environment. \
             Create it with: conda env create -f sim/environment.yml",
        )?;

        Ok(Self {
            sim_dir,
            conda_env,
            engine: None,
            window: None,
            bridge: None,
            started: None,
            crashed: None,
            headless: false,
        })
    }

    fn find_sim_dir() -> Option<PathBuf> {
        if let Ok(d) = std::env::var("MARS_SIM_DIR") {
            let p = PathBuf::from(d);
            if p.join("worlds").is_dir() {
                return Some(p);
            }
        }

        // From the executable and from the current directory, going up. The
        // executable first: it is the only reliable thing when the app is
        // launched from somewhere else, which is exactly what mars-desktop's
        // launcher does.
        let mut roots = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            roots.push(exe);
        }
        if let Ok(cwd) = std::env::current_dir() {
            roots.push(cwd);
        }

        for root in roots {
            for dir in root.ancestors() {
                for candidate in [dir.join("sim"), dir.to_path_buf()] {
                    if candidate.join("worlds").is_dir() && candidate.join("protocol").is_dir() {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }

    fn find_conda_env() -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(p) = std::env::var("MARS_CONDA_ENV") {
            candidates.push(PathBuf::from(p));
        }
        if let Ok(p) = std::env::var("CONDA_PREFIX") {
            candidates.push(PathBuf::from(p));
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            for root in ["miniforge3", "miniconda3", "anaconda3"] {
                candidates.push(Path::new(&home).join(root).join("envs/mars-sim"));
            }
        }

        candidates.into_iter().find(|c| Self::lib_dir_of(c).is_dir())
    }

    /// Where conda puts the DLLs. On Windows they hang from `Library/`; on
    /// Linux and macOS they go straight into the prefix.
    fn lib_dir_of(env: &Path) -> PathBuf {
        let win = env.join("Library/bin");
        if win.is_dir() {
            win
        } else {
            env.join("bin")
        }
    }

    /// Runs without opening the 3D window. For CI, where there is no screen.
    pub fn set_headless(&mut self, value: bool) {
        self.headless = value;
    }

    pub fn sim_dir(&self) -> &Path {
        &self.sim_dir
    }

    pub fn conda_env(&self) -> &Path {
        &self.conda_env
    }

    /// The places the bridge can be, in order of preference.
    ///
    /// There are three because there are three ways of having it. In an
    /// installation it travels already compiled inside `build/`, next to the
    /// engine and MarsLink: the user has neither cargo nor the bridge's
    /// sources, so that is the only possible place. In the repository it is
    /// wherever cargo left it, which is `release/` or `debug/` depending on
    /// how it was built --- and looking only in `debug/` is what made a
    /// `cargo build --release` leave the app saying the bridge did not exist.
    fn bridge_paths(&self) -> [PathBuf; 3] {
        [
            self.sim_dir.join("build/mars-bridge.exe"),
            self.sim_dir.join("bridge/target/release/mars-bridge.exe"),
            self.sim_dir.join("bridge/target/debug/mars-bridge.exe"),
        ]
    }

    fn find_bridge(&self) -> Option<PathBuf> {
        self.bridge_paths().into_iter().find(|p| p.is_file())
    }

    /// Checks, one by one, everything that has to be in place for "Start" to
    /// work.
    ///
    /// It exists because this app's failures are almost all installation
    /// ones --- a binary not built, a plugin path that is not there --- and
    /// none of them explains itself: the engine dies with a Windows error that
    /// does not say which DLL is missing, or the window opens grey and the
    /// reason stays in a stderr nobody looks at.
    pub fn diagnostics(&self) -> Vec<Check> {
        let lib = Self::lib_dir_of(&self.conda_env);
        let worlds = self.worlds().len();
        let robots = self.robots().len();

        let binary = |name: &str, rel: &str, fix: &str, critical: bool| {
            let p = self.sim_dir.join(rel);
            let ok = p.is_file();
            let detail = if ok {
                p.display().to_string()
            } else {
                format!("missing: {}", p.display())
            };
            if critical {
                Check::new(name, ok, detail, fix)
            } else {
                Check::warning(name, ok, detail, fix)
            }
        };

        vec![
            Check::new(
                "sim/ directory",
                self.sim_dir.join("worlds").is_dir(),
                self.sim_dir.display().to_string(),
                "Set MARS_SIM_DIR to the sim/ folder of the repository.",
            ),
            Check::new(
                "Conda environment",
                lib.is_dir(),
                self.conda_env.display().to_string(),
                "Create it with: conda env create -f sim/environment.yml",
            ),
            binary(
                "Physics engine (mars-sim-server)",
                "build/mars-sim-server.exe",
                BINARY_FIX,
                true,
            ),
            {
                let found = self.find_bridge();
                Check::new(
                    "Bridge (mars-bridge)",
                    found.is_some(),
                    match &found {
                        Some(p) => p.display().to_string(),
                        // The one named when missing is the installation's,
                        // not cargo's: it is where it has to be on the
                        // machine of someone who does not have the repository.
                        None => format!("missing: {}", self.bridge_paths()[0].display()),
                    },
                    BINARY_FIX,
                )
            },
            binary(
                "World window (mars-sim-gui)",
                "build/mars-sim-gui.exe",
                "Reinstall MARS, or build it from the repository with sim\\build.ps1. \
                 Without it the simulation still runs headless.",
                false,
            ),
            binary(
                "Actuator plugin (MarsLink)",
                "build/MarsLink.dll",
                "Reinstall MARS, or build it from the repository with sim\\build.ps1. \
                 Without it the world loads with no actuators, silently.",
                true,
            ),
            Check::warning(
                "OGRE-Next render resources",
                lib.join("OGRE-Next").is_dir(),
                lib.join("OGRE-Next").display().to_string(),
                "Without this path the 3D window opens grey. Reinstall gz-rendering in the conda environment.",
            ),
            Check::new(
                "Worlds",
                worlds > 0,
                format!("{worlds} world(s) in worlds/"),
                "Create one from World Library → New world.",
            ),
            Check::new(
                "Robot maps",
                robots > 0,
                format!("{robots} robot map(s) in models/"),
                "Add a models/<robot>/robot-map.json. See Import Guide.",
            ),
        ]
    }

    /// Available worlds, as paths relative to `sim/`.
    pub fn worlds(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.sim_dir.join("worlds"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "sdf"))
            .filter_map(|e| e.file_name().into_string().ok())
            .map(|n| format!("worlds/{n}"))
            .collect();
        v.sort();
        v
    }

    /// Available robot maps, as paths relative to `sim/`.
    pub fn robots(&self) -> Vec<String> {
        let mut v = Vec::new();
        for entry in std::fs::read_dir(self.sim_dir.join("models")).into_iter().flatten().flatten() {
            let map = entry.path().join("robot-map.json");
            if map.is_file() {
                if let Ok(dir) = entry.file_name().into_string() {
                    v.push(format!("models/{dir}/robot-map.json"));
                }
            }
        }
        v.sort();
        v
    }

    /// PATH for the children: conda's first, and without MSYS2.
    ///
    /// Without `Library/bin` in front, the engine does not find Gazebo's DLLs
    /// and dies on start with a Windows error that does not say which one is
    /// missing. And MSYS2 is filtered out because its same-named DLLs get in
    /// before conda's: the same problem that already forces filtering it
    /// when building.
    fn child_path(&self) -> String {
        let bin = Self::lib_dir_of(&self.conda_env);
        let rest: Vec<String> = std::env::var("PATH")
            .unwrap_or_default()
            .split(';')
            .filter(|p| !p.is_empty() && !p.to_lowercase().contains("msys64"))
            .map(String::from)
            .collect();
        format!("{};{}", bin.display(), rest.join(";"))
    }

    /// Variables the 3D window needs and the headless engine does not.
    ///
    /// `OGRE2_RESOURCE_PATH` is the hard one to find: conda installs
    /// OGRE-Next's RenderSystems in `Library/bin/OGRE-Next`, and gz-rendering
    /// looks for them in the path baked in at compile time. Without this the
    /// window opens, shows grey and the only trace is an `unable to find
    /// OpenGL 3+ Rendering Subsystem` in stderr.
    fn render_env(&self, cmd: &mut Command) {
        let lib = self.conda_env.join("Library");
        // The window resolves on its own the meshes that reach it over
        // gz-transport, so it needs the same model paths as the engine:
        // otherwise the world has the balls and the window does not draw them.
        cmd.env("GZ_SIM_RESOURCE_PATH", self.sim_dir.join("models"));
        cmd.env("OGRE2_RESOURCE_PATH", lib.join("bin/OGRE-Next"));
        cmd.env(
            "GZ_GUI_PLUGIN_PATH",
            format!(
                "{};{}",
                lib.join("lib/gz-gui-10/plugins").display(),
                lib.join("lib/gz-sim-10/plugins/gui").display()
            ),
        );
    }

    fn open_log(&self, name: &str) -> Result<Stdio> {
        let dir = self.sim_dir.join("build");
        std::fs::create_dir_all(&dir)?;
        let f = std::fs::File::create(dir.join(name))?;
        Ok(Stdio::from(f))
    }

    pub fn start(&mut self, cfg: &Config) -> Result<()> {
        if self.is_running() {
            bail!("the simulation is already running");
        }
        self.crashed = None;

        let engine_exe = self.sim_dir.join("build/mars-sim-server.exe");
        if !engine_exe.is_file() {
            bail!("{} is missing. {}", engine_exe.display(), BINARY_FIX);
        }
        let bridge_exe = self.find_bridge().ok_or_else(|| {
            anyhow!("{} is missing. {}", self.bridge_paths()[0].display(), BINARY_FIX)
        })?;
        if !self.sim_dir.join(&cfg.world).is_file() {
            bail!("world {} does not exist", cfg.world);
        }
        if !self.sim_dir.join(&cfg.robot_map).is_file() {
            bail!("robot map {} does not exist", cfg.robot_map);
        }

        let path = self.child_path();

        // The engine first: the bridge dies if it finds nobody publishing, and
        // it needs the NT4 server to exist anyway.
        let engine = Command::new(&engine_exe)
            .args([cfg.world.as_str(), "run"])
            .current_dir(&self.sim_dir)
            .env("PATH", &path)
            // This is where gz-sim looks for our own systems; without it
            // MarsLink does not load and the world starts with no actuators,
            // silently.
            .env("GZ_SIM_SYSTEM_PLUGIN_PATH", self.sim_dir.join("build"))
            // Where `model://` resolves. Without it a world that includes
            // `model://fuel` loads without the balls and only one line of
            // stderr says so; the physics keeps running, so it looks like the
            // world is fine and simply has nothing in it.
            .env("GZ_SIM_RESOURCE_PATH", self.sim_dir.join("models"))
            .stdout(self.open_log("app-engine.log")?)
            .stderr(self.open_log("app-engine.err")?)
            .spawn()
            .with_context(|| format!("could not launch {}", engine_exe.display()))?;
        self.engine = Some(engine);

        // A breather so gz-transport's discovery learns about the engine
        // before the window and the bridge subscribe. Without it they start,
        // see nothing and sit waiting for their timeout.
        std::thread::sleep(std::time::Duration::from_millis(800));

        // The world window. If it is not built we carry on without it: the
        // simulation is useful headless (it is how it runs in CI) and losing
        // the physics because it cannot be drawn would be absurd.
        let window_exe = self.sim_dir.join("build/mars-sim-gui.exe");
        if self.headless {
            eprintln!("[sup] headless mode: no 3D window");
        } else if window_exe.is_file() {
            let mut cmd = Command::new(&window_exe);
            cmd.arg("gui/mars.config")
                .current_dir(&self.sim_dir)
                .env("PATH", &path)
                .stdout(self.open_log("app-window.log")?)
                .stderr(self.open_log("app-window.err")?);
            self.render_env(&mut cmd);
            match cmd.spawn() {
                Ok(m) => self.window = Some(m),
                Err(e) => eprintln!("[sup] no 3D window: {e}"),
            }
        } else {
            eprintln!("[sup] no 3D window: {} is missing", window_exe.display());
        }

        let bridge = Command::new(&bridge_exe)
            .args([
                "--robot-map",
                cfg.robot_map.as_str(),
                "--nt-host",
                cfg.nt_host.as_str(),
                "--nt-port",
                &cfg.nt_port.to_string(),
            ])
            .current_dir(&self.sim_dir)
            .env("PATH", &path)
            .stdout(self.open_log("app-bridge.log")?)
            .stderr(self.open_log("app-bridge.err")?)
            .spawn();

        match bridge {
            Ok(b) => self.bridge = Some(b),
            Err(e) => {
                // If the bridge does not start, the engine cannot be left loose.
                self.stop();
                return Err(anyhow!("could not launch the bridge: {e}"));
            }
        }

        self.started = Some(Instant::now());
        Ok(())
    }

    pub fn stop(&mut self) {
        // The bridge first: killing the engine while the bridge writes leaves
        // connection errors in its log that are not the cause of anything.
        for child in [self.bridge.take(), self.window.take(), self.engine.take()]
            .into_iter()
            .flatten()
        {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
        }
        self.started = None;
    }

    fn is_running(&mut self) -> bool {
        self.engine.is_some() || self.bridge.is_some() || self.window.is_some()
    }

    /// Current status, reaping along the way any children that died on their
    /// own.
    pub fn status(&mut self) -> Status {
        // `try_wait` is what turns a dead process into a visible status.
        // Without it the UI would say "running" forever after a crash, which
        // is the worst way to fail: silently.
        // The window does NOT count here: closing it is something the user
        // does on purpose and must not kill the simulation. It is reaped
        // separately.
        if let Some(Ok(Some(_))) = self.window.as_mut().map(|h| h.try_wait()) {
            self.window = None;
        }

        for (name, slot) in [("the engine", &mut self.engine), ("the bridge", &mut self.bridge)] {
            let exited = match slot.as_mut().map(|h| h.try_wait()) {
                Some(Ok(Some(status))) => Some(status),
                _ => None,
            };
            if let Some(status) = exited {
                *slot = None;
                if self.crashed.is_none() {
                    self.crashed = Some(format!("{name} exited ({status})"));
                }
            }
        }

        // If one went down, the other has nobody to talk to.
        if self.crashed.is_some() && (self.engine.is_some() || self.bridge.is_some()) {
            self.stop();
        }

        Status {
            running: self.engine.is_some() && self.bridge.is_some(),
            engine_pid: self.engine.as_ref().map(|h| h.id()),
            window_pid: self.window.as_ref().map(|h| h.id()),
            bridge_pid: self.bridge.as_ref().map(|h| h.id()),
            seconds: self.started.map(|t| t.elapsed().as_secs()).unwrap_or(0),
            crashed: self.crashed.clone(),
        }
    }

    /// The last lines of a log, for the panel.
    pub fn log(&self, name: &str, lines: usize) -> String {
        let path = self.sim_dir.join("build").join(name);
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let all: Vec<&str> = text.lines().collect();
        all[all.len().saturating_sub(lines)..].join("\n")
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The JSON the UI sends has to land in `Config` field by field.
    ///
    /// It is the same object literal as in `ui/js/pages/launch.js`. A name
    /// that does not match is not a compile error anywhere: serde fails at run
    /// time, with the window already open and the user pressing Start.
    #[test]
    fn the_ui_and_config_speak_the_same_json() {
        let from_ui = r#"{
            "world": "worlds/swerve.sdf",
            "robot_map": "models/swerve/robot-map.json",
            "nt_host": "127.0.0.1",
            "nt_port": 5810
        }"#;
        let cfg: Config = serde_json::from_str(from_ui).expect("the UI sends something Config cannot read");
        assert_eq!(cfg.world, "worlds/swerve.sdf");
        assert_eq!(cfg.robot_map, "models/swerve/robot-map.json");
        assert_eq!(cfg.nt_port, 5810);
    }

    /// The fields with a default can be missing.
    #[test]
    fn the_nt4_server_has_a_default() {
        let minimal = r#"{"world": "worlds/empty.sdf", "robot_map": "models/testbot/robot-map.json"}"#;
        let cfg: Config = serde_json::from_str(minimal).expect("defaults missing");
        assert_eq!(cfg.nt_host, "127.0.0.1");
        assert_eq!(cfg.nt_port, 5810);
    }
}
