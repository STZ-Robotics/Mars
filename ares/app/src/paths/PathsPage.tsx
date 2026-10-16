import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import PageHeader from "@desktop/components/layout/PageHeader"
import PanelHeader from "@desktop/components/layout/PanelHeader"
import Panel from "@desktop/components/common/Panel"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import { Card, MiniButton, Q, QInput, Toggle } from "../ui/controls"
import FieldView, { SPEED_GRADIENT_CSS } from "./FieldView"
import {
  FieldDoc, KeepOut, PathEntry, PathSpec, PlanResult, Selection, Tool, Trajectory, Waypoint, newPathSpec,
} from "./types"

interface Props {
  robot: RobotConfig
  robotPath: string | null
  onSaveRobot: () => void
}

const SIDEBAR_WIDTH = 330
const SAVE_DELAY_MS = 400
const PLAN_DELAY_MS = 250

interface Current {
  spec: PathSpec
  /** The name it has on disk, or null if never saved: a rename moves the file. */
  savedName: string | null
}

export default function PathsPage({ robot, robotPath, onSaveRobot }: Props) {
  if (!robotPath) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-page)" }}>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Save the robot first</div>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)", maxWidth: 360, lineHeight: 1.5, marginBottom: 10 }}>
            Paths live next to the robot.json, in a <code>paths/</code> folder, and the trajectories the robot code reads go in <code>trajectories/</code>.
          </div>
          <MiniButton onClick={onSaveRobot}>Save robot…</MiniButton>
        </Card>
      </div>
    )
  }
  return <Editor robot={robot} robotPath={robotPath} />
}

