# MARS Installer

One executable that installs, updates and uninstalls the MARS ecosystem. You
download it, open it, pick which edition you want, and that is it — no git, no
node, no Rust, and no administrator rights.

```
release/MARS-Installer.exe            Windows  (recommended)
release/MARS-Installer-linux-x86_64   Linux
release/MARS-Installer-macos-aarch64  macOS Apple Silicon
release/MARS-Installer-macos-x86_64   macOS Intel
```

## What it installs

| | Complete MARS | Tools only |
|---|---|---|
| NetworkTables dashboard, 2D/3D field, swerve, mechanisms, plots, equations, SysId, loop timing, bandwidth, console, `.wpilog` files | ✅ | ✅ |
| MARS framework: projects, packages, manifest, subsystem wizard, features, subsystem status, watchdog | ✅ | — |

"Tools only" is **not the same app with the buttons hidden**: it is a different
build, with no MARS code in the front-end bundle and none in the Rust binary.
How that is done is in [`desktop/src/mars/README.md`](../desktop/src/mars/README.md).

## How it works

```
        GitHub Releases                        the user's machine
   ┌──────────────────────────┐        ┌──────────────────────────────┐
   │ manifest.json            │───1───▶│ pick edition and folder      │
   │ mars-desktop-full-…zip   │        │                              │
   │ mars-desktop-tools-…zip  │───2───▶│ download + verify sha256     │
   │                          │        │ extract                      │
   └──────────────────────────┘        │ shortcuts + program entry    │
                                       │ installation.json            │
                                       └──────────────────────────────┘
```

1. **The latest release is fetched** through the GitHub API. If it carries a
   `manifest.json` (written by `scripts/make-manifest.mjs`), its sizes and
   sha256 sums are used; if not — a release published by hand — the files are
   derived from their names and the screen says outright that nothing can be
   verified.
2. **Only what applies is downloaded** for this platform, architecture and
   edition. The names follow a strict convention:
   `mars-desktop-{full|tools}-{windows|linux|macos}-{x86_64|aarch64}.{zip|tar.gz}`.
3. **It installs under the user**, never into Program Files or `/opt`: that is
   what lets a student install it on the lab computer without asking anyone for
   a password.

| | Default folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\MARS` |
| Linux | `~/.local/share/MARS` |
| macOS | `~/Applications/MARS` |

Every installation leaves a record in `<user data>/installation.json` with **the
exact list of files and shortcuts it created**. Uninstalling deletes that list
and nothing else: a `remove_dir_all` on the folder the user picked is one line
shorter and an excellent way to wipe the desktop of somebody who installed into
`C:\`.

## Uninstalling

Three routes, all the same code:

- Open the installer again → **Uninstall**.
- On Windows, *Settings → Installed apps → MARS Desktop*.
- Run `mars-uninstall` from the install folder with `--uninstall`.

Preferences, saved layouts and 3D asset packs are **not** deleted unless the box
is ticked: those are hours of the team's work and an uninstaller has no business
taking them along.

## Things you would not guess from the code

- **WebView2 (Windows).** A Tauri app with no WebView2 runtime opens a blank
  window and says nothing at all. Windows 11 ships it; Windows 10 does not
  always. The installer checks the registry and, if it is missing, installs
  Microsoft's official bootstrapper first.
- **Gatekeeper quarantine (macOS).** macOS tags everything downloaded from the
  internet, and an unsigned binary under quarantine will not open. Since the
  installer is what downloaded the files, it clears the tag itself
  (`xattr -dr com.apple.quarantine`). This does **not** replace signing and
  notarising the app; it is what makes it open until there is an Apple developer
  account.
- **The uninstaller cannot delete itself** while it runs: on Windows the file is
  locked by its own process. It leaves a `.bat` that waits for the process to
  die, retries the delete, and removes itself at the end.
- **The archives are flat**, with the executable at the root, which is where
  the shortcuts point.
- **The Simulation Studio is no longer installed.** Releases up to 1.1.6
  carried it in the Complete edition; updating one of those installs removes
  it along with everything else the install record lists.

## Development

```bash
cargo run  --manifest-path installer/Cargo.toml              # open it
cargo test --manifest-path installer/Cargo.toml              # offline tests
cargo test --manifest-path installer/Cargo.toml -- --ignored # against the real release
```

The two `--ignored` tests are the ones that matter whenever the name format or
the manifest changes: they really download an archive from the published
release, verify its sha256, and check that the executable lands at the root. No
offline test can cover that what the packager publishes is what the installer
looks for.

To test against a different repository:

```bash
MARS_RELEASES_REPO=myuser/myfork cargo run --manifest-path installer/Cargo.toml
```

The interface is plain ES modules in `ui/`, no bundler, with mars-desktop's
palette copied into `css/tokens.css`. It is embedded into the binary at compile
time; `build.rs` watches `ui/` so that editing a `.js` really does trigger a
rebuild.

## Releasing a version

```bash
node scripts/sync-version.mjs --write   # line up every file that carries a version
git tag v1.1.4 && git push --tags       # fires .github/workflows/release.yml
```

The workflow builds on three runners (Windows, Linux, and macOS producing both
architectures), collects the archives, writes `manifest.json` with the real
sha256 sums, and publishes the release. It has to be done this way rather than
from one machine: Tauri links against each system's webview, so there is no
cross-compiling between operating systems.

To package only the current platform by hand:

```bash
node scripts/package-release.mjs
node scripts/make-manifest.mjs release 1.1.4
```
