import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { open, save } from "@tauri-apps/plugin-dialog"
import { fileNameOf } from "@desktop/utils/field/robotModel"
import RobotSettingsPage from "./robot/RobotSettingsPage"
import PathsPage from "./paths/PathsPage"
import { newRobot, RobotConfig } from "./robot/types"
import VariablesPage from "./vars/VariablesPage"
import AutosPage from "./autos/AutosPage"
import { VariablesProvider } from "./vars/context"
import { useProjectSync } from "./vars/sync"
import { ToastProvider } from "./ui/toasts"

type Page = "robot" | "paths" | "autos" | "field" | "variables"

const LAST_ROBOT_KEY = "ares.lastRobot"
const LAST_PAGE_KEY = "ares.lastPage"

// The shell: MARS Desktop's chrome (dark menu bar, docked panels, status bar)
// around Ares' pages. One robot is open at a time; its robot.json is the
// document the File menu opens and saves.
export default function App() {
  const [page, setPage] = useState<Page>(() => {
    try { const p = localStorage.getItem(LAST_PAGE_KEY); if (p === "robot" || p === "paths" || p === "autos" || p === "field" || p === "variables") return p } catch { /* first run */ }
    return "robot"
  })
  useEffect(() => { try { localStorage.setItem(LAST_PAGE_KEY, page) } catch { /* nothing to remember */ } }, [page])
  const [robot, setRobot] = useState<RobotConfig>(newRobot)
  const [robotPath, setRobotPath] = useState<string | null>(null)
  const [saved, setSaved] = useState<string>(() => JSON.stringify(newRobot()))
  const [status, setStatus] = useState<string>("Ready")
  const dirty = JSON.stringify(robot) !== saved

  const openPath = useCallback(async (path: string) => {
    try {
      const config = await invoke<RobotConfig>("robot_open", { path })
      setRobot(config)
      setSaved(JSON.stringify(config))
      setRobotPath(path)
      remember(path)
      setStatus(`Opened ${fileNameOf(path)}`)
    } catch (e) {
      setStatus(String(e))
    }
  }, [])

  // A file given on the command line wins; otherwise reopen the last robot:
  // a team works on one robot for months.
  useEffect(() => {
    invoke<string | null>("startup_robot")
      .catch(() => null)
      .then(arg => {
        const path = arg ?? recall()
        if (path) openPath(path)
      })
  }, [openPath])

  const confirmDiscard = () => !dirty || window.confirm("The robot has unsaved changes. Discard them?")

  const fileNew = () => {
    if (!confirmDiscard()) return
    const r = newRobot()
    setRobot(r); setSaved(JSON.stringify(r)); setRobotPath(null); setStatus("New robot")
  }
  const fileOpen = async () => {
    if (!confirmDiscard()) return
    const picked = await open({ multiple: false, title: "Open robot", filters: [{ name: "Robot (robot.json)", extensions: ["json"] }] })
    if (typeof picked === "string") openPath(picked)
  }
  const saveTo = async (path: string) => {
    try {
      const written = await invoke<RobotConfig>("robot_save", { path, config: robot })
      setRobot(written); setSaved(JSON.stringify(written)); setRobotPath(path); remember(path)
      setStatus(`Saved ${fileNameOf(path)}`)
    } catch (e) {
      setStatus(String(e))
    }
  }
  const fileSaveAs = async () => {
    const path = await save({ title: "Save robot", defaultPath: `${slug(robot.name)}.robot.json`, filters: [{ name: "Robot (robot.json)", extensions: ["json"] }] })
    if (path) saveTo(path)
  }
  const fileSave = () => (robotPath ? saveTo(robotPath) : fileSaveAs())

  // Ctrl+S / Ctrl+O / Ctrl+N, through a ref so the listener sees the latest.
  const keys = useRef({ fileSave, fileOpen, fileNew })
  keys.current = { fileSave, fileOpen, fileNew }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === "s") { e.preventDefault(); keys.current.fileSave() }
      else if (k === "o") { e.preventDefault(); keys.current.fileOpen() }
      else if (k === "n") { e.preventDefault(); keys.current.fileNew() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    const name = robotPath ? fileNameOf(robotPath) : "New robot"
    getCurrentWindow().setTitle(`${dirty ? "● " : ""}${name} — Ares`).catch(() => {})
  }, [robotPath, dirty])

  return (
    <ToastProvider>
    <VariablesProvider robotPath={robotPath}>
    <ProjectSync robotPath={robotPath} setRobot={setRobot} />
    <div className="app-root">
      <MenuBar
        menus={[
          { label: "File", items: [
            { label: "New robot", shortcut: "Ctrl+N", action: fileNew },
            { label: "Open robot…", shortcut: "Ctrl+O", action: fileOpen },
            { label: "Save", shortcut: "Ctrl+S", action: fileSave, separator: true },
            { label: "Save as…", action: fileSaveAs },
          ] },
        ]}
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Rail page={page} onSelect={setPage} />
        {page === "robot" && <RobotSettingsPage robot={robot} onChange={setRobot} robotPath={robotPath} />}
        {page === "paths" && <PathsPage robot={robot} robotPath={robotPath} onSaveRobot={fileSave} />}
        {page === "autos" && <AutosPage robot={robot} robotPath={robotPath} />}
        {page === "field" && <ComingSoon page={page} />}
        {page === "variables" && <VariablesPage robot={robot} robotPath={robotPath} onRobot={setRobot} />}
      </div>
      <StatusBar robot={robot.name} dirty={dirty} status={status} />
    </div>
    </VariablesProvider>
    </ToastProvider>
  )
}

