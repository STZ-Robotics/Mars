import { describe, it, expect } from "vitest"
import { solveOls, solveLinearSystem } from "./ols"
import {
  fitFeedforward, accelerationOf, buildSamples, buildDiagnostics, predictVoltage,
  SysIdSample, SysIdTestRun, SysIdTestType, MechanismType, ALL_TESTS, TEST_COLORS,
} from "./feedforward"

// --- Synthetic data generation ----------------------------------------
//
// The strategy: start from KNOWN gains, generate the exact voltage the model
// predicts, and check that the fit recovers them. If the math is wrong, the
// numbers do not come back.
//
// The velocity is made LINEAR in t on purpose: its centered-difference
// derivative is exact at every point (the ends included), so the fit's error
// does not mix with the differentiation error.

interface TrueGains { kS: number; kV: number; kA: number; kG?: number }

function makeRun(
  mechanism: MechanismType,
  type: SysIdTestType,
  gains: TrueGains,
  opts: { accel: number; v0: number; count: number; dt: number; theta0?: number },
): SysIdTestRun {
  const samples: SysIdSample[] = []
  for (let i = 0; i < opts.count; i++) {
    const t = i * opts.dt
    const velocity = opts.v0 + opts.accel * t
    // θ advances with the velocity; only the arm model looks at it.
    const position = (opts.theta0 ?? 0) + opts.v0 * t + 0.5 * opts.accel * t * t

    let voltage = gains.kS * Math.sign(velocity) + gains.kV * velocity + gains.kA * opts.accel
    if (mechanism === "elevator") voltage += gains.kG!
    if (mechanism === "arm") voltage += gains.kG! * Math.cos(position)

    samples.push({ t, voltage, position, velocity })
  }
  return { type, samples }
}

/** The four standard runs: quasistatic (a≈0) and dynamic (high a). */
function fullTestSet(mechanism: MechanismType, gains: TrueGains): SysIdTestRun[] {
  return [
    makeRun(mechanism, "quasistatic-forward", gains, { accel: 0.02, v0: 0.05, count: 200, dt: 0.02, theta0: 0.1 }),
    makeRun(mechanism, "quasistatic-backward", gains, { accel: -0.02, v0: -0.05, count: 200, dt: 0.02, theta0: 0.4 }),
    makeRun(mechanism, "dynamic-forward", gains, { accel: 3.5, v0: 0.2, count: 120, dt: 0.02, theta0: 0.8 }),
    makeRun(mechanism, "dynamic-backward", gains, { accel: -3.5, v0: -0.2, count: 120, dt: 0.02, theta0: 1.2 }),
  ]
}

// ---------------------------------------------------------------------------

describe("solveLinearSystem", () => {
  it("solves a known system", () => {
    // 2x + y = 5 ; x + 3y = 10  ->  x = 1, y = 3
    const out = solveLinearSystem([[2, 1], [1, 3]], [5, 10])!
    expect(out[0]).toBeCloseTo(1, 10)
    expect(out[1]).toBeCloseTo(3, 10)
  })

  it("returns null if the matrix is singular", () => {
    // Segunda fila = 2× la primera: infinitas soluciones.
    expect(solveLinearSystem([[1, 2], [2, 4]], [3, 6])).toBeNull()
  })

  it("survives a zero initial pivot thanks to partial pivoting", () => {
    // Without row swapping this would divide by zero.
    const out = solveLinearSystem([[0, 1], [1, 0]], [2, 3])!
    expect(out[0]).toBeCloseTo(3, 10)
    expect(out[1]).toBeCloseTo(2, 10)
  })
})

describe("solveOls", () => {
  it("recovers a linear relation exactly", () => {
    // y = 2·a + 3·b
    const x = [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]
    const y = x.map(([a, b]) => 2 * a + 3 * b)
    const r = solveOls(x, y)!
    expect(r.coefficients[0]).toBeCloseTo(2, 9)
    expect(r.coefficients[1]).toBeCloseTo(3, 9)
    expect(r.rSquared).toBeCloseTo(1, 9)
    expect(r.rmse).toBeCloseTo(0, 9)
  })

  it("lowers R² when the data does not follow the model", () => {
    const x = [[1], [2], [3], [4], [5]]
    const y = [1, 5, 2, 8, 3] // ruido puro
    const r = solveOls(x, y)!
    expect(r.rSquared).toBeLessThan(0.5)
  })

  it("returns null with fewer samples than unknowns", () => {
    expect(solveOls([[1, 2, 3]], [1])).toBeNull()
  })

  it("returns null if a column is constant zero", () => {
    // A test that did not move the mechanism leaves the acceleration column at 0.
    expect(solveOls([[1, 0], [2, 0], [3, 0]], [1, 2, 3])).toBeNull()
  })

  it("does not return NaN when y is constant", () => {
    // ssTot = 0 would divide by zero when computing R².
    const r = solveOls([[1], [2], [3]], [5, 5, 5])!
    expect(isNaN(r.rSquared)).toBe(false)
  })

  it("rejects non-finite values", () => {
    expect(solveOls([[1, NaN], [2, 1]], [1, 2])).toBeNull()
  })
})

