import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import PageHeader from "@desktop/components/layout/PageHeader"
import PanelHeader from "@desktop/components/layout/PanelHeader"
import Panel from "@desktop/components/common/Panel"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import { Card, MiniButton, Q, QInput, Toggle } from "../ui/controls"
import FieldView, { COLORS, RAMP_CSS } from "./FieldView"
import {
  CONSTRAINTS, ConstraintType, DEFAULT_VIEW, EventMarker, FieldDoc, GRADIENTS, KeepOut, PathEntry, PathSpec, PlanResult,
  ScopedConstraint, Selection, Target, Tool, Trajectory, ViewOptions, Waypoint, WaypointKind, afterInsert, afterRemove,
  constraintMeta, kindOf, newConstraint, newPathSpec, rangeOf, targetLabel,
} from "./types"

interface Props {
  robot: RobotConfig
  robotPath: string | null
  onSaveRobot: () => void
}

const SIDEBAR_WIDTH = 340
const SAVE_DELAY_MS = 400
const VIEW_KEY = "ares.pathView"

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
  const [tool, setTool] = useState<Tool>({ kind: "select" })
  const [guess, setGuess] = useState<Trajectory | null>(null)
  const [guessError, setGuessError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<{ result: PlanResult | null; trajectory: Trajectory; key: string } | null>(null)
  const [genState, setGenState] = useState<{ kind: "idle" } | { kind: "running" } | { kind: "error"; message: string }>({ kind: "idle" })
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [fitSignal, setFitSignal] = useState(0)
  const [saveNote, setSaveNote] = useState<string>("")
  const [view, setView] = useState<ViewOptions>(() => loadView())
  // Bumped on every committed edit (a drag's end, a typed value): that is
  // what saves. Drags in progress only re-time the guess.
  const [commit, setCommit] = useState(0)
  const [fieldCommit, setFieldCommit] = useState(0)

  useEffect(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)) } catch { /* nothing to remember */ } }, [view])

  const spec = current?.spec ?? null
  const n = spec?.waypoints.length ?? 0
  const genKey = (s: PathSpec | null) => (s ? JSON.stringify([s, fieldDoc, robot]) : "")
  const stale = !!generated && generated.key !== genKey(spec)
  const shown = generated?.trajectory ?? guess
  const topSpeed = usableSpeed(robot)

  // --- Files -----------------------------------------------------------------
  const refresh = useCallback(async () => {
    const list = await invoke<PathEntry[]>("paths_list", { robotPath })
    setEntries(list)
    return list
  }, [robotPath])

  const loadPath = useCallback(async (s: PathSpec) => {
    setCurrent({ spec: s, savedName: s.name })
    setSelected(null)
    setPlayhead(null)
    setPlaying(false)
    setGenState({ kind: "idle" })
    // The trajectory saved with it, if any: shown until the path changes.
    const traj = await invoke<Trajectory | null>("trajectory_open", { robotPath, name: s.name }).catch(() => null)
    setGenerated(traj ? { result: null, trajectory: traj, key: JSON.stringify([s, fieldDocRef.current, robot]) } : null)
  }, [robotPath, robot])

  const fieldDocRef = useRef(fieldDoc)
  fieldDocRef.current = fieldDoc

  useEffect(() => {
    setCurrent(null)
    setGenerated(null)
    invoke<FieldDoc>("field_open", { robotPath }).then(f => { setFieldDoc(f); fieldDocRef.current = f })
      .then(() => refresh())
      .then(list => {
        const first = list.find(e => e.spec)
        if (first?.spec) loadPath(first.spec)
      })
  }, [robotPath])

  const createPath = () => {
    const taken = new Set(entries.map(e => e.name.toLowerCase()))
    let name = "New path"
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `New path ${i}`
    setCurrent({ spec: newPathSpec(name), savedName: null })
    setGenerated(null)
    setSelected(null)
    setCommit(c => c + 1)
  }

  const deletePath = async () => {
    if (!current) return
    if (!window.confirm(`Delete "${current.spec.name}" and its trajectory?`)) return
    if (current.savedName) await invoke("path_delete", { robotPath, name: current.savedName })
    setCurrent(null)
    setGenerated(null)
    const list = await refresh()
    const first = list.find(e => e.spec)
    if (first?.spec) loadPath(first.spec)
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

  // --- The guess, live -------------------------------------------------------
  // One request in flight at a time: while it runs, newer edits only replace
  // the pending one, so a fast drag never piles up work behind the cursor.
  const timing = useRef<{ busy: boolean; pending: { robot: RobotConfig; spec: PathSpec } | null }>({ busy: false, pending: null })
  const requestGuess = useCallback((req: { robot: RobotConfig; spec: PathSpec }) => {
    const q = timing.current
    if (q.busy) { q.pending = req; return }
    q.busy = true
    invoke<Trajectory>("path_time", req)
      .then(t => { setGuess(t); setGuessError(null) })
      .catch(e => { setGuess(null); setGuessError(String(e)) })
      .finally(() => {
        q.busy = false
        const next = q.pending
        q.pending = null
        if (next) requestGuess(next)
      })
  }, [])
  const specKey = spec ? JSON.stringify(spec) : ""
  useEffect(() => {
    if (!spec) { setGuess(null); return }
    requestGuess({ robot, spec })
  }, [specKey, JSON.stringify(robot)])

  // --- Generate --------------------------------------------------------------
  const genReq = useRef(0)
  const generate = () => {
    if (!spec || genState.kind === "running") return
    const id = ++genReq.current
    const key = genKey(spec)
    setGenState({ kind: "running" })
    invoke<PlanResult>("path_plan", { robot, spec, field: fieldDoc, fieldSize, robotPath })
      .then(result => {
        if (id !== genReq.current) return
        setGenerated({ result, trajectory: result.trajectory, key })
        setGenState({ kind: "idle" })
        setPlayhead(null)
      })
      .catch(e => { if (id === genReq.current) setGenState({ kind: "error", message: String(e) }) })
  }

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
  const editConstraint = (i: number, patch: Partial<ScopedConstraint>, final: boolean) =>
    editSpec(s => ({ ...s, scoped: s.scoped.map((c, j) => (j === i ? ({ ...c, ...patch } as ScopedConstraint) : c)) }), final)
  const editEvent = (i: number, patch: Partial<EventMarker>) =>
    editSpec(s => ({ ...s, events: (s.events ?? []).map((e, j) => (j === i ? { ...e, ...patch } : e)) }), true)

  const setKind = (i: number, kind: WaypointKind) => {
    if (!spec) return
    if (kind === "empty" && (i === 0 || i === n - 1)) { setSaveNote("The first and last waypoints cannot be empty"); return }
    editWaypoint(i, w => {
      if (kind === "pose") return { ...w, kind, headingDeg: w.headingDeg ?? Math.round(headingAt(shown, w) * 10) / 10 }
      const { headingDeg: _, ...rest } = w
      return { ...rest, kind }
    }, true)
  }

  const addWaypoint = (x: number, y: number, kind: WaypointKind) => {
    if (!spec) return
    // Near a segment: insert into it. Elsewhere: extend the path.
    const ws = spec.waypoints
    let best = -1, bestD = 0.6
    for (let i = 0; i + 1 < ws.length; i++) {
      const d = distToSegment(x, y, ws[i], ws[i + 1])
      if (d < bestD) { bestD = d; best = i }
    }
    const at = best >= 0 ? best + 1 : ws.length
    // An empty waypoint cannot be the last one.
    const k = kind === "empty" && at === ws.length ? "translation" : kind
    const w: Waypoint = k === "pose" ? { x, y, kind: k, headingDeg: 0 } : { x, y, kind: k }
    editSpec(s => ({ ...s, ...afterInsert(s, at), waypoints: [...s.waypoints.slice(0, at), w, ...s.waypoints.slice(at)] }), true)
    setSelected({ kind: "waypoint", index: at })
  }

  const removeSelected = () => {
    if (!spec || !selected) return
    if (selected.kind === "waypoint" && n > 2) {
      const at = selected.index
      editSpec(s => ({ ...s, ...afterRemove(s, at), waypoints: s.waypoints.filter((_, j) => j !== at) }), true)
    } else if (selected.kind === "constraint") {
      editSpec(s => ({ ...s, scoped: s.scoped.filter((_, j) => j !== selected.index) }), true)
    } else if (selected.kind === "event") {
      editSpec(s => ({ ...s, events: (s.events ?? []).filter((_, j) => j !== selected.index) }), true)
    } else if (selected.kind === "keepout") {
      editField(f => ({ ...f, keepOut: f.keepOut.filter((_, j) => j !== selected.index) }), true)
    } else return
    setSelected(null)
  }

  const editField = (f: (d: FieldDoc) => FieldDoc, final: boolean) => {
    setFieldDoc(d => f(d))
    if (final) setFieldCommit(c => c + 1)
  }
  const editKeepOut = (i: number, patch: Partial<KeepOut>, final: boolean) =>
    editField(d => ({ ...d, keepOut: d.keepOut.map((k, j) => (j === i ? { ...k, ...patch } : k)) }), final)

  // Constraint tool: first click picks the start, second the end (the same
  // waypoint twice for a single-waypoint constraint).
  const onWaypointClick = (i: number) => {
    if (!spec) return
    if (tool.kind === "event") {
      const events = spec.events ?? []
      const name = `Event ${events.length + 1}`
      editSpec(s => ({ ...s, events: [...(s.events ?? []), { name, target: targetOf(i, n), offsetS: 0 }] }), true)
      setSelected({ kind: "event", index: events.length })
      setTool({ kind: "select" })
      return
    }
    if (tool.kind !== "constraint") return
    const meta = constraintMeta(tool.type)
    if (tool.from === null && meta.scope !== "waypoint") { setTool({ ...tool, from: i }); return }
    const from = tool.from ?? i
    const [a, b] = [Math.min(from, i), Math.max(from, i)]
    if (meta.scope === "segment" && a === b) { setSaveNote(`${meta.label} needs a segment: click two different waypoints`); return }
    const mid = spec.waypoints.slice(a, b + 1)
    const cx = mid.reduce((acc, w) => acc + w.x, 0) / mid.length
    const cy = mid.reduce((acc, w) => acc + w.y, 0) / mid.length
    const c = newConstraint(tool.type, targetOf(a, n), a === b ? undefined : targetOf(b, n), cx, cy)
    editSpec(s => ({ ...s, scoped: [...s.scoped, c] }), true)
    setSelected({ kind: "constraint", index: spec.scoped.length })
    setTool({ kind: "select" })
  }

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

  // Keys, Choreo's where it has one.
  const keysRef = useRef({ removeSelected, togglePlay, generate, setKind, selected })
  keysRef.current = { removeSelected, togglePlay, generate, setKind, selected }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === "g") { e.preventDefault(); keysRef.current.generate(); return }
      if (e.ctrlKey || e.metaKey) return
      const kinds: Record<string, WaypointKind> = { "1": "pose", "2": "translation", "3": "empty", "!": "pose", "@": "translation", "#": "empty" }
      const code = e.code === "Digit1" ? "1" : e.code === "Digit2" ? "2" : e.code === "Digit3" ? "3" : null
      if (code && e.shiftKey) {
        const sel = keysRef.current.selected
        if (sel?.kind === "waypoint") keysRef.current.setKind(sel.index, kinds[code])
        return
      }
      if (code) { setTool({ kind: "waypoint", type: kinds[code] }); return }
      if (k === "v" || k === "escape") setTool({ kind: "select" })
      else if (k === "e") setTool({ kind: "event" })
      else if (k === "k") setTool({ kind: "keepout" })
      else if (k === "f") setFitSignal(s => s + 1)
      else if (k === "delete" || k === "backspace") keysRef.current.removeSelected()
      else if (k === " ") { e.preventDefault(); keysRef.current.togglePlay() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // --- Numbers for the result panel ------------------------------------------
  const traj = generated?.trajectory ?? null
  const stats = useMemo(() => {
    if (!traj) return null
    let peakA = 0, peakGrip = 0, top = 0
    for (const s of traj.samples) {
      top = Math.max(top, Math.hypot(s.vx, s.vy))
      for (const m of s.modules) {
        peakA = Math.max(peakA, Math.abs(m.currentA))
        peakGrip = Math.max(peakGrip, m.gripUsed)
      }
    }
    return { peakA, peakGrip, top }
  }, [traj])

  const wp = selected?.kind === "waypoint" && spec ? spec.waypoints[selected.index] : null
  const sc = selected?.kind === "constraint" && spec ? spec.scoped[selected.index] : null
  const ev = selected?.kind === "event" && spec ? (spec.events ?? [])[selected.index] : null
  const ko = selected?.kind === "keepout" ? fieldDoc.keepOut[selected.index] : null

  const toolHint =
    tool.kind === "constraint"
      ? tool.from === null
        ? constraintMeta(tool.type).scope === "waypoint" ? `${constraintMeta(tool.type).label}: click a waypoint.` : `${constraintMeta(tool.type).label}: click the first waypoint.`
        : `${constraintMeta(tool.type).label}: click the last waypoint (the same one for just that waypoint). Esc cancels.`
      : tool.kind === "event" ? "Event: click the waypoint it is timed from."
      : tool.kind === "waypoint" ? `${cap(tool.type)} waypoint: click near the path to insert, elsewhere to extend it.`
      : tool.kind === "keepout" ? "Keep-out: click to place a circle the robot must avoid on every path."
      : null

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ width: SIDEBAR_WIDTH, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <PageHeader eyebrow="Paths" title={spec?.name ?? "No path"} subtitle={saveNote || `${entries.length} in this project`} />
        <div className="ares-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <Panel title="Paths" icon="ti-route">
            <div style={{ maxHeight: 160, overflowY: "auto" }}>
              {entries.length === 0 && !current && <Empty>No paths yet.</Empty>}
              {entries.map(e => (
                <Row key={e.name} active={current?.savedName === e.name} onClick={() => e.spec && loadPath(e.spec)} title={e.error ?? undefined}
                  icon={e.error ? "ti-alert-triangle" : "ti-route"} danger={!!e.error}>
                  {e.name}
                </Row>
              ))}
              {current && current.savedName === null && <Row active icon="ti-route">{current.spec.name}</Row>}
            </div>
            <Buttons>
              <MiniButton onClick={createPath}>New</MiniButton>
              <MiniButton onClick={deletePath}>Delete</MiniButton>
            </Buttons>
          </Panel>

          {spec && (
            <Panel title="Path" icon="ti-settings">
              <PropertyRow label="Name">
                <NameInput value={spec.name} onCommit={name => editSpec(s => ({ ...s, name }), true)} />
              </PropertyRow>
              <Q label="Max speed" dim="plain" unit="m/s" optional value={spec.constraints.maxVelocityMps}
                onChange={v => editSpec(s => ({ ...s, constraints: { ...s.constraints, maxVelocityMps: v } }), true)} hint="On the whole path. Empty: what the robot can do" />
              <Q label="Max rotation" dim="plain" unit="°/s" optional value={spec.constraints.maxAngularVelocityDps}
                onChange={v => editSpec(s => ({ ...s, constraints: { ...s.constraints, maxAngularVelocityDps: v } }), true)} hint="On the whole path. Empty: what the robot can do" />
            </Panel>
          )}

          {wp && selected?.kind === "waypoint" && spec && (
            <Panel title={`Waypoint ${selected.index + 1} of ${n}`} icon="ti-map-pin">
              <PropertyRow label="Type">
                <select style={propertyInputStyle} value={kindOf(wp)} onChange={e => setKind(selected.index, e.target.value as WaypointKind)}>
                  <option value="pose">Pose (position + heading)</option>
                  <option value="translation">Translation (position)</option>
                  <option value="empty" disabled={selected.index === 0 || selected.index === n - 1}>Empty (shapes the guess)</option>
                </select>
              </PropertyRow>
              <Q label="X" dim="length" unit="m" value={wp.x} onChange={v => editWaypoint(selected.index, { x: v }, true)} />
              <Q label="Y" dim="length" unit="m" value={wp.y} onChange={v => editWaypoint(selected.index, { y: v }, true)} />
              {kindOf(wp) === "pose" && (
                <Q label="Heading" dim="plain" unit="°" value={wp.headingDeg} onChange={v => editWaypoint(selected.index, { headingDeg: v }, true)} />
              )}
              {selected.index < n - 1 && (
                <PropertyRow label="Samples to next">
                  <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }} title="Override how many intervals the optimizer uses up to the next waypoint. More is finer and slower to solve.">
                    <input type="checkbox" checked={wp.intervals !== undefined}
                      onChange={e => editWaypoint(selected.index, w => {
                        if (!e.target.checked) { const { intervals: _, ...rest } = w; return rest }
                        return { ...w, intervals: guessIntervals(shown, selected.index) }
                      }, true)} />
                    {wp.intervals !== undefined
                      ? <QInput dim="plain" integer value={wp.intervals} onChange={v => editWaypoint(selected.index, { intervals: Math.max(1, Math.round(v)) }, true)} />
                      : <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>automatic</span>}
                  </div>
                </PropertyRow>
              )}
              {selected.index > 0 && selected.index < n - 1 && (
                <PropertyRow label="Split here">
                  <input type="checkbox" checked={!!wp.split} onChange={e => editWaypoint(selected.index, { split: e.target.checked || undefined }, true)} />
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>the robot code can run each part</span>
                </PropertyRow>
              )}
              <Buttons><MiniButton onClick={removeSelected}>Delete waypoint</MiniButton></Buttons>
            </Panel>
          )}

          {sc && selected?.kind === "constraint" && spec && (
            <ConstraintPanel c={sc} n={n} onChange={(patch, final) => editConstraint(selected.index, patch, final)} onDelete={removeSelected} />
          )}

          {ev && selected?.kind === "event" && spec && (
            <Panel title="Event marker" icon="ti-map-pin-bolt">
              <PropertyRow label="Name">
                <NameInput value={ev.name} onCommit={name => editEvent(selected.index, { name })} />
              </PropertyRow>
              <PropertyRow label="From waypoint">
                <TargetSelect value={ev.target} n={n} onChange={target => editEvent(selected.index, { target })} />
              </PropertyRow>
              <Q label="Offset" dim="plain" unit="s" value={ev.offsetS} onChange={v => editEvent(selected.index, { offsetS: v })} hint="Negative fires before the waypoint" />
              {traj?.events?.[selected.index] && !stale && (
                <Stat label="Fires at" value={`${traj.events[selected.index].t.toFixed(3)} s`} />
              )}
              <Buttons><MiniButton onClick={removeSelected}>Delete event</MiniButton></Buttons>
            </Panel>
          )}

          {ko && selected?.kind === "keepout" && (
            <Panel title={`Keep-out ${selected.index + 1} (every path)`} icon="ti-circle-off">
              <Q label="X" dim="length" unit="m" value={ko.x} onChange={v => editKeepOut(selected.index, { x: v }, true)} />
              <Q label="Y" dim="length" unit="m" value={ko.y} onChange={v => editKeepOut(selected.index, { y: v }, true)} />
              <Q label="Radius" dim="length" unit="m" value={ko.radiusM} onChange={v => editKeepOut(selected.index, { radiusM: v }, true)} />
              <Buttons><MiniButton onClick={removeSelected}>Delete keep-out</MiniButton></Buttons>
            </Panel>
          )}

          {spec && (
            <Panel title={`Constraints (${spec.scoped.length})`} icon="ti-adjustments-alt">
              {spec.scoped.length === 0 && <Empty>None. Add one from the toolbar.</Empty>}
              {spec.scoped.map((c, i) => {
                const meta = constraintMeta(c.type)
                const [a, b] = rangeOf(c, n)
                return (
                  <Row key={i} active={selected?.kind === "constraint" && selected.index === i} onClick={() => setSelected({ kind: "constraint", index: i })}
                    icon={meta.icon} dim={c.enabled === false}
                    right={<span style={{ fontSize: 10, opacity: 0.8 }}>{a === b ? `#${a + 1}` : `#${a + 1}–#${b + 1}`}</span>}>
                    {meta.label}{summary(c)}
                  </Row>
                )
              })}
            </Panel>
          )}

          {spec && (
            <Panel title={`Event markers (${(spec.events ?? []).length})`} icon="ti-map-pin-bolt">
              {(spec.events ?? []).length === 0 && <Empty>None. Use the Event tool (E) and click a waypoint.</Empty>}
              {(spec.events ?? []).map((e, i) => (
                <Row key={i} active={selected?.kind === "event" && selected.index === i} onClick={() => setSelected({ kind: "event", index: i })} icon="ti-map-pin-bolt"
                  right={<span style={{ fontSize: 10, opacity: 0.8 }}>{targetLabel(e.target)} {e.offsetS >= 0 ? "+" : ""}{e.offsetS.toFixed(2)} s</span>}>
                  {e.name}
                </Row>
              ))}
            </Panel>
          )}

          <Panel title="Result" icon="ti-chart-line">
            {traj ? (
              <>
                {stale && <div style={{ padding: "5px 10px", fontSize: 11, color: "var(--status-warning)", background: "var(--status-warning-bg)" }}>Out of date: generate again (Ctrl+G).</div>}
                <Stat label="Time" value={`${traj.durationS.toFixed(3)} s`} strong />
                {generated?.result && (
                  <Stat label="Guess (spline)" value={`${generated.result.splineDurationS.toFixed(3)} s`}
                    note={`${(100 * (1 - traj.durationS / generated.result.splineDurationS)).toFixed(0)}% faster`} />
                )}
                <Stat label="Top speed" value={`${stats!.top.toFixed(2)} m/s`} />
                <Stat label="Peak drive current" value={`${stats!.peakA.toFixed(0)} A`} />
                <Stat label="Peak grip" value={`${(100 * stats!.peakGrip).toFixed(0)} %`} />
                <Stat label="Samples" value={`${traj.samples.length}`} note={(traj.splits?.length ?? 0) > 0 ? `${(traj.splits?.length ?? 0) + 1} parts` : undefined} />
                {generated?.result && <Stat label="Solved in" value={`${generated.result.solveMs.toFixed(0)} ms`} note={`${generated.result.iterations} iterations`} />}
              </>
            ) : (
              <div style={{ padding: 10, fontSize: 11, color: genState.kind === "error" || guessError ? "var(--status-error)" : "var(--text-muted)", lineHeight: 1.5 }}>
                {genState.kind === "error" ? genState.message : guessError ?? (guess ? `Guess: ${guess.durationS.toFixed(3)} s. Press Generate (Ctrl+G).` : "No path open.")}
              </div>
            )}
            {traj && genState.kind === "error" && (
              <div style={{ padding: "5px 10px", fontSize: 11, color: "var(--status-error)" }}>{genState.message}</div>
            )}
          </Panel>

          <Panel title="View" icon="ti-eye">
            <PropertyRow label="Gradient">
              <select style={propertyInputStyle} value={view.gradient} title={GRADIENTS.find(g => g.id === view.gradient)?.hint}
                onChange={e => setView(v => ({ ...v, gradient: e.target.value as ViewOptions["gradient"] }))}>
                {GRADIENTS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </PropertyRow>
            {([
              ["field", "Field image"], ["grid", "Grid (1 m)"], ["guess", "Guess (spline)"], ["trajectory", "Trajectory"],
              ["samples", "Samples"], ["waypoints", "Waypoints"], ["flipped", "Flipped (other alliance)"],
            ] as [keyof ViewOptions, string][]).map(([key, label]) => (
              <PropertyRow key={key} label={label}>
                <input type="checkbox" checked={view[key] as boolean} onChange={e => setView(v => ({ ...v, [key]: e.target.checked }))} />
              </PropertyRow>
            ))}
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
            <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <Toggle on={tool.kind === "select"} onClick={() => setTool({ kind: "select" })} icon="ti-pointer" label="Select" />
              <Sep />
              <Toggle on={tool.kind === "waypoint" && tool.type === "pose"} onClick={() => setTool({ kind: "waypoint", type: "pose" })} icon="ti-navigation" label="Pose (1)" />
              <Toggle on={tool.kind === "waypoint" && tool.type === "translation"} onClick={() => setTool({ kind: "waypoint", type: "translation" })} icon="ti-circle-filled" label="Translation (2)" />
              <Toggle on={tool.kind === "waypoint" && tool.type === "empty"} onClick={() => setTool({ kind: "waypoint", type: "empty" })} icon="ti-circle-dashed" label="Empty (3)" />
              <Sep />
              <ConstraintMenu active={tool.kind === "constraint" ? tool.type : null} onPick={type => setTool({ kind: "constraint", type, from: null })} />
              <Toggle on={tool.kind === "event"} onClick={() => setTool({ kind: "event" })} icon="ti-map-pin-bolt" label="Event (E)" />
              <Toggle on={tool.kind === "keepout"} onClick={() => setTool({ kind: "keepout" })} icon="ti-circle-off" label="Keep-out (K)" />
            </span>
          }
          action={
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Toggle on={false} onClick={() => setFitSignal(s => s + 1)} icon="ti-maximize" label="Fit" />
              <GenerateButton state={genState.kind} stale={stale || !generated} onClick={generate} />
            </span>
          }
        />
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          <FieldView
            field={field}
            robot={robot}
            spec={spec}
            guess={guess}
            generated={traj}
            stale={stale}
            keepOut={fieldDoc.keepOut}
            selected={selected}
            tool={tool}
            view={view}
            topSpeed={topSpeed}
            playhead={playhead}
            fitSignal={fitSignal}
            onSelect={setSelected}
            onMoveWaypoint={(i, x, y, final) => editWaypoint(i, { x, y }, final)}
            onRotateWaypoint={(i, h, final) => editWaypoint(i, { headingDeg: h }, final)}
            onFieldClick={(x, y) => {
              if (tool.kind === "waypoint") addWaypoint(x, y, tool.type)
              else if (tool.kind === "keepout") {
                editField(d => ({ ...d, keepOut: [...d.keepOut, { x, y, radiusM: 0.5 }] }), true)
                setSelected({ kind: "keepout", index: fieldDoc.keepOut.length })
                setTool({ kind: "select" })
              }
            }}
            onWaypointClick={onWaypointClick}
            onMoveKeepOut={(i, x, y, final) => editKeepOut(i, { x, y }, final)}
            onResizeKeepOut={(i, r, final) => editKeepOut(i, { radiusM: r }, final)}
            onEditConstraint={editConstraint}
          />
          {toolHint && (
            <div style={{ position: "absolute", left: 12, top: 8, fontSize: 11, background: "rgba(255,255,255,0.92)", border: "1px solid var(--border-main)", padding: "3px 8px", color: "var(--text-primary)" }}>
              {toolHint}
            </div>
          )}
          {traj && view.trajectory && view.gradient !== "none" && view.gradient !== "splits" && (
            <div style={{ position: "absolute", right: 12, bottom: 12, background: "rgba(255,255,255,0.92)", border: "1px solid var(--border-main)", padding: "5px 8px", fontSize: 10, color: "var(--text-secondary)" }}>
              <div style={{ marginBottom: 3 }}>{GRADIENTS.find(g => g.id === view.gradient)?.label}</div>
              <div style={{ width: 150, height: 6, background: RAMP_CSS }} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                <span>{view.gradient === "interval" ? "long Δt" : view.gradient === "progress" ? "start" : "0"}</span>
                <span>{legendTop(view.gradient, topSpeed)}</span>
              </div>
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
          label={traj ? (stale ? "generated (out of date)" : "generated") : guess ? "guess" : ""}
        />
      </div>
    </div>
  )
}

