import { describe, it, expect } from "vitest"
import {
  applyTransform, computeStats, differentiateFinite, integrateTrapezoidal,
  movingAverage, TimeSeriesPoint,
} from "./mathTransforms"
import { buildPhasePlot, boundsOf } from "./phasePlot"

/** A series sampled at a fixed step `dt` over the function `f`. */
function sample(f: (t: number) => number, count: number, dt = 0.1): TimeSeriesPoint[] {
  return Array.from({ length: count }, (_, i) => ({ t: i * dt, v: f(i * dt) }))
}

describe("differentiateFinite", () => {
  it("gives the exact slope of a line", () => {
    // f(t) = 3t  ->  f'(t) = 3 everywhere
    const d = differentiateFinite(sample(t => 3 * t, 10))
    expect(d).toHaveLength(10)
    d.forEach(p => expect(p.v).toBeCloseTo(3, 10))
  })

  it("keeps the number of samples", () => {
    // The previous version (backward difference) lost the first sample and
    // misaligned the series against the others.
    const input = sample(t => t * t, 20)
    expect(differentiateFinite(input)).toHaveLength(input.length)
  })

  it("is more accurate than the backward difference on a parabola", () => {
    // f(t) = t²  ->  f'(t) = 2t. The CENTERED difference is exact here; the
    // backward one would give 2t - dt.
    const d = differentiateFinite(sample(t => t * t, 30))
    // The ends are skipped, they fall back to a simple difference for lack of a neighbor.
    for (let i = 1; i < d.length - 1; i++) {
      expect(d[i].v).toBeCloseTo(2 * d[i].t, 8)
    }
  })

  it("ignores samples with zero or negative dt", () => {
    const d = differentiateFinite([
      { t: 0, v: 0 }, { t: 0, v: 5 }, { t: 1, v: 1 },
    ])
    d.forEach(p => expect(isFinite(p.v)).toBe(true))
  })

  it("returns empty with fewer than two points", () => {
    expect(differentiateFinite([])).toEqual([])
    expect(differentiateFinite([{ t: 0, v: 1 }])).toEqual([])
  })
})

describe("segunda derivada", () => {
  it("gets the constant acceleration of a parabola", () => {
    // f(t) = ½·a·t² con a = 4  ->  f''(t) = 4
    const d2 = applyTransform(sample(t => 0.5 * 4 * t * t, 40), "derivative2")
    // The edges carry the error of each derivative's ends.
    const middle = d2.slice(3, -3)
    expect(middle.length).toBeGreaterThan(20)
    middle.forEach(p => expect(p.v).toBeCloseTo(4, 6))
  })

  it("gives zero on a line", () => {
    const d2 = applyTransform(sample(t => 2 * t + 1, 20), "derivative2")
    d2.slice(3, -3).forEach(p => expect(p.v).toBeCloseTo(0, 8))
  })
})

describe("integrateTrapezoidal", () => {
  it("integrates a constant into a ramp", () => {
    // ∫2 dt = 2t
    const out = integrateTrapezoidal(sample(() => 2, 11))
    expect(out[0].v).toBe(0)
    expect(out[10].v).toBeCloseTo(2 * 1.0, 10)
  })

  it("is the inverse of differentiating, up to the constant", () => {
    const original = sample(t => t * t, 50)
    const roundTrip = integrateTrapezoidal(differentiateFinite(original))
    const last = roundTrip[roundTrip.length - 1]
    // original(4.9) - original(0) = 24.01
    expect(last.v).toBeCloseTo(original[original.length - 1].v - original[0].v, 1)
  })
})

describe("movingAverage", () => {
  it("flattens the noise and keeps the level", () => {
    // A constant signal of 10 with alternating ±1 noise -> the average goes back to 10.
    const noisy = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.1, v: 10 + (i % 2 === 0 ? 1 : -1) }))
    const smooth = movingAverage(noisy, 5)
    smooth.slice(3, -3).forEach(p => expect(Math.abs(p.v - 10)).toBeLessThan(0.35))
  })

  it("keeps the number of samples and the timestamps", () => {
    const input = sample(t => Math.sin(t), 25)
    const out = movingAverage(input, 7)
    expect(out).toHaveLength(input.length)
    expect(out.map(p => p.t)).toEqual(input.map(p => p.t))
  })

  it("with a window of 1 or less it changes nothing", () => {
    const input = sample(t => t, 5)
    expect(movingAverage(input, 1)).toEqual(input)
    expect(movingAverage(input, 0)).toEqual(input)
  })
})

