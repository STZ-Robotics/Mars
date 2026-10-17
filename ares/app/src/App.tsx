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
import FieldPage from "./field/FieldPage"
import TunePage from "./tune/TunePage"
import CharacterizePage from "./characterize/CharacterizePage"
import LivePage from "./live/LivePage"
import LogsPage from "./logs/LogsPage"
import { VariablesProvider } from "./vars/context"
import { useProjectSync } from "./vars/sync"
import { ToastProvider } from "./ui/toasts"
import SwerveIcon from "./ui/SwerveIcon"

type Page = "robot" | "paths" | "autos" | "live" | "logs" | "tune" | "characterize" | "field" | "variables"

const LAST_ROBOT_KEY = "ares.lastRobot"
const LAST_PAGE_KEY = "ares.lastPage"

// The shell: MARS Desktop's chrome (dark menu bar, docked panels, status bar)
// around Ares' pages. One robot is open at a time; its robot.json is the
// document the File menu opens and saves.
export default function App() {
  const [page, setPage] = useState<Page>(() => {
    try { const p = localStorage.getItem(LAST_PAGE_KEY); if (p === "robot" || p === "paths" || p === "autos" || p === "live" || p === "logs" || p === "tune" || p === "characterize" || p === "field" || p === "variables") return p } catch { /* first run */ }
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

  // A MARS robot project: Ares lives in its src/main/deploy/ares/, and is
  // set up there (the robot read from PathPlanner or TunerConstants) the
  // first time.
  const fileOpenProject = async () => {
    if (!confirmDiscard()) return
    const root = await open({ directory: true, title: "Open a robot project (the folder with build.gradle)" })
    if (typeof root !== "string") return
    try {
      const p = await invoke<{ root: string; aresDir: string; robotPath: string; created: string | null; navgridImported: boolean; paths: number; autos: number }>("project_open", { root })
      await openPath(p.robotPath)
      setStatus(p.created
        ? `Set up Ares in ${p.aresDir}: the robot came from ${p.created}${p.navgridImported ? "; PathPlanner's navgrid came along" : ""}. Check it in the Robot tab.`
        : `Opened ${fileNameOf(p.root)}: ${p.paths} path${p.paths === 1 ? "" : "s"}, ${p.autos} auto${p.autos === 1 ? "" : "s"}${p.navgridImported ? "; PathPlanner's navgrid came along" : ""}`)
    } catch (e) {
      setStatus(String(e))
    }
  }

  // Ctrl+S / Ctrl+O / Ctrl+N, through a ref so the listener sees the latest.
  const keys = useRef({ fileSave, fileOpen, fileNew, fileOpenProject })
  keys.current = { fileSave, fileOpen, fileNew, fileOpenProject }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === "s") { e.preventDefault(); keys.current.fileSave() }
      else if (k === "o" && e.shiftKey) { e.preventDefault(); keys.current.fileOpenProject() }
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
            { label: "Open project…", shortcut: "Ctrl+Shift+O", action: fileOpenProject },
            { label: "New robot", shortcut: "Ctrl+N", action: fileNew, separator: true },
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
        {page === "live" && <LivePage robot={robot} />}
        {page === "logs" && <LogsPage robot={robot} robotPath={robotPath} />}
        {page === "tune" && <TunePage robot={robot} robotPath={robotPath} />}
        {page === "characterize" && <CharacterizePage robot={robot} robotPath={robotPath} onRobot={setRobot} />}
        {page === "field" && <FieldPage robot={robot} robotPath={robotPath} />}
        {page === "variables" && <VariablesPage robot={robot} robotPath={robotPath} onRobot={setRobot} />}
      </div>
      <StatusBar robot={robot.name} dirty={dirty} status={status} robotPath={robotPath} />
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
  { id: "robot", label: "Robot", icon: "swerve", ready: true },
  { id: "paths", label: "Paths", icon: "ti-route", ready: true },
  { id: "autos", label: "Autos", icon: "ti-list-details", ready: true },
  { id: "live", label: "Live", icon: "ti-broadcast", ready: true },
  { id: "logs", label: "Logs", icon: "ti-file-analytics", ready: true },
  { id: "tune", label: "Tune", icon: "ti-adjustments-alt", ready: true },
  { id: "characterize", label: "Measure", icon: "ti-chart-dots", ready: true },
  { id: "field", label: "Field", icon: "ti-map-2", ready: true },
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
          {p.icon === "swerve" ? <SwerveIcon size={21} /> : <i className={`ti ${p.icon}`} style={{ fontSize: 20 }} aria-hidden />}
          <span style={{ fontSize: 9.5 }}>{p.label}</span>
        </button>
      ))}
    </div>
  )
}

