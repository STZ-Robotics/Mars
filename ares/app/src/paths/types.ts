// What the path editor exchanges with the backend. Mirrors ares-core's
// PathSpec and Trajectory and the app's FieldDoc (serde, camelCase).

export type WaypointKind = "pose" | "translation" | "empty"

export interface Waypoint {
  x: number
  y: number
  headingDeg?: number
  kind?: WaypointKind
  /** Samples to the next waypoint, overriding the automatic count. */
  intervals?: number
  split?: boolean
  /** The segment to the next waypoint is drawn by hand (a Bézier). */
  manualNext?: boolean
  /** Bézier control points, field coordinates (PathPlanner's). */
  prevControl?: [number, number]
  nextControl?: [number, number]
  /** The segment to the next waypoint is pathfound at run time. */
  pathfindNext?: PathfindOptions
}

/** The limits the robot pathfinds with (PathPlanner's PathConstraints). */
export interface PathfindOptions { maxVelocityMps?: number; maxAccelerationMps2?: number; maxAngularVelocityDps?: number }

/** How the segment from a waypoint to the next is made. */
export type SegmentMode = "optimized" | "manual" | "pathfind"

export function segmentMode(w: Waypoint): SegmentMode {
  return w.pathfindNext ? "pathfind" : w.manualNext ? "manual" : "optimized"
}

/** Which waypoint a constraint or event points at. */
export type Target = "first" | "last" | { index: number }

export type ConstraintKind =
  | { type: "stopPoint"; waitS?: number }
  | { type: "maxVelocity"; mps: number }
  | { type: "maxAcceleration"; mps2: number }
  | { type: "maxAngularVelocity"; dps: number }
  | { type: "pointAt"; x: number; y: number; toleranceDeg: number; flip?: boolean }
  | { type: "keepInCircle"; x: number; y: number; radiusM: number }
  | { type: "keepInRectangle"; x: number; y: number; widthM: number; heightM: number }
  | { type: "keepInLane"; toleranceM: number }
  | { type: "keepOutCircle"; x: number; y: number; radiusM: number }

export type ConstraintType = ConstraintKind["type"]

export type ScopedConstraint = ConstraintKind & { from: Target; to?: Target; enabled?: boolean }

export interface EventMarker { name: string; target: Target; offsetS: number }

export interface PathConstraints { maxVelocityMps?: number; maxAngularVelocityDps?: number }

export interface PathSpec {
  name: string
  waypoints: Waypoint[]
  constraints: PathConstraints
  scoped: ScopedConstraint[]
  events?: EventMarker[]
}

export interface ModuleSample {
  speedMps: number
  angleRad: number
  forceN: number
  gripUsed: number
  loadN: number
  currentA: number
}

export interface Sample {
  t: number
  x: number
  y: number
  heading: number
  vx: number
  vy: number
  omega: number
  ax: number
  ay: number
  alpha: number
  modules: ModuleSample[]
}

export interface Trajectory {
  name: string
  robot: string
  durationS: number
  samples: Sample[]
  waypointTimes?: number[]
  splits?: number[]
  events?: { name: string; t: number }[]
  pathfind?: PathfindSpan[]
}

export interface PathfindSpan {
  startSample: number
  endSample: number
  fromWaypoint: number
  toWaypoint: number
  goalX: number
  goalY: number
  goalHeading: number
  maxVelocityMps?: number
  maxAccelerationMps2?: number
  maxAngularVelocityDps?: number
  estimatedS: number
}

export interface KeepOut { x: number; y: number; radiusM: number }

export interface FieldDoc { walls: boolean; keepOut: KeepOut[] }

export interface PathEntry { name: string; spec: PathSpec | null; error: string | null }

export interface PlanResult { trajectory: Trajectory; splineDurationS: number; iterations: number; solveMs: number }

