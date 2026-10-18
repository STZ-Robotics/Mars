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
import { useToast } from "../ui/toasts"
import SwerveIcon from "../ui/SwerveIcon"
import { copyText } from "../ui/copyText"
import type { CalibrationDoc } from "../logs/LogsPage"
import { BEST, PopulationChart, TrainingChart, WorldsChart } from "./charts"
import {
  AppliedGains, Criterion, DISTURBANCE_PRESETS, Disturbance, Method, PARAM_GROUPS, PARAM_INFO, Param, Progress, RobotCode, RobotTuning, SavedRun, TuneConfig, WORLD_VARS, World,
  appliedGains, defaultParams, findings, fmt3, gripUsed, javaSnippet, nominalWorld, robotCode,
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
  const [measuredDrive, setMeasuredDrive] = useState<{ kS: number; kV: number } | null>(null)
  const [code, setCode] = useState<RobotCode>(() => robotCode(null))
  const [params, setParams] = useState<Param[]>(() => defaultParams(robotCode(null)))
  const [world, setWorld] = useState<World>(() => nominalWorld(robot))
  const [vary, setVary] = useState<Record<string, number>>(() => Object.fromEntries(WORLD_VARS.filter(v => v.on).map(v => [v.key, v.spread])))
  const [environments, setEnvironments] = useState(24)
  const [method, setMethod] = useState<Method>({ kind: "population", generations: 40, population: 32 })
  const [criterion, setCriterion] = useState<Criterion>("worst")
  const [abortM, setAbortM] = useState(0.5)
  // Shoves: off, or one of the presets (then editable).
  const [disturbance, setDisturbance] = useState<Disturbance | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [tracks, setTracks] = useState<Progress["tracks"]>([])
  const [baseTracks, setBaseTracks] = useState<Progress["tracks"]>([])
  const [showBase, setShowBase] = useState(false)
  const [hoverWorld, setHoverWorld] = useState<number | null>(null)
  // Every gain set tried in this run, for the population cloud.
  const [cloud, setCloud] = useState<{ gen: number; c: Progress["best"] }[]>([])
  const [ranWith, setRanWith] = useState<{ params: Param[]; paths: string[]; forceFf: boolean; disturbance: Disturbance | null } | null>(null)
  // What the robot runs with (gains.json), and the runs kept in tuning/.
  const [applied, setApplied] = useState<AppliedGains | null>(null)
  const [saved, setSaved] = useState<SavedRun[]>([])
  const [viewingSaved, setViewingSaved] = useState<number | null>(null)
  const refreshSaved = () => {
    invoke<AppliedGains | null>("gains_open", { robotPath }).then(setApplied).catch(() => setApplied(null))
    invoke<SavedRun[]>("tune_runs", { robotPath }).then(setSaved).catch(() => setSaved([]))
  }
  useEffect(refreshSaved, [robotPath])

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
      setChosen(c => (c.length ? c.filter(n => loaded[n]) : names.filter(n => loaded[n]).slice(0, 4)))
    })
    let folder: string | null = null
    try { folder = localStorage.getItem(`ares.robotCode:${robotPath}`) } catch { /* none */ }
    Promise.all([
      invoke<RobotTuning>("robot_tuning", { robotPath, folder }).catch(() => null),
      invoke<{ drive?: { kS: number; kV: number } } | null>("characterization_open", { robotPath }).catch(() => null),
    ]).then(([t, measured]) => {
      setTuning(t)
      const c = robotCode(t)
      // What the Measure tab found on the robot beats what the code says.
      if (measured?.drive) {
        c.driveKs = measured.drive.kS
        c.driveKv = measured.drive.kV
        setMeasuredDrive(measured.drive)
      }
      setCode(c)
      setParams(defaultParams(c))
      if (t?.driveFrictionV != null) setWorld(w => ({ ...w, driveFrictionV: t.driveFrictionV! }))
    })
  }, [robotPath])
  useEffect(() => setWorld(w => ({ ...nominalWorld(robot), latencyS: w.latencyS, driveFrictionV: w.driveFrictionV, ...(calibration?.values ?? {}) })), [robot])
  // The world the Logs tab found the robot in: the worlds are centered on it.
  const [calibration, setCalibration] = useState<CalibrationDoc | null>(null)
  useEffect(() => {
    if (!robotPath) return
    invoke<CalibrationDoc | null>("calibration_open", { robotPath }).then(c => {
      setCalibration(c)
      if (c) setWorld(w => ({ ...w, ...c.values }))
    }).catch(() => {})
  }, [robotPath])

  // Progress, as the search sends it.
  useEffect(() => {
    const un = listen<Progress>("tune-progress", e => {
      const p = e.payload
      setProgress(p)
      if (!p.done) setCloud(c => [...c, ...p.population.map(x => ({ gen: p.generation, c: x }))].slice(-3000))
      if (p.baselineTracks.length) setBaseTracks(p.baselineTracks)
      if (p.tracks.length) setTracks(p.tracks)
      if (p.done) {
        setRunning(false)
        setTimeout(refreshSaved, 300)
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
      code, params, world, vary, environments, method, criterion, disturbance,
      sim: { abortM, settleS: 0.5, record: false }, seed: 2026,
    }
    setProgress(null)
    setCloud([])
    setTracks([])
    setBaseTracks([])
    setRanWith({ params, paths: chosen, forceFf: code.forceFf, disturbance })
    setViewingSaved(null)
    try {
      setRunning(true)
      await invoke("tune_start", { robot, robotPath, paths: chosen, config })
    } catch (e) {
      setRunning(false)
      toast({ kind: "error", title: "Could not start tuning", body: String(e) })
    }
  }

  // A run from tuning/ shows as a finished progress, without the field lines.
  const savedRun = viewingSaved !== null ? saved[viewingSaved] : null
  const shown: Progress | null = savedRun
    ? { generation: savedRun.history[savedRun.history.length - 1]?.generation ?? 0, generations: savedRun.history[savedRun.history.length - 1]?.generation ?? 0, runs: savedRun.runs, elapsedS: savedRun.elapsedS,
        baseline: savedRun.baseline, best: savedRun.best, population: [], history: savedRun.history, tracks: [], baselineTracks: [], worlds: [], done: true, cancelled: savedRun.cancelled }
    : progress
  const best = shown?.best ?? null
  const baseline = shown?.baseline ?? null
  const shownParams = savedRun?.config.params ?? ranWith?.params ?? params
  const shownPaths = savedRun?.paths ?? ranWith?.paths ?? chosen
  const margins = chosen.map(n => ({ name: n, grip: trajs[n] ? gripUsed(trajs[n].samples) : 0 }))
  const tight = margins.filter(m => m.grip > 0.95)
  const tunedCount = params.filter(p => p.tune).length
  const apply = async () => {
    if (!best || !baseline) return
    const g = appliedGains(shownParams, best.values, { source: `Tune, ${new Date().toLocaleString()}`, score: best.score, baselineScore: baseline.score, paths: shownPaths })
    try {
      await invoke("gains_save", { robotPath, gains: g })
      setApplied(g)
      toast({ kind: "success", title: "Applied to the robot", body: "Saved in gains.json: AresLib uses it after the next deploy (unless the code calls withGains). /Ares/Gains on NetworkTables says which gains it runs." })
    } catch (e) {
      toast({ kind: "error", title: "Could not apply them", body: String(e) })
    }
  }
  const totalRuns = method.kind === "grid"
    ? Math.pow(Math.max(2, method.steps), tunedCount) * environments * Math.max(1, chosen.length)
    : method.generations * method.population * environments * Math.max(1, chosen.length)

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div className="ares-scroll" style={{ width: SIDEBAR, flexShrink: 0, overflowY: "auto", borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--border-light)" }}>
          <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4 }}>Tune</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Path following gains</div>
          <div style={{ fontSize: 10.5, color: "var(--text-header-subtitle)", marginTop: 5, lineHeight: 1.45 }}>
            Simulates the selected paths in each world with the robot code's controllers and searches the gains by the chosen criterion.
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
        <div style={{ margin: "6px 12px", padding: "6px 8px", border: "1px solid var(--border-light)", background: "var(--bg-page)", fontSize: 10.5, lineHeight: 1.5 }}
          title="gains.json in the project: what AresLib runs with after a deploy, unless the robot code calls withGains">
          <b>On the robot</b>{" "}
          {applied
            ? <>(gains.json{applied.source ? `, ${applied.source}` : ""}): translation kP {fmt3(applied.translation.kp)} kD {fmt3(applied.translation.kd)} · rotation kP {fmt3(applied.rotation.kp)} kD {fmt3(applied.rotation.kd)}
                {" "}<a href="#" style={{ color: "#c21c1c" }} onClick={async e => {
                  e.preventDefault()
                  if (!window.confirm("Remove gains.json? After the next deploy AresLib uses the code's withGains, or its defaults.")) return
                  await invoke("gains_delete", { robotPath }).catch(err => toast({ kind: "error", title: "Could not remove it", body: String(err) }))
                  refreshSaved()
                }}>Remove</a></>
            : <>: no gains.json yet, so AresLib uses its defaults (kP 4) or the code's withGains. "Apply to robot" writes it.</>}
        </div>
        <div style={{ padding: "4px 12px 2px", fontSize: 10, color: "var(--text-muted)" }}>
          {tuning?.file ? <>From the robot code: <span title={tuning.file}>{tuning.file.split(/[\\/]/).pop()}</span>. </> : "Robot code not found: Tuner X's defaults. "}
          {measuredDrive && <>Drive kS {measuredDrive.kS.toFixed(4)} and kV {measuredDrive.kV.toFixed(4)} as measured (Measure tab). </>}
          Checked gains are searched between min and max; the rest stay at their value.
        </div>
        {PARAM_GROUPS.map(group => (
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
        {calibration && (
          <div style={{ margin: "2px 12px 6px", padding: "5px 8px", fontSize: 10.5, lineHeight: 1.45, background: "rgba(46,158,91,0.09)", border: "1px solid rgba(46,158,91,0.35)" }}>
            Nominal values from the log calibration ({calibration.path}, {calibration.log}): {Object.keys(calibration.values).map(k => WORLD_VARS.find(v => v.key === k)?.label ?? k).join(", ")}.{" "}
            <a href="#" onClick={e => { e.preventDefault(); setCalibration(null); setWorld(w => ({ ...nominalWorld(robot), latencyS: 0.02, driveFrictionV: w.driveFrictionV })) }}>Use the robot.json's</a>
          </div>
        )}
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

        <Heading label="Shoves (disturbances)" />
        <Note>
          Every world but the nominal one gets shoved: the gains are judged on how far the robot is knocked, how fast it is back within 5 cm, and how much later it finishes.
          AresLib replans when knocked well off and drives to the end if a late shove leaves it short; tick the <b>Recovery</b> gains to tune those too.
        </Note>
        <Row label="Shoves" hint="Off: the worlds differ but nobody touches the robot">
          <select style={{ ...propertyInputStyle, width: 190 }} value={disturbance ? (DISTURBANCE_PRESETS.find(p => JSON.stringify(p.d) === JSON.stringify(disturbance))?.id ?? "custom") : "off"}
            onChange={e => {
              const id = e.target.value
              if (id === "off") setDisturbance(null)
              else if (id !== "custom") setDisturbance({ ...DISTURBANCE_PRESETS.find(p => p.id === id)!.d })
            }}>
            <option value="off">None</option>
            {DISTURBANCE_PRESETS.map(p => <option key={p.id} value={p.id} title={p.hint}>{p.label}</option>)}
            {disturbance && !DISTURBANCE_PRESETS.some(p => JSON.stringify(p.d) === JSON.stringify(disturbance)) && <option value="custom">Custom</option>}
          </select>
        </Row>
        {disturbance && (
          <>
            <Row label="Per run"><Num value={disturbance.perRun} onChange={v => setDisturbance({ ...disturbance, perRun: Math.max(1, Math.min(5, Math.round(v))) })} /></Row>
            <Pair label="Force" unit="N" hint="How hard, drawn between the two" a={disturbance.forceMinN} b={disturbance.forceMaxN}
              onChange={(a, b) => setDisturbance({ ...disturbance, forceMinN: Math.max(0, a), forceMaxN: Math.max(0, b) })} />
            <Pair label="Lasting" unit="s" hint="A bump is a tenth of a second; defense leans for one or two" a={disturbance.durationMinS} b={disturbance.durationMaxS}
              onChange={(a, b) => setDisturbance({ ...disturbance, durationMinS: Math.max(0.01, a), durationMaxS: Math.max(0.01, b) })} />
            <Row label="Off center, up to" hint="How far from the robot's center it is hit: what turns it"><Num value={disturbance.leverMaxM} onChange={v => setDisturbance({ ...disturbance, leverMaxM: Math.max(0, v) })} /> m</Row>
            <Pair label="When, along the path" unit="%" hint="Between these fractions of the path" a={Math.round(disturbance.from * 100)} b={Math.round(disturbance.to * 100)}
              onChange={(a, b) => setDisturbance({ ...disturbance, from: Math.min(1, Math.max(0, a / 100)), to: Math.min(1, Math.max(0, b / 100)) })} />
          </>
        )}

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

        <Heading label="Previous runs">
          {saved.length > 0 && (
            <IconAction icon="ti-trash" title="Delete every saved run" onClick={async () => {
              if (!window.confirm(`Delete all ${saved.length} saved runs in tuning/?`)) return
              try {
                const n = await invoke<number>("tune_runs_clear", { robotPath })
                setViewingSaved(null)
                refreshSaved()
                toast({ kind: "info", title: `Deleted ${n} run${n === 1 ? "" : "s"}` })
              } catch (e) { toast({ kind: "error", title: "Could not delete them", body: String(e) }) }
            }} />
          )}
        </Heading>
        {saved.length === 0 && <Note>None yet: each finished run is kept in tuning/.</Note>}
        {saved.map((r, i) => {
          const gain = r.baseline.score > 0 ? (1 - r.best.score / r.baseline.score) * 100 : 0
          return (
            <div key={r.savedAt} onClick={() => setViewingSaved(v => (v === i ? null : i))} title="Show this run's result"
              style={{ padding: "5px 12px", fontSize: 11, cursor: "pointer", borderBottom: "1px solid var(--border-light)", background: viewingSaved === i ? "var(--tree-selection-bg)" : "transparent", color: viewingSaved === i ? "var(--tree-selection-fg)" : "var(--text-primary)" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{new Date(r.savedAt * 1000).toLocaleString()}</span>
                <span style={{ marginLeft: "auto", fontWeight: 600 }}>{gain >= 0 ? "−" : "+"}{Math.abs(gain).toFixed(0)}%</span>
                <IconAction icon="ti-x" title="Delete this run" onClick={async ev => {
                  ev.stopPropagation()
                  try {
                    await invoke("tune_run_delete", { robotPath, savedAt: r.savedAt })
                    setViewingSaved(null)
                    refreshSaved()
                  } catch (e) { toast({ kind: "error", title: "Could not delete it", body: String(e) }) }
                }} />
              </div>
              <div style={{ opacity: 0.8 }}>{r.paths.join(", ")}{r.cancelled ? " · stopped" : ""}</div>
            </div>
          )
        })}
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
          {best && running && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-secondary)", fontFamily: "Consolas, monospace" }} title="The best gains so far">
              best so far: {shownParams.map((p, i) => (p.tune ? `${PARAM_INFO[p.key].label.replace("Translation", "t").replace("Rotation", "r").replace("Drive", "d")} ${fmt3(best.values[i])}` : null)).filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <TuneField robot={robot} trajs={shownPaths.map(n => trajs[n]).filter(Boolean)} tracks={savedRun ? [] : tracks} baseTracks={showBase && !savedRun ? baseTracks : []} hoverWorld={hoverWorld} />
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
        </div>
          {best && baseline && shown && (
            <ResultPanel
              progress={shown} params={shownParams} best={best} baseline={baseline} running={running} saved={!!savedRun}
              notes={findings(shownParams, best, baseline, shown.sensitivity, shownPaths.filter(n => trajs[n] && gripUsed(trajs[n].samples) > 0.95), savedRun?.config.code.forceFf ?? ranWith?.forceFf ?? code.forceFf, !!(savedRun?.config.disturbance ?? ranWith?.disturbance))}
              applied={applied}
              onApply={apply}
              onCopy={async () => {
                const java = javaSnippet(shownParams, best.values)
                if (await copyText(java)) toast({ kind: "info", title: "Copied the gains as Java", body: "Paste them into the Ares.Config (withGains), or use Apply to robot and change no code." })
                else toast({ kind: "error", title: "Could not copy the gains", body: java })
              }}
              onUseAsStart={() => {
                setParams(ps => ps.map(p => ({ ...p, start: best.values[shownParams.findIndex(q => q.key === p.key)] ?? p.start })))
                toast({ kind: "info", title: "The best gains are now the starting point" })
              }}
            />
          )}
        </div>
        <div style={{ height: 200, flexShrink: 0, display: "flex", borderTop: "1px solid var(--border-main)", background: "var(--bg-page)" }}>
          {shown ? (
            <>
              <TrainingChart history={shown.history} baseline={baseline?.score ?? null} />
              <WorldsChart best={best} baseline={baseline} worlds={shown.worlds} hovered={hoverWorld} onHover={setHoverWorld} />
              <PopulationChart cloud={savedRun ? [] : cloud} best={best} params={shownParams} />
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

/** The result, big: the gains to use, how much better they are, and what to make of it. */
function ResultPanel({ progress, params, best, baseline, running, saved, notes, applied, onApply, onCopy, onUseAsStart }: {
  progress: Progress; params: Param[]; best: Progress["best"]; baseline: Progress["baseline"]; running: boolean; saved: boolean
  notes: ReturnType<typeof findings>; applied: AppliedGains | null
  onApply: () => void; onCopy: () => void; onUseAsStart: () => void
}) {
  const gain = baseline.score > 0 ? (1 - best.score / baseline.score) * 100 : 0
  const title = saved ? "Saved run" : running ? "Best so far" : progress.cancelled ? "Stopped: best so far" : "Final gains"
  const isApplied = applied && params.every((p, i) => {
    const v = best.values[i]
    const a = p.key === "translationKp" ? applied.translation.kp : p.key === "translationKi" ? applied.translation.ki : p.key === "translationKd" ? applied.translation.kd
      : p.key === "rotationKp" ? applied.rotation.kp : p.key === "rotationKi" ? applied.rotation.ki : p.key === "rotationKd" ? applied.rotation.kd : v
    return Math.abs(a - v) < 1e-9
  })
  const sens = new Map((progress.sensitivity ?? []).map(x => [x.key, x]))
  const color = { warn: "#b45309", info: "var(--text-secondary)", good: "#15803d" }
  const icon = { warn: "ti-alert-triangle", info: "ti-info-circle", good: "ti-circle-check" }
  return (
    <div className="ares-scroll" style={{ width: 330, flexShrink: 0, overflowY: "auto", borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)", fontSize: 11.5 }}>
      <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--border-light)" }}>
        <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase" }}>{title}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
          <span style={{ fontSize: 30, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{gain >= 0 ? "−" : "+"}{Math.abs(gain).toFixed(0)}%</span>
          <span style={{ color: "var(--text-secondary)" }}>error {gain >= 0 ? "less" : "more"} than the gains now</span>
        </div>
        <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
          score {baseline.score.toFixed(3)} → <b style={{ color: "var(--text-primary)" }}>{best.score.toFixed(3)}</b> · {progress.runs.toLocaleString()} runs in {progress.elapsedS.toFixed(1)} s
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
        <thead>
          <tr style={{ color: "var(--text-muted)", fontSize: 10 }}>
            <th style={{ textAlign: "left", padding: "4px 14px", fontWeight: 400 }}>gain</th>
            <th style={{ textAlign: "right", fontWeight: 400 }}>now</th>
            <th style={{ textAlign: "right", fontWeight: 400, padding: "0 14px" }}>use</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p, i) => {
            if (!p.tune) return null
            const s = sens.get(p.key)
            const steep = s ? Math.max(s.lowerScore, s.upperScore) / Math.max(best.score, 1e-9) - 1 : null
            return (
              <tr key={p.key} style={{ borderTop: "1px solid var(--border-light)" }}>
                <td style={{ padding: "5px 14px" }}>
                  {PARAM_INFO[p.key].label}
                  {steep !== null && (
                    <div style={{ fontSize: 9.5, color: "var(--text-muted)" }} title={`Score with it at ${fmt3(s!.lowerValue)}: ${s!.lowerScore.toFixed(3)}; at ${fmt3(s!.upperValue)}: ${s!.upperScore.toFixed(3)}`}>
                      {steep < 0.03 ? "flat: round it freely" : steep < 0.15 ? "matters a little" : "matters: keep it close"}
                    </div>
                  )}
                </td>
                <td style={{ textAlign: "right", fontFamily: "Consolas, monospace", color: "var(--text-muted)" }}>{fmt3(baseline.values[i])}</td>
                <td style={{ textAlign: "right", padding: "0 14px", fontFamily: "Consolas, monospace", fontWeight: 700, fontSize: 13, color: "var(--text-primary)" }}>{fmt3(best.values[i])}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "3px 10px", padding: "10px 14px", borderTop: "1px solid var(--border-light)", color: "var(--text-secondary)" }}>
        <span /><span style={{ fontSize: 10, color: "var(--text-muted)" }}>now</span><span style={{ fontSize: 10, color: "var(--text-muted)" }}>best</span>
        <span>Off the path, average</span><span>{(baseline.meanRmsM * 100).toFixed(1)} cm</span><b>{(best.meanRmsM * 100).toFixed(1)} cm</b>
        <span>Worst end</span><span>{(baseline.worstFinalM * 100).toFixed(1)} cm</span><b>{(best.worstFinalM * 100).toFixed(1)} cm</b>
        <span>Runs that lost the path</span><span>{baseline.aborts}</span><b>{best.aborts}</b>
        {(best.maxPushedM > 0 || baseline.maxPushedM > 0) && (
          <>
            <span title="Shoved: the longest it took to be back within 5 cm">Back after a shove, worst</span><span>{baseline.worstRecoveryS.toFixed(2)} s</span><b>{best.worstRecoveryS.toFixed(2)} s</b>
            <span>…on average</span><span>{baseline.meanRecoveryS.toFixed(2)} s</span><b>{best.meanRecoveryS.toFixed(2)} s</b>
            <span title="The farthest a shove put it from where the trajectory was">Farthest off after one</span><span>{(baseline.maxPushedM * 100).toFixed(0)} cm</span><b>{(best.maxPushedM * 100).toFixed(0)} cm</b>
            <span title="How many times the pathfinder took it back, over every run">Times it replanned</span><span>{baseline.replans}</span><b>{best.replans}</b>
          </>
        )}
      </div>

      {notes.length > 0 && (
        <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border-light)", display: "flex", flexDirection: "column", gap: 6 }}>
          {notes.map((n, i) => (
            <div key={i} style={{ display: "flex", gap: 6, color: color[n.level], lineHeight: 1.45 }}>
              <i className={`ti ${icon[n.level]}`} style={{ marginTop: 2 }} /><span>{n.text}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--border-light)", display: "flex", flexDirection: "column", gap: 6 }}>
        <button onClick={onApply} disabled={running}
          title="Writes gains.json next to the robot: AresLib uses it after the next deploy, with no code to change"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, height: 30, fontSize: 12, fontWeight: 600, cursor: running ? "default" : "pointer", border: "1px solid #c2410c", borderRadius: 2, background: isApplied ? "var(--btn-classic-bg)" : "#e95420", color: isApplied ? "#15803d" : "#fff", opacity: running ? 0.5 : 1 }}>
          {isApplied ? <i className="ti ti-circle-check" /> : <SwerveIcon size={15} />} {isApplied ? "Applied: on the robot after a deploy" : "Apply to robot"}
        </button>
        <div style={{ display: "flex", gap: 6 }}>
          <SmallButton icon="ti-copy" label="Copy as Java" onClick={onCopy} />
          <SmallButton icon="ti-arrow-back-up" label="Start from these" onClick={onUseAsStart} />
        </div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.45 }}>
          Then check them on the robot: run the path a few times and watch /Ares/ErrorM (and /Ares/Gains, which says which gains it runs).
        </div>
      </div>
    </div>
  )
}

function SmallButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, height: 26, fontSize: 11, cursor: "pointer", border: "1px solid var(--btn-classic-border)", borderRadius: 2, background: "var(--btn-classic-bg)", color: "var(--text-primary)" }}>
      <i className={`ti ${icon}`} /> {label}
    </button>
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
      // Where the shoves hit, in the worst world (or the one hovered): an
      // arrow along the force, longer the harder.
      for (const tr of hoverWorld !== null ? tracks.filter(t => t.env === hoverWorld) : [worst]) {
        for (const [px, py, fx, fy] of tr.pushes ?? []) {
          const f = Math.hypot(fx, fy)
          if (f < 1) continue
          const len = 0.25 + f / 1000
          const [x0, y0] = toScreen(px - fx / f * len, py - fy / f * len)
          const [x1, y1] = toScreen(px, py)
          const ang = Math.atan2(y1 - y0, x1 - x0)
          ctx.lineCap = "round"
          for (const [color, width] of [["rgba(255,255,255,0.95)", 6], ["#1c1c1f", 2.5]] as const) {
            ctx.strokeStyle = color
            ctx.lineWidth = width
            ctx.beginPath()
            ctx.moveTo(x0, y0)
            ctx.lineTo(x1, y1)
            ctx.moveTo(x1, y1)
            ctx.lineTo(x1 - 9 * Math.cos(ang - 0.45), y1 - 9 * Math.sin(ang - 0.45))
            ctx.moveTo(x1, y1)
            ctx.lineTo(x1 - 9 * Math.cos(ang + 0.45), y1 - 9 * Math.sin(ang + 0.45))
            ctx.stroke()
          }
          const label = `shove ${f.toFixed(0)} N`
          ctx.font = "600 10.5px 'Segoe UI', Arial, sans-serif"
          ctx.fillStyle = "rgba(255,255,255,0.92)"
          ctx.fillRect(x0 - 4, y0 - 15, ctx.measureText(label).width + 8, 14)
          ctx.fillStyle = "#1c1c1f"
          ctx.fillText(label, x0, y0 - 4)
        }
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

function Heading({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 6px 0 12px", marginTop: 6, background: "var(--bg-panel-header)", borderTop: "1px solid var(--border-main)", borderBottom: "1px solid var(--border-main)" }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)" }}>{label}</span>
      <span style={{ marginLeft: "auto" }}>{children}</span>
    </div>
  )
}

function IconAction({ icon, title, onClick }: { icon: string; title: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button title={title} onClick={onClick}
      style={{ border: "none", background: "transparent", cursor: "pointer", padding: "2px 4px", color: "var(--text-muted)", fontSize: 13 }}
      onMouseEnter={e => (e.currentTarget.style.color = "#c21c1c")} onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}>
      <i className={`ti ${icon}`} />
    </button>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div title={hint} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", fontSize: 11.5 }}>
      <span style={{ flex: 1 }}>{label}</span>{children}
    </div>
  )
}

function Pair({ label, unit, hint, a, b, onChange }: { label: string; unit: string; hint?: string; a: number; b: number; onChange: (a: number, b: number) => void }) {
  return (
    <div title={hint} style={{ display: "grid", gridTemplateColumns: "1fr 56px 14px 56px 22px", gap: 4, alignItems: "center", padding: "3px 12px", fontSize: 11.5 }}>
      <span>{label}</span>
      <Num value={a} onChange={v => onChange(v, b)} />
      <span style={{ textAlign: "center", color: "var(--text-muted)" }}>–</span>
      <Num value={b} onChange={v => onChange(a, v)} />
      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{unit}</span>
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
