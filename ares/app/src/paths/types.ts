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
}

/** Which waypoint a constraint or event points at. */
export type Target = "first" | "last" | { index: number }

export type ConstraintKind =
  | { type: "stopPoint" }
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
  field: boolean
  grid: boolean
  guess: boolean
  trajectory: boolean
  samples: boolean
  waypoints: boolean
  flipped: boolean
  gradient: Gradient
}

export const DEFAULT_VIEW: ViewOptions = {
  field: true, grid: false, guess: true, trajectory: true, samples: false, waypoints: true, flipped: false, gradient: "velocity",
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
