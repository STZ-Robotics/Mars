import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import { useRobotNames } from "../autos/robotNames"
import { hotReload } from "../ui/hotReload"
import { askText } from "../ui/askText"
import { newFolderName, useFolders } from "../ui/Folders"
import { renderTopView, TopView } from "../robot/topView"
import { bindField } from "../vars/bind"
import { useVariables } from "../vars/context"
import { useToast } from "../ui/toasts"
import { isExpr } from "../vars/expr"
import { applyScope, dropExprs, evaluateAll, linkToPose, linkedPose, numberText, withOverrides } from "../vars/variables"
import { Card, MiniButton, Q, Toggle } from "../ui/controls"
import FieldView, { RAMP_CSS } from "./FieldView"
import Charts from "./Charts"
import Sidebar, { IconButton } from "./Sidebar"
import ConfigPanel, { TextInput } from "./ConfigPanel"
import { StopIcon, WaypointIcon, GLYPH } from "./glyphs"
import {
  PathStatus, SlowZone, mirrorPath, moveWaypoints,
  CONSTRAINTS, ConstraintType, DEFAULT_VIEW, EventMarker, FieldDoc, GRADIENTS, KeepOut, PathEntry, PathSpec, PlanResult,
  ScopedConstraint, Selection, Target, Tool, Trajectory, ViewOptions, Waypoint, WaypointKind, afterInsert, afterMove,
  afterRemove, constraintMeta, kindOf, moveControl, newConstraint, newPathSpec, NEXT_MODE, segmentMode, setSegmentMode, setWait, shiftControls, stopAt, toggleStop, waitAt,
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
  const { names: robotNames } = useRobotNames(robotPath)
  const field = FIELDS[0]
  const fieldSize = { lengthM: field.sizeMeters[0], widthM: field.sizeMeters[1] }

  const [entries, setEntries] = useState<PathEntry[]>([])
  const [current, setCurrent] = useState<Current | null>(null)
  const [fieldDoc, setFieldDoc] = useState<FieldDoc>({ walls: true, keepOut: [] })
  const [selected, setSelected] = useState<Selection>(null)
  // Waypoints selected together, and what Ctrl+C took.
  const [multi, setMulti] = useState<number[]>([])
  const clipboard = useRef<Waypoint[]>([])
  const [hovered, setHovered] = useState<Selection>(null)
  const [tool, setTool] = useState<Tool>({ kind: "select" })
  const [guess, setGuess] = useState<Trajectory | null>(null)
  const [guessError, setGuessError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<{ result: PlanResult | null; trajectory: Trajectory; key: string } | null>(null)
  const [genState, setGenState] = useState<{ kind: "idle" } | { kind: "running" } | { kind: "error"; message: string }>({ kind: "idle" })
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  // Hovering the charts shows the robot at that time without moving the playhead.
  const [scrub, setScrub] = useState<number | null>(null)
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

  const base = current?.spec ?? null
  // The variant being viewed: the path with its overrides in place. Edits go
  // to the base path; what is drawn, timed and generated is the variant.
  const [variant, setVariant] = useState<string | null>(null)
  const { scope, version, variables, setVariables } = useVariables()
  const variantDef = base?.variants?.find(v => v.name === variant) ?? null
  const spec = useMemo(() => {
    if (!base || !variantDef) return base
    return applyScope(base, evaluateAll(withOverrides(variables, variantDef.overrides)).scope).doc
  }, [base, variantDef, variables])
  const n = spec?.waypoints.length ?? 0
  const genKey = (s: PathSpec | null) => (s ? JSON.stringify([s, fieldDoc, robot, variant]) : "")
  const latestKey = useRef("")
  latestKey.current = genKey(spec)
  const stale = !!generated && generated.key !== genKey(spec)
  const shown = generated?.trajectory ?? guess
  const topSpeed = usableSpeed(robot)
  const currentRef = useRef(current)
  currentRef.current = current
  const fieldDocRef = useRef(fieldDoc)
  fieldDocRef.current = fieldDoc

  // Variables changed: the open path and the field follow, in memory (the
  // project sync rewrites the files).
  useEffect(() => {
    setCurrent(c => {
      if (!c) return c
      const out = applyScope(c.spec, scope)
      return out.changed ? { ...c, spec: out.doc } : c
    })
    setFieldDoc(d => applyScope(d, scope).doc)
  }, [version])

  /**
   * A waypoint linked to a pose variable moves the pose (and so every path
   * through it); one with formulas on x or y loses them when dragged. Returns
   * false if the move is refused (the pose itself is a formula).
   */
  const moveLinked = (i: number, x: number, y: number, final: boolean): boolean => {
    const w = spec?.waypoints[i]
    if (!w) return false
    const name = linkedPose(w)
    if (name) {
      const v = variables.find(q => q.name === name)
      if (v?.kind === "pose" && (isExpr(v.x) || isExpr(v.y))) {
        if (final) setNote(`"${name}" is computed by a formula: edit it in Variables`)
        return false
      }
      editWaypoint(i, q => ({ ...shiftControls(q, x - q.x, y - q.y), x, y }), final)
      if (final && v?.kind === "pose") setVariables(variables.map(q => (q === v ? { ...v, x: numberText(x), y: numberText(y) } : q)))
      return true
    }
    editWaypoint(i, q => dropExprs({ ...shiftControls(q, x - q.x, y - q.y), x, y }, ["x", "y"]), final)
    return true
  }
  const rotateLinked = (i: number, headingDeg: number, final: boolean) => {
    const w = spec?.waypoints[i]
    if (!w) return
    const m = w.exprs?.headingDeg?.match(/^=\s*([A-Za-z_][A-Za-z0-9_]*)\.heading\s*$/)
    const v = m ? variables.find(q => q.name === m[1]) : undefined
    if (v?.kind === "pose" && !isExpr(v.heading)) {
      editWaypoint(i, { headingDeg }, final)
      if (final) setVariables(variables.map(q => (q === v ? { ...v, heading: numberText(headingDeg) } : q)))
      return
    }
    if (v && final) { setNote(`"${v.name}" is computed by a formula: edit it in Variables`); return }
    editWaypoint(i, q => dropExprs({ ...q, headingDeg }, ["headingDeg"]), final)
  }

  // The robot's STL from above, as the 2D robot.
  const [topView, setTopView] = useState<TopView | null>(null)
  const modelKey = JSON.stringify([robot.model, robot.bumper, view.robotColor])
  useEffect(() => {
    if (!robot.model) { setTopView(null); return }
    let alive = true
    invoke<string>("resolve_model_path", { robotPath, modelPath: robot.model.path })
      .then(path => renderTopView(robot, path, view.robotColor))
      .then(v => { if (alive) setTopView(v) })
      .catch(() => { if (alive) setTopView(null) })
    return () => { alive = false }
  }, [modelKey, robotPath])

  // --- Files -----------------------------------------------------------------
  const [status, setStatus] = useState<Record<string, PathStatus>>({})
  const refreshStatus = useCallback(async () => {
    const st = await invoke<PathStatus[]>("paths_status", { robotPath, robot, field: fieldDocRef.current }).catch(() => [] as PathStatus[])
    setStatus(Object.fromEntries(st.map(q => [q.name, q])))
  }, [robotPath, robot])
  const refresh = useCallback(async () => {
    const list = await invoke<PathEntry[]>("paths_list", { robotPath })
    setEntries(list)
    refreshStatus()
    return list
  }, [robotPath, refreshStatus])
  useEffect(() => { refreshStatus() }, [JSON.stringify(robot), fieldCommit])

  // Branches leaving the open path: their specs and trajectories, to draw
  // them from their fork.
  const [branchTrajs, setBranchTrajs] = useState<Record<string, Trajectory | null>>({})
  const branches = useMemo(
    () => entries.filter(e => e.spec && base && e.spec.continuesFrom === base.name && e.spec.continuesAt !== undefined).map(e => e.spec!),
    [entries, base?.name],
  )
  useEffect(() => {
    let alive = true
    Promise.all(branches.map(b => invoke<Trajectory | null>("trajectory_open", { robotPath, name: b.name }).catch(() => null)))
      .then(ts => { if (alive) setBranchTrajs(Object.fromEntries(branches.map((b, k) => [b.name, ts[k]]))) })
    return () => { alive = false }
  }, [branches, status])

  const loadPath = useCallback(async (s: PathSpec, savedName: string | null = s.name, keepVariant = false) => {
    setCurrent({ spec: s, savedName })
    if (!keepVariant) setVariant(null)
    history.current = { undo: [], redo: [], committed: s }
    setHistoryTick(t => t + 1)
    setSelected(null)
    setPlayhead(null)
    setPlaying(false)
    setGenState({ kind: "idle" })
    // The trajectory saved with it, if any: shown until the path changes.
    const traj = savedName ? await invoke<Trajectory | null>("trajectory_open", { robotPath, name: savedName }).catch(() => null) : null
    setGenerated(traj ? { result: null, trajectory: traj, key: JSON.stringify([s, fieldDocRef.current, robot, null]) } : null)
  }, [robotPath, robot])

  // Switching variants shows that variant's trajectory, if generated.
  useEffect(() => {
    if (!base || !current?.savedName) return
    let alive = true
    const name = variant ? `${base.name}@${variant}` : base.name
    invoke<Trajectory | null>("trajectory_open", { robotPath, name }).catch(() => null).then(traj => {
      if (!alive) return
      setGenerated(traj ? { result: null, trajectory: traj, key: genKey(spec) } : null)
      setPlayhead(null)
    })
    return () => { alive = false }
  }, [variant])

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
    const t = setTimeout(() => { invoke("field_save", { robotPath, field: fieldDoc, fieldSize }).catch(e => setNote(String(e))) }, SAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [fieldCommit])

  // --- The guess, live -------------------------------------------------------
  // One request in flight at a time: while it runs, newer edits only replace
  // the pending one, so a fast drag never piles up work behind the cursor.
  const timing = useRef<{ busy: boolean; pending: { robot: RobotConfig; spec: PathSpec; robotPath: string } | null }>({ busy: false, pending: null })
  const requestGuess = useCallback((req: { robot: RobotConfig; spec: PathSpec; robotPath: string }) => {
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
    requestGuess({ robot, spec, robotPath })
  }, [specKey, JSON.stringify(robot)])

  // --- Generate --------------------------------------------------------------
  const genReq = useRef(0)
  const toast = useToast()
  // Stop: the running generation (or every one of Generate all) ends at the
  // solver's next iteration; nothing it did is kept.
  const stopRequested = useRef(false)
  const stop = () => {
    stopRequested.current = true
    invoke("plan_cancel").catch(() => {})
  }
  const isStopped = (e: unknown) => String(e).includes("Generation stopped")
  const generate = () => {
    if (!spec) return
    if (genState.kind === "running") { stop(); return }
    stopRequested.current = false
    const id = ++genReq.current
    const key = genKey(spec)
    const label = variant ? `${spec.name} ◇ ${variant}` : spec.name
    setGenState({ kind: "running" })
    invoke<PlanResult>("path_plan", { robot, spec, field: fieldDoc, fieldSize, robotPath, variant })
      .then(result => {
        if (id !== genReq.current) return
        setGenerated({ result, trajectory: result.trajectory, key })
        setGenState({ kind: "idle" })
        setPlayhead(null)
        refreshStatus()
        const faster = 100 * (1 - result.trajectory.durationS / result.splineDurationS)
        const changed = key !== latestKey.current
        toast({
          kind: "success",
          title: `Generated "${label}"`,
          body: `${result.trajectory.durationS.toFixed(3)} s${faster > 0.5 ? ` (${faster.toFixed(0)}% faster than the guess)` : ""} · solved in ${(result.solveMs / 1000).toFixed(2)} s${changed ? " · the path changed while it ran: generate again" : ""}`,
        })
        hotReload(robotPath, [variant ? `${spec.name}@${variant}` : spec.name], true, toast)
      })
      .catch(e => {
        if (id !== genReq.current) return
        if (isStopped(e)) {
          setGenState({ kind: "idle" })
          toast({ kind: "stopped", title: `Stopped generating "${label}"`, body: "Nothing was saved; the last trajectory stays." })
        } else {
          setGenState({ kind: "error", message: String(e) })
          toast({ kind: "error", title: `Could not generate "${label}"`, body: String(e) })
        }
      })
  }

  /**
   * Generates many paths in the right order: a path before the ones that
   * continue or branch from it (they start from its trajectory). With
   * `outdated`, only those not generated or generated from something else;
   * each path's variants too.
   */
  const generateMany = async (which: "outdated" | "all") => {
    if (genState.kind === "running") return
    stopRequested.current = false
    setGenState({ kind: "running" })
    const specs = (await invoke<PathEntry[]>("paths_list", { robotPath })).flatMap(e => (e.spec ? [e.spec] : []))
    const byName = new Map(specs.map(q => [q.name, q]))
    const order: PathSpec[] = []
    const seen = new Set<string>()
    const visit = (q: PathSpec) => {
      if (seen.has(q.name)) return
      seen.add(q.name)
      const parent = q.continuesFrom ? byName.get(q.continuesFrom) : undefined
      if (parent) visit(parent)
      order.push(q)
    }
    specs.forEach(visit)
    const st = Object.fromEntries((await invoke<PathStatus[]>("paths_status", { robotPath, robot, field: fieldDoc })).map(q => [q.name, q]))
    let done = 0, failed: string[] = []
    const sent: string[] = []
    // A parent regenerated now outdates what continues from it.
    const regenerated = new Set<string>()
    let stopped = false
    for (const q of order) {
      if (stopRequested.current) { stopped = true; break }
      const need = which === "all" || !st[q.name]?.generated || st[q.name]?.outdated || (q.continuesFrom && regenerated.has(q.continuesFrom))
      if (!need) continue
      setNote(`Generating ${q.name}…`)
      const jobs: [PathSpec, string | null][] = [[applyScope(q, scope).doc, null]]
      for (const v of q.variants ?? []) jobs.push([applyScope(q, evaluateAll(withOverrides(variables, v.overrides)).scope).doc, v.name])
      for (const [s2, v] of jobs) {
        if (stopRequested.current) { stopped = true; break }
        try {
          await invoke<PlanResult>("path_plan", { robot, spec: s2, field: fieldDoc, fieldSize, robotPath, variant: v })
          done++
          sent.push(v ? `${q.name}@${v}` : q.name)
        } catch (e) {
          if (isStopped(e)) { stopped = true; break }
          failed.push(`${q.name}${v ? "@" + v : ""}: ${String(e)}`)
        }
      }
      if (stopped) break
      regenerated.add(q.name)
    }
    setGenState(failed.length ? { kind: "error", message: failed.join(" · ") } : { kind: "idle" })
    setNote(`Generated ${done} trajector${done === 1 ? "y" : "ies"}${failed.length ? `, ${failed.length} failed` : ""}`)
    const plural = (k: number) => `${k} trajector${k === 1 ? "y" : "ies"}`
    if (stopped) toast({ kind: "stopped", title: "Stopped generating", body: `${plural(done)} done before the stop; the rest kept their last trajectory.` })
    else if (failed.length) toast({ kind: "error", title: `Generated ${plural(done)}, ${failed.length} failed`, body: failed.join(" · ") })
    else toast({ kind: "success", title: done ? `Generated ${plural(done)}` : "Everything is up to date", body: done ? "In order: each path before what continues from it." : undefined })
    if (sent.length) hotReload(robotPath, sent, true, toast)
    await refreshStatus()
    // The open path shows its fresh trajectory.
    if (base && current?.savedName) {
      const traj = await invoke<Trajectory | null>("trajectory_open", { robotPath, name: variant ? `${base.name}@${variant}` : base.name }).catch(() => null)
      setGenerated(traj ? { result: null, trajectory: traj, key: genKey(spec) } : null)
    }
  }

  /** A new path forking from waypoint `i`, under a condition from the robot code. */
  const createBranch = async (i: number) => {
    if (!base || !current?.savedName) { setNote("Save the path first"); return }
    const condition = (await askText("Condition that takes this branch", "hasNote", "A NamedCondition in the robot code: at this waypoint, the robot takes the branch when it is true."))?.trim()
    if (!condition) return
    const name = uniqueName(`${base.name} if ${condition}`)
    const w = base.waypoints[i]
    const heading = w.headingDeg ?? 0
    const branch: PathSpec = {
      name,
      waypoints: [
        { x: w.x, y: w.y, kind: "continue", headingDeg: heading },
        { x: w.x + 1.5 * Math.cos(heading * Math.PI / 180), y: w.y + 1.5 * Math.sin(heading * Math.PI / 180), kind: "pose", headingDeg: heading },
      ],
      constraints: {},
      // A branch leaves moving: it only stops at its end.
      scoped: [{ type: "stopPoint", from: "last" }],
      events: [],
      continuesFrom: base.name,
      continuesAt: i,
      condition,
    }
    await invoke("path_save", { robotPath, spec: branch, previous: null })
    await refresh()
    loadPath(branch)
    setNote(`Branch "${name}": generate "${base.name}" first, then this one (or Generate all)`)
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
  // --- Folders ----------------------------------------------------------------
  const pathFolders = useFolders(robotPath, "paths")
  /** Puts a path, with the whole chain it belongs to (what continues it, and what it continues), in a folder. */
  const moveToFolder = async (name: string, folder: string | undefined) => {
    const byName = new Map(entries.map(e => [e.name, e]))
    let root = name
    for (let k = 0; k < 50 && byName.get(root)?.spec?.continuesFrom && byName.has(byName.get(root)!.spec!.continuesFrom!); k++) root = byName.get(root)!.spec!.continuesFrom!
    const chain = new Set([root])
    for (let grew = true; grew;) {
      grew = false
      for (const e of entries) if (e.spec?.continuesFrom && chain.has(e.spec.continuesFrom) && !chain.has(e.name)) { chain.add(e.name); grew = true }
    }
    await setFolderOf([...chain], folder)
  }
  const setFolderOf = async (names: string[], folder: string | undefined) => {
    const put = (s: PathSpec): PathSpec => { const { folder: _, ...rest } = s; return folder ? { ...rest, folder } : rest }
    for (const name of names) {
      if (current?.savedName === name) { editSpec(put, true); continue }
      const e = entries.find(x => x.name === name)
      if (!e?.spec || (e.spec.folder ?? undefined) === folder) continue
      await invoke("path_save", { robotPath, spec: put(e.spec), previous: name }).catch(err => toast({ kind: "error", title: `Could not move ${name}`, body: String(err) }))
    }
    await refresh()
  }
  const inFolder = (f: string) => entries.filter(e => e.spec?.folder === f).map(e => e.name)

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
    if ((kind === "unknown" || kind === "continue") && i !== 0) { setNote("Only the first waypoint can be an unknown or continued start"); return }
    editSpec(s => ({
      ...s,
      // Leaving "continue", the link to the other path goes.
      continuesFrom: i === 0 && kind !== "continue" ? undefined : s.continuesFrom,
      waypoints: s.waypoints.map((w, j) => {
        if (j !== i) return w
        if (kind === "pose") return { ...w, kind, headingDeg: w.headingDeg ?? Math.round(headingAt(shown, w) * 10) / 10 }
        if (kind === "continue") return { ...w, kind }
        const { headingDeg: _, ...rest } = w
        return { ...rest, kind }
      }),
    }), true)
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
    // A group of waypoints goes together (a path keeps at least two).
    if (multi.length > 1 && spec) {
      const keep = spec.waypoints.length - multi.length
      if (keep < 2) { setNote("A path needs at least two waypoints"); return }
      editSpec(s => [...multi].sort((a, b) => b - a).reduce((acc, i) => ({ ...acc, ...afterRemove(acc, i), waypoints: acc.waypoints.filter((_, j) => j !== i) }), s), true)
      setMulti([])
      setSelected(null)
      return
    }
    if (!selected) return
    if (selected.kind === "waypoint") deleteWaypoint(selected.index)
    else if (selected.kind === "constraint") deleteConstraint(selected.index)
    else if (selected.kind === "event") deleteEvent(selected.index)
    else if (selected.kind === "keepout") {
      editField(f => ({ ...f, keepOut: f.keepOut.filter((_, j) => j !== selected.index) }), true)
      setSelected(null)
    } else if (selected.kind === "zone") {
      editField(f => ({ ...f, slowZones: (f.slowZones ?? []).filter((_, j) => j !== selected.index) }), true)
      setSelected(null)
    } else if (selected.kind === "rotation") {
      editSpec(s => ({ ...s, rotationTargets: (s.rotationTargets ?? []).filter((_, j) => j !== selected.index) }), true)
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
  // Arrow keys nudge the selected waypoints; copy and paste waypoints.
  const nudge = (dx: number, dy: number) => {
    const idx = multi.length ? multi : selected?.kind === "waypoint" ? [selected.index] : []
    if (!idx.length) return false
    editSpec(s => moveWaypoints(s, idx, dx, dy), true)
    return true
  }
  const copy = () => {
    if (!spec) return
    const idx = multi.length ? multi : selected?.kind === "waypoint" ? [selected.index] : []
    clipboard.current = idx.map(i => structuredClone(spec.waypoints[i]))
    if (idx.length) setNote(`Copied ${idx.length} waypoint${idx.length > 1 ? "s" : ""}`)
  }
  const paste = () => {
    if (!spec || !clipboard.current.length) return
    // After the selection (or at the end), a little offset so it is visible.
    const after = Math.max(-1, ...(multi.length ? multi : selected?.kind === "waypoint" ? [selected.index] : [spec.waypoints.length - 1]))
    const at = Math.min(after + 1, spec.waypoints.length)
    const pasted = clipboard.current.map(w => ({ ...structuredClone(w), x: w.x + 0.3, y: w.y - 0.3, exprs: undefined, manualNext: undefined, pathfindNext: undefined, kind: w.kind === "unknown" || w.kind === "continue" ? "translation" as const : w.kind }))
    editSpec(s => {
      let out = s
      pasted.forEach((w, k) => { out = { ...out, ...afterInsert(out, at + k), waypoints: [...out.waypoints.slice(0, at + k), w, ...out.waypoints.slice(at + k)] } })
      return out
    }, true)
    setMulti(pasted.map((_, k) => at + k))
    setSelected(null)
  }
  const keysRef = useRef({ removeSelected, togglePlay, generate, setKind, selected, travel, nudge, copy, paste })
  keysRef.current = { removeSelected, togglePlay, generate, setKind, selected, travel, nudge, copy, paste }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return
      const k = e.key.toLowerCase()
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && k === "g") { e.preventDefault(); keysRef.current.generate(); return }
      if (ctrl && k === "z") { e.preventDefault(); keysRef.current.travel(e.shiftKey ? "redo" : "undo"); return }
      if (ctrl && k === "y") { e.preventDefault(); keysRef.current.travel("redo"); return }
      if (ctrl && k === "c") { keysRef.current.copy(); return }
      if (ctrl && k === "v") { e.preventDefault(); keysRef.current.paste(); return }
      if (ctrl && k === "a") {
        e.preventDefault()
        const n = currentRef.current?.spec.waypoints.length ?? 0
        setMulti(Array.from({ length: n }, (_, i) => i))
        return
      }
      if (e.key.startsWith("Arrow")) {
        const step = e.shiftKey ? 0.1 : 0.01
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key as "ArrowLeft"]
        if (d && keysRef.current.nudge(d[0], d[1])) e.preventDefault()
        return
      }
      if (ctrl) return
      const kinds: Record<string, WaypointKind> = { "1": "pose", "2": "translation", "3": "empty" }
      const code = e.code === "Digit1" ? "1" : e.code === "Digit2" ? "2" : e.code === "Digit3" ? "3" : null
      if (code && e.shiftKey) {
        const sel = keysRef.current.selected
        if (sel?.kind === "waypoint") keysRef.current.setKind(sel.index, kinds[code])
        return
      }
      if (code) { setTool({ kind: "waypoint", type: kinds[code] }); return }
      if (k === "escape") { setTool({ kind: "select" }); setSelected(null); setMulti([]) }
      else if (k === "r") setTool({ kind: "ruler" })
      else if (k === "z") setTool({ kind: "zone" })
      else if (k === "t") setTool({ kind: "rotation" })
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
      : tool.kind === "zone" ? "Slow zone: drag a rectangle, or click for a circle. Every path drives slower inside. Esc cancels."
      : tool.kind === "rotation" ? "Rotation target: click on the path where the robot must face a heading. Esc cancels."
      : tool.kind === "ruler" ? "Ruler: drag between two points. Snaps to waypoints and poses; Esc clears it."
      : multi.length > 1 ? `${multi.length} waypoints selected: drag one to move them all, arrows nudge (Shift: 10 cm), Ctrl+C / Ctrl+V, Delete.`
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
          robotNames={robotNames}
          folders={pathFolders.folders}
          folderOpen={pathFolders.open}
          onToggleFolder={pathFolders.toggle}
          onMoveToFolder={moveToFolder}
          onAddFolder={() => pathFolders.save([...pathFolders.folders, newFolderName(pathFolders.folders)])}
          onRenameFolder={(from, to) => { if (pathFolders.folders.includes(to)) return; pathFolders.save(pathFolders.folders.map(f => (f === from ? to : f))); setFolderOf(inFolder(from), to) }}
          onDeleteFolder={f => { pathFolders.save(pathFolders.folders.filter(x => x !== f)); setFolderOf(inFolder(f), undefined) }}
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
          onCycleSegment={i => editSpec(s => setSegmentMode(s, i, NEXT_MODE[segmentMode(s.waypoints[i])]), true)}
          onMoveWaypoint={moveWaypoint}
          onDeleteWaypoint={deleteWaypoint}
          onToggleConstraint={i => editSpec(s => ({ ...s, scoped: s.scoped.map((c, j) => (j === i ? { ...c, enabled: c.enabled === false ? undefined : false } : c)) }), true)}
          onDeleteConstraint={deleteConstraint}
          onDeleteEvent={deleteEvent}
          status={status}
          onGenerateMany={generateMany}
          onDeleteRotation={i => { editSpec(s => ({ ...s, rotationTargets: (s.rotationTargets ?? []).filter((_, j) => j !== i) }), true); setSelected(null) }}
        >
          {spec && (
            <>
              {base && base.continuesFrom && base.continuesAt !== undefined && (
                <>
                  <SectionHeading label="Branch" />
                  <div style={{ padding: "5px 12px", fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
                    Starts at the parent's waypoint, at the robot's state there, when the condition holds. The robot code registers the condition by name (a NamedCondition); the parent keeps going otherwise.
                  </div>
                  <PropertyRow label="Branch of">
                    <select style={propertyInputStyle} value={base.continuesFrom} onChange={e => editSpec(q => ({ ...q, continuesFrom: e.target.value }), true)}>
                      {entries.filter(e => e.name !== base.name).map(e => <option key={e.name} value={e.name}>{e.name}</option>)}
                    </select>
                  </PropertyRow>
                  <PropertyRow label="At waypoint">
                    <select style={propertyInputStyle} value={base.continuesAt} onChange={e => editSpec(q => ({ ...q, continuesAt: Number(e.target.value) }), true)}>
                      {Array.from({ length: entries.find(e => e.name === base.continuesFrom)?.spec?.waypoints.length ?? 0 }, (_, j) => <option key={j} value={j}>Waypoint {j + 1}</option>)}
                    </select>
                  </PropertyRow>
                  <PropertyRow label="When (condition)">
                    <TextInput value={base.condition ?? ""} onCommit={c => editSpec(q => ({ ...q, condition: c || undefined }), true)} />
                  </PropertyRow>
                  <PropertyRow label="">
                    <MiniButton onClick={() => { const e = entries.find(q => q.name === base.continuesFrom); if (e?.spec) loadPath(e.spec) }}>Open parent</MiniButton>
                  </PropertyRow>
                </>
              )}
              {base && base.waypoints.some((w, i) => i > 0 && i < base.waypoints.length - 1 && (w.split || w.section)) && (
                <>
                  <SectionHeading label="Sections" />
                  <PropertyRow label="First section">
                    <TextInput value={base.firstSection ?? ""} onCommit={v => editSpec(q => ({ ...q, firstSection: v || undefined }), true)} />
                  </PropertyRow>
                  {(generated?.trajectory.sections ?? []).map(sec => (
                    <PropertyRow key={sec.name} label={sec.name}>
                      <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11 }}>{(sec.endT - sec.startT).toFixed(2)} s</span>
                      <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 8 }}>{sec.startT.toFixed(2)} → {sec.endT.toFixed(2)} s</span>
                    </PropertyRow>
                  ))}
                </>
              )}
              {base && (
                <>
                  <SectionHeading label={`Variants (${base.variants?.length ?? 0})`} />
                  <div style={{ padding: "4px 12px 2px", fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
                    Versions of this path that set some variables otherwise (which note, how fast). Each generates its own trajectory.
                  </div>
                  {[null, ...(base.variants ?? []).map(v => v.name)].map(v => (
                    <div key={v ?? "__base"} onClick={() => setVariant(v)}
                      style={{ display: "flex", alignItems: "center", gap: 7, height: 26, padding: "0 10px", fontSize: 11.5, cursor: "pointer", borderBottom: "1px solid var(--border-light)",
                        background: variant === v ? "var(--tree-selection-bg)" : "transparent", color: variant === v ? "var(--tree-selection-fg)" : "var(--text-primary)" }}>
                      <span style={{ width: 14, textAlign: "center" }}>{v === null ? "●" : "◇"}</span>
                      <span style={{ flex: 1 }}>{v ?? "Base"}</span>
                      {v !== null && (
                        <span title="Delete variant" onClick={e => { e.stopPropagation(); if (variant === v) setVariant(null); editSpec(q => ({ ...q, variants: (q.variants ?? []).filter(x => x.name !== v) }), true) }}
                          style={{ opacity: 0.7, cursor: "pointer" }}><i className="ti ti-trash" /></span>
                      )}
                    </div>
                  ))}
                  <PropertyRow label="">
                    <MiniButton onClick={async () => {
                      const name = (await askText("Variant name", `variant ${(base.variants?.length ?? 0) + 1}`, "The same path with some variables set otherwise; it generates its own trajectory."))?.trim()
                      if (!name || base.variants?.some(v => v.name === name)) return
                      editSpec(q => ({ ...q, variants: [...(q.variants ?? []), { name, overrides: {} }] }), true)
                      setVariant(name)
                    }}>+ Variant</MiniButton>
                  </PropertyRow>
                  {variantDef && (
                    <>
                      {Object.entries(variantDef.overrides).map(([name, value]) => (
                        <PropertyRow key={name} label={name}>
                          <span style={{ display: "flex", gap: 4, width: "100%" }}>
                            <TextInput value={value} onCommit={v => editSpec(q => ({ ...q, variants: (q.variants ?? []).map(x => (x.name === variant ? { ...x, overrides: { ...x.overrides, [name]: v } } : x)) }), true)} />
                            <span title="Remove override" style={{ cursor: "pointer", opacity: 0.7 }}
                              onClick={() => editSpec(q => ({ ...q, variants: (q.variants ?? []).map(x => { if (x.name !== variant) return x; const o = { ...x.overrides }; delete o[name]; return { ...x, overrides: o } }) }), true)}>
                              <i className="ti ti-x" />
                            </span>
                          </span>
                        </PropertyRow>
                      ))}
                      <PropertyRow label="Override">
                        <select style={propertyInputStyle} value="" onChange={e => {
                          const name = e.target.value
                          if (!name) return
                          const v = variables.find(q => q.name === name)
                          const start = v?.kind === "number" ? v.value : variables.find(q => q.kind === "pose" && q.name !== name)?.name ?? name
                          editSpec(q => ({ ...q, variants: (q.variants ?? []).map(x => (x.name === variant ? { ...x, overrides: { ...x.overrides, [name]: start } } : x)) }), true)
                        }}>
                          <option value="">+ a variable…</option>
                          {variables.filter(v => !(v.name in variantDef.overrides)).map(v => <option key={v.name} value={v.name}>{v.name} ({v.kind})</option>)}
                        </select>
                      </PropertyRow>
                      <div style={{ padding: "2px 12px 6px", fontSize: 10, color: "var(--text-muted)" }}>
                        A number takes a value or =formula; a pose takes another pose's name (=note2).
                      </div>
                    </>
                  )}
                </>
              )}
              <SectionHeading label="Path limits" />
              <Q label="Max speed" dim="plain" unit="m/s" optional hint="On the whole path. Empty: what the robot can do"
                {...bindField(spec.constraints, "maxVelocityMps", f => editSpec(s => ({ ...s, constraints: f(s.constraints) }), true))} />
              <Q label="Max rotation" dim="plain" unit="°/s" optional hint="On the whole path. Empty: what the robot can do"
                {...bindField(spec.constraints, "maxAngularVelocityDps", f => editSpec(s => ({ ...s, constraints: f(s.constraints) }), true))} />
              <SectionHeading label="Field" />
              <PropertyRow label="Walls">
                <input type="checkbox" checked={fieldDoc.walls} onChange={e => editField(d => ({ ...d, walls: e.target.checked }), true)} />
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>{fieldSize.lengthM} × {fieldSize.widthM} m</span>
              </PropertyRow>
              <PropertyRow label="Keep-outs">
                <span style={{ fontSize: 11 }}>{fieldDoc.keepOut.length}</span>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>shared by every path (K to add)</span>
              </PropertyRow>
              <PropertyRow label="Slow zones">
                <span style={{ fontSize: 11 }}>{(fieldDoc.slowZones ?? []).length}</span>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>shared by every path (Z to add)</span>
              </PropertyRow>
              {(fieldDoc.slowZones ?? []).map((z, i) => (
                <div key={i} onClick={() => setSelected({ kind: "zone", index: i })}
                  style={{ display: "flex", alignItems: "center", gap: 7, height: 26, padding: "0 10px", fontSize: 11.5, cursor: "pointer", borderBottom: "1px solid var(--border-light)",
                    background: selected?.kind === "zone" && selected.index === i ? "var(--tree-selection-bg)" : "transparent",
                    color: selected?.kind === "zone" && selected.index === i ? "var(--tree-selection-fg)" : "var(--text-primary)" }}>
                  <i className="ti ti-square-half" style={{ color: "#ca8a04" }} />
                  <span style={{ flex: 1 }}>{z.name || `Zone ${i + 1}`}</span>
                  <span style={{ fontSize: 10, opacity: 0.85 }}>{z.maxVelocityMps !== undefined ? `≤ ${z.maxVelocityMps} m/s` : ""}</span>
                </div>
              ))}
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
          <ToolButton on={tool.kind === "zone"} onClick={() => setTool({ kind: "zone" })} label="Slow zone" k="Z" desc="Drag a rectangle (or click for a circle) where every path drives slower. Set its caps in its panel."><i className="ti ti-square-half" style={{ color: "#ca8a04" }} /></ToolButton>
          <ToolButton on={tool.kind === "rotation"} onClick={() => setTool({ kind: "rotation" })} label="Rotation" k="T" desc="Click on the path: a heading to hit at that point of the segment (PathPlanner's rotation targets). Drag its arrow to turn it."><i className="ti ti-rotate-clockwise-2" style={{ color: "#e95420" }} /></ToolButton>
          <ToolButton on={tool.kind === "ruler"} onClick={() => setTool({ kind: "ruler" })} label="Ruler" k="R" desc="Drag to measure a distance and an angle on the field. It snaps to waypoints and poses; Esc clears it."><i className="ti ti-ruler-2" /></ToolButton>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <MirrorMenu onMirror={(how, copy) => {
              if (!spec) return
              const m = mirrorPath(spec, how, fieldSize.lengthM, fieldSize.widthM)
              if (copy) { loadPath({ ...m, name: uniqueName(`${spec.name} ${how === "alliance" ? "mirrored" : "flipped"}`), continuesFrom: undefined }, null); setCommit(c => c + 1) }
              else editSpec(() => m, true)
            }} />
            <span title="What the field shows: the path gradient and the layers."><Toggle on={viewOpen} onClick={() => setViewOpen(o => !o)} icon="ti-eye" label="View" /></span>
            <span title="Fit the whole field in view (F)."><Toggle on={false} onClick={() => setFitSignal(s => s + 1)} icon="ti-maximize" label="Fit" /></span>
            {(base?.variants?.length ?? 0) > 0 && (
              <span title="The variant shown, edited and generated">
                <select style={{ ...propertyInputStyle, width: 130, height: 26 }} value={variant ?? ""} onChange={e => setVariant(e.target.value || null)}>
                  <option value="">Base</option>
                  {base!.variants!.map(v => <option key={v.name} value={v.name}>◇ {v.name}</option>)}
                </select>
              </span>
            )}
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
            navgrid={fieldDoc.navgrid}
            selected={selected}
            hovered={hovered}
            tool={tool}
            view={view}
            topSpeed={topSpeed}
            playhead={scrub ?? playhead}
            fitSignal={fitSignal}
            topView={topView}
            onSelect={setSelected}
            onMoveWaypoint={(i, x, y, final) => { moveLinked(i, x, y, final) }}
            onMoveControl={(i, side, x, y, final, free) => editSpec(s => moveControl(s, i, side, x, y, free), final)}
            onRotateWaypoint={rotateLinked}
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
            multi={multi}
            onMulti={setMulti}
            onMoveGroup={(indices, dx, dy, final) => editSpec(s => moveWaypoints(s, indices, dx, dy), final)}
            poseMarks={variables.flatMap(v => {
              const val = scope.get(v.name)
              return v.kind === "pose" && val && typeof val !== "number" ? [{ name: v.name, x: val.x, y: val.y, heading: val.heading }] : []
            })}
            zones={fieldDoc.slowZones ?? []}
            onAddZone={z => {
              editField(d => ({ ...d, slowZones: [...(d.slowZones ?? []), z] }), true)
              setSelected({ kind: "zone", index: (fieldDoc.slowZones ?? []).length })
              setTool({ kind: "select" })
            }}
            onEditZone={(i, patch, final) => editField(d => ({ ...d, slowZones: (d.slowZones ?? []).map((z, j) => (j === i ? ({ ...z, ...patch } as SlowZone) : z)) }), final)}
            branches={branches.flatMap(b => {
              const at = b.continuesAt!
              const fork = base?.waypoints[at]
              if (!fork) return []
              const t = branchTrajs[b.name]
              const points: [number, number][] = t ? t.samples.filter((_, k) => k % 4 === 0).map(q => [q.x, q.y]) : b.waypoints.map(w => [w.x, w.y])
              return [{ name: b.name, condition: b.condition, fork: [fork.x, fork.y] as [number, number], points }]
            })}
            onOpenPath={name => { const e = entries.find(q => q.name === name); if (e?.spec) loadPath(e.spec) }}
            onAddRotation={(segment, fraction, headingDeg) => {
              editSpec(s => ({ ...s, rotationTargets: [...(s.rotationTargets ?? []), { segment, fraction, headingDeg }] }), true)
              setSelected({ kind: "rotation", index: (spec?.rotationTargets ?? []).length })
              setTool({ kind: "select" })
            }}
            onEditRotation={(i, patch, final) => editSpec(s => ({ ...s, rotationTargets: (s.rotationTargets ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }), final)}
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
              robotNames={robotNames}
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
              onSetSegment={(i, mode) => editSpec(s => setSegmentMode(s, i, mode), true)}
              onPathfind={(i, patch) => editWaypoint(i, w => ({ ...w, pathfindNext: { ...w.pathfindNext, ...patch } }), true)}
              onConstraint={(i, patch) => editConstraint(i, patch, true)}
              onConstraintFn={(i, f) => editSpec(s => ({ ...s, scoped: s.scoped.map((c, j) => (j === i ? f(c) : c)) }), true)}
              onEventFn={(i, f) => editSpec(s => ({ ...s, events: (s.events ?? []).map((e, j) => (j === i ? f(e) : e)) }), true)}
              onKeepOutFn={(i, f) => editField(d => ({ ...d, keepOut: d.keepOut.map((k, j) => (j === i ? f(k) : k)) }), true)}
              stopIndexOf={i => stopAt(spec, i)}
              onBranch={createBranch}
              zones={fieldDoc.slowZones ?? []}
              onZoneFn={(i, f) => editField(d => ({ ...d, slowZones: (d.slowZones ?? []).map((z, j) => (j === i ? f(z) : z)) }), true)}
              onRotationFn={(i, f) => editSpec(s => ({ ...s, rotationTargets: (s.rotationTargets ?? []).map((r, j) => (j === i ? f(r) : r)) }), true)}
              otherPaths={entries.map(e => e.name).filter(n => n !== spec.name)}
              onContinueFrom={name => editSpec(s => ({ ...s, continuesFrom: name }), true)}
              poses={variables.filter(v => v.kind === "pose").map(v => ({ name: v.name, computed: v.kind === "pose" && (isExpr(v.x) || isExpr(v.y)) }))}
              onLink={(i, name) => {
                if (!name) { editWaypoint(i, w => dropExprs(w, ["x", "y", "headingDeg"]), true); return }
                const pose = scope.get(name)
                if (!pose || typeof pose === "number") { setNote(`"${name}" has no value yet`); return }
                editWaypoint(i, w => linkToPose(w, name, pose, kindOf(w) === "pose"), true)
              }}
              onSaveAsPose={async i => {
                const w = spec.waypoints[i]
                let name = "pose"
                for (let k = 2; variables.some(v => v.name === name); k++) name = `pose${k}`
                const typed = (await askText("Name for the new pose variable", name, "The waypoint becomes linked to it: move the variable and every path that uses it moves."))?.trim()
                if (!typed) return
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(typed) || variables.some(v => v.name === typed)) { setNote(`"${typed}" is not a free variable name`); return }
                const heading = w.headingDeg ?? Math.round(headingAt(shown, w) * 10) / 10
                setVariables([...variables, { name: typed, kind: "pose", x: numberText(w.x), y: numberText(w.y), heading: numberText(heading) }])
                editWaypoint(i, q => linkToPose(q, typed, { x: w.x, y: w.y, heading }, kindOf(q) === "pose"), true)
              }}
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
        {view.charts && shown && (
          <Charts
            trajectory={shown}
            playhead={playhead}
            limits={{ speed: topSpeed, accel: robot.drivetrain.wheelCof * 9.80665, current: robot.drivetrain.driveCurrentLimitA }}
            onScrub={setScrub}
            onSeek={t => { setPlaying(false); setPlayhead(t) }}
          />
        )}
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
          <i className="ti ti-pencil" style={{ color: "#e95420", fontSize: 13 }} /><span>Manual curve (drag its square handles)</span>
          <span style={{ width: 13, height: 13, borderRadius: 7, background: "#16a34a", color: "#fff", fontSize: 9.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>?</span><span>Pathfind at run time (estimated route)</span>
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
  corridor: "Around a pathfind estimate, the band the robot can use: a bumper's reach each side.",
  navgrid: "The cells the pathfinder keeps out of (drawn in the Field tab): only the \"?\" segments obey them.",
  charts: "Speed, acceleration, turn rate, heading, current and grip over time, under the field.",
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
      <div title="Plan: a dark technical drawing of the field. Photo: the field image.">
        <PropertyRow label="Field">
          <select style={propertyInputStyle} value={view.fieldStyle} onChange={e => onChange({ ...view, fieldStyle: e.target.value as ViewOptions["fieldStyle"] })}>
            <option value="blueprint">Plan (drawing)</option>
            <option value="photo">Photo</option>
          </select>
        </PropertyRow>
      </div>
      <div title="WPILib puts the blue alliance at x = 0. Mirror (or turn) the field picture so its blue side is there. Coordinates do not change.">
        <PropertyRow label="Blue alliance at x = 0">
          <select style={propertyInputStyle} value={view.fieldFlip} onChange={e => onChange({ ...view, fieldFlip: e.target.value as ViewOptions["fieldFlip"] })}>
            <option value="mirror">Mirror the picture</option>
            <option value="rotate">Turn the picture 180°</option>
            <option value="none">Picture as is</option>
          </select>
        </PropertyRow>
      </div>
      <div title="The 2D robot's color. Its STL is painted with it so it stands out on the field.">
        <PropertyRow label="Robot color">
          <input type="color" value={view.robotColor} onChange={e => onChange({ ...view, robotColor: e.target.value })} style={{ width: 40, height: 20, border: "none", padding: 0, background: "none" }} />
          <span style={{ display: "flex", gap: 4, marginLeft: 8 }}>
            {["#22d3ee", "#e95420", "#facc15", "#4ade80", "#f472b6", "#ffffff"].map(c => (
              <span key={c} onClick={() => onChange({ ...view, robotColor: c })} title={c}
                style={{ width: 14, height: 14, background: c, border: view.robotColor === c ? "2px solid var(--text-primary)" : "1px solid var(--border-dark)", cursor: "pointer" }} />
            ))}
          </span>
        </PropertyRow>
      </div>
      <div title="Drags land on a grid of this size. Off keeps millimeters.">
        <PropertyRow label="Snap to grid">
          <select style={propertyInputStyle} value={view.snap} onChange={e => onChange({ ...view, snap: Number(e.target.value) })}>
            <option value={0}>Off</option>
            <option value={0.05}>5 cm</option>
            <option value={0.1}>10 cm</option>
            <option value={0.25}>25 cm</option>
            <option value={0.5}>50 cm</option>
          </select>
        </PropertyRow>
      </div>
      <div title="While dragging, line up with other waypoints and poses (dashed guides).">
        <PropertyRow label="Alignment guides">
          <input type="checkbox" checked={view.guides} onChange={e => onChange({ ...view, guides: e.target.checked })} />
        </PropertyRow>
      </div>
      <PropertyRow label="Path gradient">
        <select style={propertyInputStyle} value={view.gradient} title={GRADIENTS.find(g => g.id === view.gradient)?.hint}
          onChange={e => onChange({ ...view, gradient: e.target.value as ViewOptions["gradient"] })}>
          {GRADIENTS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
      </PropertyRow>
      {([
        ["field", "Field"], ["grid", "Grid (1 m)"], ["guess", "Guess (spline)"], ["trajectory", "Trajectory"],
        ["samples", "Samples"], ["waypoints", "Waypoints & constraints"], ["corridor", "Pathfind corridor"], ["navgrid", "Navgrid (pathfinder)"], ["charts", "Charts"], ["flipped", "Other alliance (mirror)"],
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
                {c.type === "stopPoint" ? <StopIcon size={13} /> : <i className={`ti ${c.icon}`} style={{ color: "#e95420" }} />}
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
  if (running) {
    return (
      <button onClick={onClick} title="Stop generating: the solver stops at its next iteration and nothing is saved"
        style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid #a81818", borderRadius: 2, background: "#c21c1c", color: "#ffffff" }}>
        <i className="ti ti-player-stop" /> Stop
      </button>
    )
  }
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

export function loadView(): ViewOptions {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw) return { ...DEFAULT_VIEW, ...JSON.parse(raw) }
  } catch { /* defaults */ }
  return DEFAULT_VIEW
}

function MirrorMenu({ onMirror }: { onMirror: (how: "alliance" | "vertical", copy: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const item = (label: string, hint: string, f: () => void) => (
    <div title={hint} onClick={() => { setOpen(false); f() }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--tree-hover-bg)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
      style={{ padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>{label}</div>
  )
  return (
    <span style={{ position: "relative" }} title="Mirror the path: across the field to the other alliance, or top to bottom.">
      <Toggle on={open} onClick={() => setOpen(o => !o)} icon="ti-flip-vertical" label="Mirror ▾" />
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: 28, right: 0, zIndex: 31, minWidth: 240, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "2px 2px 0 var(--shadow-soft)", padding: "3px 0" }}>
            {item("Other alliance → new path", "A copy as the other alliance would run it: x mirrored, headings turned.", () => onMirror("alliance", true))}
            {item("Top ↔ bottom → new path", "A copy on the other side of the field: y mirrored, headings turned.", () => onMirror("vertical", true))}
            <div style={{ height: 1, background: "var(--border-light)", margin: "3px 0" }} />
            {item("Other alliance (this path)", "Mirror this path in place (Ctrl+Z undoes it).", () => onMirror("alliance", false))}
            {item("Top ↔ bottom (this path)", "Flip this path in place (Ctrl+Z undoes it).", () => onMirror("vertical", false))}
          </div>
        </>
      )}
    </span>
  )
}