function Editor({ robot, robotPath }: { robot: RobotConfig; robotPath: string }) {
  const field = FIELDS[0]
  const fieldSize = { lengthM: field.sizeMeters[0], widthM: field.sizeMeters[1] }

  const [entries, setEntries] = useState<PathEntry[]>([])
  const [current, setCurrent] = useState<Current | null>(null)
  const [fieldDoc, setFieldDoc] = useState<FieldDoc>({ walls: true, keepOut: [] })
  const [selected, setSelected] = useState<Selection>(null)
  const [tool, setTool] = useState<Tool>("select")
  const [spline, setSpline] = useState<Trajectory | null>(null)
  const [splineError, setSplineError] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ result: PlanResult; forSpec: string } | null>(null)
  const [planState, setPlanState] = useState<{ kind: "idle" } | { kind: "planning" } | { kind: "error"; message: string }>({ kind: "idle" })
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [fitSignal, setFitSignal] = useState(0)
  const [saveNote, setSaveNote] = useState<string>("")
  // Bumped on every committed edit (a drag's end, a typed value): that is
  // what saves and optimizes. Drags in progress only re-time the spline.
  const [commit, setCommit] = useState(0)
  const [fieldCommit, setFieldCommit] = useState(0)
  // Bumped when a path is opened: it is optimized without being edited.
  const [loaded, setLoaded] = useState(0)

  const spec = current?.spec ?? null
  const specKey = spec ? JSON.stringify(spec) : ""
  const planned = plan && plan.forSpec === specKey + JSON.stringify(fieldDoc) ? plan.result.trajectory : null
  const shown = planned ?? spline

  // --- Files -----------------------------------------------------------------
  const refresh = useCallback(async () => {
    const list = await invoke<PathEntry[]>("paths_list", { robotPath })
    setEntries(list)
    return list
  }, [robotPath])

  useEffect(() => {
    setCurrent(null)
    setPlan(null)
    invoke<FieldDoc>("field_open", { robotPath }).then(setFieldDoc)
    refresh().then(list => {
      const first = list.find(e => e.spec)
      if (first?.spec) { setCurrent({ spec: first.spec, savedName: first.spec.name }); setLoaded(n => n + 1) }
    })
  }, [robotPath, refresh])

  const open = (e: PathEntry) => {
    if (!e.spec) return
    setCurrent({ spec: e.spec, savedName: e.spec.name })
    setLoaded(n => n + 1)
    setSelected(null)
    setPlayhead(null)
    setPlaying(false)
  }

  const createPath = () => {
    const taken = new Set(entries.map(e => e.name.toLowerCase()))
    let name = "New path"
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `New path ${i}`
    setCurrent({ spec: newPathSpec(name), savedName: null })
    setSelected(null)
    setCommit(c => c + 1)
  }

  const deletePath = async () => {
    if (!current) return
    if (!window.confirm(`Delete "${current.spec.name}" and its trajectory?`)) return
    if (current.savedName) await invoke("path_delete", { robotPath, name: current.savedName })
    setCurrent(null)
    setPlan(null)
    const list = await refresh()
    const first = list.find(e => e.spec)
    if (first?.spec) { setCurrent({ spec: first.spec, savedName: first.spec.name }); setLoaded(n => n + 1) }
  }

  // Autosave: every committed edit lands on disk shortly after.
  useEffect(() => {
    if (!commit || !current) return
    const t = setTimeout(async () => {
      try {
        await invoke("path_save", { robotPath, spec: current.spec, previous: current.savedName })
        setCurrent(c => c && c.spec.name === current.spec.name ? { ...c, savedName: current.spec.name } : c)
        setSaveNote("Saved")
        refresh()
      } catch (e) {
        setSaveNote(String(e))
      }
    }, SAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [commit])

  useEffect(() => {
    if (!fieldCommit) return
    const t = setTimeout(() => { invoke("field_save", { robotPath, field: fieldDoc }).catch(e => setSaveNote(String(e))) }, SAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [fieldCommit])

  // --- Stage 1, live ---------------------------------------------------------
  // One request in flight at a time: while it runs, newer edits only replace
  // the pending one, so a fast drag never piles up work behind the cursor.
  const timing = useRef<{ busy: boolean; pending: { robot: RobotConfig; spec: PathSpec } | null }>({ busy: false, pending: null })
  const requestTiming = useCallback((req: { robot: RobotConfig; spec: PathSpec }) => {
    const q = timing.current
    if (q.busy) { q.pending = req; return }
    q.busy = true
    invoke<Trajectory>("path_time", req)
      .then(t => { setSpline(t); setSplineError(null) })
      .catch(e => { setSpline(null); setSplineError(String(e)) })
      .finally(() => {
        q.busy = false
        const next = q.pending
        q.pending = null
        if (next) requestTiming(next)
      })
  }, [])
  useEffect(() => {
    if (!spec) { setSpline(null); return }
    requestTiming({ robot, spec })
  }, [specKey, JSON.stringify(robot)])

  // --- Stage 2, after each committed edit -----------------------------------
  const planReq = useRef(0)
  useEffect(() => {
    if (!spec) return
    const id = ++planReq.current
    const key = specKey + JSON.stringify(fieldDoc)
    const t = setTimeout(() => {
      setPlanState({ kind: "planning" })
      invoke<PlanResult>("path_plan", { robot, spec, field: fieldDoc, fieldSize, robotPath })
        .then(result => {
          if (id !== planReq.current) return
          setPlan({ result, forSpec: key })
          setPlanState({ kind: "idle" })
        })
        .catch(e => { if (id === planReq.current) setPlanState({ kind: "error", message: String(e) }) })
    }, PLAN_DELAY_MS)
    return () => clearTimeout(t)
  }, [commit, fieldCommit, loaded, JSON.stringify(robot)])

  // --- Edits -----------------------------------------------------------------
  const editSpec = (f: (s: PathSpec) => PathSpec, final: boolean) => {
    setCurrent(c => (c ? { ...c, spec: f(c.spec) } : c))
    if (final) setCommit(c => c + 1)
  }
  const editWaypoint = (i: number, patch: Partial<Waypoint> | ((w: Waypoint) => Waypoint), final: boolean) =>
    editSpec(s => ({
      ...s,
      waypoints: s.waypoints.map((w, j) => (j === i ? (typeof patch === "function" ? patch(w) : { ...w, ...patch }) : w)),
    }), final)

  const addWaypoint = (x: number, y: number) => {
    if (!spec) return
    // Near a segment: insert into it. Elsewhere: extend the path.
    const ws = spec.waypoints
    let best = -1, bestD = 0.6
    for (let i = 0; i + 1 < ws.length; i++) {
      const d = distToSegment(x, y, ws[i], ws[i + 1])
      if (d < bestD) { bestD = d; best = i }
    }
    const at = best >= 0 ? best + 1 : ws.length
    editSpec(s => ({ ...s, waypoints: [...s.waypoints.slice(0, at), { x, y }, ...s.waypoints.slice(at)] }), true)
    setSelected({ kind: "waypoint", index: at })
  }

  const removeSelected = () => {
    if (selected?.kind === "waypoint" && spec && spec.waypoints.length > 2) {
      editSpec(s => ({ ...s, waypoints: s.waypoints.filter((_, j) => j !== selected.index) }), true)
      setSelected(null)
    } else if (selected?.kind === "keepout") {
      editField(f => ({ ...f, keepOut: f.keepOut.filter((_, j) => j !== selected.index) }), true)
      setSelected(null)
    }
  }

  const editField = (f: (d: FieldDoc) => FieldDoc, final: boolean) => {
    setFieldDoc(d => f(d))
    if (final) setFieldCommit(c => c + 1)
  }
  const editKeepOut = (i: number, patch: Partial<KeepOut>, final: boolean) =>
    editField(d => ({ ...d, keepOut: d.keepOut.map((k, j) => (j === i ? { ...k, ...patch } : k)) }), final)

  // --- Playback ----------------------------------------------------------------
  useEffect(() => {
    if (!playing || !shown) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      let stop = false
      setPlayhead(p => {
        const next = (p ?? 0) + dt
        if (next >= shown.durationS) { stop = true; return shown.durationS }
        return next
      })
      if (stop) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, shown])

  const togglePlay = () => {
    if (!shown) return
    if (!playing && (playhead === null || playhead >= shown.durationS - 1e-3)) setPlayhead(0)
    setPlaying(p => !p)
  }

  // Keys: tools, delete, play.
  const keysRef = useRef({ removeSelected, togglePlay })
  keysRef.current = { removeSelected, togglePlay }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return
      if (e.ctrlKey || e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === "v" || k === "escape") setTool("select")
      else if (k === "w") setTool("waypoint")
      else if (k === "k") setTool("keepout")
      else if (k === "f") setFitSignal(s => s + 1)
      else if (k === "delete" || k === "backspace") keysRef.current.removeSelected()
      else if (k === " ") { e.preventDefault(); keysRef.current.togglePlay() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // --- Numbers for the result panel ------------------------------------------
  const stats = useMemo(() => {
    if (!planned) return null
    let peakA = 0, peakGrip = 0, top = 0
    for (const s of planned.samples) {
      top = Math.max(top, Math.hypot(s.vx, s.vy))
      for (const m of s.modules) {
        peakA = Math.max(peakA, Math.abs(m.currentA))
        peakGrip = Math.max(peakGrip, m.gripUsed)
      }
    }
    return { peakA, peakGrip, top }
  }, [planned])

  const wp = selected?.kind === "waypoint" && spec ? spec.waypoints[selected.index] : null
  const ko = selected?.kind === "keepout" ? fieldDoc.keepOut[selected.index] : null

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ width: SIDEBAR_WIDTH, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <PageHeader eyebrow="Paths" title={spec?.name ?? "No path"} subtitle={saveNote || `${entries.length} in this project`} />
        <div className="ares-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <Panel title="Paths" icon="ti-route">
            <div style={{ maxHeight: 180, overflowY: "auto" }}>
              {entries.length === 0 && !current && (
                <div style={{ padding: 10, fontSize: 11, color: "var(--text-muted)" }}>No paths yet.</div>
              )}
              {entries.map(e => {
                const active = current?.savedName === e.name
                return (
                  <div
                    key={e.name}
                    onClick={() => open(e)}
                    title={e.error ?? undefined}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", fontSize: 11.5, cursor: e.spec ? "pointer" : "default",
                      background: active ? "var(--tree-selection-bg)" : "transparent", color: active ? "var(--tree-selection-fg)" : e.error ? "var(--status-error)" : "var(--text-primary)",
                      borderBottom: "1px solid var(--border-light)",
                    }}
                  >
                    <i className={`ti ${e.error ? "ti-alert-triangle" : "ti-route"}`} style={{ fontSize: 13 }} aria-hidden />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                  </div>
                )
              })}
              {current && current.savedName === null && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", fontSize: 11.5, background: "var(--tree-selection-bg)", color: "var(--tree-selection-fg)" }}>
                  <i className="ti ti-route" style={{ fontSize: 13 }} aria-hidden /> {current.spec.name}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 4, padding: 6, borderTop: "1px solid var(--border-light)" }}>
              <MiniButton onClick={createPath}>New</MiniButton>
              <MiniButton onClick={deletePath}>Delete</MiniButton>
            </div>
          </Panel>

          {spec && (
            <Panel title="Path" icon="ti-settings">
              <PropertyRow label="Name">
                <NameInput value={spec.name} onCommit={name => editSpec(s => ({ ...s, name }), true)} />
              </PropertyRow>
              <Q label="Max speed" dim="plain" unit="m/s" optional value={spec.constraints.maxVelocityMps}
                onChange={v => editSpec(s => ({ ...s, constraints: { ...s.constraints, maxVelocityMps: v } }), true)} hint="Empty: what the robot can do" />
              <Q label="Max rotation" dim="plain" unit="°/s" optional value={spec.constraints.maxAngularVelocityDps}
                onChange={v => editSpec(s => ({ ...s, constraints: { ...s.constraints, maxAngularVelocityDps: v } }), true)} hint="Empty: what the robot can do" />
            </Panel>
          )}

          {wp && selected?.kind === "waypoint" && spec && (
            <Panel title={`Waypoint ${selected.index + 1} of ${spec.waypoints.length}`} icon="ti-map-pin">
              <Q label="X" dim="length" unit="m" value={wp.x} onChange={v => editWaypoint(selected.index, { x: v }, true)} />
              <Q label="Y" dim="length" unit="m" value={wp.y} onChange={v => editWaypoint(selected.index, { y: v }, true)} />
              <PropertyRow label="Heading">
                <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }}>
                  <select
                    style={{ ...propertyInputStyle, width: 82 }}
                    value={wp.headingDeg === undefined ? "free" : "fixed"}
                    onChange={e => {
                      const fixed = e.target.value === "fixed"
                      editWaypoint(selected.index, w => {
                        if (!fixed) { const { headingDeg: _, ...rest } = w; return rest }
                        return { ...w, headingDeg: Math.round(headingAt(shown, w) * 10) / 10 }
                      }, true)
                    }}
                  >
                    <option value="free">Free</option>
                    <option value="fixed">Fixed</option>
                  </select>
                  {wp.headingDeg !== undefined
                    ? <><QInput dim="plain" value={wp.headingDeg} onChange={v => editWaypoint(selected.index, { headingDeg: v }, true)} /><span style={{ fontSize: 10, color: "var(--text-muted)" }}>°</span></>
                    : <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>the planner picks it</span>}
                </div>
              </PropertyRow>
              <div style={{ display: "flex", gap: 4, padding: 6 }}>
                <MiniButton onClick={removeSelected}>Delete waypoint</MiniButton>
              </div>
            </Panel>
          )}

          {ko && selected?.kind === "keepout" && (
            <Panel title={`Keep-out ${selected.index + 1}`} icon="ti-circle-off">
              <Q label="X" dim="length" unit="m" value={ko.x} onChange={v => editKeepOut(selected.index, { x: v }, true)} />
              <Q label="Y" dim="length" unit="m" value={ko.y} onChange={v => editKeepOut(selected.index, { y: v }, true)} />
              <Q label="Radius" dim="length" unit="m" value={ko.radiusM} onChange={v => editKeepOut(selected.index, { radiusM: v }, true)} />
              <div style={{ display: "flex", gap: 4, padding: 6 }}>
                <MiniButton onClick={removeSelected}>Delete keep-out</MiniButton>
              </div>
            </Panel>
          )}

          <Panel title="Result" icon="ti-chart-line">
            {planned && plan ? (
              <>
                <Stat label="Time" value={`${planned.durationS.toFixed(3)} s`} strong />
                <Stat label="Along the spline" value={`${plan.result.splineDurationS.toFixed(3)} s`}
                  note={`${(100 * (1 - planned.durationS / plan.result.splineDurationS)).toFixed(0)}% faster`} />
                <Stat label="Top speed" value={`${stats!.top.toFixed(2)} m/s`} />
                <Stat label="Peak drive current" value={`${stats!.peakA.toFixed(0)} A`} />
                <Stat label="Peak grip" value={`${(100 * stats!.peakGrip).toFixed(0)} %`} />
                <Stat label="Solved in" value={`${plan.result.solveMs.toFixed(0)} ms`} note={`${plan.result.iterations} iterations`} />
              </>
            ) : (
              <div style={{ padding: 10, fontSize: 11, color: planState.kind === "error" || splineError ? "var(--status-error)" : "var(--text-muted)", lineHeight: 1.5 }}>
                {splineError ?? (planState.kind === "error" ? planState.message : spline ? `Spline: ${spline.durationS.toFixed(3)} s. Optimizing…` : "No path open.")}
              </div>
            )}
          </Panel>

          <Panel title="Field" icon="ti-map-2">
            <PropertyRow label="Walls">
              <input type="checkbox" checked={fieldDoc.walls} onChange={e => editField(d => ({ ...d, walls: e.target.checked }), true)} />
              <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>{fieldSize.lengthM} × {fieldSize.widthM} m</span>
            </PropertyRow>
            <PropertyRow label="Keep-outs">
              <span style={{ fontSize: 11 }}>{fieldDoc.keepOut.length}</span>
              <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>shared by every path</span>
            </PropertyRow>
          </Panel>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <PanelHeader
          title={
            <span style={{ display: "flex", gap: 6 }}>
              <Toggle on={tool === "select"} onClick={() => setTool("select")} icon="ti-pointer" label="Select (V)" />
              <Toggle on={tool === "waypoint"} onClick={() => setTool("waypoint")} icon="ti-map-pin-plus" label="Waypoint (W)" />
              <Toggle on={tool === "keepout"} onClick={() => setTool("keepout")} icon="ti-circle-off" label="Keep-out (K)" />
            </span>
          }
          meta={<PlanBadge state={planState} hasPlan={!!planned} />}
          action={<Toggle on={false} onClick={() => setFitSignal(s => s + 1)} icon="ti-maximize" label="Fit (F)" />}
        />
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          <FieldView
            field={field}
            robot={robot}
            spec={spec}
            spline={spline}
            planned={planned}
            keepOut={fieldDoc.keepOut}
            selected={selected}
            tool={tool}
            playhead={playhead}
            fitSignal={fitSignal}
            onSelect={setSelected}
            onMoveWaypoint={(i, x, y, final) => editWaypoint(i, { x, y }, final)}
            onRotateWaypoint={(i, h, final) => editWaypoint(i, { headingDeg: h }, final)}
            onAddWaypoint={addWaypoint}
            onAddKeepOut={(x, y) => {
              editField(d => ({ ...d, keepOut: [...d.keepOut, { x, y, radiusM: 0.5 }] }), true)
              setSelected({ kind: "keepout", index: fieldDoc.keepOut.length })
              setTool("select")
            }}
            onMoveKeepOut={(i, x, y, final) => editKeepOut(i, { x, y }, final)}
            onResizeKeepOut={(i, r, final) => editKeepOut(i, { radiusM: r }, final)}
          />
          {planned && (
            <div style={{ position: "absolute", right: 12, bottom: 64, background: "rgba(255,255,255,0.92)", border: "1px solid var(--border-main)", padding: "5px 8px", fontSize: 10, color: "var(--text-secondary)" }}>
              <div style={{ marginBottom: 3 }}>Speed</div>
              <div style={{ width: 140, height: 6, background: SPEED_GRADIENT_CSS }} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}><span>0</span><span>free speed</span></div>
            </div>
          )}
        </div>
        <PlaybackBar
          duration={shown?.durationS ?? 0}
          playhead={playhead}
          playing={playing}
          onToggle={togglePlay}
          onScrub={t => { setPlaying(false); setPlayhead(t) }}
          enabled={!!shown}
        />
      </div>
    </div>
  )
}

