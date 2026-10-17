import { ReactNode, useEffect, useMemo, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open } from "@tauri-apps/plugin-dialog"
import type { RobotConfig } from "../robot/types"
import { RobotCode, RobotTuning, World, WORLD_VARS, nominalWorld, robotCode, fmt3 } from "../tune/model"
import FieldCanvas from "../ui/FieldCanvas"
import TimeChart from "../ui/TimeChart"
import { useToast } from "../ui/toasts"
import { BarButton } from "../ui/NtConnect"

// The Logs tab: a .wpilog from a real match or practice, the paths AresLib
// drove in it, and how each went: where the robot was against where it
// should have been, the speeds asked for against the speeds it had. And
// calibration: the world in which the simulator does what the robot did,
// which Tune then uses instead of the robot.json's.

type P3 = [number, number, number]
interface LoggedSample { t: number; robot: P3; target: P3 | null; commanded: P3 | null; measured: P3 | null; err: number }
interface LoggedRun {
  index: number; path: string; startS: number; durationS: number; maxErrM: number; meanErrM: number; replans: number
  translation: P3 | null; rotation: P3 | null; samples: LoggedSample[]; pathPoses: P3[]
}
interface LogInfo { name: string; durationS: number; topics: string[]; runs: LoggedRun[] }
interface Calibration { values: number[]; rmsBeforeM: number; rmsAfterM: number; world: World; history: number[]; track: P3[]; runs: number }
interface FitVar { key: keyof World; min: number; max: number; on: boolean }
/** calibration.json */
export interface CalibrationDoc { log: string; path: string; rmsBeforeM: number; rmsAfterM: number; values: Partial<World>; savedAt?: number }

const PATH = "#e95420"
const ROBOT = "#2f6fdb"
const SIM = "#2e9e5b"

/** What can be calibrated, and the range to look in around the robot.json's value. */
function fitVars(w: World): FitVar[] {
  return [
    { key: "massKg", min: w.massKg * 0.85, max: w.massKg * 1.2, on: true },
    { key: "mu", min: 0.6, max: 1.3, on: true },
    { key: "latencyS", min: 0, max: 0.12, on: true },
    { key: "motorScale", min: 0.85, max: 1.1, on: false },
    { key: "driveFrictionV", min: 0, max: 0.5, on: false },
    { key: "batteryROhm", min: 0.005, max: 0.04, on: false },
    { key: "wheelRadiusM", min: w.wheelRadiusM * 0.97, max: w.wheelRadiusM * 1.03, on: false },
    { key: "moiKgM2", min: w.moiKgM2 * 0.6, max: w.moiKgM2 * 1.6, on: false },
    { key: "steerTauS", min: 0.005, max: 0.06, on: false },
  ]
}
const info = (k: keyof World) => WORLD_VARS.find(v => v.key === k)
const label = (k: keyof World) => info(k)?.label ?? k
const shown = (k: keyof World, v: number) => {
  const i = info(k)
  return `${+(v * (i?.scale ?? 1)).toFixed(3)}${i?.unit ? ` ${i.unit}` : ""}`
}

