# Change Log

## 0.3.2

### Fixed

- **On macOS, MARS Desktop is found as `MARS Desktop.app`,** the app bundle
  the installer puts there from MARS 1.1.8 on. 0.3.1's notes claimed this
  already; that change had not reached its build.

## 0.3.1

### Fixed

- **MARS Desktop is found wherever it was installed.** The launcher looked only
  in the installer's default folder; it now reads the folder the installer
  recorded in `installation.json` first.

### Removed

- **Launch Simulation Studio** and `mars.simulationStudioPath`: the Simulation
  Studio is no longer distributed with MARS.

### Notes

- 0.3.0 was published from a working copy whose changes never reached the
  repository. They are rebuilt here from the published package: the reference
  page, the `@`, `@Unit` and `Manifest.` completion, the identifier, the
  `engines` range and the icons.

## 0.3.0

### Added

- **`MARS: Show what MARS autocompletes and warns about`**, a reference page
  listing every completion trigger, the hover catalog, the snippet prefixes and
  every diagnostic code with its meaning and whether a quick fix exists.
- **More completion.** `@` now offers `@Tunable` and `@Signal` with the `key`
  argument ready to fill in, `@Fallback`, and `@Unit` with its value list open
  as a choice; `Manifest.` offers the project's own `HAS_*` switches wherever
  it is read, not only inside `Injector.createIO`.

### Fixed

- The manifest was missing `publisher`, so a packaged VSIX installed as
  `undefined_publisher.mars` instead of `STZRobotics.mars-developer-tools`.
- `engines.vscode` required `^1.137.0`, a version that does not exist yet and
  refused to install on any VS Code actually released. Lowered to `^1.85.0`,
  which is what the source actually needs.

### Changed

- The extension is named `mars-developer-tools`, published as
  `STZRobotics.mars-developer-tools`. The plain `mars` identifier is taken by
  another extension on the Marketplace and cannot be registered.
- The status bar entry and the project tree's root icon use `$(symbol-function)`
  instead of `$(rocket)`.
- `media/mars.svg` recompressed from 161 KB to 12 KB. The artwork inside was
  embedded at 1634x1680 and rendered at a fraction of that; it is now downsampled
  to the size the icon is actually displayed at and palette-encoded, pixel-for-
  pixel the same at every size the icon is shown.

## 0.2.0

### Added

- **Live NetworkTables.** Connect to the robot or the simulator and every topic's
  current value appears at the end of the line that publishes it. A lens over a
  `@Tunable` writes a new value back; the architecture tree shows the same values
  on its topic nodes; a status bar entry carries the connection.
  `mars.networkTables.address` connects straight to a `host:port`; without it you
  are offered the simulator, the robot derived from the team number, the Driver
  Station and Systemcore.
- **Quick fixes** for the diagnostics that can be repaired without guessing:
  create or use the `KeyManager` constant behind a `.key(null)`, construct an
  orphan subsystem in the container, write the `Real` and `Sim` implementations
  an IO interface is missing, and put the Manifest back to `REAL`.
- **`MARS: Rename a NetworkTables table`**, which rewrites the key constant and
  every literal naming the same table -- a rename of strings, which no language
  server can offer.

### Notes

- The NetworkTables client is deliberately not a second dashboard: no graphs, no
  history, no log playback. It also does not synchronise clocks (nothing shows a
  timestamp, and a written value is stamped by the server on arrival) and it
  subscribes only to the tables the open project publishes rather than to the
  whole tree.
- No quick fix is offered for a topic collision. Deciding which of the two is
  wrong would be a guess, and a quick fix that guesses gets accepted unread.

## 0.1.0

The first version that does anything. Everything below is built on one scan of
the project's Java, kept current as you type.

### Added

- **A MARS sidebar** with two views. **Project**: whether MARS Desktop and
  Simulation Studio are installed, the team number, the run mode, the vendordeps
  and the installed packages, each linking to the file that decides it.
  **Architecture**: subsystems with their data, IO layer and its implementations,
  their requests and the NetworkTables topics they publish.
- **Launch buttons** for MARS Desktop and Simulation Studio, in the sidebar's
  title bar and in the command palette. They look where the installer puts each
  application, at `mars.desktopPath` / `mars.simulationStudioPath`, and at a
  development build inside this repository.
- **CodeLens** over MARS declarations: from a subsystem to its data, IO,
  implementations, requests and table; from a request back to the subsystem it
  acts on; from an IO implementation to its interface and its siblings; and the
  full topic over every `@Tunable` and `@Signal`.
- **Diagnostics** for duplicate subsystem keys, colliding topics, the subsystem
  wizard's leftover `.key(null)`, subsystems no container constructs, IO
  interfaces with no implementation, a Manifest pinned to anything but `REAL`,
  and an installed Feature whose `marsCoreRequired` the vendordep does not meet.
- **Snippets** for the MARS patterns, matching the shape the subsystem wizard
  generates, and **hovers** for the framework's types and for the project's own
  key constants and subsystems.
- **Completion** for NetworkTables tables and keys inside `NetworkIO.set(...)`
  and `.key(...)`, offering the project's key constants and the names already
  published under a table.
- **A status bar entry** showing the MARS version and the run mode, coloured when
  the run mode is not `REAL`.
- `MARS: Go to a NetworkTables topic`, which lists every topic the project
  publishes and jumps to the line that publishes it.

### Notes

- Keys held in constants are resolved. The subsystem wizard writes
  `.key(KeyManager.ARM_KEY)` and the dashboard's source map stops there; this
  reads the constant and names the topic. Keys built by concatenation or
  returned from a method are still reported as unresolved rather than guessed.
- The extension does not yet tell MARS Desktop what you are looking at. Launching
  it opens the dashboard, not the dashboard positioned on the current file —
  that needs the dashboard to accept arguments, which it does not do today.

## 0.0.1

- The `yo code` scaffold, with the identity filled in.