describe("accelerationOf", () => {
  it("is exact with linear velocity, ends included", () => {
    const samples: SysIdSample[] = Array.from({ length: 10 }, (_, i) => ({
      t: i * 0.02, voltage: 0, position: 0, velocity: 1 + 2.5 * (i * 0.02),
    }))
    accelerationOf(samples).forEach(a => expect(a).toBeCloseTo(2.5, 9))
  })

  it("does not divide by zero with repeated timestamps", () => {
    const samples: SysIdSample[] = [
      { t: 0, voltage: 0, position: 0, velocity: 0 },
      { t: 0, voltage: 0, position: 0, velocity: 1 },
    ]
    accelerationOf(samples).forEach(a => expect(isFinite(a)).toBe(true))
  })
})

describe("fitFeedforward — simple motor", () => {
  const truth = { kS: 0.22, kV: 2.4, kA: 0.31 }

  it("recovers kS, kV and kA from synthetic data", () => {
    const fit = fitFeedforward("simple", fullTestSet("simple", truth))!
    expect(fit.gains.kS).toBeCloseTo(truth.kS, 6)
    expect(fit.gains.kV).toBeCloseTo(truth.kV, 6)
    expect(fit.gains.kA).toBeCloseTo(truth.kA, 6)
    expect(fit.rSquared).toBeCloseTo(1, 6)
    expect(fit.gains.kG).toBeUndefined()
  })

  it("warns about nothing when the fit is good and all four tests are there", () => {
    const fit = fitFeedforward("simple", fullTestSet("simple", truth))!
    expect(fit.warnings).toEqual([])
  })

  it("warns if any of the four runs is missing", () => {
    // Only ONE is removed: with the other three the system is still solvable.
    const runs = fullTestSet("simple", truth).filter(r => r.type !== "dynamic-backward")
    const fit = fitFeedforward("simple", runs)!
    expect(fit.warnings.some(w => w.includes("Dynamic backward"))).toBe(true)
    // With three runs the gains still come out right; the warning is preventive.
    expect(fit.gains.kV).toBeCloseTo(truth.kV, 5)
  })

  it("does not make up gains if only the quasistatic tests were run", () => {
    // Without the dynamic runs the acceleration is proportional to sgn(v), so
    // kS and kA are mathematically indistinguishable. Returning any pair of
    // numbers would be worse than returning nothing: the user would load them
    // onto the robot believing they work.
    const runs = fullTestSet("simple", truth).filter(r => r.type.startsWith("quasistatic"))
    expect(fitFeedforward("simple", runs)).toBeNull()
  })

  it("warns when the terms are almost indistinguishable", () => {
    // Same as above but with a little noise in the acceleration: it is no longer
    // singular, so the fit "closes" and R² looks high — but the gains are badly
    // split. This is what happens with real data.
    const runs = fullTestSet("simple", truth)
      .filter(r => r.type.startsWith("quasistatic"))
      .map(r => ({
        ...r,
        samples: r.samples.map((sample, i) => ({
          ...sample,
          velocity: sample.velocity * (1 + (i % 3) * 1e-9),
        })),
      }))
    const fit = fitFeedforward("simple", runs)
    if (fit !== null) {
      expect(fit.warnings.some(w => w.includes("nearly indistinguishable"))).toBe(true)
    }
  })
})

describe("fitFeedforward — elevator", () => {
  const truth = { kS: 0.15, kV: 3.1, kA: 0.42, kG: 0.85 }

  it("separates constant gravity from static friction", () => {
    // kG and kS are the hard case: both are "constant" terms except that kS
    // changes sign with the velocity. Without runs in both directions they
    // would be indistinguishable.
    const fit = fitFeedforward("elevator", fullTestSet("elevator", truth))!
    expect(fit.gains.kG).toBeCloseTo(truth.kG, 6)
    expect(fit.gains.kS).toBeCloseTo(truth.kS, 6)
    expect(fit.gains.kV).toBeCloseTo(truth.kV, 6)
    expect(fit.gains.kA).toBeCloseTo(truth.kA, 6)
  })
})