function PlanBadge({ state, hasPlan }: { state: { kind: string; message?: string }; hasPlan: boolean }) {
  if (state.kind === "planning") return <span style={{ color: "var(--mars-accent)" }}><i className="ti ti-loader-2" /> Optimizing…</span>
  if (state.kind === "error") return <span style={{ color: "var(--status-error)" }} title={state.message}><i className="ti ti-alert-triangle" /> Not optimized</span>
  if (hasPlan) return <span style={{ color: "var(--status-success)" }}><i className="ti ti-check" /> Optimized</span>
  return null
}

function PlaybackBar({ duration, playhead, playing, onToggle, onScrub, enabled }: {
  duration: number; playhead: number | null; playing: boolean; onToggle: () => void; onScrub: (t: number) => void; enabled: boolean
}) {
  const t = playhead ?? 0
  return (
    <div style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", background: "var(--bg-menubar)", borderTop: "1px solid var(--border-main)", opacity: enabled ? 1 : 0.5 }}>
      <button
        onClick={onToggle}
        disabled={!enabled}
        title="Play (Space)"
        style={{ width: 30, height: 26, border: "1px solid var(--btn-classic-border)", background: "var(--btn-classic-bg)", borderRadius: 2, cursor: "pointer" }}
      >
        <i className={`ti ${playing ? "ti-player-pause-filled" : "ti-player-play-filled"}`} />
      </button>
      <input
        type="range" min={0} max={duration || 1} step={0.005} value={Math.min(t, duration)} disabled={!enabled}
        onChange={e => onScrub(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11, width: 110, textAlign: "right", color: "var(--text-secondary)" }}>
        {t.toFixed(2)} / {duration.toFixed(2)} s
      </span>
    </div>
  )
}

function Stat({ label, value, note, strong }: { label: string; value: string; note?: string; strong?: boolean }) {
  return (
    <PropertyRow label={label}>
      <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: strong ? 13 : 11, fontWeight: strong ? 600 : 400 }}>{value}</span>
      {note && <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 8 }}>{note}</span>}
    </PropertyRow>
  )
}

/** Commits on Enter or blur, like the quantity inputs. */
function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value) }
  return (
    <input
      style={propertyInputStyle}
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }}
    />
  )
}

function distToSegment(x: number, y: number, a: Waypoint, b: Waypoint): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
}

/** The heading the trajectory has at a waypoint, in degrees. */
function headingAt(traj: Trajectory | null, w: Waypoint): number {
  if (!traj) return 0
  let best = traj.samples[0], d = Infinity
  for (const s of traj.samples) {
    const e = (s.x - w.x) ** 2 + (s.y - w.y) ** 2
    if (e < d) { d = e; best = s }
  }
  return ((best.heading * 180 / Math.PI + 540) % 360) - 180
}
