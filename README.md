# MARS

**MARS** is a toolkit for FRC robot software from STZ Robotics: a Java framework
for structuring robot code, a desktop dashboard to see what the robot is doing,
an editor extension that understands MARS projects, and Ares, a trajectory
planner with its own robot library.

| | What it is |
|---|---|
| [**MARS library**](lib/README.md) | A WPILib vendordep. Subsystems built from swappable hardware layers, a run mode for real, simulated and replayed hardware, live diagnostics, a blackboard for sharing state, controller abstractions and pit-test routines. |
| [**MARS Desktop**](desktop/README.md) | A NetworkTables dashboard: 2D and 3D field, swerve and mechanism views, plots, live equations, SysId, `.wpilog` files, loop timing and bandwidth. With the framework edition it also creates projects, installs packages and generates subsystems. |
| [**MARS for VS Code**](extension/README.md) | The editor side: architecture view, live NetworkTables values next to the code, diagnostics and quick fixes for common MARS mistakes, completion and snippets. |
| [**Ares**](ares/README.md) | A trajectory planner and auto builder that plans with the robot's real physics, plus [**AresLib**](ares/areslib/README.md), which follows those trajectories and runs the autos on the robot. |

## Install

**MARS Desktop** — download the installer for your system from the
[latest release](https://github.com/STZ-Robotics/Mars/releases/latest) and run it.
No administrator rights are needed; the same installer updates and uninstalls.

| System | File |
|---|---|
| Windows | `MARS-Installer.exe` |
| macOS | `MARS-Installer-macos-aarch64` (Apple Silicon) or `MARS-Installer-macos-x86_64` (Intel) |
| Linux | `MARS-Installer-linux-x86_64` |

On macOS and Linux, make the installer executable first:
`chmod +x MARS-Installer-*`.

**MARS library** — in VS Code with the WPILib extension, *WPILib: Manage Vendor
Libraries → Install new library (online)*, and paste:

```
https://stz-robotics.github.io/Mars/Mars.json
```

A project created from MARS Desktop already has it.

**MARS for VS Code** — install
[MARS Developer Tools](https://marketplace.visualstudio.com/items?itemName=STZRobotics.mars-developer-tools)
from the Marketplace.

**Ares** — the installers are on the
[Releases page](https://github.com/STZ-Robotics/Mars/releases), under the
`ares-v*` tags. See the [Ares README](ares/README.md).

## Documentation

- Guides: <https://stz-robotics.github.io/Mars/>
- Library API (Javadoc): <https://stz-robotics.github.io/Mars/api/>

## Building from source

Each product builds on its own with its own toolchain:

```bash
cd lib        && ./gradlew build                       # Java 17
cd desktop    && npm install && npm run tauri dev      # Node 22 + Rust
cd extension  && npm install && npm run compile        # Node 22
cd installer  && cargo run                             # Rust
cd ares       && cargo test --release                  # Rust + CMake + a C++23 compiler
```

`node scripts/package-release.mjs` builds the installer and MARS Desktop
archives for the current platform into `release/`. Pushing a `vX.Y.Z` tag builds
and publishes them for Windows, Linux and macOS; `node scripts/sync-version.mjs`
checks that every file carrying the version agrees first.

## License

[MIT](LICENSE), except `templates/project/WPILib-License.md`, which covers the
WPILib-derived files in the project template.
