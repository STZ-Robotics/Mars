// The Characterize tab's data: what AresLib's routines publish under
// /Ares/Characterize/<routine> (see areslib characterize/), read through
// MARS Desktop's NT4 client.

/** NTValue as the Rust client serializes it: one key, the type. */
export type NtValue = { Number: number } | { Boolean: boolean } | { String: string } | { NumberArray: number[] } | { BooleanArray: boolean[] } | { StringArray: string[] } | { Raw: number[] }

export type Routine = "Drive" | "Steer" | "WheelRadius"
export const ROUTINES: Routine[] = ["Drive", "Steer", "WheelRadius"]

export const PREFIX = "/Ares/Characterize/"
/** The dashboard button: setting its `running` topic to true starts the command. */
export const runTopic = (r: Routine) => `/SmartDashboard/Ares Characterize/${r}/running`

export interface RoutineState {
  state: string
  progress: number
  volts: number[]
  speed: number[]
  results: Record<string, number>
  /** Wheel radius while it spins. */
  live?: number
}

export function num(v: NtValue | undefined): number | undefined {
  return v && "Number" in v ? v.Number : undefined
}

export function arr(v: NtValue | undefined): number[] {
  return v && "NumberArray" in v ? v.NumberArray : []
}

export function str(v: NtValue | undefined): string | undefined {
  return v && "String" in v ? v.String : undefined
}

/** Every routine's state out of the topics under /Ares/Characterize/. */
export function readRoutines(values: Record<string, NtValue>): Record<Routine, RoutineState | null> {
  const out = {} as Record<Routine, RoutineState | null>
  for (const r of ROUTINES) {
    const base = `${PREFIX}${r}/`
    const state = str(values[`${base}State`])
    if (state === undefined) { out[r] = null; continue }
    const results: Record<string, number> = {}
    for (const k of ["kS", "kV", "R2", "WheelRadiusM", "kVTheory", "TurnedRad"]) {
      const v = num(values[`${base}${k}`])
      if (v !== undefined) results[k] = v
    }
    out[r] = { state, progress: num(values[`${base}Progress`]) ?? 0, volts: arr(values[`${base}Volts`]), speed: arr(values[`${base}Speed`]), results, live: num(values[`${base}LiveRadiusM`]) }
  }
  return out
}

/** |V| = kS + kV·speed through the points that moved, as the robot fits it. */
export function fit(volts: number[], speed: number[], minSpeed: number): { kS: number; kV: number; r2: number; n: number } | null {
  const pts = volts.map((v, i) => [speed[i], Math.abs(v)] as const).filter(([s]) => s > minSpeed)
  const n = pts.length
  if (n < 2) return null
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y }
  const dx = n * sxx - sx * sx, dy = n * syy - sy * sy
  if (dx <= 0) return null
  const kV = (n * sxy - sx * sy) / dx
  const kS = (sy - kV * sx) / n
  const r = dy > 0 ? (n * sxy - sx * sy) / Math.sqrt(dx * dy) : 1
  return { kS, kV, r2: r * r, n }
}

/** The measured gains as Tuner X's Slot0, keeping the code's kP and kD. */
export function slot0(name: "driveGains" | "steerGains", kS: number, kV: number, kp: number | null, kd: number | null): string {
  const f = (x: number) => +x.toFixed(4)
  return `private static final Slot0Configs ${name} =\n    new Slot0Configs().withKP(${kp ?? 0}).withKI(0).withKD(${kd ?? 0}).withKS(${f(kS)}).withKV(${f(kV)});`
}

/** characterization.json: the last results, which Tune starts from. */
export interface CharacterizationDoc {
  drive?: { kS: number; kV: number; r2: number; wheelRadiusM?: number; at: number }
  steer?: { kS: number; kV: number; r2: number; at: number }
  wheelRadiusM?: { value: number; at: number }
}
