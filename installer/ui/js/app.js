// MARS Installer — the wizard.
//
// One `state` object and one function per screen. Each screen draws itself
// whole when entered (`paint*`) and sets up its own footer buttons: that way
// there is nowhere for the "Next" button to have to guess which step it is on.

import { invoke, listen, pickFolder, close } from "./tauri.js"
import { $, el, notice, summary, showStep, footer, log, progress, mb, date } from "./ui.js"

const OS_NAMES = { windows: "Windows", linux: "Linux", macos: "macOS" }

const state = {
  /** Whatever `install_status` returned. */
  system: null,
  /** "full" | "tools" */
  edition: "full",
  dir: "",
  desktopShortcut: true,
  /** The download plan for the release we checked. */
  plan: null,
  /** Result of the installation. */
  record: null,
}

// --- Startup ----------------------------------------------------------------

async function start() {
  try {
    state.system = await invoke("install_status")
  } catch (e) {
    showStep("start")
    $("start-title").textContent = "I could not read the state of this system"
    notice($("start-notices"), "error", String(e))
    footer({ cancel: { text: "Close", on: close } })
    return
  }

  state.dir = state.system.suggested_dir
  $("brand-sub").textContent =
    `INSTALLER v${state.system.installer_version} · ${OS_NAMES[state.system.os] ?? state.system.os} ${state.system.arch}`

  // Windows calls the uninstaller with --uninstall from the installed apps
  // list: that goes straight to this screen.
  const mode = await invoke("initial_mode").catch(() => "install")
  if (mode === "uninstall" && state.system.installed) {
    paintUninstall()
  } else {
    paintStart()
  }

  listen("installer://progress", ({ payload }) => applyProgress(payload))
}

// --- 1. Start ---------------------------------------------------------------

function paintStart() {
  showStep("start")
  const inst = state.system.installed

  if (!inst) {
    $("start-title").textContent = "Install MARS Desktop"
    $("start-lede").textContent =
      "This wizard downloads MARS from its official repository and leaves it ready to use. " +
      "No administrator rights needed: everything is installed under your user."
    summary($("start-summary"), [
      ["System", `${OS_NAMES[state.system.os] ?? state.system.os} · ${state.system.arch}`],
      ["Source", `github.com/${state.system.repo}`],
      ["Will be installed in", state.system.suggested_dir],
    ])
    notice(
      $("start-notices"),
      "warn",
      state.system.needs_webview2
        ? "Microsoft's WebView2 runtime is missing — that is what draws the app's window. " +
          "The installer will install it first (a small download, no reboot)."
        : "",
    )
    footer({
      cancel: { text: "Cancel", on: close },
      next: { text: "Get started", on: () => paintEdition() },
    })
    return
  }

  // Something is installed already: the screen switches from "install" to
  // "manage".
  state.edition = inst.edition
  $("start-title").textContent = `MARS ${inst.version} is installed`
  $("start-lede").textContent =
    "You can update it, reinstall it with a different edition, or remove it from this computer."
  summary($("start-summary"), [
    ["Edition", inst.edition === "tools" ? "Tools only" : "Complete MARS"],
    ["Version", inst.version],
    ["Folder", inst.dir],
    ["Components", inst.components.map(componentName).join(", ")],
    ["Installed on", date(inst.installed_at)],
  ])
  $("start-notices").replaceChildren()

  footer({
    cancel: { text: "Close", on: close },
    uninstall: { text: "Uninstall", on: () => paintUninstall() },
    next: { text: "Update or change", on: () => paintEdition() },
  })

  // The version check runs after painting: if GitHub does not answer, the
  // screen is already complete and only one line is missing.
  checkForUpdates(inst)
}

async function checkForUpdates(inst) {
  const box = $("start-notices")
  box.replaceChildren()
  const line = el("div", "lede")
  line.append(el("span", "spinner"), document.createTextNode("Checking for updates…"))
  box.appendChild(line)

  try {
    const plan = await invoke("check_release", { edition: inst.edition })
    state.plan = plan
    if (plan.is_newer) {
      notice(box, "ok", `A newer version is available: ${plan.release.version} (you have ${inst.version}).`)
    } else if (plan.release.version === inst.version) {
      notice(box, "ok", `You have the latest published version (${plan.release.version}).`)
    } else {
      // This happens with a local build newer than what is published. Saying
      // "you are up to date" there would be a lie, and offering to "update" to
      // an older version would be worse.
      notice(box, "warn", `You have ${inst.version}, newer than the latest published version (${plan.release.version}).`)
    }
  } catch (e) {
    notice(box, "warn", `I could not check for updates:\n${e}`)
  }
}

// --- 2. Edition -------------------------------------------------------------