/** Keeps every formula in the project current as variables change. */
function ProjectSync({ robotPath, setRobot }: { robotPath: string | null; setRobot: (f: (r: RobotConfig) => RobotConfig) => void }) {
  useProjectSync(robotPath, setRobot)
  return null
}

function remember(path: string) {
  try { localStorage.setItem(LAST_ROBOT_KEY, path) } catch { /* private mode: nothing to remember */ }
}
function recall(): string | null {
  try { return localStorage.getItem(LAST_ROBOT_KEY) } catch { return null }
}
function slug(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "robot"
}

interface MenuEntry { label: string; action: () => void; shortcut?: string; separator?: boolean }

function MenuBar({ menus }: { menus: { label: string; items: MenuEntry[] }[] }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  return (
    <div style={{ height: 30, background: "var(--bg-menubar-dark)", display: "flex", alignItems: "center", flexShrink: 0, position: "relative", zIndex: 20 }}>
      <span style={{ color: "var(--text-menubar)", fontWeight: 700, letterSpacing: 2, fontSize: 12, padding: "0 14px 0 12px" }}>
        <span style={{ color: "#e05a5a" }}>▲</span> ARES
      </span>
      {menus.map(m => (
        <div key={m.label} style={{ position: "relative" }}>
          <button
            onClick={() => setOpenMenu(o => o === m.label ? null : m.label)}
            onMouseEnter={() => openMenu && setOpenMenu(m.label)}
            style={{
              height: 30, padding: "0 10px", border: "none", fontSize: 12, cursor: "pointer",
              background: openMenu === m.label ? "var(--bg-menubar-dark-active)" : "transparent", color: "var(--text-menubar)",
            }}
          >
            {m.label}
          </button>
          {openMenu === m.label && (
            <>
              <div style={{ position: "fixed", inset: 0 }} onClick={() => setOpenMenu(null)} />
              <div style={{ position: "absolute", top: 30, left: 0, minWidth: 220, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "2px 2px 0 var(--shadow-soft)", padding: "3px 0" }}>
                {m.items.map(item => (
                  <div key={item.label}>
                    {item.separator && <div style={{ height: 1, background: "var(--border-light)", margin: "3px 0" }} />}
                    <div
                      onClick={() => { setOpenMenu(null); item.action() }}
                      style={{ display: "flex", padding: "5px 14px", fontSize: 12, cursor: "pointer" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--tree-hover-bg)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 11 }}>{item.shortcut}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

const PAGES: { id: Page; label: string; icon: string; ready: boolean }[] = [
  { id: "robot", label: "Robot", icon: "ti-robot", ready: true },
  { id: "paths", label: "Paths", icon: "ti-route", ready: true },
  { id: "autos", label: "Autos", icon: "ti-list-details", ready: true },
  { id: "field", label: "Field", icon: "ti-map-2", ready: false },
  { id: "variables", label: "Variables", icon: "ti-variable", ready: true },
]

function Rail({ page, onSelect }: { page: Page; onSelect: (p: Page) => void }) {
  return (
    <div style={{ width: 52, flexShrink: 0, background: "var(--bg-sidebar)", borderRight: "1px solid var(--border-main)", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 6, gap: 2 }}>
      {PAGES.map(p => (
        <button
          key={p.id}
          title={p.ready ? p.label : `${p.label} (coming)`}
          onClick={() => onSelect(p.id)}
          style={{
            width: 46, padding: "6px 0", border: "none", borderRadius: 3, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            background: page === p.id ? "var(--toolbar-active-bg)" : "transparent",
            color: p.ready ? "var(--icon-tree)" : "var(--text-light)", opacity: p.ready ? 1 : 0.6,
          }}
        >
          <i className={`ti ${p.icon}`} style={{ fontSize: 20 }} aria-hidden />
          <span style={{ fontSize: 9.5 }}>{p.label}</span>
        </button>
      ))}
    </div>
  )
}

function ComingSoon(_: { page: Page }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13, background: "var(--bg-page)" }}>
      The field editor is next: for now, keep-outs are drawn in Paths.
    </div>
  )
}

function StatusBar({ robot, dirty, status }: { robot: string; dirty: boolean; status: string }) {
  return (
    <div style={{ height: 26, background: "var(--bg-dark)", borderTop: "1px solid var(--border-main)", display: "flex", alignItems: "center", gap: 16, padding: "0 12px", fontSize: 11, color: "var(--text-secondary)", flexShrink: 0 }}>
      <span>Robot: <b style={{ color: "var(--text-primary)" }}>{robot || "unnamed"}</b>{dirty && " (unsaved)"}</span>
      <span style={{ marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status}</span>
    </div>
  )
}
