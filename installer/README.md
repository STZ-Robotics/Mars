# MARS Installer

Installs, updates and uninstalls MARS Desktop. Download it, run it, pick an
edition, and it fetches the rest.

| System | File |
|---|---|
| Windows | `MARS-Installer.exe` |
| macOS | `MARS-Installer-macos-aarch64` (Apple Silicon) or `MARS-Installer-macos-x86_64` (Intel) |
| Linux | `MARS-Installer-linux-x86_64` |

Get it from the [latest release](https://github.com/STZ-Robotics/Mars/releases/latest).
On macOS and Linux, run `chmod +x MARS-Installer-*` first. On macOS, the first
time you open it, allow it under *System Settings → Privacy & Security*.

## Editions

| | Complete MARS | Tools only |
|---|---|---|
| Dashboard: NetworkTables, 2D/3D field, swerve, mechanisms, plots, equations, SysId, loop timing, bandwidth, console, `.wpilog` files | ✅ | ✅ |
| MARS framework: projects, packages, manifest, subsystem wizard, features, subsystem status, watchdog | ✅ | — |

## What it does

- **Installs for your user only**, with no administrator rights — so it works on
  a school or lab computer.

  | | Default folder |
  |---|---|
  | Windows | `%LOCALAPPDATA%\Programs\MARS` |
  | macOS | `~/Applications/MARS` (as `MARS Desktop.app`) |
  | Linux | `~/.local/share/MARS` |

- **Verifies every download** against the SHA-256 published with the release.
- **Creates shortcuts**: Start Menu (and optionally the desktop) on Windows, an
  application launcher on Linux. On Windows it also appears under *Settings →
  Installed apps*, and installs Microsoft's WebView2 runtime if it is missing.
- **Updates in place.** Open it again and it shows the installed version and
  whether a newer one is out. If MARS Desktop is still open, it asks you to
  close it before changing anything, and it downloads the new version before
  removing the old one, so a failed download leaves your installation working.
- **Uninstalls exactly what it installed**, from the installer, from *Installed
  apps* on Windows, or with `mars-uninstall --uninstall` in the install folder.
  Your preferences, layouts and 3D models are kept unless you choose to delete
  them.

## Development

```bash
cargo run  --manifest-path installer/Cargo.toml              # open it
cargo test --manifest-path installer/Cargo.toml              # offline tests
cargo test --manifest-path installer/Cargo.toml -- --ignored # against the published release
```

The installer reads the newest MARS release (tags `vX.Y.Z`) from GitHub, and its
`manifest.json` for sizes and checksums; the archive names are defined in
`src/platform.rs` and produced by `scripts/package-release.mjs`.
`MARS_RELEASES_REPO=owner/repo` points it at a fork. The interface is plain
HTML and JavaScript in `ui/`, embedded at build time.