function paintEdition() {
  showStep("edition")

  $("ed-full-list").replaceChildren(
    ...[
      "Full dashboard: NetworkTables, 2D and 3D field, swerve, mechanisms, plots, SysId, .wpilog files",
      "MARS framework: projects, packages, manifest, subsystem wizard, features",
    ].map((t) => el("li", null, t)),
  )
  $("ed-tools-list").replaceChildren(
    ...[
      "Full dashboard: NetworkTables, 2D and 3D field, swerve, mechanisms, plots, SysId, .wpilog files",
      "No MARS framework: nothing about projects, packages or subsystems is compiled or installed",
    ].map((t, i) => el("li", i > 0 ? "no" : null, t)),
  )

  const mark = () => {
    $("ed-full").classList.toggle("chosen", state.edition === "full")
    $("ed-tools").classList.toggle("chosen", state.edition === "tools")
  }
  for (const id of ["ed-full", "ed-tools"]) {
    $(id).onclick = () => {
      state.edition = $(id).dataset.edition
      mark()
    }
  }
  mark()

  $("path").value = state.dir
  $("path").oninput = (e) => { state.dir = e.target.value }
  $("btn-browse").onclick = async () => {
    const chosen = await pickFolder(state.dir)
    if (chosen) {
      state.dir = chosen
      $("path").value = chosen
    }
  }
  $("chk-desktop").checked = state.desktopShortcut
  $("chk-desktop").onchange = (e) => { state.desktopShortcut = e.target.checked }

  notice(
    $("edition-notices"),
    "warn",
    state.system.installed && state.system.installed.edition !== state.edition
      ? "You are switching editions: the current installation is removed and the new one installed. Your preferences and layouts are kept."
      : "",
  )

  footer({
    back: { text: "Back", on: () => paintStart() },
    cancel: { text: "Cancel", on: close },
    next: { text: "Next", on: () => paintConfirm() },
  })
}

// --- 3. Confirmation --------------------------------------------------------

async function paintConfirm() {
  if (!state.dir.trim()) {
    notice($("edition-notices"), "error", "An install folder is required.")
    return
  }

  showStep("confirm")
  $("confirm-lede").textContent = "Checking the latest published version…"
  $("confirm-summary").replaceChildren()
  $("confirm-notes").replaceChildren()
  $("confirm-notices").replaceChildren()
  footer({
    back: { text: "Back", on: () => paintEdition() },
    cancel: { text: "Cancel", on: close },
    next: { text: "Install", disabled: true },
  })

  let plan
  try {
    plan = await invoke("check_release", { edition: state.edition })
  } catch (e) {
    $("confirm-lede").textContent = "I could not prepare the installation."
    notice($("confirm-notices"), "error", String(e))
    footer({
      back: { text: "Back", on: () => paintEdition() },
      cancel: { text: "Close", on: close },
      next: { text: "Try again", on: () => paintConfirm() },
    })
    return
  }

  state.plan = plan
  const total = plan.artifacts.reduce((s, a) => s + (a.size || 0), 0)

  $("confirm-lede").textContent = "Check everything looks right before starting."
  summary($("confirm-summary"), [
    ["Edition", state.edition === "tools" ? "Tools only" : "Complete MARS"],
    ["Version", `${plan.release.version} (${plan.release.tag})`],
    ["Components", plan.artifacts.map((a) => componentName(a.component)).join(", ")],
    ["Download", mb(total) ?? "size not reported"],
    ["Folder", state.dir],
    ["Desktop shortcut", state.desktopShortcut ? "Yes" : "No"],
    ["Integrity", plan.release.verified ? "sha256 published — will be verified" : "the release publishes no checksums"],
  ])

  if (plan.release.notes.trim()) {
    const heading = el("div", "lede", "What is new in this version — ")
    const seeMore = el("span", "link", "see the full release")
    seeMore.onclick = () => invoke("open_url", { url: plan.release.url }).catch(() => {})
    heading.appendChild(seeMore)
    $("confirm-notes").replaceChildren(heading, el("div", "notes", plan.release.notes))
  }

  const notices = []
  if (plan.missing.length) {
    notices.push(`The release does not publish these for this platform: ${plan.missing.join(", ")}. The rest will be installed.`)
  }
  if (!plan.release.verified) {
    notices.push("This release carries no checksums, so I cannot verify what gets downloaded.")
  }
  notice($("confirm-notices"), "warn", notices.join("\n\n"))

  footer({
    back: { text: "Back", on: () => paintEdition() },
    cancel: { text: "Cancel", on: close },
    next: { text: "Install", on: () => runInstall() },
  })
}

// --- 4. Progress ------------------------------------------------------------

