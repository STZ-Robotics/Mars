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
  replan: Replan | null
}

/** AresLib's recovery: replan when knocked off, and arrive at the end. */
export interface Replan {
  toleranceM: number
  delayS: number
  rejoinAheadS: number
  maxReplans: number
  arriveM: number
  maxVelocityMps: number
  maxAccelerationMps2: number
  maxOmegaRadps: number
  maxAlphaRadps2: number
}

export const DEFAULT_REPLAN: Replan = {
  toleranceM: 0.5, delayS: 0.2, rejoinAheadS: 1.0, maxReplans: 3, arriveM: 0.1,
  maxVelocityMps: 3, maxAccelerationMps2: 3, maxOmegaRadps: 2 * Math.PI, maxAlphaRadps2: 4 * Math.PI,
}

/** A shove, field frame. `at` is a fraction of the path. */
export interface Push { at: number; durationS: number; fxN: number; fyN: number; torqueNm: number }

/** How the worlds get shoved (all but the nominal one). */
export interface Disturbance {
  perRun: number
  forceMinN: number
  forceMaxN: number
  durationMinS: number
  durationMaxS: number
  leverMaxM: number
  from: number
  to: number
}

export const DISTURBANCE_PRESETS: { id: string; label: string; hint: string; d: Disturbance }[] = [
  { id: "bump", label: "Bumps (a robot runs into it)", hint: "Short, hard hits: 300–900 N for a tenth to a quarter of a second, off center.",
    d: { perRun: 1, forceMinN: 300, forceMaxN: 900, durationMinS: 0.08, durationMaxS: 0.25, leverMaxM: 0.35, from: 0.15, to: 0.85 } },
  { id: "defense", label: "Defense (pushed for a while)", hint: "A defender leaning on it: 150–400 N for half a second to a second and a half.",
    d: { perRun: 1, forceMinN: 150, forceMaxN: 400, durationMinS: 0.5, durationMaxS: 1.5, leverMaxM: 0.15, from: 0.1, to: 0.8 } },
  { id: "both", label: "Both, twice a run", hint: "Two shoves per run, from a light lean to a hard hit.",
    d: { perRun: 2, forceMinN: 150, forceMaxN: 900, durationMinS: 0.08, durationMaxS: 1.0, leverMaxM: 0.3, from: 0.1, to: 0.9 } },
]

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
  pushes: Push[]
  visionHz: number
  visionNoiseM: number
  visionGain: number
}

export interface Param { key: ParamKey; min: number; max: number; start: number; log: boolean; tune: boolean }

export type ParamKey =
  | "translationKp" | "translationKi" | "translationKd"
  | "rotationKp" | "rotationKi" | "rotationKd"
  | "driveKp" | "driveKs" | "driveKv"
  | "replanToleranceM" | "replanDelayS" | "rejoinAheadS" | "arriveM"

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
  disturbance: Disturbance | null
}

export interface Candidate {
  values: number[]
  score: number
  perEnv: number[]
  perPath: number[]
  aborts: number
  meanRmsM: number
  worstFinalM: number
  worstRecoveryS: number
  meanRecoveryS: number
  maxPushedM: number
  replans: number
}

export interface HistoryPoint { generation: number; best: number; genBest: number; genMedian: number; genWorst: number }
export interface Track { env: number; path: number; cost: number; aborted: boolean; points: [number, number, number][]; pushes: [number, number, number, number][] }

export interface Sensitivity { key: ParamKey; lowerValue: number; lowerScore: number; upperValue: number; upperScore: number }

/** gains.json: what "Apply to robot" writes and AresLib reads at startup. */
export interface AppliedGains {
  translation: Pid
  rotation: Pid
  drive?: { kp: number; ks: number; kv: number }
  recovery?: { toleranceM: number; delayS: number; rejoinAheadS: number; arriveM: number }
  source?: string
  score?: number
  baselineScore?: number
  paths?: string[]
  savedAt?: number
}

/** A run saved in tuning/. */
export interface SavedRun {
  savedAt: number
  paths: string[]
  config: TuneConfig
  baseline: Candidate
  best: Candidate
  history: HistoryPoint[]
  runs: number
  elapsedS: number
  cancelled: boolean
}

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
  sensitivity?: Sensitivity[]
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
  steerKp?: number | null
  steerKs?: number | null
  steerKv?: number | null
  wheelRadiusM?: number | null
}

export type ParamGroup = "Path controller (AresLib)" | "Recovery from shoves (AresLib)" | "Drive motor (TunerConstants)"
export const PARAM_GROUPS: ParamGroup[] = ["Path controller (AresLib)", "Recovery from shoves (AresLib)", "Drive motor (TunerConstants)"]

