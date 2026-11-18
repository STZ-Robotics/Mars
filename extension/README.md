# MARS Developer Tools

VS Code support for robot projects built with the
[MARS](https://github.com/STZ-Robotics/Mars) framework for FRC. It reads your
project the way MARS does — subsystems, their IO layers, their requests and the
NetworkTables topics they publish — and shows it where you write the code.

## Features

**Project view.** Whether MARS Desktop is installed, the team number, the run
mode, the MARS version you compile against and the installed packages — each
one a link to the file that sets it — and a button to launch MARS Desktop.

**Architecture view.** Every subsystem put back together: its data class, IO
interface and implementations, requests and topics, each one a click away from
its declaration.

**CodeLens.** Above a subsystem: its data, IO, requests and NetworkTables table.
Above a `@Tunable` or `@Signal`: the full topic it publishes. Above a request:
the subsystem it acts on.

**Live NetworkTables.** Connect to the robot or the simulator and each topic's
current value appears at the end of the line that publishes it. A lens over a
`@Tunable` writes a new value to the robot.

**Diagnostics** for mistakes that compile fine and fail on the robot:

| | |
|---|---|
| `mars.duplicateKey` | Two subsystems publish under the same NetworkTables table. |
| `mars.topicCollision` | The same topic is published from two places. |
| `mars.nullKey` | A subsystem still has the wizard's `.key(null)` and publishes nowhere. |
| `mars.missingKey` | A subsystem never sets its table. |
| `mars.nonLiteralKey` | A table name the extension cannot resolve, so its topics cannot be traced. |
| `mars.orphanSubsystem` | Nothing constructs the subsystem, so it never runs. |
| `mars.unimplementedIo` | An IO interface has no real or simulated implementation. |
| `mars.runMode` | The Manifest is pinned to `SIM` or `REPLAY`. |
| `mars.featureRequirement` | An installed package needs a newer MARS than the project has. |

**Quick fixes** for the ones that can be fixed without guessing: create or reuse
the `KeyManager` constant for a `.key(null)`, construct an orphan subsystem in
the container, write the `Real` and `Sim` classes an IO interface is missing,
and set the run mode back to `REAL`.

**Completion** where only the project knows the answer: key constants in
`.key(...)` and `NetworkIO.set(...)`, topic names already published under a
table, Blackboard keys, MARS annotations after `@` (with their arguments ready
to fill in), the unit vocabulary inside `@Unit(value = "...")`, and the
project's `HAS_*` switches after `Manifest.`.

**Rename a NetworkTables table** — rewrites the key constant and every string
that names the same table.

**Snippets and hovers** for every MARS pattern, matching what MARS Desktop's
subsystem wizard generates.

**Status bar** — the MARS version and run mode, highlighted when the robot is
not in `REAL`.

Run **MARS: Show what MARS autocompletes and warns about** for a reference of
every completion, hover, snippet and diagnostic.

## Commands

| Command | |
|---|---|
| MARS: Launch MARS Desktop | Opens the dashboard. |
| MARS: Connect to NetworkTables / Disconnect | Live values in the editor. |
| MARS: Go to a NetworkTables topic | Jump to the code that publishes a topic. |
| MARS: Rename a NetworkTables table | Rename a table everywhere it is named. |
| MARS: Open the Manifest | Opens `Manifest.java`. |
| MARS: Rescan the project | Re-reads the project from disk. |
| MARS: Show what MARS autocompletes and warns about | The reference page. |

## Settings

| | |
|---|---|
| `mars.desktopPath` | Full path to `mars-desktop`. Empty: wherever the MARS installer put it. |
| `mars.codeLens` | Show the CodeLens links. |
| `mars.networkTables.address` | Connect straight to this `host:port`. Empty: choose between the simulator, the robot (from the team number), the Driver Station and Systemcore. |

## Requirements

VS Code 1.85 or newer, and a WPILib robot project with the MARS vendordep. The
extension activates when the project has a `workspace-mars/` folder or a
`vendordeps/Mars.json`.