export type Selection =
  | { kind: "waypoint"; index: number }
  | { kind: "keepout"; index: number }
  | { kind: "constraint"; index: number }
  | { kind: "event"; index: number }
  | null

/** What a click on the field does. */
export type Tool =
  | { kind: "select" }
  | { kind: "waypoint"; type: WaypointKind }
  | { kind: "keepout" }
  | { kind: "constraint"; type: ConstraintType; from: number | null }
  | { kind: "event" }

export type Gradient = "none" | "velocity" | "progress" | "acceleration" | "interval" | "angular" | "splits"

export interface ViewOptions {
  /** A dark technical drawing of the field, or the photo. */
  fieldStyle: "blueprint" | "photo"
  /** The 2D robot's color (its STL is tinted with it). */
  robotColor: string
  field: boolean
  grid: boolean
  guess: boolean
  trajectory: boolean
  samples: boolean
  waypoints: boolean
  flipped: boolean
  /** The band a pathfind segment's route can take. */
  corridor: boolean
  gradient: Gradient
}

export const DEFAULT_VIEW: ViewOptions = {
  fieldStyle: "blueprint", robotColor: "#22d3ee",
  field: true, grid: false, guess: true, trajectory: true, samples: false, waypoints: true, flipped: false, corridor: true, gradient: "velocity",
}

export const GRADIENTS: { id: Gradient; label: string; hint: string }[] = [
  { id: "none", label: "None", hint: "One color." },
  { id: "velocity", label: "Linear velocity", hint: "Faster is warmer, up to the usable speed." },
  { id: "progress", label: "Progress", hint: "Later in the path is warmer." },
  { id: "acceleration", label: "Linear acceleration", hint: "Harder acceleration or braking is warmer." },
  { id: "interval", label: "Interval Δt", hint: "Shorter time between samples is warmer: where the solver had to look closely." },
  { id: "angular", label: "Angular velocity", hint: "Faster rotation is warmer." },
  { id: "splits", label: "Split trajectories", hint: "Each part between split waypoints in its own color." },
]

export const CONSTRAINTS: { type: ConstraintType; label: string; icon: string; scope: "waypoint" | "segment" | "both"; hint: string }[] = [
  { type: "stopPoint", label: "Stop Point", icon: "ti-player-stop", scope: "waypoint", hint: "At rest here: no linear or angular velocity." },
  { type: "maxVelocity", label: "Max Velocity", icon: "ti-gauge", scope: "both", hint: "A cap on the chassis' speed." },
  { type: "maxAcceleration", label: "Max Acceleration", icon: "ti-trending-up", scope: "both", hint: "A cap on the chassis' acceleration." },
  { type: "maxAngularVelocity", label: "Max Angular Velocity", icon: "ti-rotate", scope: "both", hint: "A cap on the turn rate." },
  { type: "pointAt", label: "Point At", icon: "ti-target-arrow", scope: "both", hint: "The front (or back) faces a field point, within a tolerance." },
  { type: "keepInCircle", label: "Keep In Circle", icon: "ti-circle-dashed", scope: "both", hint: "Every bumper corner stays inside a circle." },
  { type: "keepInRectangle", label: "Keep In Rectangle", icon: "ti-square-dashed", scope: "both", hint: "Every bumper corner stays inside a rectangle." },
  { type: "keepInLane", label: "Keep In Lane", icon: "ti-road", scope: "segment", hint: "The center stays within a distance of the straight line between the ends." },
  { type: "keepOutCircle", label: "Keep Out Circle", icon: "ti-circle-off", scope: "both", hint: "The bumper stays out of a circle, on this part of the path only." },
]

export function constraintMeta(type: ConstraintType) {
  return CONSTRAINTS.find(c => c.type === type)!
}