function StatusBar({ robot, dirty, status, robotPath }: { robot: string; dirty: boolean; status: string; robotPath: string | null }) {
  const [where, setWhere] = useState(false)
  const project = projectOf(robotPath)
  return (
    <div style={{ height: 26, background: "var(--bg-dark)", borderTop: "1px solid var(--border-main)", display: "flex", alignItems: "center", gap: 16, padding: "0 12px", fontSize: 11, color: "var(--text-secondary)", flexShrink: 0, position: "relative" }}>
      {project && (
        <span title={project.root}>Project: <b style={{ color: "var(--text-primary)" }}>{fileNameOf(project.root)}</b></span>
      )}
      <span>Robot: <b style={{ color: "var(--text-primary)" }}>{robot || "unnamed"}</b>{dirty && " (unsaved)"}</span>
      {robotPath && (
        <button onClick={() => setWhere(w => !w)} title="Where Ares keeps each thing"
          style={{ border: "none", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
          <i className="ti ti-folder" /> Where things are
        </button>
      )}
      <span style={{ marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status}</span>
      {where && robotPath && <WherePanel robotPath={robotPath} onClose={() => setWhere(false)} />}
    </div>
  )
}

/** The robot project around an Ares project in its deploy folder. */
function projectOf(robotPath: string | null): { root: string; ares: string } | null {
  if (!robotPath) return null
  const norm = robotPath.replace(/\\/g, "/")
  const i = norm.indexOf("/src/main/deploy/ares/")
  if (i < 0) return null
  return { root: norm.slice(0, i), ares: norm.slice(0, i) + "/src/main/deploy/ares" }
}

function WherePanel({ robotPath, onClose }: { robotPath: string; onClose: () => void }) {
  const dir = robotPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "")
  const project = projectOf(robotPath)
  const rows: [string, string][] = [
    [fileNameOf(robotPath), "the robot (Robot tab)"],
    ["paths/", "every path you draw, one .path.json each (Paths tab)"],
    ["trajectories/", "what Generate solved, one .traj.json each: AresLib follows these"],
    ["autos/", "every auto, one .auto.json each (Autos tab)"],
    ["ares-index.json", "what AresLib reads first: paths, branches, variants, autos"],
    ["field.json", "keep-outs, slow zones and the navgrid (Paths and Field tabs)"],
    ["navgrid.json", "the navgrid in PathPlanner's format, for AresLib's pathfinder"],
    ["variables.json", "the project's variables (Variables tab)"],
    ["gains.json", "the gains and recovery Tune applied: AresLib uses them"],
    ["characterization.json", "what Measure found on the robot"],
    ["calibration.json", "the world Logs found the robot in, which Tune starts from"],
    ["tuning/", "every Tune run"],
  ]
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={onClose} />
      <div style={{ position: "absolute", left: 12, bottom: 30, zIndex: 41, width: 560, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "0 8px 22px rgba(0,0,0,0.18)", padding: "10px 14px", fontSize: 11.5, color: "var(--text-primary)" }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Where Ares keeps things</div>
        <div style={{ color: "var(--text-muted)", marginBottom: 8, wordBreak: "break-all" }}>
          {dir}{project ? " — inside the robot project's deploy folder, so a deploy carries all of it to the roboRIO." : " — not inside a robot project: File → Open project… sets Ares up in one."}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {rows.map(([f, what]) => (
              <tr key={f} style={{ borderTop: "1px solid var(--border-light)" }}>
                <td style={{ padding: "3px 10px 3px 0", fontFamily: "Consolas, monospace", whiteSpace: "nowrap" }}>{f}</td>
                <td style={{ color: "var(--text-secondary)" }}>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
