import { ReactNode, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { CODE_KEY, useRobotNames } from "../autos/robotNames"
import { useVariables } from "../vars/context"
import { useField } from "../ui/field"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import { ProjectSettings, writeVarsJava } from "../vars/writeJava"
import { useToast } from "../ui/toasts"
import { useSettings } from "./settings"

// The Settings tab: how the app behaves on this computer, the robot it talks
// to, and what Ares keeps about the project.

export default function SettingsPage({ robotPath }: { robotPath: string | null }) {
  const [s, set] = useSettings()
  const toast = useToast()
  const [info, setInfo] = useState<{ version: string; areslib: string } | null>(null)
  useEffect(() => { invoke<{ version: string; areslib: string }>("app_info").then(setInfo).catch(() => {}) }, [])
  const [target, setTarget] = useState(() => { try { return localStorage.getItem("ares.ntTarget") ?? "sim" } catch { return "sim" } })
  const saveTarget = (v: string) => { setTarget(v); try { localStorage.setItem("ares.ntTarget", v.trim() || "sim") } catch { /* not remembered */ } }
  const prefs = (() => { try { return Object.keys(localStorage).filter(k => k.startsWith("ares.") && !KEEP.includes(k)) } catch { return [] } })()

  return (
    <div className="ares-scroll" style={{ flex: 1, overflowY: "auto", background: "var(--bg-page)" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "22px 24px 40px" }}>
        <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase" }}>Settings</div>
        <div style={{ fontSize: 20, fontWeight: 600, margin: "2px 0 18px" }}>Ares</div>

        <Section title="General">
          <Switch label="Open the last robot on start" hint="Off: the app starts with a new robot, or the one given on the command line."
            on={s.openLastRobot} onChange={v => set({ openLastRobot: v })} />
          <Switch label="Motion" hint="Menus, pages and panels move in. Off: everything just appears."
            on={s.motion} onChange={v => set({ motion: v })} />
        </Section>

        <Section title="Robot connection">
          <Row label="Robot" hint={'"sim" for the simulation on this computer, a team number (10.TE.AM.2), or an address (172.22.11.2 over USB). Live, Measure and hot reload use it.'}>
            <input style={{ ...propertyInputStyle, width: 180 }} value={target} onChange={e => saveTarget(e.target.value)} />
          </Row>
          <Switch label="Hot reload" hint="While connected, each path you generate and each auto you save goes to the robot at once, without a deploy (AresLib takes it unless a field is connected). It lasts until the robot restarts: deploy to keep it."
            on={s.hotReload} onChange={v => set({ hotReload: v })} />
        </Section>

        {robotPath && <ProjectSection robotPath={robotPath} />}

        <Section title="This computer">
          <Row label="Saved view preferences" hint="Panel sizes, open folders, the last tab and robot, chart choices: kept per computer. Resetting does not touch the project.">
            <button disabled={prefs.length === 0} style={btn}
              onClick={() => {
                if (!window.confirm(`Forget ${prefs.length} saved view preferences on this computer?`)) return
                prefs.forEach(k => { try { localStorage.removeItem(k) } catch { /* nothing */ } })
                toast({ kind: "info", title: "View preferences forgotten", body: "They come back as you use the app." })
              }}>
              <i className="ti ti-eraser" /> Reset ({prefs.length})
            </button>
          </Row>
        </Section>

        <Section title="About">
          <Row label="Ares"><Mono>{info?.version ?? "…"}</Mono></Row>
          <Row label="AresLib" hint="The MARS feature the robot code uses (ares/areslib)."><Mono>{info?.areslib ?? "…"}</Mono></Row>
          {robotPath && <Row label="Robot file"><Mono>{robotPath}</Mono></Row>}
        </Section>
      </div>
    </div>
  )
}

/** What is kept about the project: where its robot code is, and its variables as Java. */
function ProjectSection({ robotPath }: { robotPath: string }) {
  const { names, pickFolder } = useRobotNames(robotPath)
  const { variables } = useVariables()
  const field = useField()
  const toast = useToast()
  const [ps, setPs] = useState<ProjectSettings | null>(null)
  const [written, setWritten] = useState<string | null>(null)
  useEffect(() => { invoke<ProjectSettings>("project_settings_open", { robotPath }).then(setPs).catch(() => {}) }, [robotPath])
  const save = async (patch: Partial<ProjectSettings>, write: boolean) => {
    // The rest of project.json (the field) stays as it is on disk.
    const onDisk = await invoke<ProjectSettings>("project_settings_open", { robotPath }).catch(() => null)
    const next = { ...(onDisk ?? { varsJava: { enabled: false, file: "" } }), ...patch } as ProjectSettings
    setPs(next)
    await invoke("project_settings_save", { robotPath, settings: next }).catch(e => toast({ kind: "error", title: "Could not save project.json", body: String(e) }))
    if (write) {
      try { setWritten(await writeVarsJava(robotPath, variables, true)) } catch (e) { toast({ kind: "error", title: "Could not write the Java constants", body: String(e) }) }
    }
  }
  const defaultFile = async () => {
    let folder: string | null = null
    try { folder = localStorage.getItem(CODE_KEY(robotPath)) } catch { /* none */ }
    return (await invoke<string | null>("vars_java_default", { robotPath, folder }).catch(() => null)) ?? "src/main/java/frc/robot/generated/AresVars.java"
  }
  const vj = ps?.varsJava ?? { enabled: false, file: "" }
  return (
    <Section title="Project">
      <Row label="Robot code" hint="Where Ares reads the robot's command and condition names (and its gains). Found above the project, or picked by hand.">
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Mono>{names?.root ?? "not found"}</Mono>
          <button style={btn} onClick={pickFolder}><i className="ti ti-folder" /> Pick…</button>
        </span>
      </Row>
      <Row label="Field" hint={`The game the project plays: the picture and size everywhere in Ares, and the size and the red side's ${field.symmetry} symmetry on the robot (in ares-index.json). Paths generated for another field show as out of date.`}>
        <select style={{ ...propertyInputStyle, width: 240 }} value={field.field.key} onChange={e => field.choose(e.target.value)}>
          {FIELDS.map(f => <option key={f.key} value={f.key}>{f.game} · {f.sizeMeters[0].toFixed(2)} × {f.sizeMeters[1].toFixed(2)} m</option>)}
        </select>
      </Row>
      <Switch label="Variables in the robot code" hint={`The Variables tab as a Java class of constants (WPILib units, Pose2d), written again every time a variable changes. ${variables.length} variable${variables.length === 1 ? "" : "s"} now. Saved in project.json, for the whole team.`}
        on={vj.enabled} onChange={async on => save({ varsJava: { enabled: on, file: vj.file || (await defaultFile()) } }, on)} />
      {vj.enabled && (
        <Row label="The class" hint="Inside the robot project, under src/main/java: the package comes from the folder.">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input style={{ ...propertyInputStyle, width: 330, fontFamily: "Consolas, monospace", fontSize: 11 }} defaultValue={vj.file} key={vj.file}
              onBlur={e => { const f = e.target.value.trim(); if (f && f !== vj.file) save({ varsJava: { ...vj, file: f } }, true) }} />
            <button style={btn} onClick={() => save({ varsJava: vj }, true)}><i className="ti ti-file-code" /> Write now</button>
          </span>
        </Row>
      )}
      {vj.enabled && written && <div style={{ padding: "4px 14px 10px", fontSize: 11, color: "#16a34a" }}><i className="ti ti-circle-check" /> Written: <span style={{ fontFamily: "Consolas, monospace" }}>{written}</span></div>}
    </Section>
  )
}

/** Preferences that are settings themselves, not view state: a reset keeps them. */
const KEEP = ["ares.settings", "ares.ntTarget"]

const btn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, height: 26, padding: "0 10px", fontSize: 11.5, cursor: "pointer",
  border: "1px solid var(--btn-classic-border)", borderRadius: 2, background: "var(--btn-classic-bg)", color: "var(--text-primary)", whiteSpace: "nowrap",
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 18, border: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
      <div style={{ padding: "8px 14px", fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)", background: "var(--bg-panel-header)", borderBottom: "1px solid var(--border-main)" }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 14px", borderBottom: "1px solid var(--border-light)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0, maxWidth: "55%" }}>{children}</div>
    </div>
  )
}

function Switch({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} hint={hint}>
      <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
        style={{ width: 36, height: 20, borderRadius: 10, border: "none", padding: 2, cursor: "pointer", background: on ? "var(--ares-accent)" : "#c4c4c8", display: "flex" }}>
        <span style={{ width: 16, height: 16, borderRadius: 8, background: "#ffffff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transform: `translateX(${on ? 16 : 0}px)`, transition: "transform 160ms var(--ares-ease)" }} />
      </button>
    </Row>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", maxWidth: 360, verticalAlign: "middle" }} title={String(children)}>{children}</span>
}