/** A new constraint of `type` from `from` to `to`, with its shape near (cx, cy). */
export function newConstraint(type: ConstraintType, from: Target, to: Target | undefined, cx: number, cy: number): ScopedConstraint {
  const scope = { from, to }
  switch (type) {
    case "stopPoint": return { type, from }
    case "maxVelocity": return { type, mps: 2, ...scope }
    case "maxAcceleration": return { type, mps2: 4, ...scope }
    case "maxAngularVelocity": return { type, dps: 180, ...scope }
    case "pointAt": return { type, x: cx, y: cy + 1, toleranceDeg: 5, flip: false, ...scope }
    case "keepInCircle": return { type, x: cx, y: cy, radiusM: 2, ...scope }
    case "keepInRectangle": return { type, x: cx - 1.5, y: cy - 1, widthM: 3, heightM: 2, ...scope }
    case "keepInLane": return { type, toleranceM: 0.3, ...scope }
    case "keepOutCircle": return { type, x: cx, y: cy, radiusM: 0.5, ...scope }
  }
}

/** The kind a waypoint reads as (files from before kinds use the heading). */
export function kindOf(w: Waypoint): WaypointKind {
  if (w.kind === "pose" && w.headingDeg === undefined) return "translation"
  if (w.kind) return w.kind
  return w.headingDeg !== undefined ? "pose" : "translation"
}

export function resolveTarget(t: Target, n: number): number {
  if (t === "first") return 0
  if (t === "last") return n - 1
  return Math.min(t.index, n - 1)
}

export function rangeOf(c: ScopedConstraint, n: number): [number, number] {
  const a = resolveTarget(c.from, n)
  const b = c.to === undefined ? a : resolveTarget(c.to, n)
  return [Math.min(a, b), Math.max(a, b)]
}

export function targetLabel(t: Target): string {
  return t === "first" ? "First" : t === "last" ? "Last" : `#${t.index + 1}`
}

/** Constraints and events after inserting a waypoint at `at`. */
export function afterInsert(spec: PathSpec, at: number): Pick<PathSpec, "scoped" | "events"> {
  const shift = (t: Target): Target => (typeof t === "object" && t.index >= at ? { index: t.index + 1 } : t)
  return {
    scoped: spec.scoped.map(c => ({ ...c, from: shift(c.from), to: c.to === undefined ? undefined : shift(c.to) })),
    events: (spec.events ?? []).map(e => ({ ...e, target: shift(e.target) })),
  }
}

/** Constraints and events after removing waypoint `at`: what pointed at it goes too. */
export function afterRemove(spec: PathSpec, at: number): Pick<PathSpec, "scoped" | "events"> {
  const gone = (t: Target) => typeof t === "object" && t.index === at
  const shift = (t: Target): Target => (typeof t === "object" && t.index > at ? { index: t.index - 1 } : t)
  return {
    scoped: spec.scoped
      .filter(c => !gone(c.from) && !(c.to !== undefined && gone(c.to)))
      .map(c => ({ ...c, from: shift(c.from), to: c.to === undefined ? undefined : shift(c.to) })),
    events: (spec.events ?? []).filter(e => !gone(e.target)).map(e => ({ ...e, target: shift(e.target) })),
  }
}

