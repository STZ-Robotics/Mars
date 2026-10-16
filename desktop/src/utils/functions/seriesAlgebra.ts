import { TimeSeriesPoint } from "./mathTransforms"

export type SeriesOperator = "add" | "subtract" | "multiply" | "divide"

export const OPERATOR_LABELS: Record<SeriesOperator, string> = {
  add: "+",
  subtract: "−",
  multiply: "×",
  divide: "÷",
}

function applyOperator(op: SeriesOperator, a: number, b: number): number {
  switch (op) {
    case "add": return a + b
    case "subtract": return a - b
    case "multiply": return a * b
    case "divide": return b === 0 ? NaN : a / b
  }
}

// Linearly interpolates the value of `points` at instant `t`. Returns null if
// `t` falls outside the range the buffer covers — it does not extrapolate,
// because outside the range we have no real basis to make up a value.
export function interpolateAt(points: TimeSeriesPoint[], t: number): number | null {
  if (points.length === 0) return null
  const first = points[0]
  const last = points[points.length - 1]
  if (t < first.t || t > last.t) return null
  if (t === first.t) return first.v
  if (t === last.t) return last.v

  // Linear search: the live window's buffers are short (seconds at ~20Hz),
  // a binary search is not worth it here.
  for (let i = 1; i < points.length; i++) {
    if (points[i].t >= t) {
      const p0 = points[i - 1]
      const p1 = points[i]
      const span = p1.t - p0.t
      const frac = span > 0 ? (t - p0.t) / span : 0
      return p0.v + (p1.v - p0.v) * frac
    }
  }
  return null
}

// Combines two series sample by sample. It uses the FIRST series' (`a`)
// timestamps as the reference grid and interpolates the second one (`b`) over
// that grid — that way the result always stays aligned to `a`'s clock.
export function combineSeries(a: TimeSeriesPoint[], b: TimeSeriesPoint[], operator: SeriesOperator): TimeSeriesPoint[] {
  const out: TimeSeriesPoint[] = []
  for (const pa of a) {
    const bVal = interpolateAt(b, pa.t)
    if (bVal === null) continue
    const v = applyOperator(operator, pa.v, bVal)
    if (!isFinite(v)) continue
    out.push({ t: pa.t, v })
  }
  return out
}

export interface ErrorBandPoint { t: number; actual: number; target: number }

// Builds the "actual vs target" band by aligning the target over the actual
// series' time grid, point by point, so the area between both curves can be
// shaded even if they do not share exact timestamps.
export function buildErrorBand(actual: TimeSeriesPoint[], target: TimeSeriesPoint[]): ErrorBandPoint[] {
  const out: ErrorBandPoint[] = []
  for (const p of actual) {
    const targetVal = interpolateAt(target, p.t)
    if (targetVal === null) continue
    out.push({ t: p.t, actual: p.v, target: targetVal })
  }
  return out
}