// --- Pieces --------------------------------------------------------------------

function ConstraintPanel({ c, n, onChange, onDelete }: {
  c: ScopedConstraint; n: number; onChange: (patch: Partial<ScopedConstraint>, final: boolean) => void; onDelete: () => void
}) {
  const meta = constraintMeta(c.type)
  const set = (patch: Record<string, unknown>) => onChange(patch as Partial<ScopedConstraint>, true)
  return (
    <Panel title={meta.label} icon={meta.icon}>
      <div style={{ padding: "5px 10px", fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.45, borderBottom: "1px solid var(--border-light)" }}>{meta.hint}</div>
      <PropertyRow label="Enabled">
        <input type="checkbox" checked={c.enabled !== false} onChange={e => set({ enabled: e.target.checked ? undefined : false })} />
      </PropertyRow>
      <PropertyRow label={meta.scope === "waypoint" ? "Waypoint" : "From"}>
        <TargetSelect value={c.from} n={n} onChange={from => set({ from })} />
      </PropertyRow>
      {meta.scope !== "waypoint" && (
        <PropertyRow label="To">
          <TargetSelect value={c.to} n={n} allowNone={meta.scope === "both"} onChange={to => set({ to })} />
        </PropertyRow>
      )}
      {c.type === "maxVelocity" && <Q label="Max velocity" dim="plain" unit="m/s" value={c.mps} onChange={v => set({ mps: v })} />}
      {c.type === "maxAcceleration" && <Q label="Max acceleration" dim="plain" unit="m/s²" value={c.mps2} onChange={v => set({ mps2: v })} />}
      {c.type === "maxAngularVelocity" && <Q label="Max angular velocity" dim="plain" unit="°/s" value={c.dps} onChange={v => set({ dps: v })} />}
      {c.type === "pointAt" && (
        <>
          <Q label="Target X" dim="length" unit="m" value={c.x} onChange={v => set({ x: v })} />
          <Q label="Target Y" dim="length" unit="m" value={c.y} onChange={v => set({ y: v })} />
          <Q label="Tolerance" dim="plain" unit="°" value={c.toleranceDeg} onChange={v => set({ toleranceDeg: v })} />
          <PropertyRow label="Face">
            <select style={propertyInputStyle} value={c.flip ? "back" : "front"} onChange={e => set({ flip: e.target.value === "back" })}>
              <option value="front">Front toward it</option>
              <option value="back">Back toward it</option>
            </select>
          </PropertyRow>
        </>
      )}
      {(c.type === "keepInCircle" || c.type === "keepOutCircle") && (
        <>
          <Q label="Center X" dim="length" unit="m" value={c.x} onChange={v => set({ x: v })} />
          <Q label="Center Y" dim="length" unit="m" value={c.y} onChange={v => set({ y: v })} />
          <Q label="Radius" dim="length" unit="m" value={c.radiusM} onChange={v => set({ radiusM: v })} />
        </>
      )}
      {c.type === "keepInRectangle" && (
        <>
          <Q label="X (left)" dim="length" unit="m" value={c.x} onChange={v => set({ x: v })} />
          <Q label="Y (bottom)" dim="length" unit="m" value={c.y} onChange={v => set({ y: v })} />
          <Q label="Width" dim="length" unit="m" value={c.widthM} onChange={v => set({ widthM: v })} />
          <Q label="Height" dim="length" unit="m" value={c.heightM} onChange={v => set({ heightM: v })} />
        </>
      )}
      {c.type === "keepInLane" && <Q label="Tolerance" dim="length" unit="m" value={c.toleranceM} onChange={v => set({ toleranceM: v })} />}
      <Buttons><MiniButton onClick={onDelete}>Delete constraint</MiniButton></Buttons>
    </Panel>
  )
}