/** The state at time `t`, interpolated (modules from the sample before). */
export function sampleAt(traj: Trajectory, t: number): Sample {
  const s = traj.samples
  if (t <= s[0].t) return s[0]
  if (t >= s[s.length - 1].t) return s[s.length - 1]
  let lo = 0, hi = s.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (s[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = s[lo], b = s[hi]
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0
  const lerp = (p: number, q: number) => p + (q - p) * f
  return {
    ...a, t,
    x: lerp(a.x, b.x), y: lerp(a.y, b.y), heading: lerp(a.heading, b.heading),
    vx: lerp(a.vx, b.vx), vy: lerp(a.vy, b.vy), omega: lerp(a.omega, b.omega),
  }
}

/** A new path stops at both ends, like Choreo's. */
export function newPathSpec(name: string): PathSpec {
  return {
    name,
    waypoints: [{ x: 2, y: 4, headingDeg: 0, kind: "pose" }, { x: 5, y: 5.5, kind: "translation" }, { x: 7, y: 4, headingDeg: 0, kind: "pose" }],
    constraints: {},
    scoped: [{ type: "stopPoint", from: "first" }, { type: "stopPoint", from: "last" }],
    events: [],
  }
}

/** Constraints and events after moving waypoint `from` to position `to`. */
export function afterMove(spec: PathSpec, from: number, to: number): Pick<PathSpec, "scoped" | "events"> {
  const n = spec.waypoints.length
  // Where each old index lands.
  const order = Array.from({ length: n }, (_, i) => i)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  const where = new Array<number>(n)
  order.forEach((old, now) => { where[old] = now })
  const map = (t: Target): Target => (typeof t === "object" ? { index: where[Math.min(t.index, n - 1)] } : t)
  return {
    scoped: spec.scoped.map(c => ({ ...c, from: map(c.from), to: c.to === undefined ? undefined : map(c.to) })),
    events: (spec.events ?? []).map(e => ({ ...e, target: map(e.target) })),
  }
}

/** The stop point on waypoint `i` alone, if there is one. */
export function stopAt(spec: PathSpec, i: number): number {
  const n = spec.waypoints.length
  return spec.scoped.findIndex(c => c.type === "stopPoint" && c.enabled !== false && rangeOf(c, n)[0] === i)
}

/** Adds or removes the stop point on waypoint `i`. */
export function toggleStop(spec: PathSpec, i: number): PathSpec {
  const k = stopAt(spec, i)
  const n = spec.waypoints.length
  if (k >= 0) return { ...spec, scoped: spec.scoped.filter((_, j) => j !== k) }
  const from: Target = i === 0 ? "first" : i === n - 1 ? "last" : { index: i }
  return { ...spec, scoped: [...spec.scoped, { type: "stopPoint", from }] }
}

/** How long the robot waits at waypoint `i` (0 if it does not stop or wait). */
export function waitAt(spec: PathSpec, i: number): number {
  const k = stopAt(spec, i)
  const c = k >= 0 ? spec.scoped[k] : null
  return c && c.type === "stopPoint" ? c.waitS ?? 0 : 0
}

/** Sets the wait on waypoint `i`'s stop, adding the stop if needed. */
export function setWait(spec: PathSpec, i: number, waitS: number): PathSpec {
  const s = stopAt(spec, i) >= 0 ? spec : toggleStop(spec, i)
  const k = stopAt(s, i)
  return { ...s, scoped: s.scoped.map((c, j) => (j === k ? { ...c, waitS: waitS > 0 ? waitS : undefined } as ScopedConstraint : c)) }
}

/** The waypoint-scope constraints on `i`, other than a stop. */
export function constraintsOn(spec: PathSpec, i: number): ScopedConstraint[] {
  const n = spec.waypoints.length
  return spec.scoped.filter(c => c.type !== "stopPoint" && c.enabled !== false && c.to === undefined && rangeOf(c, n)[0] === i)
}

/** A constraint's few-word summary, for chips on the field and list rows. */
export function constraintChip(c: ScopedConstraint): string {
  switch (c.type) {
    case "stopPoint": return c.waitS ? `Stop ${c.waitS} s` : "Stop"
    case "maxVelocity": return `≤ ${c.mps} m/s`
    case "maxAcceleration": return `≤ ${c.mps2} m/s²`
    case "maxAngularVelocity": return `≤ ${c.dps} °/s`
    case "pointAt": return c.flip ? "Back at ⊕" : "Point at ⊕"
    case "keepInCircle": return "Keep in ◯"
    case "keepInRectangle": return "Keep in ▭"
    case "keepInLane": return `Lane ±${c.toleranceM} m`
    case "keepOutCircle": return "Keep out ⊘"
  }
}

/** Catmull-Rom directions at each waypoint, as the core computes them. */
function directions(ws: Waypoint[]): [number, number][] {
  const n = ws.length
  return ws.map((_, k) => {
    const a = ws[Math.max(0, k - 1)], b = ws[Math.min(n - 1, k + 1)]
    const dx = b.x - a.x, dy = b.y - a.y
    const l = Math.hypot(dx, dy)
    return l > 1e-9 ? [dx / l, dy / l] : [1, 0]
  })
}

/**
 * Turns the segment from `i` to the next waypoint manual (or back). New
 * control points start a third of the chord along the automatic tangent, so
 * the curve barely moves when it becomes editable.
 */
export function setManual(spec: PathSpec, i: number, on: boolean): PathSpec {
  const ws = spec.waypoints.map(w => ({ ...w }))
  if (i < 0 || i >= ws.length - 1) return spec
  if (!on) {
    ws[i].manualNext = undefined
    return { ...spec, waypoints: ws }
  }
  const dir = directions(ws)
  const a = ws[i], b = ws[i + 1]
  const third = Math.hypot(b.x - a.x, b.y - a.y) / 3
  a.manualNext = true
  a.nextControl ??= [a.x + dir[i][0] * third, a.y + dir[i][1] * third]
  b.prevControl ??= [b.x - dir[i + 1][0] * third, b.y - dir[i + 1][1] * third]
  return { ...spec, waypoints: ws }
}

/** Whether waypoint `i` has a manual segment on side `side`. */
export function manualSide(spec: PathSpec, i: number, side: "prev" | "next"): boolean {
  return side === "next" ? !!spec.waypoints[i]?.manualNext : !!spec.waypoints[i - 1]?.manualNext
}

/**
 * Moves one control point. When both of the waypoint's segments are manual
 * the other control turns with it (same line, its own length) so the curve
 * stays smooth, PathPlanner's behavior; `free` breaks the tangent instead.
 */
export function moveControl(spec: PathSpec, i: number, side: "prev" | "next", x: number, y: number, free: boolean): PathSpec {
  const ws = spec.waypoints.map(w => ({ ...w }))
  const w = ws[i]
  if (side === "next") w.nextControl = [x, y]
  else w.prevControl = [x, y]
  const other = side === "next" ? "prev" : "next"
  const otherKey = other === "next" ? "nextControl" : "prevControl"
  const otherCtl = w[otherKey]
  if (!free && otherCtl && manualSide(spec, i, other)) {
    const len = Math.hypot(otherCtl[0] - w.x, otherCtl[1] - w.y)
    const dx = w.x - x, dy = w.y - y
    const l = Math.hypot(dx, dy)
    if (l > 1e-9) w[otherKey] = [w.x + (dx / l) * len, w.y + (dy / l) * len]
  }
  return { ...spec, waypoints: ws }
}

/** A waypoint moved by (dx, dy) carries its control points along. */
export function shiftControls(w: Waypoint, dx: number, dy: number): Waypoint {
  return {
    ...w,
    prevControl: w.prevControl ? [w.prevControl[0] + dx, w.prevControl[1] + dy] : undefined,
    nextControl: w.nextControl ? [w.nextControl[0] + dx, w.nextControl[1] + dy] : undefined,
  }
}

/** Sets how the segment from waypoint `i` to the next is made. */
export function setSegmentMode(spec: PathSpec, i: number, mode: SegmentMode): PathSpec {
  if (i < 0 || i >= spec.waypoints.length - 1) return spec
  const base = setManual(spec, i, mode === "manual")
  const ws = base.waypoints.map((w, j) => (j === i ? { ...w, pathfindNext: mode === "pathfind" ? (w.pathfindNext ?? {}) : undefined } : w))
  return { ...base, waypoints: ws }
}

export const NEXT_MODE: Record<SegmentMode, SegmentMode> = { optimized: "manual", manual: "pathfind", pathfind: "optimized" }
