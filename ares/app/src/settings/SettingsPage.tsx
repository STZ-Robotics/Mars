import { ReactNode, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { useRobotNames } from "../autos/robotNames"
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

/** What is kept about the project: where its robot code is. */
function ProjectSection({ robotPath }: { robotPath: string }) {
  const { names, pickFolder } = useRobotNames(robotPath)
  return (
    <Section title="Project">
      <Row label="Robot code" hint="Where Ares reads the robot's command and condition names (and its gains). Found above the project, or picked by hand.">
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Mono>{names?.root ?? "not found"}</Mono>
          <button style={btn} onClick={pickFolder}><i className="ti ti-folder" /> Pick…</button>
        </span>
      </Row>
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
