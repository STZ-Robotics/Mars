# MARS

The whole MARS ecosystem for FRC in one repository: the library a robot
actually imports, the NetworkTables dashboard, the Gazebo-based simulation
environment, the installer that puts them on a machine, and the documentation.

They live together because they ship together. One release carries all three,
one `manifest.json` describes it, and one installer reads that manifest — so a
change that crosses products (a new archive name, a version bump, a folder the
Studio needs at runtime) is one commit and not a coordination problem across
three repositories.

## Installing

Download the installer for your system from the
[latest release](https://github.com/STZ-Robotics/Mars/releases/latest) and run it.
It fetches everything else.

| System | File |
|---|---|
| **Windows** (recommended) | `MARS-Installer.exe` |
| Linux | `MARS-Installer-linux-x86_64` (`chmod +x` first) |
| macOS | `MARS-Installer-macos-aarch64` or `-x86_64` (`chmod +x` first) |

The installer lets you pick the edition, needs no administrator rights, and also
uninstalls.

## What is in here

| Folder | What it is |
|---|---|
| [`lib/`](lib/README.md) | **MARS**, the FRC Java library — the vendordep teams install. Its own version, its own release cycle, and the only thing here whose output is consumed by people who never clone this repository. |
| [`desktop/`](desktop/README.md) | **MARS Desktop**: the NetworkTables dashboard. React + TypeScript over a Rust/Tauri backend. This is what most people mean by "MARS". |
| [`simulationstudio/`](simulationstudio/app/README.md) | **MARS Simulation Studio** and the Gazebo-based simulation engine. A separate product with its own version and its own life cycle. |
| [`templates/`](templates/README.md) | The project and feature scaffolds the dashboard writes. They ship inside its binary, so creating a project needs neither network nor git. |
| [`extension/`](extension/README.md) | **MARS for VS Code**: the editor half. Reads a robot project's architecture out of its Java and puts it in the sidebar, over the declarations, and in the problems panel. |
| [`installer/`](installer/README.md) | **MARS Installer**: the app that installs, updates and uninstalls the ecosystem. |
| [`docs/`](docs/) | The documentation site (MkDocs Material). |
| [`scripts/`](scripts/) | The only things that know about more than one at once: release packaging, version syncing, the vendordep check. |

Each folder builds on its own — no cargo workspace, no npm workspace, on
purpose: the products have different toolchains (gradle, npm + cargo, cargo +
conda + CMake, cargo) and nothing to gain from sharing a lockfile.

```bash
cd lib                && ./gradlew build
cd desktop            && npm install && npm run tauri dev
cd simulationstudio   && ./build.ps1 && cargo run --manifest-path app/Cargo.toml
cd installer          && cargo run
```

## The published site

One GitHub Pages site, at `https://stz-robotics.github.io/Mars/`, built by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml):

| Path | What |
|---|---|
| `/` | this documentation (MkDocs, from `docs/`) |
| `/api/` | the library's Javadoc |
| `/maven/` | **the maven repository** the vendordep resolves against |
| `/Mars.json` | **the vendordep itself** |

The last two are URLs written into the `vendordeps/Mars.json` of every robot
project that has MARS installed, so they are not ours to move once published.
`node scripts/check-vendordep.mjs` refuses a `Mars.json` that promises a version
`lib/maven/` does not carry, and the workflow runs it before uploading anything.

The library used to be published from a separate repository at the same address
this one now answers on. Renaming this repository to `Mars` reclaimed that
address, so no robot project ever had to be migrated — which also makes the name
load-bearing. [`lib/README.md`](lib/README.md) explains what that means before
anybody renames anything again.

### One folder, two names

Inside a release archive the Studio's data travels as `sim/`, not as
`simulationstudio/`. That name is a contract with the installed application
(`Supervisor::buscar_sim_dir` looks for a `sim/` next to the executable), so the
packager writes it literally and it does not follow this repository's layout.

## Releasing a version

The dashboard's version is written in **one place**,
`desktop/src/constants/version.ts`; the Studio's is in
`simulationstudio/app/Cargo.toml` and does not follow it. Line up every file
that carries either of them with:

```bash
node scripts/sync-version.mjs          # check
node scripts/sync-version.mjs --write  # fix
```

After that, a `vX.Y.Z` tag fires [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds on three runners (Windows, Linux, and macOS producing both
architectures), writes `manifest.json` with the real sha256 sums, and publishes
the release. Each platform is built on its own because Tauri links against the
system webview: cross-compiling between operating systems is not possible.

To build the archives for your own platform without a tag:

```bash
node scripts/package-release.mjs       # leaves them in release/
```

## License

[MIT](LICENSE), for everything in this repository except
`templates/project/WPILib-License.md`, which covers the WPILib-derived files the
project template carries.