describe("fitFeedforward — arm", () => {
  const truth = { kS: 0.19, kV: 1.7, kA: 0.26, kG: 1.05 }

  it("recupera kG usando cos(θ)", () => {
    const fit = fitFeedforward("arm", fullTestSet("arm", truth))!
    expect(fit.gains.kG).toBeCloseTo(truth.kG, 5)
    expect(fit.gains.kS).toBeCloseTo(truth.kS, 5)
    expect(fit.gains.kV).toBeCloseTo(truth.kV, 5)
    expect(fit.gains.kA).toBeCloseTo(truth.kA, 5)
  })

  it("the arm model and the elevator model do not give the same result", () => {
    // Data generated with angle-dependent gravity: fitting it as an elevator
    // (constant gravity) has to make the fit worse.
    const runs = fullTestSet("arm", truth)
    const asArm = fitFeedforward("arm", runs)!
    const asElevator = fitFeedforward("elevator", runs)!
    expect(asArm.rSquared).toBeGreaterThan(asElevator.rSquared)
  })
})

describe("fitFeedforward — casos degenerados", () => {
  it("drops the samples with the mechanism still", () => {
    // With v ≈ 0 the sign jumps between -1 and 1 from noise and ruins kS.
    const runs = fullTestSet("simple", { kS: 0.2, kV: 2, kA: 0.3 })
    const still: SysIdTestRun = {
      type: "dynamic-forward",
      samples: Array.from({ length: 50 }, (_, i) => ({
        t: i * 0.02, voltage: 0, position: 0, velocity: 0,
      })),
    }
    const fit = fitFeedforward("simple", [...runs, still])!
    // The still ones do not count, so the gains do not move.
    expect(fit.gains.kV).toBeCloseTo(2, 5)
  })

  it("returns null if there is no usable sample at all", () => {
    const dead: SysIdTestRun = {
      type: "dynamic-forward",
      samples: Array.from({ length: 20 }, (_, i) => ({
        t: i * 0.02, voltage: 1, position: 0, velocity: 0,
      })),
    }
    expect(fitFeedforward("simple", [dead])).toBeNull()
  })

  it("returns null with runs that are too short", () => {
    expect(fitFeedforward("simple", [{ type: "dynamic-forward", samples: [] }])).toBeNull()
  })

  it("warns when kV or kA come out non-positive", () => {
    // Voltage inverted relative to the velocity: kV comes out negative.
    const runs = fullTestSet("simple", { kS: 0.2, kV: -2, kA: -0.3 })
    const fit = fitFeedforward("simple", runs)!
    expect(fit.warnings.some(w => w.includes("kV is not positive"))).toBe(true)
    expect(fit.warnings.some(w => w.includes("kA is not positive"))).toBe(true)
  })

  it("covers the four declared test types", () => {
    expect(ALL_TESTS).toHaveLength(4)
    const fit = fitFeedforward("simple", fullTestSet("simple", { kS: 0.2, kV: 2, kA: 0.3 }))!
    expect(fit.sampleCount).toBeGreaterThan(600)
  })
})

describe("buildSamples", () => {
  it("interpolates position and velocity over the voltage's grid", () => {
    // The three topics are published separately and do not share timestamps.
    const voltage = [{ t: 0.5, v: 6 }]
    const position = [{ t: 0, v: 0 }, { t: 1, v: 10 }]
    const velocity = [{ t: 0, v: 0 }, { t: 1, v: 4 }]
    const out = buildSamples(voltage, position, velocity)
    expect(out).toHaveLength(1)
    expect(out[0].position).toBeCloseTo(5)
    expect(out[0].velocity).toBeCloseTo(2)
    expect(out[0].voltage).toBe(6)
  })

  it("drops the instants with no known velocity", () => {
    // No extrapolation: outside the measured range there is no real data.
    const voltage = [{ t: 0, v: 1 }, { t: 5, v: 1 }]
    const velocity = [{ t: 0, v: 0 }, { t: 1, v: 1 }]
    expect(buildSamples(voltage, [], velocity)).toHaveLength(1)
  })

  it("uses 0 for position if there is no position topic", () => {
    // A simple motor does not need position; the model does not look at it.
    const out = buildSamples([{ t: 0.5, v: 3 }], [], [{ t: 0, v: 0 }, { t: 1, v: 2 }])
    expect(out[0].position).toBe(0)
  })
})

