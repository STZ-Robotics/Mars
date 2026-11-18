# MARS Desktop

A NetworkTables dashboard for FRC, and the control center for MARS projects.

It connects to a robot, the simulator or the Driver Station over NT4, records
everything it receives on a timeline you can scrub, and opens and saves
`.wpilog` files, so the same views work live and on a log after the match.

## Dashboard

| | |
|---|---|
| **2D Visualizer** | The field with the robot's pose, trajectories and other objects from NetworkTables. |
| **Field 3D** | The field and robot in 3D, with downloadable field and robot models. |
| **Swerve / Swerve 3D** | Each module's angle and speed, commanded against measured. |
| **Mechanism / Mechanism 3D** | WPILib `Mechanism2d` views, and 3D mechanisms built from your own models. |
| **Telemetry** | Plots of any topic over time. |
| **Display** | A free-form board of widgets bound to topics. |
| **Function / Equations** | Live math on topics: write an expression and see it plotted as the data arrives. |
| **NT Session** | Publish your own values to the robot (for tuning) and copy each one as Java code. |
| **SysId** | Characterize a mechanism from logged data and get feedforward and feedback gains. |
| **Loop timing** | Jitter and period analysis of the robot loop. |
| **Bandwidth** | What each topic costs on the network, against the field's limit. |
| **Command Console** | The robot's console output. |

Tabs, widget layouts and settings are saved between sessions, and a layout can
be saved to a file and shared.

## MARS projects

The **Complete MARS** edition adds the framework tools:

- **New Project** — a WPILib robot project with MARS already set up, created
  offline from a built-in template.
- **Packages** — browse and install MARS Features (packages that add code to a
  project) from the catalog or a URL.
- **Wizard** — generate a subsystem and its IO layer.
- **Create Feature** — package your own code as a MARS Feature and publish it.
- **Manifest** and **Variables** — the project's hardware switches and units.
- **Subsystems** — every subsystem's live status color, code and message.
- **Watchdog** — each subsystem's loop time.
- From any topic, jump to the line of code that publishes it.

The **Tools** edition is the dashboard alone, for teams that do not use the
framework. It is a separate build: the framework code is not in it at all.

## Install

Use the MARS installer from the
[latest release](https://github.com/STZ-Robotics/Mars/releases/latest); it asks
which edition you want. Windows, macOS and Linux are supported.

## Connecting

Set your team number in **Settings** and connect to the robot (`10.TE.AM.2`), or
to the simulation for robot code running on your computer. **Settings** also
lets you target the Driver Station, Systemcore, or a custom address and port
(for USB, `172.22.11.2`). If the connection drops, MARS
Desktop reconnects on its own and keeps the history it had recorded.

## Development

```bash
cd desktop
npm install
npm run tauri dev                      # Complete edition
MARS_EDITION=tools npm run tauri dev   # Tools edition

npm test                                          # front end (vitest)
cargo test --manifest-path src-tauri/Cargo.toml   # backend
```

| Folder | |
|---|---|
| `src/` | The interface (React + TypeScript). `src/mars/` holds what only the Complete edition has — see [its README](src/mars/README.md). |
| `src-tauri/` | The backend (Rust): the NT4 client, `.wpilog` reading and writing, 3D assets, code generators. |
| `public/` | Field images, bundled 3D models and icons. |

The project and feature templates are built into the binary from
[`../templates/`](../templates/README.md).

The version is set in `src/constants/version.ts`; `node scripts/sync-version.mjs
--write`, from the repository root, copies it to the other files that carry it.
