// What the path editor exchanges with the backend. Mirrors ares-core's
// PathSpec and Trajectory and the app's FieldDoc (serde, camelCase).

export interface Waypoint { x: number; y: number; headingDeg?: number }

export interface PathConstraints { maxVelocityMps?: number; maxAngularVelocityDps?: number }

export interface PathSpec { name: string; waypoints: Waypoint[]; constraints: PathConstraints }

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

export interface Trajectory { name: string; robot: string; durationS: number; samples: Sample[] }

export interface KeepOut { x: number; y: number; radiusM: number }

export interface FieldDoc { walls: boolean; keepOut: KeepOut[] }

export interface PathEntry { name: string; spec: PathSpec | null; error: string | null }

export interface PlanResult { trajectory: Trajectory; splineDurationS: number; iterations: number; solveMs: number }

export type Selection = { kind: "waypoint"; index: number } | { kind: "keepout"; index: number } | null

export type Tool = "select" | "waypoint" | "keepout"

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

export function newPathSpec(name: string): PathSpec {
  return {
    name,
    waypoints: [{ x: 2, y: 4, headingDeg: 0 }, { x: 5, y: 5.5 }, { x: 7, y: 4, headingDeg: 0 }],
    constraints: {},
  }
}