describe("buildDiagnostics", () => {
  const truth = { kS: 0.22, kV: 2.4, kA: 0.31 }

  it("predicts exactly what was measured when the fit is perfect", () => {
    const runs = fullTestSet("simple", truth)
    const fit = fitFeedforward("simple", runs)!
    const diag = buildDiagnostics("simple", fit.gains, runs)

    expect(diag).toHaveLength(4)
    for (const run of diag) {
      for (const p of run.points) {
        expect(p.predicted).toBeCloseTo(p.measured, 6)
        expect(p.residual).toBeCloseTo(0, 6)
      }
    }
  })

  it("keeps each run's type so they can be colored", () => {
    const runs = fullTestSet("simple", truth)
    const diag = buildDiagnostics("simple", fitFeedforward("simple", runs)!.gains, runs)
    expect(diag.map(d => d.type).sort()).toEqual([...ALL_TESTS].sort())
    // Each type has its color, otherwise two runs would look the same.
    expect(new Set(Object.values(TEST_COLORS)).size).toBe(4)
  })

  it("drops the same samples as the fit", () => {
    // If the plot showed points the fit did not use, the user would see
    // deviations that did not influence the gains.
    const still: SysIdTestRun = {
      type: "dynamic-forward",
      samples: Array.from({ length: 30 }, (_, i) => ({
        t: i * 0.02, voltage: 5, position: 0, velocity: 0,
      })),
    }
    const diag = buildDiagnostics("simple", { kS: 0.2, kV: 2, kA: 0.3 }, [still])
    expect(diag).toHaveLength(0)
  })

  it("shows large residuals when the gains do not match", () => {
    const runs = fullTestSet("simple", truth)
    // Made-up gains: the residual has to stop being zero.
    const diag = buildDiagnostics("simple", { kS: 5, kV: 0.1, kA: 9 }, runs)
    const worst = Math.max(...diag.flatMap(r => r.points.map(p => Math.abs(p.residual))))
    expect(worst).toBeGreaterThan(1)
  })

  it("gives away the wrong model with structured residuals", () => {
    // Arm data (gravity ~ cos θ) fit as an elevator: the residual stops being
    // noise and takes shape. That is exactly what the plot shows.
    const armRuns = fullTestSet("arm", { kS: 0.19, kV: 1.7, kA: 0.26, kG: 1.05 })
    const asElevator = fitFeedforward("elevator", armRuns)!
    const diag = buildDiagnostics("elevator", asElevator.gains, armRuns)
    const worst = Math.max(...diag.flatMap(r => r.points.map(p => Math.abs(p.residual))))
    expect(worst).toBeGreaterThan(0.05)
  })
})

describe("predictVoltage", () => {
  it("reproduces the simple motor model", () => {
    // V = 0.2·sgn(v) + 2·v + 0.3·a  con v=1.5, a=4
    const v = predictVoltage("simple", { kS: 0.2, kV: 2, kA: 0.3 },
      { t: 0, voltage: 0, position: 0, velocity: 1.5 }, 4)
    expect(v).toBeCloseTo(0.2 + 3 + 1.2, 9)
  })

  it("adds a constant kG on the elevator", () => {
    const v = predictVoltage("elevator", { kS: 0, kV: 0, kA: 0, kG: 0.9 },
      { t: 0, voltage: 0, position: 0, velocity: 1 }, 0)
    expect(v).toBeCloseTo(0.9, 9)
  })

  it("scales kG by cos(θ) on the arm", () => {
    // θ = π/3 -> cos θ = 0.5
    const v = predictVoltage("arm", { kS: 0, kV: 0, kA: 0, kG: 2 },
      { t: 0, voltage: 0, position: Math.PI / 3, velocity: 1 }, 0)
    expect(v).toBeCloseTo(1, 9)
  })

  it("flips kS's sign with the velocity", () => {
    const gains = { kS: 0.5, kV: 0, kA: 0 }
    const fwd = predictVoltage("simple", gains, { t: 0, voltage: 0, position: 0, velocity: 1 }, 0)
    const back = predictVoltage("simple", gains, { t: 0, voltage: 0, position: 0, velocity: -1 }, 0)
    expect(fwd).toBeCloseTo(0.5, 9)
    expect(back).toBeCloseTo(-0.5, 9)
  })
})