async function runInstall() {
  showStep("progress")
  $("progress-title").textContent = "Installing MARS"
  $("log").replaceChildren()
  progress(0, "Getting ready…")
  // No buttons while installing: cancelling halfway through an extraction
  // leaves half-written files, and "close the window" is already the emergency
  // exit.
  footer({})

  try {
    state.record = await invoke("install", {
      options: {
        edition: state.edition,
        dir: state.dir,
        desktop_shortcut: state.desktopShortcut,
      },
    })
    paintDone()
  } catch (e) {
    progress(100, "The installation failed")
    log(String(e), "error")
    $("progress-title").textContent = "Could not install"
    footer({
      cancel: { text: "Close", on: close },
      next: { text: "Try again", on: () => runInstall() },
    })
  }
}

function applyProgress(p) {
  progress(p.percent, p.message)
  if (p.phase === "warning") log(`warning: ${p.message}`, "warn")
  else if (p.phase === "done") log(p.message, "ok")
  else if (p.phase !== "download") log(p.message)
  // The "download" phase fires many times a second: it belongs on the status
  // line and the bar, not in the log.
}

// --- 5. Done ----------------------------------------------------------------

function paintDone() {
  showStep("done")
  const r = state.record
  $("done-title").textContent = `MARS ${r.version} is installed`
  $("done-lede").textContent =
    r.shortcuts.length > 0
      ? "It is in your applications menu now. You can also open it from here."
      : "It is installed. I could not create shortcuts, so it opens from its folder."

  summary($("done-summary"), [
    ["Edition", r.edition === "tools" ? "Tools only" : "Complete MARS"],
    ["Components", r.components.map(componentName).join(", ")],
    ["Folder", r.dir],
    ["Files installed", r.files.length],
  ])

  const note = el("div", "lede")
  note.style.marginTop = "14px"
  const openFolder = el("span", "link", "Open the folder")
  openFolder.onclick = () =>
    invoke("open_folder", { path: r.dir }).catch((e) => notice($("done-notices"), "error", String(e)))
  note.append(
    openFolder,
    document.createTextNode(". To remove it later, run this installer again"),
    document.createTextNode(
      state.system.os === "windows" ? " or use Installed apps in Windows." : ".",
    ),
  )
  $("done-notices").replaceChildren(note)

  footer({
    cancel: { text: "Close", on: close },
    next: {
      text: "Open MARS Desktop",
      on: () =>
        invoke("launch_installed", { component: "mars-desktop" }).catch((e) =>
          notice($("done-notices"), "error", String(e)),
        ),
    },
  })
}

// --- 6. Uninstall -----------------------------------------------------------

function paintUninstall() {
  showStep("uninstall")
  const inst = state.system.installed
  if (!inst) {
    notice($("uninstall-notice"), "error", "No installation is registered.")
    footer({ cancel: { text: "Close", on: close } })
    return
  }

  summary($("uninstall-summary"), [
    ["Edition", inst.edition === "tools" ? "Tools only" : "Complete MARS"],
    ["Version", inst.version],
    ["Folder", inst.dir],
    ["Will be deleted", `${inst.files.length} files and ${inst.shortcuts.length} shortcuts`],
  ])

  $("chk-data").checked = false
  const paintNotice = () => {
    $("uninstall-notice").textContent = $("chk-data").checked
      ? "Your preferences, saved layouts and downloaded 3D asset packs will be deleted too. This cannot be undone."
      : "Your preferences, layouts and 3D assets are kept in case you install again."
  }
  $("chk-data").onchange = paintNotice
  paintNotice()

  footer({
    back: { text: "Back", on: () => paintStart() },
    cancel: { text: "Close", on: close },
    uninstall: { text: "Uninstall now", on: () => runUninstall() },
  })
}

async function runUninstall() {
  showStep("progress")
  $("progress-title").textContent = "Uninstalling"
  $("log").replaceChildren()
  progress(30, "Removing files and shortcuts…")
  footer({})

  try {
    const message = await invoke("uninstall", { deleteData: $("chk-data").checked })
    progress(100, "Done")
    showStep("done")
    $("done-title").textContent = "MARS has been uninstalled"
    $("done-lede").textContent = message
    $("done-summary").replaceChildren()
    $("done-notices").replaceChildren()
    footer({ cancel: { text: "Close", on: close } })
  } catch (e) {
    progress(100, "Could not uninstall")
    log(String(e), "error")
    footer({
      cancel: { text: "Close", on: close },
      next: { text: "Try again", on: () => runUninstall() },
    })
  }
}

// --- Helpers ----------------------------------------------------------------

function componentName() {
  return "MARS Desktop"
}

start()
