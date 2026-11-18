#!/usr/bin/env node
// Builds and packages MARS for THIS platform.
//
//   node scripts/package-release.mjs                 everything that applies
//   node scripts/package-release.mjs --only tools    a single edition
//   node scripts/package-release.mjs --arch x86_64   macOS' other architecture
//
// It leaves the archives in `release/`, with the names the installer expects
// (`installer/src/platform.rs::archive_name`). If those names change on one
// side they have to change on the other: it is the only contract between the
// packager and the installer.
//
// Every archive carries its executable AT THE ROOT: the installer drops the
// contents straight into the install folder and points the shortcuts there.

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "release")

// The product this packages out of the repository tree.
const DESKTOP = "desktop"

const args = process.argv.slice(2)
const onlyEdition = args.includes("--only") ? args[args.indexOf("--only") + 1] : null
// Crossing architectures ONLY makes sense on macOS, where both live on the same
// platform and the system SDK is universal. Windows and Linux are each built on
// their own.
const requestedArch = args.includes("--arch") ? args[args.indexOf("--arch") + 1] : null

// --- Platform ---------------------------------------------------------------

const OS = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
const NATIVE_ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const ARCH = requestedArch ?? NATIVE_ARCH
if (ARCH !== "x86_64" && ARCH !== "aarch64") {
  console.error(`Unknown architecture: ${ARCH}`)
  process.exit(2)
}
if (ARCH !== NATIVE_ARCH && OS !== "macos") {
  console.error(`Architectures can only be crossed on macOS, not on ${OS}.`)
  process.exit(2)
}
// `null` when building for the native architecture: passing --target anyway
// would send the output to target/<triple>/release and force a rebuild of what
// was already compiled.
const TRIPLE = ARCH === NATIVE_ARCH ? null : `${ARCH}-apple-darwin`
const SUBDIR = TRIPLE ? `${TRIPLE}/release` : "release"

const EXE = OS === "windows" ? ".exe" : ""
const EXT = OS === "windows" ? "zip" : "tar.gz"

const version = readFileSync(join(root, DESKTOP, "src/constants/version.ts"), "utf8").match(
  /MARS_VERSION\s*=\s*"([^"]+)"/,
)?.[1]
if (!version) {
  console.error("Could not read MARS_VERSION from desktop/src/constants/version.ts")
  process.exit(2)
}

// --- Helpers ----------------------------------------------------------------

const run = (cmd, cmdArgs, options = {}) => {
  console.log(`\n$ ${cmd} ${cmdArgs.join(" ")}`)
  execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: root, shell: OS === "windows", ...options })
}

/**
 * Compresses `entries` (absolute paths to files or folders) into one archive.
 *
 * Files land at the root; a folder would keep its own name and tree.
 *
 * The system's own tool is used rather than an npm library: both
 * `Compress-Archive` and `tar` exist on all three platforms and on the CI
 * runners, and the packager needs no node_modules of its own.
 */
function packageArchive(name, entries) {
  const dest = join(outDir, name)
  rmSync(dest, { force: true })

  if (OS === "windows") {
    const list = entries.map((f) => `'${f.replace(/'/g, "''")}'`).join(",")
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${list} -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
    ])
  } else {
    // -C per entry so the tar stays flat even when the binaries come from
    // different folders (target/release of two different crates).
    const parts = entries.flatMap((f) => ["-C", dirname(f), f.slice(dirname(f).length + 1)])
    run("tar", ["-czf", dest, ...parts])
  }
  const bytes = readFileSync(dest).length
  console.log(`  → ${name} (${(bytes / 1048576).toFixed(1)} MB)`)
}

// --- Build ------------------------------------------------------------------

console.log(
  `\nMARS ${version} — packaging for ${OS} ${ARCH}` +
    (TRIPLE ? ` (crossed from ${NATIVE_ARCH})` : "") +
    `\n${"=".repeat(46)}`,
)
run("node", ["scripts/sync-version.mjs"])

// The folder is emptied ONLY on the native-architecture pass. macOS' second
// pass (`--arch x86_64`) runs against the same folder, and if it emptied it too
// it would wipe the arm64 archives the first pass had just left there — which
// is exactly what happened the first time: the release went out with no Apple
// Silicon files at all and the workflow still said "success".
if (!requestedArch) {
  rmSync(outDir, { recursive: true, force: true })
}
mkdirSync(outDir, { recursive: true })

// The icon travels with the archive: on Linux the `.desktop` file the installer
// writes references it by path, and without it the launcher gets the generic
// icon.
const icon = join(outDir, "icon.png")
cpSync(join(root, DESKTOP, "src-tauri/icons/128x128@2x.png"), icon)

const editions = onlyEdition ? [onlyEdition] : ["full", "tools"]
for (const edition of editions) {
  if (edition !== "full" && edition !== "tools") {
    console.error(`Unknown edition: ${edition}`)
    process.exit(2)
  }
  console.log(`\n--- mars-desktop (${edition}) ---`)

  // The front end first: the binary embeds it at compile time. npm runs inside
  // desktop/, which is where the dashboard's package.json lives.
  run("npm", ["run", "build"], {
    cwd: join(root, DESKTOP),
    env: { ...process.env, MARS_EDITION: edition },
  })

  // `custom-protocol` is passed explicitly rather than being a `default`
  // feature because the Tools edition is built with --no-default-features,
  // which would take it away: the binary would open the devUrl and show the
  // webview's connection error instead of the app. See the note in
  // desktop/src-tauri/Cargo.toml.
  const cargo = [
    "build", "--release",
    "--manifest-path", `${DESKTOP}/src-tauri/Cargo.toml`,
    "--features", "custom-protocol",
  ]
  if (edition === "tools") cargo.push("--no-default-features")
  if (TRIPLE) cargo.push("--target", TRIPLE)
  run("cargo", cargo)

  const binary = join(root, DESKTOP, "src-tauri/target", SUBDIR, `mars-desktop${EXE}`)
  if (!existsSync(binary)) {
    console.error(`cargo did not leave ${binary}`)
    process.exit(1)
  }
  packageArchive(`mars-desktop-${edition}-${OS}-${ARCH}.${EXT}`, [binary, icon])
}

// --- The installer ----------------------------------------------------------
//
// It ships loose, uncompressed: it is what people download and run. A zip
// holding a single .exe only adds a step.
console.log("\n--- MARS Installer ---")
const cargoInstaller = ["build", "--release", "--manifest-path", "installer/Cargo.toml"]
if (TRIPLE) cargoInstaller.push("--target", TRIPLE)
run("cargo", cargoInstaller)
const installer = join(root, "installer/target", SUBDIR, `mars-installer${EXE}`)
if (existsSync(installer)) {
  const name = OS === "windows" ? "MARS-Installer.exe" : `MARS-Installer-${OS}-${ARCH}`
  cpSync(installer, join(outDir, name))
  console.log(`  → ${name}`)
}

rmSync(icon, { force: true })

writeFileSync(join(outDir, "VERSION"), `${version}\n`)
console.log(`\nDone. Archives are in ${outDir}`)
