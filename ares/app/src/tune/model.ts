// The Tune tab's data: what goes to ares-tune (src: tune/src) and what comes
// back. Mirrors its serde types (camelCase).

import type { RobotConfig } from "../robot/types"

export interface Pid { kp: number; ki: number; kd: number }

export interface RobotCode {
  translation: Pid
  rotation: Pid
  driveKp: number
  driveKs: number
  driveKv: number
  speedAt12vMps: number
  statorLimitA: number
  supplyLimitA: number
  forceFf: boolean
}

export interface World {
  massKg: number
  moiKgM2: number
  cogHeightM: number
  mu: number
  batteryV: number
  batteryROhm: number
  wheelRadiusM: number
  motorScale: number
  driveFrictionV: number
  wheelMassKg: number
  latencyS: number
  poseNoiseM: number
  headingNoiseRad: number
  startOffsetXM: number
  startOffsetYM: number
  startOffsetRad: number
  steerTauS: number
  steerRateRadps: number
  perfectOdometry: boolean
  seed: number
}

export interface Param { key: ParamKey; min: number; max: number; start: number; log: boolean; tune: boolean }

export type ParamKey =
  | "translationKp" | "translationKi" | "translationKd"
  | "rotationKp" | "rotationKi" | "rotationKd"
  | "driveKp" | "driveKs" | "driveKv"

export type Method = { kind: "population"; generations: number; population: number } | { kind: "grid"; steps: number }
export type Criterion = "worst" | "mean" | "p90"

export interface TuneConfig {
  code: RobotCode
  params: Param[]
  world: World
  vary: Record<string, number>
  environments: number
  method: Method
  criterion: Criterion
  sim: { abortM: number; settleS: number; record: boolean }
  seed: number
}

export interface Candidate {
  values: number[]
  score: number
  perEnv: number[]
  perPath: number[]
  aborts: number
  meanRmsM: number
  worstFinalM: number
}

export interface HistoryPoint { generation: number; best: number; genBest: number; genMedian: number; genWorst: number }
export interface Track { env: number; path: number; cost: number; aborted: boolean; points: [number, number, number][] }

export interface Progress {
  generation: number
  generations: number
  runs: number
  elapsedS: number
  baseline: Candidate
  best: Candidate
  population: Candidate[]
  history: HistoryPoint[]
  tracks: Track[]
  baselineTracks: Track[]
  worlds: World[]
  done: boolean
  cancelled: boolean
}

/** What robot_tuning reads from the robot code (null: not found). */
export interface RobotTuning {
  file: string | null
  driveKp: number | null
  driveKs: number | null
  driveKv: number | null
  speedAt12vMps: number | null
  slipCurrentA: number | null
  driveFrictionV: number | null
  translation: [number, number, number] | null
  rotation: [number, number, number] | null
}

export const PARAM_INFO: Record<ParamKey, { label: string; group: "Path controller (AresLib)" | "Drive motor (TunerConstants)"; unit: string; hint: string }> = {
  translationKp: { label: "Translation kP", group: "Path controller (AresLib)", unit: "1/s", hint: "m/s of correction per meter off the trajectory, in x and in y." },
  translationKi: { label: "Translation kI", group: "Path controller (AresLib)", unit: "", hint: "Usually 0: the forces already carry the robot." },
  translationKd: { label: "Translation kD", group: "Path controller (AresLib)", unit: "s", hint: "Damps the correction; 0–0.5." },
  rotationKp: { label: "Rotation kP", group: "Path controller (AresLib)", unit: "1/s", hint: "rad/s of correction per radian off the heading." },
  rotationKi: { label: "Rotation kI", group: "Path controller (AresLib)", unit: "", hint: "Usually 0." },
  rotationKd: { label: "Rotation kD", group: "Path controller (AresLib)", unit: "s", hint: "Damps the heading correction." },
  driveKp: { label: "Drive kP", group: "Drive motor (TunerConstants)", unit: "V/rps", hint: "The TalonFX's velocity loop: volts per rotor rps of error." },
  driveKs: { label: "Drive kS", group: "Drive motor (TunerConstants)", unit: "V", hint: "Volts to break static friction." },
  driveKv: { label: "Drive kV", group: "Drive motor (TunerConstants)", unit: "V/rps", hint: "Volts per rotor rps: should match the motor (≈0.12 for a Kraken)." },
}

