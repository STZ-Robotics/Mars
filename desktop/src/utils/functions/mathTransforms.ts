export interface TimeSeriesPoint { t: number; v: number }

// raw          -> the signal as is
// derivative   -> velocity (d/dt)
// derivative2  -> acceleration (d²/dt²)
// integral     -> accumulated area
// movingAvg    -> moving average: the filter most needed in FRC, because
//                 the derivative of a raw encoder is pure noise
export type FunctionTransform = "raw" | "integral" | "derivative" | "derivative2" | "movingAvg"

export const TRANSFORM_LABELS: Record<FunctionTransform, string> = {
  raw: "Raw",
  derivative: "d/dt (1st derivative)",
  derivative2: "d²/dt² (2nd derivative)",
  integral: "∫ dt (integral)",
  movingAvg: "Moving average",
}

// Numeric integration by the trapezoidal rule: accumulates the area under the
// curve sample by sample. integral[0] is always 0 (a reference relative to the
// first point available in the buffer, not a real integration constant).
export function integrateTrapezoidal(points: TimeSeriesPoint[]): TimeSeriesPoint[] {
  if (points.length === 0) return []
  const out: TimeSeriesPoint[] = [{ t: points[0].t, v: 0 }]
  let acc = 0
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].t - points[i - 1].t
    if (dt > 0) acc += ((points[i].v + points[i - 1].v) / 2) * dt
    out.push({ t: points[i].t, v: acc })
  }
  return out
}

// Numeric derivative by CENTERED differences where possible:
//   f'(t_i) ≈ (f(t_i+1) - f(t_i-1)) / (t_i+1 - t_i-1)
// The backward difference used before delays the signal by half a step and
// amplifies the noise; the centered one has O(h²) error instead of O(h), which
// is quite noticeable with a noisy encoder. The ends fall back to a simple
// difference because they have no neighbor on one side.
export function differentiateFinite(points: TimeSeriesPoint[]): TimeSeriesPoint[] {
  if (points.length < 2) return []
  const out: TimeSeriesPoint[] = []
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const dt = next.t - prev.t
    if (dt <= 0) continue
    out.push({ t: points[i].t, v: (next.v - prev.v) / dt })
  }
  return out
}

/** A centered moving average of `windowSize` samples. */
export function movingAverage(points: TimeSeriesPoint[], windowSize: number): TimeSeriesPoint[] {
  const size = Math.max(1, Math.floor(windowSize))
  if (size <= 1 || points.length === 0) return points
  const half = Math.floor(size / 2)
  const out: TimeSeriesPoint[] = []
  for (let i = 0; i < points.length; i++) {
    const from = Math.max(0, i - half)
    const to = Math.min(points.length - 1, i + half)
    let sum = 0
    for (let k = from; k <= to; k++) sum += points[k].v
    out.push({ t: points[i].t, v: sum / (to - from + 1) })
  }
  return out
}

export interface TransformOptions {
  /** Samples of the moving average (only for the "movingAvg" transform). */
  smoothWindow?: number
  /** Multiplier applied AFTER the transform (unit conversion). */
  scale?: number
  /** Shift applied after scaling (removing a sensor offset). */
  offset?: number
}

export function applyTransform(
  points: TimeSeriesPoint[],
  transform: FunctionTransform,
  options: TransformOptions = {},
): TimeSeriesPoint[] {
  let out: TimeSeriesPoint[]
  switch (transform) {
    case "integral": out = integrateTrapezoidal(points); break
    case "derivative": out = differentiateFinite(points); break
    // The second derivative is differentiating twice; on noisy data it is best
    // to smooth first with "Moving average" in another series.
    case "derivative2": out = differentiateFinite(differentiateFinite(points)); break
    case "movingAvg": out = movingAverage(points, options.smoothWindow ?? 5); break
    default: out = points
  }

  const scale = options.scale ?? 1
  const offset = options.offset ?? 0
  if (scale === 1 && offset === 0) return out
  return out.map(p => ({ t: p.t, v: p.v * scale + offset }))
}

// --- Statistics ------------------------------------------------------------

export interface SeriesStats {
  count: number
  min: number
  max: number
  mean: number
  /** Population standard deviation. */
  stdDev: number
  /** Root mean square. */
  rms: number
  last: number
}

export function computeStats(points: TimeSeriesPoint[]): SeriesStats | null {
  if (points.length === 0) return null

  let min = Infinity
  let max = -Infinity
  let sum = 0
  let sumSq = 0
  let count = 0

  for (const p of points) {
    if (!isFinite(p.v)) continue
    if (p.v < min) min = p.v
    if (p.v > max) max = p.v
    sum += p.v
    sumSq += p.v * p.v
    count++
  }
  if (count === 0) return null

  const mean = sum / count
  // Var = E[x²] - E[x]², which with floats can give a tiny negative.
  const variance = Math.max(0, sumSq / count - mean * mean)

  return {
    count,
    min,
    max,
    mean,
    stdDev: Math.sqrt(variance),
    rms: Math.sqrt(sumSq / count),
    last: points[points.length - 1].v,
  }
}
