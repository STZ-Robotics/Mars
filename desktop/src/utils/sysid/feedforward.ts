// Feedforward fitting in the style of WPILib's SysId.
//
// Models (docs.wpilib.org, System Identification):
//
//   Simple    V = kS·sgn(v) + kV·v + kA·a
//   Elevator  V = kG + kS·sgn(v) + kV·v + kA·a
//   Arm       V = kG·cos(θ) + kS·sgn(v) + kV·v + kA·a
//
// The fit is OLS over the CONTINUOUS form (the one WPILib documents); the
// acceleration comes from differentiating the velocity by centered differences.

import { solveOls, OlsResult, POOR_CONDITIONING } from "./ols"

export type MechanismType = "simple" | "elevator" | "arm"

export const MECHANISM_LABELS: Record<MechanismType, string> = {
  simple: "Simple motor (drivetrain, flywheel, turret)",
  elevator: "Elevator (constant gravity)",
  arm: "Arm (gravity varies with angle)",
}

/** SysId's four standard tests. */
export type SysIdTestType =
  | "quasistatic-forward"
  | "quasistatic-backward"
  | "dynamic-forward"
  | "dynamic-backward"

export const TEST_LABELS: Record<SysIdTestType, string> = {
  "quasistatic-forward": "Quasistatic forward",
  "quasistatic-backward": "Quasistatic backward",
  "dynamic-forward": "Dynamic forward",
  "dynamic-backward": "Dynamic backward",
}

export const ALL_TESTS: SysIdTestType[] = [
  "quasistatic-forward",
  "quasistatic-backward",
  "dynamic-forward",
  "dynamic-backward",
]

/** A synchronized sample of a test. */
export interface SysIdSample {
  /** Segundos. */
  t: number
  /** Voltios aplicados al motor. */
  voltage: number
  /** Position (m or rad). Only the arm model uses it. */
  position: number
  /** Velocidad (m/s o rad/s). */
  velocity: number
}

export interface SysIdTestRun {
  type: SysIdTestType
  samples: SysIdSample[]
}

export interface FeedforwardGains {
  kS: number
  kV: number
  kA: number
  /** Only on elevator and arm. */
  kG?: number
}

export interface FeedforwardFit {
  mechanism: MechanismType
  gains: FeedforwardGains
  rSquared: number
  rmse: number
  sampleCount: number
  /** Warnings that do NOT invalidate the fit but make it suspicious. */
  warnings: string[]
}

/**
 * Minimum velocity to consider the mechanism moving.
 * With the mechanism still, sgn(v) jumps between -1 and 1 from noise and ruins
 * the kS estimate; SysId discards those samples for the same reason.
 */
const MOVING_THRESHOLD = 1e-4

/** Acceleration by centered differences over the velocity. */
export function accelerationOf(samples: SysIdSample[]): number[] {
  const out: number[] = []
  for (let i = 0; i < samples.length; i++) {
    const prev = samples[Math.max(0, i - 1)]
    const next = samples[Math.min(samples.length - 1, i + 1)]
    const dt = next.t - prev.t
    out.push(dt > 0 ? (next.velocity - prev.velocity) / dt : 0)
  }
  return out
}

export const TEST_COLORS: Record<SysIdTestType, string> = {
  "quasistatic-forward": "#2f6fdb",
  "quasistatic-backward": "#4db8d8",
  "dynamic-forward": "#d65c5c",
  "dynamic-backward": "#e08a3c",
}

/** The design matrix's columns for each mechanism type. */
function designRow(
  mechanism: MechanismType,
  sample: SysIdSample,
  accel: number,
): number[] {
  const sgn = Math.sign(sample.velocity)
  switch (mechanism) {
    case "simple":
      return [sgn, sample.velocity, accel]
    case "elevator":
      // Gravity on an elevator is constant, so it goes in as an independent
      // term.
      return [1, sgn, sample.velocity, accel]
    case "arm":
      // On an arm gravity depends on the angle: cos(θ) measured from the
      // horizontal.
      return [Math.cos(sample.position), sgn, sample.velocity, accel]
  }
}

function gainsFrom(mechanism: MechanismType, coefficients: number[]): FeedforwardGains {
  if (mechanism === "simple") {
    const [kS, kV, kA] = coefficients
    return { kS, kV, kA }
  }
  const [kG, kS, kV, kA] = coefficients
  return { kG, kS, kV, kA }
}

/**
 * Fits the gains from the runs. They are passed ALL together because each one
 * contributes a different part of the information: the quasistatic ones pin
 * kS and kV (acceleration ~0) and the dynamic ones pin kA.
 */
export function fitFeedforward(
  mechanism: MechanismType,
  runs: SysIdTestRun[],
): FeedforwardFit | null {
  const x: number[][] = []
  const y: number[] = []
  let discardedStill = 0

  for (const run of runs) {
    if (run.samples.length < 3) continue
    const accel = accelerationOf(run.samples)
    run.samples.forEach((sample, i) => {
      if (!isFinite(sample.voltage) || !isFinite(sample.velocity)) return
      // Samples with the mechanism still: sgn(v) is pure noise there.
      if (Math.abs(sample.velocity) < MOVING_THRESHOLD) { discardedStill++; return }
      x.push(designRow(mechanism, sample, accel[i]))
      y.push(sample.voltage)
    })
  }

  const result = solveOls(x, y)
  if (result === null) return null

  return {
    mechanism,
    gains: gainsFrom(mechanism, result.coefficients),
    rSquared: result.rSquared,
    rmse: result.rmse,
    sampleCount: result.count,
    warnings: buildWarnings(mechanism, runs, result, discardedStill),
  }
}

