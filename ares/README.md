# Ares

A trajectory planner and auto builder for swerve robots. Ares plans each path
with the robot's real physics — its mass and inertia, the motors and their
current limit, the battery, the wheels' grip and how weight shifts when it
accelerates — so the robot can actually drive what was planned. On the robot,
[**AresLib**](areslib/README.md) follows those trajectories and runs the autos.

## Features

| Tab | |
|---|---|
| **Robot** | One `.robot.json` per robot: physics, modules, bumpers, cameras and its 3D model. |
| **Paths** | Draw paths with waypoints, rotation targets, keep-outs, slow zones, event markers, branches, variants and sections. Each path is optimized to the fastest trajectory the robot can follow, with the force on every wheel. |
| **Autos** | Build autos from paths, waits, commands, conditions and parallel steps, organized in folders. |
| **Field** | Pick the game's field and draw the navigation grid used for pathfinding. |
| **Variables** | Named distances, angles and poses used across paths, optionally exported as Java constants. |
| **Live** | Watch the robot follow a path in real time: target against actual pose, speeds and error. |
| **Logs** | Open a `.wpilog` and see how each path went on the real robot. |
| **Measure** | Characterize the drivetrain on the robot (drive and steer feedforward, wheel radius) without SysId. |
| **Tune** | Find path-following gains that hold up across heavier, slicker or worn-out conditions, and apply them to the robot. |
| **Settings** | The project's field, hot reload, and code generation. |

Also:

- **See AprilTags** — a constraint that turns the robot just enough to keep its
  cameras on the field's tags along a stretch of path, and moves the path
  aside when turning is not enough.
- **Hot reload** — with the app connected, every generated path and saved auto
  goes straight to the robot, without a deploy.

## Install

The installers are on the [Releases page](https://github.com/STZ-Robotics/Mars/releases),
under the `ares-v*` tags:

| System | File |
|---|---|
| Windows | `Ares_*_x64-setup.exe` (or the `.msi`) |
| macOS (Apple Silicon) | `Ares_*_aarch64.dmg` |
| Linux (Debian, Ubuntu) | `Ares_*_amd64.deb`: `sudo apt install ./Ares_*_amd64.deb` |
| Linux (any) | `Ares_*_amd64.AppImage`: `chmod +x` it and run it |

Then install AresLib in the robot project, from MARS Desktop's Packages page:
see the [AresLib README](areslib/README.md).

## Getting started

1. Create a robot (**Robot** tab) and save its `.robot.json` in the robot
   project's `src/main/deploy/ares/`, so every deploy carries the paths.
2. Draw a path in **Paths** and generate it.
3. Put paths together in **Autos**.
4. In the robot code, build the autos with AresLib and pick one from the
   dashboard.

## Command line

The planner also runs without the app:

```bash
cargo run --release --bin ares -- plan examples/robots/offseason2026.json examples/paths/hub-run.json -o hub-run.traj.json
```

## Building from source

```bash
cd ares && cargo test --release          # the planner needs CMake and a C++23 compiler (GCC 13 or MSVC 2022)
cd ares/app && npm ci && npx tauri build # the app
```

| Folder | |
|---|---|
| `core/` | The file formats, the robot model and the time-optimal path timing. |
| `planner/` | The trajectory optimizer and the vision constraint. |
| `tune/` | The simulator behind the Tune tab. |
| `app/` | The desktop app (Tauri + React). |
| `areslib/` | The robot library. |
