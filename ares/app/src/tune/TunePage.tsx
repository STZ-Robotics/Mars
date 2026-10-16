import { ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import type { PathEntry, Trajectory } from "../paths/types"
import { drawFieldBackground } from "../paths/FieldView"
import { fieldSketch } from "../paths/fieldSketch"
import { loadView } from "../paths/PathsPage"
import { Toggle } from "../ui/controls"
import { useToast } from "../ui/toasts"
import { BEST, PopulationChart, TrainingChart, WorldsChart } from "./charts"
import {
  Criterion, Method, PARAM_INFO, Param, Progress, RobotCode, RobotTuning, TuneConfig, WORLD_VARS, World,
  defaultParams, gripUsed, javaSnippet, nominalWorld, robotCode,
} from "./model"

// The Tune tab: the gains that follow your paths best, found by simulating
// the robot against many worlds (heavier, slicker, a tired battery, worn
// wheels, placed a little off...) and keeping what holds up in the worst of
// them. The simulator is ares-tune: Ares's physics, with the robot code's
// own control loops (AresLib's path PID with the wheel forces, and the
// TalonFX velocity loop from TunerConstants), at 1 kHz.

const SIDEBAR = 370

export default function TunePage({ robot, robotPath }: { robot: RobotConfig; robotPath: string | null }) {
  if (!robotPath) {
    return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>Open a robot to tune it.</div>
  }
  return <Tuner robot={robot} robotPath={robotPath} />
}

function Tuner({ robot, robotPath }: { robot: RobotConfig; robotPath: string }) {
  const toast = useToast()
  const [paths, setPaths] = useState<string[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [trajs, setTrajs] = useState<Record<string, Trajectory>>({})
  const [tuning, setTuning] = useState<RobotTuning | null>(null)
  const [code, setCode] = useState<RobotCode>(() => robotCode(null))
  const [params, setParams] = useState<Param[]>(() => defaultParams(robotCode(null)))
  const [world, setWorld] = useState<World>(() => nominalWorld(robot))
  const [vary, setVary] = useState<Record<string, number>>(() => Object.fromEntries(WORLD_VARS.filter(v => v.on).map(v => [v.key, v.spread])))
  const [environments, setEnvironments] = useState(24)
  const [method, setMethod] = useState<Method>({ kind: "population", generations: 40, population: 32 })
  const [criterion, setCriterion] = useState<Criterion>("worst")
  const [abortM, setAbortM] = useState(0.5)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [tracks, setTracks] = useState<Progress["tracks"]>([])
  const [baseTracks, setBaseTracks] = useState<Progress["tracks"]>([])
  const [showBase, setShowBase] = useState(false)
  const [hoverWorld, setHoverWorld] = useState<number | null>(null)
  const [ranWith, setRanWith] = useState<{ params: Param[]; paths: string[] } | null>(null)

  // The paths with a trajectory, and what the robot code has now.
  useEffect(() => {
    invoke<PathEntry[]>("paths_list", { robotPath }).then(async list => {
      const names = list.flatMap(e => (e.spec ? [e.spec.name] : []))
      const loaded: Record<string, Trajectory> = {}
      await Promise.all(names.map(async n => {
        const t = await invoke<Trajectory | null>("trajectory_open", { robotPath, name: n }).catch(() => null)
        if (t) loaded[n] = t
      }))
      setTrajs(loaded)
      setPaths(names.filter(n => loaded[n]))
      setChosen(c => (c.length ? c.filter(n => loaded[n]) : names.filter(n => loaded[n]).slice(0, 1)))
    })
    let folder: string | null = null
    try { folder = localStorage.getItem(`ares.robotCode:${robotPath}`) } catch { /* none */ }
    invoke<RobotTuning>("robot_tuning", { robotPath, folder }).then(t => {
      setTuning(t)
      const c = robotCode(t)
      setCode(c)
      setParams(defaultParams(c))
      if (t.driveFrictionV !== null) setWorld(w => ({ ...w, driveFrictionV: t.driveFrictionV! }))
    }).catch(() => {})
  }, [robotPath])
  useEffect(() => setWorld(w => ({ ...nominalWorld(robot), latencyS: w.latencyS, driveFrictionV: w.driveFrictionV })), [robot])

  // Progress, as the search sends it.
  useEffect(() => {
    const un = listen<Progress>("tune-progress", e => {
      const p = e.payload
      setProgress(p)
      if (p.baselineTracks.length) setBaseTracks(p.baselineTracks)
      if (p.tracks.length) setTracks(p.tracks)
      if (p.done) {
        setRunning(false)
        const gain = p.baseline.score > 0 ? (1 - p.best.score / p.baseline.score) * 100 : 0
        toast(p.cancelled
          ? { kind: "stopped", title: "Tuning stopped", body: `Best so far: ${gain.toFixed(0)}% better than the gains now, after ${p.runs.toLocaleString()} runs.` }
          : { kind: "success", title: `Tuned: ${gain.toFixed(0)}% better in the ${criterion === "worst" ? "worst world" : criterion === "mean" ? "average world" : "90th-percentile world"}`, body: `${p.runs.toLocaleString()} runs in ${p.elapsedS.toFixed(1)} s. Saved in tuning/.` })
      }
    })
    return () => { un.then(f => f()) }
  }, [criterion])

  const start = async () => {
    if (running) { invoke("tune_cancel"); return }
    const config: TuneConfig = {
      code, params, world, vary, environments, method, criterion,
      sim: { abortM, settleS: 0.5, record: false }, seed: 2026,
    }
    setProgress(null)
    setTracks([])
    setBaseTracks([])
    setRanWith({ params, paths: chosen })
    try {
      setRunning(true)
      await invoke("tune_start", { robot, robotPath, paths: chosen, config })
    } catch (e) {
      setRunning(false)
      toast({ kind: "error", title: "Could not start tuning", body: String(e) })
    }
  }

  const best = progress?.best ?? null
  const baseline = progress?.baseline ?? null
  const shownParams = ranWith?.params ?? params
  const margins = chosen.map(n => ({ name: n, grip: trajs[n] ? gripUsed(trajs[n].samples) : 0 }))
  const tight = margins.filter(m => m.grip > 0.95)
  const tunedCount = params.filter(p => p.tune).length
  const totalRuns = method.kind === "grid"
    ? Math.pow(Math.max(2, method.steps), tunedCount) * environments * Math.max(1, chosen.length)
    : method.generations * method.population * environments * Math.max(1, chosen.length)

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div className="ares-scroll" style={{ width: SIDEBAR, flexShrink: 0, overflowY: "auto", borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--border-light)" }}>
          <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4 }}>Tune</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Gains that hold up</div>
          <div style={{ fontSize: 10.5, color: "var(--text-header-subtitle)", marginTop: 5, lineHeight: 1.45 }}>
            The robot is simulated on your paths in many worlds, with its own code's loops, and the search keeps the gains that do best where it goes worst.
          </div>
        </div>

        <Heading label="Paths" />
        {paths.length === 0 && <Note>No generated paths yet: generate one in Paths.</Note>}
        {paths.map(n => {
          const g = trajs[n] ? gripUsed(trajs[n].samples) : 0
          return (
            <label key={n} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px", fontSize: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={chosen.includes(n)} onChange={e => setChosen(c => (e.target.checked ? [...c, n] : c.filter(x => x !== n)))} />
              <span style={{ flex: 1 }}>{n}</span>
              <span title="The most grip any wheel uses along it: near 100% the feedback has nothing left to correct with"
                style={{ fontSize: 10, fontFamily: "Consolas, monospace", color: g > 0.95 ? "#b45309" : "var(--text-muted)" }}>
                {(g * 100).toFixed(0)}% grip
              </span>
            </label>
          )
        })}
        {tight.length > 0 && (
          <Note warn>
            {tight.map(t => t.name).join(", ")} use{tight.length === 1 ? "s" : ""} all the grip: any correction makes a wheel slip and the odometry drift, whatever the gains.
            Plan with margin (a lower wheel grip or max speed in Robot) and the gains have room to work.
          </Note>
        )}

        <Heading label="Gains" />
        <div style={{ padding: "4px 12px 2px", fontSize: 10, color: "var(--text-muted)" }}>
          {tuning?.file ? <>From the robot code: <span title={tuning.file}>{tuning.file.split(/[\\/]/).pop()}</span>. </> : "Robot code not found: Tuner X's defaults. "}
          Checked gains are searched between min and max; the rest stay at their value.
        </div>
        {(["Path controller (AresLib)", "Drive motor (TunerConstants)"] as const).map(group => (
          <div key={group}>
            <div style={{ padding: "6px 12px 2px", fontSize: 10, fontWeight: 700, color: "var(--text-header-eyebrow)" }}>{group}</div>
            {params.map((p, i) => PARAM_INFO[p.key].group !== group ? null : (
              <div key={p.key} title={PARAM_INFO[p.key].hint} style={{ display: "grid", gridTemplateColumns: "18px 1fr 52px 52px 52px", gap: 4, alignItems: "center", padding: "2px 12px", fontSize: 11.5 }}>
                <input type="checkbox" checked={p.tune} onChange={e => setParams(ps => ps.map((q, j) => (j === i ? { ...q, tune: e.target.checked } : q)))} />
                <span>{PARAM_INFO[p.key].label}</span>
                <Num value={p.start} title="Now (where the search starts)" onChange={v => setParams(ps => ps.map((q, j) => (j === i ? { ...q, start: v } : q)))} />
                <Num value={p.min} title="Min" dim={!p.tune} onChange={v => setParams(ps => ps.map((q, j) => (j === i ? { ...q, min: v } : q)))} />
                <Num value={p.max} title="Max" dim={!p.tune} onChange={v => setParams(ps => ps.map((q, j) => (j === i ? { ...q, max: v } : q)))} />
              </div>
            ))}
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "18px 1fr 52px 52px 52px", gap: 4, padding: "0 12px", fontSize: 9.5, color: "var(--text-muted)" }}>
          <span /><span /><span>now</span><span>min</span><span>max</span>
        </div>
        <label title="AresLib feeds each wheel's force from the trajectory forward. Off: speeds only, as a PathPlanner robot that drops its feedforwards"
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 11.5 }}>
          <input type="checkbox" checked={code.forceFf} onChange={e => setCode(c => ({ ...c, forceFf: e.target.checked }))} /> Feed the wheel forces forward (AresLib)
        </label>

        <Heading label="Worlds" />
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 11.5 }}>
          <span style={{ flex: 1 }} title="The nominal world, and the rest sampled so every range is covered (a Latin hypercube)">How many</span>
          <Num value={environments} onChange={v => setEnvironments(Math.max(1, Math.min(256, Math.round(v))))} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "18px 1fr 60px 14px 52px 38px", gap: 4, padding: "0 12px", fontSize: 9.5, color: "var(--text-muted)" }}>
          <span /><span /><span>nominal</span><span /><span>±</span><span />
        </div>
        {WORLD_VARS.map(v => {
          const on = vary[v.key] !== undefined
          return (
            <div key={v.key} title={v.hint} style={{ display: "grid", gridTemplateColumns: "18px 1fr 60px 14px 52px 38px", gap: 4, alignItems: "center", padding: "2px 12px", fontSize: 11.5 }}>
              <input type="checkbox" checked={on} onChange={e => setVary(m => { const n = { ...m }; if (e.target.checked) n[v.key] = v.spread; else delete n[v.key]; return n })} />
              <span>{v.label}</span>
              <Num value={+((world[v.key] as number) * v.scale).toFixed(4)} onChange={x => setWorld(w => ({ ...w, [v.key]: x / v.scale }))} />
              <span style={{ textAlign: "center", color: "var(--text-muted)" }}>±</span>
              <Num value={+((vary[v.key] ?? v.spread) * v.scale).toFixed(4)} dim={!on} onChange={x => setVary(m => ({ ...m, [v.key]: x / v.scale }))} />
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{v.unit}</span>
            </div>
          )
        })}
        <label title="The code steers by its wheel encoders and gyro, so a slipping wheel misleads it. On: it knows exactly where it is (as with perfect vision)"
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 11.5 }}>
          <input type="checkbox" checked={world.perfectOdometry} onChange={e => setWorld(w => ({ ...w, perfectOdometry: e.target.checked }))} /> Perfect odometry
        </label>

        <Heading label="Search" />
        <Row label="Method" hint="Population: a cloud of gain sets that moves toward the best each generation (cross-entropy). Grid: every combination, like the Python tuner.">
          <select style={{ ...propertyInputStyle, width: 150 }} value={method.kind}
            onChange={e => setMethod(e.target.value === "grid" ? { kind: "grid", steps: 6 } : { kind: "population", generations: 40, population: 32 })}>
            <option value="population">Population (learns)</option>
            <option value="grid">Grid (every combination)</option>
          </select>
        </Row>
        {method.kind === "population" ? (
          <>
            <Row label="Generations"><Num value={method.generations} onChange={v => setMethod({ ...method, generations: Math.max(1, Math.round(v)) })} /></Row>
            <Row label="Population"><Num value={method.population} onChange={v => setMethod({ ...method, population: Math.max(4, Math.round(v)) })} /></Row>
          </>
        ) : (
          <Row label="Values per gain"><Num value={method.steps} onChange={v => setMethod({ kind: "grid", steps: Math.max(2, Math.round(v)) })} /></Row>
        )}
        <Row label="Judge by" hint="Worst: the gains that never go badly (minimax, like the Python tuner). Mean: best on average. 90th percentile: the worst minus the outliers.">
          <select style={{ ...propertyInputStyle, width: 150 }} value={criterion} onChange={e => setCriterion(e.target.value as Criterion)}>
            <option value="worst">the worst world</option>
            <option value="p90">the 90th percentile</option>
            <option value="mean">the average world</option>
          </select>
        </Row>
        <Row label="Lost the path at" hint="Off the trajectory by more than this, a run counts as lost (PathFollowingTuner's abort)"><Num value={abortM} onChange={setAbortM} /> m</Row>
        <Note>About {totalRuns.toLocaleString()} runs, at several thousand a second.</Note>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "0 10px", background: "var(--bg-menubar)", borderBottom: "1px solid var(--border-main)" }}>
          <button onClick={start} disabled={!running && chosen.length === 0}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${running ? "#a81818" : "#c2410c"}`, borderRadius: 2, background: running ? "#c21c1c" : "#e95420", color: "#fff", opacity: !running && chosen.length === 0 ? 0.5 : 1 }}>
            <i className={`ti ${running ? "ti-player-stop" : "ti-player-play"}`} /> {running ? "Stop" : "Tune"}
          </button>
          {progress && (
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              {progress.done ? (progress.cancelled ? "Stopped" : "Done") : "Generation"} {progress.generation}/{progress.generations} · {progress.runs.toLocaleString()} runs · {progress.elapsedS.toFixed(1)} s
            </span>
          )}
          {best && baseline && (
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 11.5 }}>
              <span title="The score: meters equivalent (rms + ¼·max + final + 0.15·heading), lower is better">
                now <b>{baseline.score.toFixed(3)}</b> → best <b style={{ color: BEST }}>{best.score.toFixed(3)}</b>
                {baseline.score > 0 && <span style={{ color: "#16a34a", fontWeight: 600 }}> ({((1 - best.score / baseline.score) * 100).toFixed(0)}% better)</span>}
              </span>
              <span title="Copy the gains as Java"><Toggle on={false} icon="ti-copy" label="Java" onClick={() => {
                navigator.clipboard?.writeText(javaSnippet(shownParams, best.values))
                toast({ kind: "info", title: "Copied the gains as Java", body: "Paste them into the Ares.Config in the robot code." })
              }} /></span>
              <span title="Make the best gains the starting point (the next run starts from them)"><Toggle on={false} icon="ti-check" label="Use as now" onClick={() => {
                setParams(ps => ps.map((p, i) => ({ ...p, start: best.values[i] ?? p.start })))
                toast({ kind: "info", title: "The best gains are now the starting point" })
              }} /></span>
            </span>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <TuneField robot={robot} trajs={(ranWith?.paths ?? chosen).map(n => trajs[n]).filter(Boolean)} tracks={tracks} baseTracks={showBase ? baseTracks : []} hoverWorld={hoverWorld} />
          {(tracks.length > 0) && (
            <div style={{ position: "absolute", left: 10, top: 10, background: "rgba(255,255,255,0.94)", border: "1px solid var(--border-main)", padding: "6px 10px", fontSize: 11, lineHeight: 1.6 }}>
              <div><span style={{ color: "#1c1c1f" }}>━</span> the trajectory</div>
              <div><span style={{ color: "#2f6fdb" }}>━</span> the robot with the best gains, one line per world (darker: worse)</div>
              <div><span style={{ color: BEST }}>━</span> its worst world</div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={showBase} onChange={e => setShowBase(e.target.checked)} /> <span style={{ color: "#71717a" }}>┅</span> with the gains now
              </label>
            </div>
          )}
          {best && (
            <ResultCard params={shownParams} best={best} baseline={baseline} />
          )}
        </div>
        <div style={{ height: 200, flexShrink: 0, display: "flex", borderTop: "1px solid var(--border-main)", background: "var(--bg-page)" }}>
          {progress ? (
            <>
              <TrainingChart history={progress.history} baseline={baseline?.score ?? null} />
              <WorldsChart best={best} baseline={baseline} worlds={progress.worlds} hovered={hoverWorld} onHover={setHoverWorld} />
              <PopulationChart population={progress.population} best={best} params={shownParams} />
            </>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
              Pick paths and press Tune: the training shows here as it goes.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ResultCard({ params, best, baseline }: { params: Param[]; best: NonNullable<Progress["best"]>; baseline: Progress["baseline"] | null }) {
  return (
    <div style={{ position: "absolute", right: 10, top: 10, width: 260, background: "rgba(255,255,255,0.96)", border: "1px solid var(--border-main)", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", fontSize: 11.5 }}>
      <div style={{ padding: "6px 10px", fontWeight: 600, borderBottom: "1px solid var(--border-light)" }}>Best gains</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ color: "var(--text-muted)", fontSize: 10 }}><th style={{ textAlign: "left", padding: "3px 10px", fontWeight: 400 }}></th><th style={{ textAlign: "right", fontWeight: 400 }}>now</th><th style={{ textAlign: "right", padding: "0 10px", fontWeight: 400 }}>best</th></tr></thead>
        <tbody>
          {params.map((p, i) => (p.tune || (baseline && baseline.values[i] !== best.values[i])) && (
            <tr key={p.key}>
              <td style={{ padding: "2px 10px" }}>{PARAM_INFO[p.key].label}</td>
              <td style={{ textAlign: "right", fontFamily: "Consolas, monospace", color: "var(--text-muted)" }}>{baseline?.values[i]?.toFixed(3)}</td>
              <td style={{ textAlign: "right", padding: "0 10px", fontFamily: "Consolas, monospace", fontWeight: 600 }}>{best.values[i]?.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: "6px 10px", borderTop: "1px solid var(--border-light)", color: "var(--text-secondary)", lineHeight: 1.5 }}>
        Off the path: {(best.meanRmsM * 100).toFixed(1)} cm on average{baseline ? ` (now ${(baseline.meanRmsM * 100).toFixed(1)})` : ""}<br />
        Worst end: {(best.worstFinalM * 100).toFixed(1)} cm{baseline ? ` (now ${(baseline.worstFinalM * 100).toFixed(1)})` : ""}<br />
        {best.aborts > 0 ? <span style={{ color: "#b45309" }}>Lost the path in {best.aborts} run{best.aborts === 1 ? "" : "s"}</span> : "Never lost the path"}
      </div>
    </div>
  )
}

/** The field: the trajectories, and the robot's true paths in every world. */
function TuneField({ robot, trajs, tracks, baseTracks, hoverWorld }: {
  robot: RobotConfig; trajs: Trajectory[]; tracks: Progress["tracks"]; baseTracks: Progress["tracks"]; hoverWorld: number | null
}) {
  const field = FIELDS[0]
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [sketch, setSketch] = useState<HTMLCanvasElement | null>(null)
  const view = useMemo(() => loadView(), [])
  const [L, W] = field.sizeMeters
  useEffect(() => {
    const img = new Image()
    img.onload = () => { setImage(img); fieldSketch(img).then(setSketch) }
    img.src = field.imageUrl
  }, [field.imageUrl])
  useEffect(() => {
    const el = host.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const c = canvas.current
    if (!c || size.w === 0) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr
    c.height = size.h * dpr
    const ctx = c.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Fit what is drawn, not the whole field: the error is centimeters.
    const xs = trajs.flatMap(t => t.samples.map(s => s.x)), ys = trajs.flatMap(t => t.samples.map(s => s.y))
    const margin = 1.2
    const [bx0, bx1, by0, by1] = xs.length
      ? [Math.min(...xs) - margin, Math.max(...xs) + margin, Math.min(...ys) - margin, Math.max(...ys) + margin]
      : [0, L, 0, W]
    const k = Math.min((size.w - 40) / (bx1 - bx0), (size.h - 40) / (by1 - by0))
    const ox = (size.w - (bx1 - bx0) * k) / 2 - bx0 * k, oy = (size.h + (by1 - by0) * k) / 2 + by0 * k
    const toScreen = (x: number, y: number): [number, number] => [ox + x * k, oy - y * k]
    drawFieldBackground(ctx, size, toScreen, k, field, image, sketch, view)

    const path = (pts: [number, number][]) => {
      ctx.beginPath()
      pts.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy) })
      ctx.stroke()
    }
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    // The trajectories, under everything.
    for (const t of trajs) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 6
      path(t.samples.map(s => [s.x, s.y]))
      ctx.strokeStyle = "#1c1c1f"; ctx.lineWidth = 2
      path(t.samples.map(s => [s.x, s.y]))
    }
    for (const tr of baseTracks) {
      ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(113,113,122,0.7)"; ctx.lineWidth = 1.5
      path(tr.points.map(p => [p[0], p[1]]))
      ctx.setLineDash([])
    }
    if (tracks.length) {
      const costs = tracks.map(t => t.cost)
      const lo = Math.min(...costs), hi = Math.max(...costs)
      const worst = tracks.reduce((a, b) => (b.cost > a.cost ? b : a))
      for (const tr of tracks) {
        if (tr === worst) continue
        const f = hi > lo ? (tr.cost - lo) / (hi - lo) : 0
        const dim = hoverWorld !== null && tr.env !== hoverWorld
        ctx.strokeStyle = `hsl(217 70% ${72 - f * 40}% / ${dim ? 0.15 : 0.85})`
        ctx.lineWidth = hoverWorld === tr.env ? 3 : 1.5
        path(tr.points.map(p => [p[0], p[1]]))
      }
      ctx.strokeStyle = BEST
      ctx.lineWidth = hoverWorld === null || hoverWorld === worst.env ? 2.5 : 1.5
      path(worst.points.map(p => [p[0], p[1]]))
      const end = worst.points[worst.points.length - 1]
      if (end) {
        const [sx, sy] = toScreen(end[0], end[1])
        ctx.font = "600 11px 'Segoe UI', Arial, sans-serif"
        const text = `worst: world ${worst.env}${worst.aborted ? ", lost the path" : ""}`
        ctx.fillStyle = "rgba(255,255,255,0.92)"
        ctx.fillRect(sx + 6, sy - 9, ctx.measureText(text).width + 8, 16)
        ctx.fillStyle = "#1c1c1f"
        ctx.fillText(text, sx + 10, sy + 3)
      }
      // The robot at the end of each world, as a footprint.
      const hl = robot.bumper.lengthM / 2 * k, hw = robot.bumper.widthM / 2 * k
      for (const tr of hoverWorld !== null ? tracks.filter(t => t.env === hoverWorld) : [worst]) {
        const p = tr.points[tr.points.length - 1]
        if (!p) continue
        const [cx, cy] = toScreen(p[0], p[1])
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(-p[2])
        ctx.strokeStyle = tr === worst ? BEST : "#2f6fdb"
        ctx.lineWidth = 2
        ctx.strokeRect(-hl, -hw, 2 * hl, 2 * hw)
        ctx.restore()
      }
    }
  }, [size, image, sketch, trajs, tracks, baseTracks, hoverWorld, view, robot])
  return (
    <div ref={host} style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  )
}

function Heading({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 12px", marginTop: 6, background: "var(--bg-panel-header)", borderTop: "1px solid var(--border-main)", borderBottom: "1px solid var(--border-main)" }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)" }}>{label}</span>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div title={hint} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", fontSize: 11.5 }}>
      <span style={{ flex: 1 }}>{label}</span>{children}
    </div>
  )
}

function Note({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <div style={{ padding: "6px 12px", fontSize: 10.5, lineHeight: 1.5, color: warn ? "#b45309" : "var(--text-muted)" }}>{warn && <i className="ti ti-alert-triangle" />} {children}</div>
}

function Num({ value, onChange, title, dim }: { value: number; onChange: (v: number) => void; title?: string; dim?: boolean }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <input title={title} style={{ ...propertyInputStyle, width: "100%", minWidth: 0, fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11, opacity: dim ? 0.45 : 1 }}
      value={text} onChange={e => setText(e.target.value)}
      onBlur={() => { const v = Number(text); if (Number.isFinite(v)) onChange(v); else setText(String(value)) }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
  )
}