// A fit can "close" numerically and still be useless. These are the cases seen
// most in practice.
function buildWarnings(
  mechanism: MechanismType,
  runs: SysIdTestRun[],
  result: OlsResult,
  discardedStill: number,
): string[] {
  const warnings: string[] = []
  const present = new Set(runs.filter(r => r.samples.length >= 3).map(r => r.type))

  for (const test of ALL_TESTS) {
    if (!present.has(test)) warnings.push(`Missing ${TEST_LABELS[test]} — gains will be biased.`)
  }

  const gains = gainsFrom(mechanism, result.coefficients)
  if (gains.kV <= 0) warnings.push("kV is not positive: check the sign of velocity vs voltage.")
  if (gains.kA <= 0) warnings.push("kA is not positive: the dynamic tests may be too short to see acceleration.")
  if (gains.kS < 0) warnings.push("kS is negative, which is not physical.")
  if (result.rSquared < 0.9) warnings.push(`Low fit quality (R² = ${result.rSquared.toFixed(3)}).`)
  // It gets its own warning because R² does NOT give it away: an almost
  // singular system fits the data perfectly and still splits the gains badly.
  if (result.conditioning < POOR_CONDITIONING) {
    warnings.push(
      "Terms are nearly indistinguishable — the tests do not separate kS from kA. " +
      "Run both the quasistatic and the dynamic tests.",
    )
  }
  if (result.count < 100) warnings.push(`Only ${result.count} usable samples.`)
  if (discardedStill > result.count) {
    warnings.push("Most samples had the mechanism stopped; the tests may not have moved it.")
  }

  return warnings
}

/** A sample with what was measured and what the fitted model predicts. */
export interface DiagnosticPoint {
  measured: number
  predicted: number
  velocity: number
  /** medido − predicho, en voltios. */
  residual: number
}

export interface RunDiagnostics {
  type: SysIdTestType
  points: DiagnosticPoint[]
}

/** The voltage the model predicts for a given sample. */
export function predictVoltage(
  mechanism: MechanismType,
  gains: FeedforwardGains,
  sample: SysIdSample,
  accel: number,
): number {
  const row = designRow(mechanism, sample, accel)
  const coefficients = mechanism === "simple"
    ? [gains.kS, gains.kV, gains.kA]
    : [gains.kG ?? 0, gains.kS, gains.kV, gains.kA]
  return row.reduce((sum, term, i) => sum + term * coefficients[i], 0)
}

/**
 * Compares measured against predicted sample by sample. It is what turns an R²
 * into something actionable: a high number can hide that ONE of the four runs
 * deviates, and in the plot that jumps out.
 *
 * It discards exactly the same samples as the fit (the ones with the
 * mechanism still), or the plot would show points that never took part.
 */
export function buildDiagnostics(
  mechanism: MechanismType,
  gains: FeedforwardGains,
  runs: SysIdTestRun[],
): RunDiagnostics[] {
  const out: RunDiagnostics[] = []

  for (const run of runs) {
    if (run.samples.length < 3) continue
    const accel = accelerationOf(run.samples)
    const points: DiagnosticPoint[] = []

    run.samples.forEach((sample, i) => {
      if (!isFinite(sample.voltage) || !isFinite(sample.velocity)) return
      if (Math.abs(sample.velocity) < MOVING_THRESHOLD) return
      const predicted = predictVoltage(mechanism, gains, sample, accel[i])
      if (!isFinite(predicted)) return
      points.push({
        measured: sample.voltage,
        predicted,
        velocity: sample.velocity,
        residual: sample.voltage - predicted,
      })
    })

    if (points.length > 0) out.push({ type: run.type, points })
  }

  return out
}

/**
 * Pairs voltage, position and velocity on a single time grid.
 * The three topics are published separately and almost never share
 * timestamps, so the voltage one is taken as the reference and the others are
 * interpolated.
 */
export function buildSamples(
  voltage: { t: number; v: number }[],
  position: { t: number; v: number }[],
  velocity: { t: number; v: number }[],
): SysIdSample[] {
  const out: SysIdSample[] = []
  for (const p of voltage) {
    const pos = interpolate(position, p.t)
    const vel = interpolate(velocity, p.t)
    if (vel === null) continue
    out.push({ t: p.t, voltage: p.v, position: pos ?? 0, velocity: vel })
  }
  return out
}

function interpolate(points: { t: number; v: number }[], t: number): number | null {
  if (points.length === 0) return null
  if (t < points[0].t || t > points[points.length - 1].t) return null
  for (let i = 1; i < points.length; i++) {
    if (points[i].t >= t) {
      const p0 = points[i - 1]
      const p1 = points[i]
      const span = p1.t - p0.t
      return span > 0 ? p0.v + (p1.v - p0.v) * ((t - p0.t) / span) : p0.v
    }
  }
  return points[points.length - 1].v
}