export default function LogsPage({ robot, robotPath }: { robot: RobotConfig; robotPath: string | null }) {
  const toast = useToast()
  const [log, setLog] = useState<LogInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [run, setRun] = useState<LoggedRun | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [code, setCode] = useState<RobotCode>(() => robotCode(null))
  const nominal = useMemo(() => ({ ...nominalWorld(robot), visionHz: 0 }), [robot])
  const [vars, setVars] = useState<FitVar[]>(() => fitVars(nominal))
  const [generations, setGenerations] = useState(25)
  const [calibrating, setCalibrating] = useState<{ gen: number; rms: number } | null>(null)
  const [result, setResult] = useState<Calibration | null>(null)
  const [stored, setStored] = useState<CalibrationDoc | null>(null)

  useEffect(() => setVars(fitVars(nominal)), [nominal])
  useEffect(() => {
    if (!robotPath) return
    let folder: string | null = null
    try { folder = localStorage.getItem(`ares.robotCode:${robotPath}`) } catch { /* none */ }
    Promise.all([
      invoke<RobotTuning>("robot_tuning", { robotPath, folder }).catch(() => null),
      invoke<{ drive?: { kS: number; kV: number } } | null>("characterization_open", { robotPath }).catch(() => null),
    ]).then(([t, measured]) => {
      const c = robotCode(t)
      if (measured?.drive) { c.driveKs = measured.drive.kS; c.driveKv = measured.drive.kV }
      setCode(c)
    })
    invoke<CalibrationDoc | null>("calibration_open", { robotPath }).then(setStored).catch(() => {})
  }, [robotPath])
  useEffect(() => {
    const un = listen<[number, number]>("log-calibrate-progress", e => setCalibrating({ gen: e.payload[0], rms: e.payload[1] }))
    return () => { un.then(f => f()) }
  }, [])

  const openLog = async () => {
    const picked = await open({ multiple: false, title: "Open a robot log", filters: [{ name: "WPILib log", extensions: ["wpilog"] }] })
    if (typeof picked !== "string") return
    setLoading(true)
    try {
      const l = await invoke<LogInfo>("log_open", { path: picked })
      setLog(l)
      setRun(null)
      setResult(null)
      if (l.runs.length) pick(l.runs[0].index)
    } catch (e) {
      toast({ kind: "error", title: "Could not read the log", body: String(e) })
    } finally {
      setLoading(false)
    }
  }
  const pick = async (index: number) => {
    setResult(null)
    setCursor(null)
    setRun(await invoke<LoggedRun>("log_run", { index }))
  }
  const calibrate = async () => {
    if (!run || !robotPath) return
    setCalibrating({ gen: 0, rms: NaN })
    setResult(null)
    try {
      const fit = vars.filter(v => v.on).map(({ key, min, max }) => ({ key, min, max }))
      setResult(await invoke<Calibration>("log_calibrate", { robot, robotPath, index: run.index, code, world: nominal, vars: fit, generations }))
    } catch (e) {
      toast({ kind: "error", title: "Could not calibrate", body: String(e) })
    } finally {
      setCalibrating(null)
    }
  }
  const useInTune = async () => {
    if (!result || !run || !log || !robotPath) return
    const fitted = vars.filter(v => v.on)
    const doc: CalibrationDoc = {
      log: log.name, path: run.path, rmsBeforeM: result.rmsBeforeM, rmsAfterM: result.rmsAfterM,
      values: Object.fromEntries(fitted.map((v, i) => [v.key, result.values[i]])),
    }
    try {
      await invoke("calibration_save", { robotPath, doc })
      setStored(await invoke<CalibrationDoc | null>("calibration_open", { robotPath }))
      toast({ kind: "info", title: "Saved to calibration.json", body: "Tune centers its worlds on it." })
    } catch (e) {
      toast({ kind: "error", title: "Could not save it", body: String(e) })
    }
  }

  const rows = useMemo(() => (run?.samples ?? []).map(s => ({
    t: s.t,
    cmdV: s.commanded ? Math.hypot(s.commanded[0], s.commanded[1]) : NaN,
    measV: s.measured ? Math.hypot(s.measured[0], s.measured[1]) : NaN,
    cmdW: s.commanded?.[2] ?? NaN,
    measW: s.measured?.[2] ?? NaN,
    err: s.err,
  })), [run])
  const at = cursor !== null && run ? run.samples.reduce((a, b) => (Math.abs(b.t - cursor) < Math.abs(a.t - cursor) ? b : a), run.samples[0]) : null

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--bg-page)" }}>
      <div style={{ height: 40, flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "0 12px", borderBottom: "1px solid var(--border-main)", background: "var(--bg-panel)", fontSize: 12 }}>
        <BarButton icon="ti-folder-open" onClick={openLog}>{loading ? "Reading…" : "Open .wpilog…"}</BarButton>
        {log && <span><b>{log.name}</b> <span style={{ color: "var(--text-secondary)" }}>· {log.durationS.toFixed(0)} s · {log.runs.length} path{log.runs.length === 1 ? "" : "s"} driven by AresLib</span></span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ width: 230, flexShrink: 0, borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)", overflowY: "auto" }}>
          <Heading>Paths in the log</Heading>
          {!log && <Note>Open a log from the roboRIO (/home/lvuser/logs, or the USB stick). DataLogManager keeps what AresLib publishes under /Ares.</Note>}
          {log && log.topics.length === 0 && <Note>This log has nothing under /Ares: the robot was not running AresLib, or DataLogManager was not logging NetworkTables.</Note>}
          {log && log.topics.length > 0 && log.runs.length === 0 && <Note>AresLib was running, but no path was driven.</Note>}
          {log?.runs.map(r => (
            <div key={r.index} onClick={() => pick(r.index)}
              style={{ padding: "7px 12px", borderBottom: "1px solid var(--border-light)", cursor: "pointer", fontSize: 11.5, background: run?.index === r.index ? "var(--bg-selected, rgba(47,111,219,0.1))" : undefined }}>
              <div style={{ display: "flex" }}>
                <b>{r.path}</b>
                <span style={{ marginLeft: "auto", color: "var(--text-secondary)" }}>{fmtClock(r.startS)}</span>
              </div>
              <div style={{ color: "var(--text-secondary)", fontSize: 10.5, marginTop: 2 }}>
                {r.durationS.toFixed(2)} s · off at most {(r.maxErrM * 100).toFixed(1)} cm{r.replans ? ` · ${r.replans} replans` : ""}
              </div>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            <FieldCanvas deps={[run, result, at, robot]} draw={({ line, trail, bumper }) => {
              if (!run) return
              const xy = (p: P3) => ({ x: p[0], y: p[1], heading: p[2] })
              line(run.pathPoses.map(xy), "rgba(255,255,255,0.9)", 7)
              line(run.pathPoses.map(xy), PATH, 3)
              line(run.samples.filter(s => s.target).map(s => xy(s.target!)), PATH, 1.5, [4, 4])
              if (result) line(result.track.map(xy), SIM, 2.5, [7, 4])
              trail(run.samples.map(s => xy(s.robot)), ROBOT, 2.5)
              if (at) {
                if (at.target) bumper(xy(at.target), robot.bumper.lengthM, robot.bumper.widthM, PATH, null, [6, 4])
                bumper(xy(at.robot), robot.bumper.lengthM, robot.bumper.widthM, ROBOT, "rgba(47,111,219,0.28)")
              }
            }} />
            {run && (
              <div style={{ position: "absolute", left: 10, top: 10, background: "rgba(255,255,255,0.94)", border: "1px solid var(--border-main)", padding: "6px 10px", fontSize: 11, lineHeight: 1.6 }}>
                <div><span style={{ color: PATH }}>━</span> the path · <span style={{ color: PATH }}>┅</span> where it said to be</div>
                <div><span style={{ color: ROBOT }}>━</span> where the robot was</div>
                {result && <div><span style={{ color: SIM }}>╍</span> the simulator, calibrated</div>}
                <div style={{ color: "var(--text-muted)" }}>Click a chart to place the robot at that moment.</div>
              </div>
            )}
          </div>
          <div style={{ height: 190, flexShrink: 0, display: "flex", borderTop: "1px solid var(--border-main)" }}>
            <TimeChart title="Speed" unit="m/s" rows={rows} marker={cursor} onPick={setCursor} series={[["cmdV", PATH, "commanded"], ["measV", ROBOT, "actual"]]} />
            <TimeChart title="Turn rate" unit="rad/s" rows={rows} marker={cursor} onPick={setCursor} series={[["cmdW", PATH, "commanded"], ["measW", ROBOT, "actual"]]} symmetric />
            <TimeChart title="Off the trajectory" unit="m" rows={rows} marker={cursor} onPick={setCursor} series={[["err", ROBOT, "error"]]} />
          </div>
        </div>
        <div style={{ width: 300, flexShrink: 0, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)", overflowY: "auto", fontSize: 11.5 }}>
          <Heading>This run</Heading>
          {!run && <Note>Pick a path on the left.</Note>}
          {run && (
            <div style={{ padding: "6px 12px 10px", lineHeight: 1.7 }}>
              <Row k="Duration" v={`${run.durationS.toFixed(2)} s`} />
              <Row k="Off the trajectory, mean" v={`${(run.meanErrM * 100).toFixed(1)} cm`} />
              <Row k="…at most" v={`${(run.maxErrM * 100).toFixed(1)} cm`} />
              <Row k="Replans" v={String(run.replans)} />
              <Row k="Translation kP / kD" v={run.translation ? `${fmt3(run.translation[0])} / ${fmt3(run.translation[2])}` : "not in the log"} />
              <Row k="Rotation kP / kD" v={run.rotation ? `${fmt3(run.rotation[0])} / ${fmt3(run.rotation[2])}` : "not in the log"} />
            </div>
          )}
          <Heading>Calibrate the simulator</Heading>
          <Note>Finds the values for which the simulator, running this path with these gains, drives where the robot drove.</Note>
          <div style={{ padding: "0 12px" }}>
            {vars.map((v, i) => {
              const sc = info(v.key)?.scale ?? 1
              const set = (p: Partial<FitVar>) => setVars(vs => vs.map((x, j) => (j === i ? { ...x, ...p } : x)))
              return (
                <div key={v.key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
                  <input type="checkbox" checked={v.on} onChange={e => set({ on: e.target.checked })} />
                  <span style={{ flex: 1, color: v.on ? "var(--text-primary)" : "var(--text-muted)" }}>{label(v.key)}</span>
                  <NumIn value={v.min * sc} onChange={x => set({ min: x / sc })} disabled={!v.on} />
                  <span style={{ color: "var(--text-muted)" }}>–</span>
                  <NumIn value={v.max * sc} onChange={x => set({ max: x / sc })} disabled={!v.on} />
                  <span style={{ width: 34, color: "var(--text-muted)", fontSize: 10 }}>{info(v.key)?.unit}</span>
                </div>
              )
            })}
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 0" }}>
              <span style={{ flex: 1 }}>Generations</span>
              <NumIn value={generations} onChange={x => setGenerations(Math.max(1, Math.round(x)))} />
            </div>
            {calibrating
              ? <button onClick={() => invoke("log_calibrate_cancel")} style={buttonStyle}>
                  Stop · generation {calibrating.gen}/{generations}{Number.isFinite(calibrating.rms) ? ` · ${(calibrating.rms * 100).toFixed(1)} cm` : ""}
                </button>
              : <button disabled={!run || !robotPath || !vars.some(v => v.on)} onClick={calibrate} style={buttonStyle}>Calibrate on this run</button>}
          </div>
          {result && (
            <div style={{ padding: "10px 12px" }}>
              <div style={{ marginBottom: 6 }}>
                Simulator vs. robot: <b>{(result.rmsBeforeM * 100).toFixed(1)} cm</b> → <b style={{ color: SIM }}>{(result.rmsAfterM * 100).toFixed(1)} cm</b> RMS
                <span style={{ color: "var(--text-muted)" }}> ({result.runs} simulations)</span>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead><tr style={{ color: "var(--text-secondary)", textAlign: "right" }}><th style={{ textAlign: "left", fontWeight: 500 }}></th><th style={{ fontWeight: 500 }}>robot.json</th><th style={{ fontWeight: 500 }}>found</th></tr></thead>
                <tbody>
                  {vars.filter(v => v.on).map((v, i) => (
                    <tr key={v.key} style={{ borderTop: "1px solid var(--border-light)" }}>
                      <td style={{ padding: "3px 0" }}>{label(v.key)}</td>
                      <td style={{ textAlign: "right", fontFamily: "Consolas, monospace" }}>{shown(v.key, nominal[v.key] as number)}</td>
                      <td style={{ textAlign: "right", fontFamily: "Consolas, monospace", fontWeight: 600 }}>{shown(v.key, result.values[i])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.rmsAfterM > 0.1 && <div style={{ marginTop: 6, color: "#a15c00" }}>Still {(result.rmsAfterM * 100).toFixed(0)} cm off: something the simulator does not model (a collision, a wheel off the ground, a different trajectory than this project's).</div>}
              <div style={{ marginTop: 6, color: "var(--text-muted)" }}>Mass and grip both limit how hard the robot can accelerate, so one can stand in for the other: check that the values are reasonable.</div>
              <button onClick={useInTune} style={{ ...buttonStyle, marginTop: 8 }}>Use in Tune</button>
            </div>
          )}
          {stored && (
            <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-light)", color: "var(--text-secondary)", lineHeight: 1.5 }}>
              <b>In use by Tune</b> (calibration.json): {stored.path} in {stored.log}, {(stored.rmsAfterM * 100).toFixed(1)} cm RMS.
              <div>{Object.entries(stored.values).map(([k, v]) => `${label(k as keyof World)} ${shown(k as keyof World, v as number)}`).join(" · ")}</div>
              <a href="#" style={{ color: "#c21c1c" }} onClick={async e => {
                e.preventDefault()
                if (!robotPath || !window.confirm("Remove calibration.json? Tune goes back to the robot.json's values.")) return
                await invoke("calibration_delete", { robotPath }).catch(err => toast({ kind: "error", title: "Could not remove it", body: String(err) }))
                setStored(null)
              }}>Remove</a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const buttonStyle: React.CSSProperties = {
  width: "100%", height: 30, border: "1px solid var(--border-dark)", background: "var(--bg-page)", cursor: "pointer", fontSize: 12, fontWeight: 600,
}

function fmtClock(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(0).padStart(2, "0")}`
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 12px", background: "var(--bg-panel-header)", borderBottom: "1px solid var(--border-main)", fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)" }}>
      {children}
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.45 }}>{children}</div>
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex" }}>
      <span style={{ color: "var(--text-secondary)", flex: 1 }}>{k}</span>
      <span style={{ fontFamily: "Consolas, monospace" }}>{v}</span>
    </div>
  )
}

function NumIn({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(String(+value.toFixed(4)))
  useEffect(() => setText(String(+value.toFixed(4))), [value])
  return (
    <input value={text} disabled={disabled} onChange={e => setText(e.target.value)}
      onBlur={() => { const x = parseFloat(text); if (Number.isFinite(x)) onChange(x); else setText(String(+value.toFixed(4))) }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }}
      style={{ width: 52, height: 22, fontSize: 11, textAlign: "right", border: "1px solid var(--border-main)", background: "var(--bg-page)", padding: "0 4px" }} />
  )
}