export const PARAM_INFO: Record<ParamKey, { label: string; group: ParamGroup; unit: string; hint: string }> = {
  translationKp: { label: "Translation kP", group: "Path controller (AresLib)", unit: "1/s", hint: "m/s of correction per meter off the trajectory, in x and in y." },
  translationKi: { label: "Translation kI", group: "Path controller (AresLib)", unit: "", hint: "Usually 0: the forces already carry the robot." },
  translationKd: { label: "Translation kD", group: "Path controller (AresLib)", unit: "s", hint: "Damps the correction; 0–0.5." },
  rotationKp: { label: "Rotation kP", group: "Path controller (AresLib)", unit: "1/s", hint: "rad/s of correction per radian off the heading." },
  rotationKi: { label: "Rotation kI", group: "Path controller (AresLib)", unit: "", hint: "Usually 0." },
  rotationKd: { label: "Rotation kD", group: "Path controller (AresLib)", unit: "s", hint: "Damps the heading correction." },
  driveKp: { label: "Drive kP", group: "Drive motor (TunerConstants)", unit: "V/rps", hint: "The TalonFX's velocity loop: volts per rotor rps of error." },
  driveKs: { label: "Drive kS", group: "Drive motor (TunerConstants)", unit: "V", hint: "Volts to break static friction." },
  driveKv: { label: "Drive kV", group: "Drive motor (TunerConstants)", unit: "V/rps", hint: "Volts per rotor rps: should match the motor (≈0.12 for a Kraken)." },
  replanToleranceM: { label: "Replan past", unit: "m", group: "Recovery from shoves (AresLib)", hint: "Knocked farther than this off the trajectory, the pathfinder takes over. Lower reacts sooner; too low replans on noise." },
  replanDelayS: { label: "…for at least", unit: "s", group: "Recovery from shoves (AresLib)", hint: "How long it must stay that far off first: a short bump the feedback can absorb does not trigger it." },
  rejoinAheadS: { label: "Rejoin ahead", unit: "s", group: "Recovery from shoves (AresLib)", hint: "Where the robot rejoins: where the trajectory will be this much later. Farther gives it room; nearer loses less of the path." },
  arriveM: { label: "Arrive within", unit: "m", group: "Recovery from shoves (AresLib)", hint: "A path that ends at rest, ending farther than this from its last pose, drives there before it is done." },
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
  { key: "visionHz", label: "Vision fixes", unit: "Hz", scale: 1, spread: 5, on: false, hint: "How often Limelight/QuestNav corrects the odometry. 0: wheels and gyro only, and a robot shoved sideways never knows." },
  { key: "visionNoiseM", label: "Vision noise", unit: "cm", scale: 100, spread: 0.02, on: false, hint: "How far off each vision fix is." },
  { key: "visionGain", label: "Vision trust", unit: "", scale: 1, spread: 0.1, on: false, hint: "How much of the gap to the vision fix each one closes (the pose estimator's trust in vision)." },
]

/** The robot as its robot.json says, as tune's World::nominal builds it. */
export function nominalWorld(r: RobotConfig): World {
  return {
    massKg: r.massKg, moiKgM2: r.moiKgM2, cogHeightM: r.cogHeightM ?? 0, mu: r.drivetrain.wheelCof,
    batteryV: 12.5, batteryROhm: 0.015, wheelRadiusM: r.drivetrain.wheelRadiusM, motorScale: 1, driveFrictionV: 0.2,
    wheelMassKg: 1.5, latencyS: 0.02, poseNoiseM: 0, headingNoiseRad: 0, startOffsetXM: 0, startOffsetYM: 0, startOffsetRad: 0,
    steerTauS: 0.02, steerRateRadps: 24, perfectOdometry: false, seed: 1,
    pushes: [], visionHz: 10, visionNoiseM: 0.03, visionGain: 0.2,
  }
}

