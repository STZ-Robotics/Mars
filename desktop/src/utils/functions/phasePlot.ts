import { TimeSeriesPoint } from "./mathTransforms"
import { interpolateAt } from "./seriesAlgebra"

// A point of the X-Y plane: two signals against each other instead of against
// time. It is what allows looking at velocity-vs-acceleration, current-vs-rpm or
// setpoint-vs-measured, where time only matters as the order of the path.
export interface PhasePoint {
  x: number
  y: number
  /** The instant the pair came from; used to color the path. */
  t: number
}

/**
 * Crosses two series over the time grid of the one on Y, interpolating the X
 * one. Without interpolating identical timestamps would have to be required,
 * and two different topics almost never have them.
 */
export function buildPhasePlot(xSeries: TimeSeriesPoint[], ySeries: TimeSeriesPoint[]): PhasePoint[] {
  const out: PhasePoint[] = []
  for (const p of ySeries) {
    const x = interpolateAt(xSeries, p.t)
    if (x === null || !isFinite(x) || !isFinite(p.v)) continue
    out.push({ x, y: p.v, t: p.t })
  }
  return out
}

export interface Bounds { min: number; max: number }

/** The range of a list of numbers, with margin and a minimum usable width. */
export function boundsOf(values: number[], marginRatio = 0.05): Bounds {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (!isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!isFinite(min) || !isFinite(max)) return { min: -1, max: 1 }

  // A constant series gives min === max and would collapse the axis to zero height.
  if (min === max) {
    const pad = Math.abs(min) > 1e-9 ? Math.abs(min) * 0.1 : 1
    return { min: min - pad, max: max + pad }
  }

  const margin = (max - min) * marginRatio
  return { min: min - margin, max: max + margin }
}