describe("scale and offset", () => {
  it("are applied after the transform", () => {
    // d/dt of 3t is 3; ×2 and +1 gives 7.
    const out = applyTransform(sample(t => 3 * t, 10), "derivative", { scale: 2, offset: 1 })
    out.forEach(p => expect(p.v).toBeCloseTo(7, 8))
  })

  it("does not touch the data if they are neutral", () => {
    const input = sample(t => t, 5)
    expect(applyTransform(input, "raw", { scale: 1, offset: 0 })).toEqual(input)
  })
})

describe("computeStats", () => {
  it("computes min/max/mean/deviation", () => {
    const s = computeStats([
      { t: 0, v: 2 }, { t: 1, v: 4 }, { t: 2, v: 4 },
      { t: 3, v: 4 }, { t: 4, v: 5 }, { t: 5, v: 5 },
      { t: 6, v: 7 }, { t: 7, v: 9 },
    ])!
    expect(s.count).toBe(8)
    expect(s.min).toBe(2)
    expect(s.max).toBe(9)
    expect(s.mean).toBe(5)
    // The known population deviation of this classic set.
    expect(s.stdDev).toBeCloseTo(2, 10)
    expect(s.last).toBe(9)
  })

  it("never returns a NaN deviation from rounding error", () => {
    // Var = E[x²] - E[x]² can give a tiny negative with large equal values;
    // the root of that would be NaN.
    const s = computeStats(Array.from({ length: 50 }, (_, i) => ({ t: i, v: 1e6 })))!
    expect(s.stdDev).toBe(0)
    expect(isNaN(s.stdDev)).toBe(false)
  })

  it("ignores non-finite values", () => {
    const s = computeStats([{ t: 0, v: 1 }, { t: 1, v: NaN }, { t: 2, v: 3 }])!
    expect(s.count).toBe(2)
    expect(s.mean).toBe(2)
  })

  it("returns null without data", () => {
    expect(computeStats([])).toBeNull()
    expect(computeStats([{ t: 0, v: NaN }])).toBeNull()
  })
})

describe("buildPhasePlot", () => {
  it("crosses two series interpolating the X axis one", () => {
    // X and Y with DIFFERENT timestamps: two topics never publish at the same time.
    const x = [{ t: 0, v: 0 }, { t: 1, v: 10 }]
    const y = [{ t: 0.5, v: 100 }]
    const out = buildPhasePlot(x, y)
    expect(out).toHaveLength(1)
    expect(out[0].x).toBeCloseTo(5)   // interpolado a mitad de camino
    expect(out[0].y).toBe(100)
  })

  it("drops the points outside the range covered by X", () => {
    // It does not extrapolate: with no X value there is no pair to plot.
    const x = [{ t: 1, v: 0 }, { t: 2, v: 1 }]
    const y = [{ t: 0, v: 5 }, { t: 1.5, v: 6 }, { t: 9, v: 7 }]
    expect(buildPhasePlot(x, y)).toHaveLength(1)
  })

  it("drops non-finite values", () => {
    const x = [{ t: 0, v: 0 }, { t: 1, v: 1 }]
    expect(buildPhasePlot(x, [{ t: 0.5, v: NaN }])).toHaveLength(0)
  })
})

describe("boundsOf", () => {
  it("agrega margen", () => {
    const b = boundsOf([0, 10], 0.1)
    expect(b.min).toBeCloseTo(-1)
    expect(b.max).toBeCloseTo(11)
  })

  it("does not collapse the axis with a constant series", () => {
    // min === max would give a zero-height axis and a division by zero when scaling.
    const b = boundsOf([5, 5, 5])
    expect(b.max).toBeGreaterThan(b.min)
  })

  it("falls back to a usable range if there is no finite data", () => {
    expect(boundsOf([])).toEqual({ min: -1, max: 1 })
    expect(boundsOf([NaN, Infinity])).toEqual({ min: -1, max: 1 })
  })
})