function TargetSelect({ value, n, onChange, allowNone }: { value: Target | undefined; n: number; onChange: (t: Target | undefined) => void; allowNone?: boolean }) {
  const enc = (t: Target | undefined) => (t === undefined ? "none" : typeof t === "string" ? t : `i:${t.index}`)
  const dec = (s: string): Target | undefined => (s === "none" ? undefined : s === "first" || s === "last" ? s : { index: Number(s.slice(2)) })
  return (
    <select style={propertyInputStyle} value={enc(value)} onChange={e => onChange(dec(e.target.value))}>
      {allowNone && <option value="none">— (just the first waypoint)</option>}
      <option value="first">First (follows the start)</option>
      <option value="last">Last (follows the end)</option>
      {Array.from({ length: n }, (_, i) => <option key={i} value={`i:${i}`}>Waypoint {i + 1}</option>)}
    </select>
  )
}

function ConstraintMenu({ active, onPick }: { active: ConstraintType | null; onPick: (t: ConstraintType) => void }) {
  const [open, setOpen] = useState(false)
  const meta = active ? constraintMeta(active) : null
  return (
    <span style={{ position: "relative" }}>
      <Toggle on={!!active} onClick={() => setOpen(o => !o)} icon={meta?.icon ?? "ti-adjustments-alt"} label={meta ? meta.label : "Constraint ▾"} />
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: 28, left: 0, zIndex: 31, minWidth: 230, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "2px 2px 0 var(--shadow-soft)", padding: "3px 0" }}>
            {CONSTRAINTS.map(c => (
              <div key={c.type} title={c.hint}
                onClick={() => { setOpen(false); onPick(c.type) }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--tree-hover-bg)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>
                <i className={`ti ${c.icon}`} style={{ color: COLORS.constraint }} />
                <span>{c.label}</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)" }}>{c.scope === "both" ? "point or segment" : c.scope}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  )
}

function GenerateButton({ state, stale, onClick }: { state: string; stale: boolean; onClick: () => void }) {
  const running = state === "running"
  return (
    <button
      onClick={onClick}
      disabled={running}
      title="Generate the trajectory (Ctrl+G)"
      style={{
        display: "flex", alignItems: "center", gap: 6, height: 26, padding: "0 12px", fontSize: 11.5, fontWeight: 600, cursor: running ? "default" : "pointer",
        border: "1px solid", borderRadius: 2,
        borderColor: stale ? "#2a4fb8" : "var(--btn-classic-border)",
        background: running ? "var(--btn-classic-bg)" : stale ? "#2f6fdb" : "var(--btn-classic-bg)",
        color: running ? "var(--text-secondary)" : stale ? "#ffffff" : "var(--text-primary)",
      }}
    >
      <i className={`ti ${running ? "ti-loader-2" : "ti-wand"}`} />
      {running ? "Generating…" : "Generate"}
    </button>
  )
}

function PlaybackBar({ duration, playhead, playing, onToggle, onScrub, enabled, label }: {
  duration: number; playhead: number | null; playing: boolean; onToggle: () => void; onScrub: (t: number) => void; enabled: boolean; label: string
}) {
  const t = playhead ?? 0
  return (
    <div style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", background: "var(--bg-menubar)", borderTop: "1px solid var(--border-main)", opacity: enabled ? 1 : 0.5 }}>
      <button onClick={onToggle} disabled={!enabled} title="Play (Space)"
        style={{ width: 30, height: 26, border: "1px solid var(--btn-classic-border)", background: "var(--btn-classic-bg)", borderRadius: 2, cursor: "pointer" }}>
        <i className={`ti ${playing ? "ti-player-pause-filled" : "ti-player-play-filled"}`} />
      </button>
      <input type="range" min={0} max={duration || 1} step={0.005} value={Math.min(t, duration)} disabled={!enabled}
        onChange={e => onScrub(Number(e.target.value))} style={{ flex: 1 }} />
      <span style={{ fontSize: 10, color: "var(--text-muted)", width: 140, textAlign: "right" }}>{label}</span>
      <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11, width: 110, textAlign: "right", color: "var(--text-secondary)" }}>
        {t.toFixed(2)} / {duration.toFixed(2)} s
      </span>
    </div>
  )
}