/** The robot code as Tuner X and the drive subsystem have it, with what was read from the Java. */
export function robotCode(t: RobotTuning | null): RobotCode {
  return {
    translation: { kp: t?.translation?.[0] ?? 5, ki: t?.translation?.[1] ?? 0, kd: t?.translation?.[2] ?? 0 },
    rotation: { kp: t?.rotation?.[0] ?? 5, ki: t?.rotation?.[1] ?? 0, kd: t?.rotation?.[2] ?? 0 },
    driveKp: t?.driveKp ?? 0.1, driveKs: t?.driveKs ?? 0, driveKv: t?.driveKv ?? 0.124,
    speedAt12vMps: t?.speedAt12vMps ?? 5.85, statorLimitA: t?.slipCurrentA ?? 120, supplyLimitA: 70, forceFf: true,
    replan: { ...DEFAULT_REPLAN },
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
    { key: "replanToleranceM", min: 0.15, max: 1.0, start: code.replan?.toleranceM ?? 0.5, log: false, tune: false },
    { key: "replanDelayS", min: 0.04, max: 0.5, start: code.replan?.delayS ?? 0.2, log: false, tune: false },
    { key: "rejoinAheadS", min: 0.3, max: 2.0, start: code.replan?.rejoinAheadS ?? 1.0, log: false, tune: false },
    { key: "arriveM", min: 0.03, max: 0.3, start: code.replan?.arriveM ?? 0.1, log: false, tune: false },
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
  if (params.some(p => p.tune && PARAM_INFO[p.key].group === "Recovery from shoves (AresLib)")) {
    lines.push(`    .withReplan(${f(v("replanToleranceM"))}, ${f(v("replanDelayS"))}, ${f(v("rejoinAheadS"))}, 3)`, `    .withArrival(${f(v("arriveM"))})`)
  }
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

/** The tuned values as gains.json. */
export function appliedGains(params: Param[], values: number[], extra: Partial<AppliedGains> = {}): AppliedGains {
  const v = (k: ParamKey) => values[params.findIndex(p => p.key === k)] ?? 0
  const out: AppliedGains = {
    translation: { kp: v("translationKp"), ki: v("translationKi"), kd: v("translationKd") },
    rotation: { kp: v("rotationKp"), ki: v("rotationKi"), kd: v("rotationKd") },
    ...extra,
  }
  if (params.some(p => p.tune && p.key.startsWith("drive"))) out.drive = { kp: v("driveKp"), ks: v("driveKs"), kv: v("driveKv") }
  if (params.some(p => p.tune && PARAM_INFO[p.key].group === "Recovery from shoves (AresLib)")) {
    out.recovery = { toleranceM: v("replanToleranceM"), delayS: v("replanDelayS"), rejoinAheadS: v("rejoinAheadS"), arriveM: v("arriveM") }
  }
  return out
}

/** What the result says about itself, as plain advice. */
export function findings(params: Param[], best: Candidate, baseline: Candidate | null, sensitivity: Sensitivity[] | undefined, tightPaths: string[], forceFf: boolean, shoved = false): { level: "warn" | "info" | "good"; text: string }[] {
  const out: { level: "warn" | "info" | "good"; text: string }[] = []
  params.forEach((p, i) => {
    if (!p.tune || p.max <= p.min) return
    const v = best.values[i]
    const u = p.log && p.min > 0 ? (Math.log(v) - Math.log(p.min)) / (Math.log(p.max) - Math.log(p.min)) : (v - p.min) / (p.max - p.min)
    if (u > 0.97) out.push({ level: "warn", text: `${PARAM_INFO[p.key].label} ended at the top of its range (${p.max}): the best may be higher. Raise its max and run again.` })
    else if (u < 0.03 && p.min > 0) out.push({ level: "warn", text: `${PARAM_INFO[p.key].label} ended at the bottom of its range (${p.min}): the best may be lower. Lower its min and run again.` })
  })
  if (best.aborts > 0) out.push({ level: "warn", text: `Even the best gains lose the path in ${best.aborts} run${best.aborts === 1 ? "" : "s"}: some worlds are beyond what gains can fix (see the cost per world).` })
  if (tightPaths.length) out.push({ level: "warn", text: `${tightPaths.join(", ")} use${tightPaths.length === 1 ? "s" : ""} all the grip: plan with margin and tune again; the error left is the path's, not the gains'.` })
  if (baseline && baseline.score > 0) {
    const gain = 1 - best.score / baseline.score
    if (gain < 0.03) out.push({ level: "good", text: "The gains you have now are already about right: the search found less than 3% to gain." })
    if (baseline.aborts > 0 && best.aborts === 0) out.push({ level: "good", text: `The gains now lose the path in ${baseline.aborts} run${baseline.aborts === 1 ? "" : "s"}; the best ones in none.` })
  }
  const flat = (sensitivity ?? []).filter(s => Math.max(s.lowerScore, s.upperScore) / Math.max(best.score, 1e-9) - 1 < 0.03)
  if (flat.length) {
    out.push({ level: "info", text: `Flat around the best, so round ${flat.length === 1 ? "it" : "them"} freely: ${flat.map(s => `${PARAM_INFO[s.key].label} ${fmt3(s.lowerValue)}–${fmt3(s.upperValue)}`).join(", ")}.` })
  }
  if (shoved) {
    const recoveryTuned = params.some(p => p.tune && PARAM_INFO[p.key].group === "Recovery from shoves (AresLib)")
    if (baseline && baseline.worstRecoveryS > 0 && best.worstRecoveryS < baseline.worstRecoveryS * 0.9) {
      out.push({ level: "good", text: `Back from the worst shove in ${best.worstRecoveryS.toFixed(2)} s instead of ${baseline.worstRecoveryS.toFixed(2)} s.` })
    }
    if (best.aborts > 0) out.push({ level: "warn", text: "Some shoves are past recovering from with any of these gains: lower the force, or give it more room (Replan past, Rejoin ahead)." })
    if (!recoveryTuned) out.push({ level: "info", text: "Only the PID was tuned against the shoves. Tick the Recovery gains to tune when it replans and where it rejoins, too." })
    if (best.replans === 0 && best.worstRecoveryS > 1.5) out.push({ level: "info", text: "It never replanned, and some shoves took over 1.5 s to absorb: a lower Replan past would hand them to the pathfinder sooner." })
  }
  if (!forceFf) out.push({ level: "info", text: "Tuned without the wheel forces fed forward: on a robot running AresLib (which feeds them), tune with them on." })
  return out
}

export function fmt3(v: number): string {
  if (!Number.isFinite(v)) return "—"
  if (Math.abs(v) >= 10) return v.toFixed(1)
  if (Math.abs(v) >= 1) return v.toFixed(2)
  return v.toFixed(3)
}