/** The variables a world can vary, with how they show and their default spread. */
export const WORLD_VARS: { key: keyof World; label: string; unit: string; scale: number; spread: number; on: boolean; hint: string }[] = [
  { key: "massKg", label: "Mass", unit: "kg", scale: 1, spread: 4, on: true, hint: "With battery and bumpers. A heavier robot brakes later." },
  { key: "mu", label: "Carpet grip μ", unit: "", scale: 1, spread: 0.1, on: true, hint: "Worn treads, a dusty field: less grip means slip, and slip means the odometry lies." },
  { key: "batteryV", label: "Battery at rest", unit: "V", scale: 1, spread: 1, on: true, hint: "A charged battery is ~12.7 V, a tired one under 12." },
  { key: "batteryROhm", label: "Battery resistance", unit: "mΩ", scale: 1000, spread: 0.005, on: true, hint: "Battery plus wiring: how much it sags while the drive pulls current." },
  { key: "cogHeightM", label: "CoG height", unit: "m", scale: 1, spread: 0.05, on: false, hint: "Higher moves more load between the wheels as the robot accelerates." },
  { key: "moiKgM2", label: "Inertia", unit: "kg·m²", scale: 1, spread: 1, on: false, hint: "How hard the robot is to turn." },
  { key: "wheelRadiusM", label: "Wheel radius", unit: "mm", scale: 1000, spread: 0.0015, on: true, hint: "Worn treads: the code believes the nominal radius, the odometry drifts." },
  { key: "motorScale", label: "Motor strength", unit: "×", scale: 1, spread: 0.05, on: true, hint: "Motors differ from the datasheet, and weaken hot." },
  { key: "driveFrictionV", label: "Drive friction", unit: "V", scale: 1, spread: 0.1, on: false, hint: "Volts lost in each module's gears and bearings." },
  { key: "latencyS", label: "Latency", unit: "ms", scale: 1000, spread: 0.01, on: true, hint: "Between the robot moving and the code knowing." },
  { key: "poseNoiseM", label: "Pose noise", unit: "cm", scale: 100, spread: 0.01, on: false, hint: "Vision corrections jumping the pose estimate." },
  { key: "startOffsetXM", label: "Placed off, x", unit: "cm", scale: 100, spread: 0.05, on: true, hint: "How far from the start the drive team puts the robot." },
  { key: "startOffsetYM", label: "Placed off, y", unit: "cm", scale: 100, spread: 0.05, on: true, hint: "" },
  { key: "startOffsetRad", label: "Placed off, heading", unit: "°", scale: 180 / Math.PI, spread: 0.035, on: true, hint: "" },
  { key: "steerTauS", label: "Steer response", unit: "ms", scale: 1000, spread: 0.01, on: false, hint: "How quickly a module turns to its angle." },
]

/** The robot as its robot.json says, as tune's World::nominal builds it. */
export function nominalWorld(r: RobotConfig): World {
  return {
    massKg: r.massKg, moiKgM2: r.moiKgM2, cogHeightM: r.cogHeightM ?? 0, mu: r.drivetrain.wheelCof,
    batteryV: 12.5, batteryROhm: 0.015, wheelRadiusM: r.drivetrain.wheelRadiusM, motorScale: 1, driveFrictionV: 0.2,
    wheelMassKg: 1.5, latencyS: 0.02, poseNoiseM: 0, headingNoiseRad: 0, startOffsetXM: 0, startOffsetYM: 0, startOffsetRad: 0,
    steerTauS: 0.02, steerRateRadps: 24, perfectOdometry: false, seed: 1,
  }
}

/** The robot code as Tuner X and the drive subsystem have it, with what was read from the Java. */
export function robotCode(t: RobotTuning | null): RobotCode {
  return {
    translation: { kp: t?.translation?.[0] ?? 5, ki: t?.translation?.[1] ?? 0, kd: t?.translation?.[2] ?? 0 },
    rotation: { kp: t?.rotation?.[0] ?? 5, ki: t?.rotation?.[1] ?? 0, kd: t?.rotation?.[2] ?? 0 },
    driveKp: t?.driveKp ?? 0.1, driveKs: t?.driveKs ?? 0, driveKv: t?.driveKv ?? 0.124,
    speedAt12vMps: t?.speedAt12vMps ?? 5.85, statorLimitA: t?.slipCurrentA ?? 120, supplyLimitA: 70, forceFf: true,
  }
}

export function defaultParams(code: RobotCode): Param[] {
  return [
    { key: "translationKp", min: 0.5, max: 40, start: code.translation.kp, log: true, tune: true },
    { key: "translationKd", min: 0, max: 0.6, start: code.translation.kd, log: false, tune: true },
    { key: "translationKi", min: 0, max: 2, start: code.translation.ki, log: false, tune: false },
    { key: "rotationKp", min: 0.5, max: 40, start: code.rotation.kp, log: true, tune: true },
    { key: "rotationKd", min: 0, max: 0.6, start: code.rotation.kd, log: false, tune: true },
    { key: "rotationKi", min: 0, max: 2, start: code.rotation.ki, log: false, tune: false },
    { key: "driveKp", min: 0.01, max: 1, start: code.driveKp, log: true, tune: false },
    { key: "driveKs", min: 0, max: 0.4, start: code.driveKs, log: false, tune: false },
    { key: "driveKv", min: 0.08, max: 0.16, start: code.driveKv, log: false, tune: false },
  ]
}

/** The tuned gains as Java to paste: AresLib's config, and Tuner X's Slot0 when the drive was tuned. */
export function javaSnippet(params: Param[], values: number[]): string {
  const v = (k: ParamKey) => values[params.findIndex(p => p.key === k)] ?? 0
  const f = (x: number) => (Math.abs(x) < 1e-9 ? "0" : x.toFixed(x >= 10 ? 1 : 3).replace(/\.?0+$/, ""))
  const lines = [
    "new Ares.Config().withGains(",
    `    new AresController.Gains(${f(v("translationKp"))}, ${f(v("translationKi"))}, ${f(v("translationKd"))}),`,
    `    new AresController.Gains(${f(v("rotationKp"))}, ${f(v("rotationKi"))}, ${f(v("rotationKd"))}))`,
  ]
  if (params.some(p => p.tune && p.key.startsWith("drive"))) {
    lines.push("", "// TunerConstants", `driveGains = new Slot0Configs().withKP(${f(v("driveKp"))}).withKS(${f(v("driveKs"))}).withKV(${f(v("driveKv"))});`)
  }
  return lines.join("\n")
}

/** The highest fraction of grip any wheel uses along a trajectory: 1 leaves the feedback nothing. */
export function gripUsed(samples: { modules: { gripUsed: number }[] }[]): number {
  let m = 0
  for (const s of samples) for (const w of s.modules) m = Math.max(m, w.gripUsed)
  return m
}