function Row({ children, active, onClick, icon, title, danger, dim, right }: {
  children: ReactNode; active?: boolean; onClick?: () => void; icon: string; title?: string; danger?: boolean; dim?: boolean; right?: ReactNode
}) {
  return (
    <div onClick={onClick} title={title}
      style={{
        display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", fontSize: 11.5, cursor: onClick ? "pointer" : "default",
        background: active ? "var(--tree-selection-bg)" : "transparent",
        color: active ? "var(--tree-selection-fg)" : danger ? "var(--status-error)" : "var(--text-primary)",
        opacity: dim ? 0.5 : 1, borderBottom: "1px solid var(--border-light)",
      }}>
      <i className={`ti ${icon}`} style={{ fontSize: 13 }} aria-hidden />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{children}</span>
      {right}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div style={{ padding: 10, fontSize: 11, color: "var(--text-muted)" }}>{children}</div>
}

function Buttons({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", gap: 4, padding: 6, borderTop: "1px solid var(--border-light)" }}>{children}</div>
}

function Sep() {
  return <span style={{ width: 1, height: 18, background: "var(--border-main)", margin: "0 3px" }} />
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
    <input style={propertyInputStyle} value={text} onChange={e => setText(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
  )
}

// --- Helpers -------------------------------------------------------------------

function summary(c: ScopedConstraint): string {
  switch (c.type) {
    case "maxVelocity": return ` · ${c.mps} m/s`
    case "maxAcceleration": return ` · ${c.mps2} m/s²`
    case "maxAngularVelocity": return ` · ${c.dps} °/s`
    case "pointAt": return ` · (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`
    case "keepInCircle":
    case "keepOutCircle": return ` · r ${c.radiusM} m`
    case "keepInLane": return ` · ±${c.toleranceM} m`
    default: return ""
  }
}

function targetOf(i: number, n: number): Target {
  return i === 0 ? "first" : i === n - 1 ? "last" : { index: i }
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1)
}

function legendTop(g: ViewOptions["gradient"], top: number): string {
  if (g === "velocity") return `${top.toFixed(1)} m/s`
  if (g === "progress") return "end"
  if (g === "interval") return "short Δt"
  return "max"
}

/** The speed that colors as "fastest": the usable speed. */
function usableSpeed(robot: RobotConfig): number {
  const FREE_RPM: Record<string, number> = { kraken_x60: 6000, falcon500: 6380, neo: 5676, neo550: 11000, cim: 5330 }
  const d = robot.drivetrain
  return (FREE_RPM[d.driveMotor] ?? 6000) * Math.PI / 30 / d.driveGearRatio * d.wheelRadiusM * (d.maxSpeedFraction ?? 1)
}

/** A starting count for the samples override: what the guess implies at 50 ms. */
function guessIntervals(traj: Trajectory | null, i: number): number {
  const t = traj?.waypointTimes
  if (!t || t.length <= i + 1) return 20
  return Math.max(3, Math.ceil((t[i + 1] - t[i]) / 0.05))
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

function loadView(): ViewOptions {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw) return { ...DEFAULT_VIEW, ...JSON.parse(raw) }
  } catch { /* defaults */ }
  return DEFAULT_VIEW
}
