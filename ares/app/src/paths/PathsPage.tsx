import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import { renderTopView, TopView } from "../robot/topView"
import { Card, MiniButton, Q, Toggle } from "../ui/controls"
import FieldView, { RAMP_CSS } from "./FieldView"
import Sidebar, { IconButton } from "./Sidebar"
import ConfigPanel, { TextInput } from "./ConfigPanel"
import { StopIcon, WaypointIcon, GLYPH } from "./glyphs"
import {
  CONSTRAINTS, ConstraintType, DEFAULT_VIEW, EventMarker, FieldDoc, GRADIENTS, KeepOut, PathEntry, PathSpec, PlanResult,
  ScopedConstraint, Selection, Target, Tool, Trajectory, ViewOptions, Waypoint, WaypointKind, afterInsert, afterMove,
  afterRemove, constraintMeta, kindOf, newConstraint, newPathSpec, setWait, stopAt, toggleStop, waitAt,
} from "./types"

interface Props {
  robot: RobotConfig
  robotPath: string | null
  onSaveRobot: () => void
}

const SIDEBAR_WIDTH = 320
const SAVE_DELAY_MS = 400
const VIEW_KEY = "ares.pathView"
const HISTORY_LIMIT = 200

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
  const [hovered, setHovered] = useState<Selection>(null)
  const [tool, setTool] = useState<Tool>({ kind: "select" })
  const [guess, setGuess] = useState<Trajectory | null>(null)
  const [guessError, setGuessError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<{ result: PlanResult | null; trajectory: Trajectory; key: string } | null>(null)
  const [genState, setGenState] = useState<{ kind: "idle" } | { kind: "running" } | { kind: "error"; message: string }>({ kind: "idle" })
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [fitSignal, setFitSignal] = useState(0)
  const [note, setNote] = useState<string>("")
  const [view, setView] = useState<ViewOptions>(() => loadView())
  const [viewOpen, setViewOpen] = useState(false)
  // Bumped on every committed edit (a drag's end, a typed value): that is
  // what saves. Drags in progress only re-time the guess.
  const [commit, setCommit] = useState(0)
  const [fieldCommit, setFieldCommit] = useState(0)
  // Undo and redo over committed path states.
  const history = useRef<{ undo: PathSpec[]; redo: PathSpec[]; committed: PathSpec | null }>({ undo: [], redo: [], committed: null })
  const [, setHistoryTick] = useState(0)

  useEffect(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)) } catch { /* nothing to remember */ } }, [view])

  const spec = current?.spec ?? null
  const n = spec?.waypoints.length ?? 0
  const genKey = (s: PathSpec | null) => (s ? JSON.stringify([s, fieldDoc, robot]) : "")
  const stale = !!generated && generated.key !== genKey(spec)
  const shown = generated?.trajectory ?? guess
  const topSpeed = usableSpeed(robot)
  const fieldDocRef = useRef(fieldDoc)
  fieldDocRef.current = fieldDoc

  // The robot's STL from above, as the 2D robot.
  const [topView, setTopView] = useState<TopView | null>(null)
  const modelKey = JSON.stringify([robot.model, robot.bumper])
  useEffect(() => {
    if (!robot.model) { setTopView(null); return }
    let alive = true
    invoke<string>("resolve_model_path", { robotPath, modelPath: robot.model.path })
      .then(path => renderTopView(robot, path))
      .then(v => { if (alive) setTopView(v) })
      .catch(() => { if (alive) setTopView(null) })
    return () => { alive = false }
  }, [modelKey, robotPath])

  // --- Files -----------------------------------------------------------------
  const refresh = useCallback(async () => {
    const list = await invoke<PathEntry[]>("paths_list", { robotPath })
    setEntries(list)
    return list
  }, [robotPath])

  const loadPath = useCallback(async (s: PathSpec, savedName: string | null = s.name) => {
    setCurrent({ spec: s, savedName })
    history.current = { undo: [], redo: [], committed: s }
    setHistoryTick(t => t + 1)
    setSelected(null)
    setPlayhead(null)
    setPlaying(false)
    setGenState({ kind: "idle" })
    // The trajectory saved with it, if any: shown until the path changes.
    const traj = savedName ? await invoke<Trajectory | null>("trajectory_open", { robotPath, name: savedName }).catch(() => null) : null
    setGenerated(traj ? { result: null, trajectory: traj, key: JSON.stringify([s, fieldDocRef.current, robot]) } : null)
  }, [robotPath, robot])

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

  const uniqueName = (base: string) => {
    const taken = new Set(entries.map(e => e.name.toLowerCase()))
    let name = base
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`
    return name
  }
  const createPath = () => { loadPath(newPathSpec(uniqueName("New path")), null); setCommit(c => c + 1) }
  const duplicatePath = () => {
    if (!spec) return
    loadPath({ ...structuredClone(spec), name: uniqueName(`${spec.name} copy`) }, null)
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
        setNote("Saved")
        refresh()
      } catch (e) {
        setNote(String(e))
      }
    }, SAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [commit])

  useEffect(() => {
    if (!fieldCommit) return
    const t = setTimeout(() => { invoke("field_save", { robotPath, field: fieldDoc }).catch(e => setNote(String(e))) }, SAVE_DELAY_MS)
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
    setCurrent(c => {
      if (!c) return c
      const next = f(c.spec)
      if (final) {
        const h = history.current
        if (h.committed && JSON.stringify(h.committed) !== JSON.stringify(next)) {
          h.undo.push(h.committed)
          if (h.undo.length > HISTORY_LIMIT) h.undo.shift()
          h.redo = []
        }
        h.committed = next
      }
      return { ...c, spec: next }
    })
    if (final) { setCommit(c => c + 1); setHistoryTick(t => t + 1) }
  }
  const travel = (dir: "undo" | "redo") => {
    const h = history.current
    const from = dir === "undo" ? h.undo : h.redo
    const to = dir === "undo" ? h.redo : h.undo
    const target = from.pop()
    if (!target || !h.committed) return
    to.push(h.committed)
    h.committed = target
    setCurrent(c => (c ? { ...c, spec: target } : c))
    setSelected(null)
    setCommit(c => c + 1)
    setHistoryTick(t => t + 1)
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
    if (kind === "empty" && (i === 0 || i === n - 1)) { setNote("The first and last waypoints cannot be empty"); return }
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

  const deleteWaypoint = (at: number) => {
    if (n <= 2) return
    editSpec(s => ({ ...s, ...afterRemove(s, at), waypoints: s.waypoints.filter((_, j) => j !== at) }), true)
    setSelected(null)
  }
  const moveWaypoint = (from: number, to: number) => {
    editSpec(s => {
      const ws = [...s.waypoints]
      const [w] = ws.splice(from, 1)
      ws.splice(to, 0, w)
      // The ends cannot be empty.
      for (const e of [0, ws.length - 1]) if (kindOf(ws[e]) === "empty") ws[e] = { ...ws[e], kind: "translation" }
      return { ...s, ...afterMove(s, from, to), waypoints: ws }
    }, true)
    setSelected({ kind: "waypoint", index: to })
  }
  const deleteConstraint = (i: number) => { editSpec(s => ({ ...s, scoped: s.scoped.filter((_, j) => j !== i) }), true); setSelected(null) }
  const deleteEvent = (i: number) => { editSpec(s => ({ ...s, events: (s.events ?? []).filter((_, j) => j !== i) }), true); setSelected(null) }

  const removeSelected = () => {
    if (!selected) return
    if (selected.kind === "waypoint") deleteWaypoint(selected.index)
    else if (selected.kind === "constraint") deleteConstraint(selected.index)
    else if (selected.kind === "event") deleteEvent(selected.index)
    else if (selected.kind === "keepout") {
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

  // Constraint tool: first click picks the start, second the end (the same
  // waypoint twice for a single-waypoint constraint).
  const onWaypointClick = (i: number) => {
    if (!spec) return
    if (tool.kind === "event") {
      const events = spec.events ?? []
      editSpec(s => ({ ...s, events: [...(s.events ?? []), { name: `Event ${events.length + 1}`, target: targetOf(i, n), offsetS: 0 }] }), true)
      setSelected({ kind: "event", index: events.length })
      setTool({ kind: "select" })
      return
    }
    if (tool.kind !== "constraint") return
    const meta = constraintMeta(tool.type)
    if (tool.from === null && meta.scope !== "waypoint") { setTool({ ...tool, from: i }); return }
    const from = tool.from ?? i
    const [a, b] = [Math.min(from, i), Math.max(from, i)]
    if (meta.scope === "segment" && a === b) { setNote(`${meta.label} needs a segment: click two different waypoints`); return }
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
  const keysRef = useRef({ removeSelected, togglePlay, generate, setKind, selected, travel })
  keysRef.current = { removeSelected, togglePlay, generate, setKind, selected, travel }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return
      const k = e.key.toLowerCase()
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && k === "g") { e.preventDefault(); keysRef.current.generate(); return }
      if (ctrl && k === "z") { e.preventDefault(); keysRef.current.travel(e.shiftKey ? "redo" : "undo"); return }
      if (ctrl && k === "y") { e.preventDefault(); keysRef.current.travel("redo"); return }
      if (ctrl) return
      const kinds: Record<string, WaypointKind> = { "1": "pose", "2": "translation", "3": "empty" }
      const code = e.code === "Digit1" ? "1" : e.code === "Digit2" ? "2" : e.code === "Digit3" ? "3" : null
      if (code && e.shiftKey) {
        const sel = keysRef.current.selected
        if (sel?.kind === "waypoint") keysRef.current.setKind(sel.index, kinds[code])
        return
      }
      if (code) { setTool({ kind: "waypoint", type: kinds[code] }); return }
      if (k === "escape") { setTool({ kind: "select" }); setSelected(null) }
      else if (k === "v") setTool({ kind: "select" })
      else if (k === "e") setTool({ kind: "event" })
      else if (k === "k") setTool({ kind: "keepout" })
      else if (k === "f") setFitSignal(s => s + 1)
      else if (k === "delete" || k === "backspace") keysRef.current.removeSelected()
      else if (k === " ") { e.preventDefault(); keysRef.current.togglePlay() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // --- Numbers for the result strip -------------------------------------------
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

  const toolHint =
    tool.kind === "constraint"
      ? tool.from === null
        ? constraintMeta(tool.type).scope === "waypoint" ? `${constraintMeta(tool.type).label}: click a waypoint.` : `${constraintMeta(tool.type).label}: click the first waypoint.`
        : `${constraintMeta(tool.type).label}: click the last waypoint (the same one for just that waypoint). Esc cancels.`
      : tool.kind === "event" ? "Event: click the waypoint it is timed from. Esc cancels."
      : tool.kind === "waypoint" ? `${cap(tool.type)} waypoint: click near the path to insert, elsewhere to extend it. Esc to stop.`
      : tool.kind === "keepout" ? "Keep-out: click to place a circle every path must avoid."
      : null

  const h = history.current

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ width: SIDEBAR_WIDTH, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--border-light)" }}>
          <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4, display: "flex", alignItems: "center" }}>
            Path
            <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
              <IconButton icon="ti-arrow-back-up" title="Undo (Ctrl+Z)" onClick={() => travel("undo")} disabled={h.undo.length === 0} />
              <IconButton icon="ti-arrow-forward-up" title="Redo (Ctrl+Shift+Z)" onClick={() => travel("redo")} disabled={h.redo.length === 0} />
            </span>
          </div>
          {spec ? (
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              <TextInput value={spec.name} onCommit={name => editSpec(s => ({ ...s, name }), true)} />
            </div>
          ) : <div style={{ fontSize: 15, fontWeight: 600 }}>No path</div>}
          <div style={{ fontSize: 10, color: note.startsWith("Saved") || !note ? "var(--text-header-subtitle)" : "var(--status-error)", marginTop: 5 }}>
            {note || `${entries.length} in this project`}
          </div>
        </div>
        <Sidebar
          entries={entries}
          activeName={current?.savedName ?? null}
          unsavedName={current && current.savedName === null ? current.spec.name : null}
          spec={spec}
          selected={selected}
          onOpen={e => e.spec && loadPath(e.spec)}
          onNewPath={createPath}
          onDuplicatePath={duplicatePath}
          onDeletePath={deletePath}
          onSelect={setSelected}
          onHover={setHovered}
          onSetKind={setKind}
          onToggleStop={i => editSpec(s => toggleStop(s, i), true)}
          onMoveWaypoint={moveWaypoint}
          onDeleteWaypoint={deleteWaypoint}
          onToggleConstraint={i => editSpec(s => ({ ...s, scoped: s.scoped.map((c, j) => (j === i ? { ...c, enabled: c.enabled === false ? undefined : false } : c)) }), true)}
          onDeleteConstraint={deleteConstraint}
          onDeleteEvent={deleteEvent}
        >
          {spec && (
            <>
              <SectionHeading label="Path limits" />
              <Q label="Max speed" dim="plain" unit="m/s" optional value={spec.constraints.maxVelocityMps}
                onChange={v => editSpec(s => ({ ...s, constraints: { ...s.constraints, maxVelocityMps: v } }), true)} hint="On the whole path. Empty: what the robot can do" />
              <Q label="Max rotation" dim="plain" unit="°/s" optional value={spec.constraints.maxAngularVelocityDps}
                onChange={v => editSpec(s => ({ ...s, constraints: { ...s.constraints, maxAngularVelocityDps: v } }), true)} hint="On the whole path. Empty: what the robot can do" />
              <SectionHeading label="Field" />
              <PropertyRow label="Walls">
                <input type="checkbox" checked={fieldDoc.walls} onChange={e => editField(d => ({ ...d, walls: e.target.checked }), true)} />
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>{fieldSize.lengthM} × {fieldSize.widthM} m</span>
              </PropertyRow>
              <PropertyRow label="Keep-outs">
                <span style={{ fontSize: 11 }}>{fieldDoc.keepOut.length}</span>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>shared by every path (K to add)</span>
              </PropertyRow>
            </>
          )}
        </Sidebar>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 4, padding: "0 10px", background: "var(--bg-menubar)", borderBottom: "1px solid var(--border-main)" }}>
          <span title={"Select (V, Esc)\nClick to select and edit, drag to move. Drag empty field, or right-drag anywhere, to pan; the wheel zooms."}><Toggle on={tool.kind === "select"} onClick={() => setTool({ kind: "select" })} icon="ti-pointer" label="Select" /></span>
          <Sep />
          <ToolButton on={tool.kind === "waypoint" && tool.type === "pose"} onClick={() => setTool({ kind: "waypoint", type: "pose" })} label="Pose" k="1" desc="Place a waypoint the robot passes facing a set heading. Click near the path to insert it, elsewhere to extend the path."><WaypointIcon kind="pose" color={GLYPH.mid} size={14} /></ToolButton>
          <ToolButton on={tool.kind === "waypoint" && tool.type === "translation"} onClick={() => setTool({ kind: "waypoint", type: "translation" })} label="Translation" k="2" desc="Place a waypoint the robot passes at any heading (the optimizer picks it)."><WaypointIcon kind="translation" color={GLYPH.mid} size={14} /></ToolButton>
          <ToolButton on={tool.kind === "waypoint" && tool.type === "empty"} onClick={() => setTool({ kind: "waypoint", type: "empty" })} label="Empty" k="3" desc="Place a guide point: not a place to reach, it only shapes the starting guess (to go around something)."><WaypointIcon kind="empty" color={GLYPH.mid} size={14} /></ToolButton>
          <Sep />
          <ConstraintMenu active={tool.kind === "constraint" ? tool.type : null} onPick={type => setTool({ kind: "constraint", type, from: null })} />
          <ToolButton on={tool.kind === "event"} onClick={() => setTool({ kind: "event" })} label="Event" k="E" desc="Then click a waypoint: a named moment, timed from it, when the robot code runs a command."><i className="ti ti-map-pin-bolt" style={{ color: "#a1690a" }} /></ToolButton>
          <ToolButton on={tool.kind === "keepout"} onClick={() => setTool({ kind: "keepout" })} label="Keep-out" k="K" desc="Place a circle that every path in the project keeps its bumper out of."><i className="ti ti-circle-off" style={{ color: "#c21c1c" }} /></ToolButton>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <span title="What the field shows: the path gradient and the layers."><Toggle on={viewOpen} onClick={() => setViewOpen(o => !o)} icon="ti-eye" label="View" /></span>
            <span title="Fit the whole field in view (F)."><Toggle on={false} onClick={() => setFitSignal(s => s + 1)} icon="ti-maximize" label="Fit" /></span>
            <GenerateButton state={genState.kind} stale={stale || !generated} onClick={generate} />
          </span>
        </div>
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
            hovered={hovered}
            tool={tool}
            view={view}
            topSpeed={topSpeed}
            playhead={playhead}
            fitSignal={fitSignal}
            topView={topView}
            onSelect={setSelected}
            onMoveWaypoint={(i, x, y, final) => editWaypoint(i, { x, y }, final)}
            onRotateWaypoint={(i, hd, final) => editWaypoint(i, { headingDeg: hd }, final)}
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
            <div style={{ position: "absolute", left: 12, top: 8, fontSize: 11, background: "rgba(255,255,255,0.94)", border: "1px solid var(--border-main)", padding: "4px 9px", color: "var(--text-primary)" }}>
              {toolHint}
            </div>
          )}
          {genState.kind === "error" && (
            <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", top: 8, maxWidth: 520, fontSize: 11, background: "var(--bg-page)", border: "1px solid var(--status-error-border)", color: "var(--status-error)", padding: "5px 10px" }}>
              <i className="ti ti-alert-triangle" /> {genState.message}
            </div>
          )}
          {spec && selected && (
            <ConfigPanel
              spec={spec}
              selected={selected}
              keepOut={fieldDoc.keepOut}
              trajectory={traj}
              stale={stale}
              onClose={() => setSelected(null)}
              onWaypoint={(i, patch) => editWaypoint(i, patch, true)}
              onSetKind={setKind}
              onToggleStop={i => editSpec(s => toggleStop(s, i), true)}
              stopOn={i => stopAt(spec, i) >= 0}
              waitOn={i => waitAt(spec, i)}
              onSetWait={(i, w) => editSpec(s => setWait(s, i, w), true)}
              onConstraint={(i, patch) => editConstraint(i, patch, true)}
              onEvent={editEvent}
              onKeepOut={(i, patch) => editKeepOut(i, patch, true)}
              onDelete={removeSelected}
              guessIntervals={i => guessIntervals(shown, i)}
            />
          )}
          {viewOpen && <ViewPanel view={view} onChange={setView} onClose={() => setViewOpen(false)} />}
          {traj && view.trajectory && view.gradient !== "none" && view.gradient !== "splits" && (
            <div style={{ position: "absolute", right: 12, bottom: 12, background: "rgba(255,255,255,0.94)", border: "1px solid var(--border-main)", padding: "5px 8px", fontSize: 10, color: "var(--text-secondary)" }}>
              <div style={{ marginBottom: 3 }}>{GRADIENTS.find(g => g.id === view.gradient)?.label}</div>
              <div style={{ width: 150, height: 6, background: RAMP_CSS }} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                <span>{view.gradient === "interval" ? "long Δt" : view.gradient === "progress" ? "start" : "0"}</span>
                <span>{legendTop(view.gradient, topSpeed)}</span>
              </div>
            </div>
          )}
          <Legend />
        </div>
        <PlaybackBar
          duration={shown?.durationS ?? 0}
          playhead={playhead}
          playing={playing}
          onToggle={togglePlay}
          onScrub={t => { setPlaying(false); setPlayhead(t) }}
          enabled={!!shown}
        >
          {traj && stats ? (
            <>
              <Metric label={stale ? "Generated (out of date)" : "Time"} value={`${traj.durationS.toFixed(3)} s`} strong warn={stale} />
              {generated?.result && <Metric label="vs guess" value={`−${(100 * (1 - traj.durationS / generated.result.splineDurationS)).toFixed(0)}%`} />}
              <Metric label="Top speed" value={`${stats.top.toFixed(2)} m/s`} />
              <Metric label="Peak current" value={`${stats.peakA.toFixed(0)} A`} />
              <Metric label="Peak grip" value={`${(100 * stats.peakGrip).toFixed(0)}%`} />
              {generated?.result && <Metric label="Solved" value={`${generated.result.solveMs.toFixed(0)} ms`} />}
            </>
          ) : guess ? (
            <Metric label="Guess (not generated)" value={`${guess.durationS.toFixed(3)} s`} />
          ) : guessError ? (
            <span style={{ fontSize: 11, color: "var(--status-error)" }}>{guessError}</span>
          ) : null}
        </PlaybackBar>
      </div>
    </div>
  )
}

// --- Pieces --------------------------------------------------------------------

/** The glyphs, explained, in a corner of the field. */
function Legend() {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ position: "absolute", right: 12, top: 8, background: "rgba(255,255,255,0.94)", border: "1px solid var(--border-main)", fontSize: 10.5, color: "var(--text-secondary)" }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: "3px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        Legend <i className={`ti ${open ? "ti-chevron-up" : "ti-chevron-down"}`} />
      </div>
      {open && (
        <div style={{ padding: "2px 8px 6px", display: "grid", gridTemplateColumns: "16px auto", gap: "4px 6px", alignItems: "center" }}>
          <WaypointIcon kind="pose" color={GLYPH.mid} size={13} /><span>Pose: position + heading</span>
          <WaypointIcon kind="translation" color={GLYPH.mid} size={13} /><span>Translation: position</span>
          <WaypointIcon kind="empty" color={GLYPH.mid} size={13} /><span>Empty: shapes the guess</span>
          <StopIcon size={13} /><span>Stops here</span>
          <span style={{ width: 12, height: 12, borderRadius: 6, background: GLYPH.start }} /><span>Start</span>
          <span style={{ width: 12, height: 12, borderRadius: 6, background: GLYPH.end }} /><span>End</span>
        </div>
      )}
    </div>
  )
}

const VIEW_HELP: Partial<Record<keyof ViewOptions, string>> = {
  field: "The field photo under everything.",
  grid: "A line every meter.",
  guess: "The dashed spline through the waypoints: what the optimizer starts from.",
  trajectory: "The generated trajectory, colored by the gradient.",
  samples: "A dot at every sample the optimizer solved for.",
  waypoints: "Waypoints, stops and constraint labels.",
  flipped: "The same trajectory as the other alliance would run it.",
}

function ViewPanel({ view, onChange, onClose }: { view: ViewOptions; onChange: (v: ViewOptions) => void; onClose: () => void }) {
  return (
    <div onPointerDown={e => e.stopPropagation()}
      style={{ position: "absolute", right: 12, top: 40, width: 260, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "2px 2px 0 var(--shadow-soft)", zIndex: 6 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "5px 6px 5px 10px", background: "var(--bg-panel-header)", borderBottom: "1px solid var(--border-main)" }}>
        <i className="ti ti-eye" style={{ marginRight: 6 }} />
        <span style={{ fontSize: 11.5, fontWeight: 600 }}>View</span>
        <span style={{ marginLeft: "auto" }}><IconButton icon="ti-x" title="Close" onClick={onClose} /></span>
      </div>
      <PropertyRow label="Path gradient">
        <select style={propertyInputStyle} value={view.gradient} title={GRADIENTS.find(g => g.id === view.gradient)?.hint}
          onChange={e => onChange({ ...view, gradient: e.target.value as ViewOptions["gradient"] })}>
          {GRADIENTS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
      </PropertyRow>
      {([
        ["field", "Field image"], ["grid", "Grid (1 m)"], ["guess", "Guess (spline)"], ["trajectory", "Trajectory"],
        ["samples", "Samples"], ["waypoints", "Waypoints & constraints"], ["flipped", "Other alliance (mirror)"],
      ] as [keyof ViewOptions, string][]).map(([key, label]) => (
        <div key={key} title={VIEW_HELP[key]}>
          <PropertyRow label={label}>
            <input type="checkbox" checked={view[key] as boolean} onChange={e => onChange({ ...view, [key]: e.target.checked })} />
          </PropertyRow>
        </div>
      ))}
    </div>
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
          <div style={{ position: "absolute", top: 28, left: 0, zIndex: 31, minWidth: 250, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "2px 2px 0 var(--shadow-soft)", padding: "3px 0" }}>
            {CONSTRAINTS.map(c => (
              <div key={c.type} title={c.hint}
                onClick={() => { setOpen(false); onPick(c.type) }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--tree-hover-bg)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>
                {c.type === "stopPoint" ? <StopIcon size={13} /> : <i className={`ti ${c.icon}`} style={{ color: "#7c3aed" }} />}
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

function ToolButton({ on, onClick, label, k, desc, children }: { on: boolean; onClick: () => void; label: string; k: string; desc: string; children: ReactNode }) {
  return (
    <button onClick={onClick} title={`${label} (${k})\n${desc}`}
      style={{
        display: "flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 8px", height: 26, cursor: "pointer",
        border: "1px solid var(--btn-classic-border)", borderRadius: 2,
        background: on ? "var(--toolbar-active-bg)" : "var(--btn-classic-bg)", color: "var(--text-primary)",
      }}>
      {children} {label} <span style={{ fontSize: 9.5, color: "var(--text-muted)" }}>{k}</span>
    </button>
  )
}

function GenerateButton({ state, stale, onClick }: { state: string; stale: boolean; onClick: () => void }) {
  const running = state === "running"
  return (
    <button onClick={onClick} disabled={running} title={"Generate (Ctrl+G)\nOptimize the trajectory for this path with the robot's physics, and save it to trajectories/ for the robot code. Blue: the path changed since the last one."}
      style={{
        display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 14px", fontSize: 12, fontWeight: 600, cursor: running ? "default" : "pointer",
        border: "1px solid", borderRadius: 2,
        borderColor: stale ? "#2a4fb8" : "var(--btn-classic-border)",
        background: running ? "var(--btn-classic-bg)" : stale ? "#2f6fdb" : "var(--btn-classic-bg)",
        color: running ? "var(--text-secondary)" : stale ? "#ffffff" : "var(--text-primary)",
      }}>
      <i className={`ti ${running ? "ti-loader-2" : "ti-wand"}`} />
      {running ? "Generating…" : "Generate"}
    </button>
  )
}

function PlaybackBar({ duration, playhead, playing, onToggle, onScrub, enabled, children }: {
  duration: number; playhead: number | null; playing: boolean; onToggle: () => void; onScrub: (t: number) => void; enabled: boolean; children: ReactNode
}) {
  const t = playhead ?? 0
  return (
    <div style={{ flexShrink: 0, background: "var(--bg-menubar)", borderTop: "1px solid var(--border-main)" }}>
      <div style={{ height: 40, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", opacity: enabled ? 1 : 0.5 }}>
        <button onClick={onToggle} disabled={!enabled} title="Play (Space)"
          style={{ width: 30, height: 26, border: "1px solid var(--btn-classic-border)", background: "var(--btn-classic-bg)", borderRadius: 2, cursor: "pointer" }}>
          <i className={`ti ${playing ? "ti-player-pause" : "ti-player-play"}`} />
        </button>
        <input type="range" min={0} max={duration || 1} step={0.005} value={Math.min(t, duration)} disabled={!enabled}
          onChange={e => onScrub(Number(e.target.value))} style={{ flex: 1 }} />
        <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11, width: 110, textAlign: "right", color: "var(--text-secondary)" }}>
          {t.toFixed(2)} / {duration.toFixed(2)} s
        </span>
      </div>
      <div style={{ height: 28, display: "flex", alignItems: "center", gap: 18, padding: "0 14px", borderTop: "1px solid var(--border-light)", background: "var(--bg-panel)" }}>
        {children}
      </div>
    </div>
  )
}

const METRIC_HELP: Record<string, string> = {
  "Time": "How long the generated trajectory takes, start to end.",
  "vs guess": "How much faster than the spline through the waypoints the optimizer made it.",
  "Top speed": "The fastest the chassis goes.",
  "Peak current": "The most any drive motor draws (stator).",
  "Peak grip": "The most of its grip any wheel uses. 100% is the edge of slipping.",
  "Solved": "How long the optimizer took.",
}

function Metric({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <span title={METRIC_HELP[label] ?? (label.startsWith("Generated") ? "The path changed after this was generated: generate again." : "The spline through the waypoints, timed. Not optimized yet.")} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: warn ? "var(--status-warning)" : "var(--text-muted)" }}>
      {label}
      <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: strong ? 12.5 : 11, fontWeight: strong ? 700 : 400, color: warn ? "var(--status-warning)" : "var(--text-primary)" }}>{value}</span>
    </span>
  )
}

function SectionHeading({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 12px", background: "var(--bg-panel-header)", borderTop: "1px solid var(--border-main)", borderBottom: "1px solid var(--border-main)", flexShrink: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)" }}>{label}</span>
    </div>
  )
}

function Sep() {
  return <span style={{ width: 1, height: 20, background: "var(--border-main)", margin: "0 4px" }} />
}

// --- Helpers -------------------------------------------------------------------

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
