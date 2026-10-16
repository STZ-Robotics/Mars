// Evaluator of the AST against the NT4 buffers.
//
// Values can be scalars or matrices, so the operators dispatch on their
// operands' type.
//
// The interesting part is the temporal operators. d(expr) and int(expr) cannot
// be resolved with the instantaneous value: they need the subexpression's
// SERIES. It is built by evaluating the tree at each instant of the buffer and
// then applying the numeric transform. Since the result is cached per node,
// nesting them —d(int(x))— still costs a single pass per operator.

import { Node, collectVariables } from "./parser"
import { TimeSeriesPoint, integrateTrapezoidal, differentiateFinite } from "../functions/mathTransforms"
import {
  Matrix, isMatrix, makeMatrix, identity, filled, rotation2d,
  add as matAdd, subtract as matSub, scale as matScale, multiply as matMul,
  transpose, determinant, inverse, trace, norm, collapseScalar,
  elementTimes, elementDiv, elementPower, elementPlus,
  elementSum, mean as matMean, elementMax, elementMin, elementMaxAbs, normP1,
  diagonal, extractRow, extractColumn, block, isEqual as matIsEqual,
  solveLinear, cholesky, matrixExp,
} from "./matrix"
import { derive } from "./symbolic"

export type EqValue = number | Matrix

export interface EvalContext {
  /** Time series by variable name. */
  buffers: Record<string, TimeSeriesPoint[]>
  /** Fixed values that win over the buffers (solve() uses them). */
  overrides?: Record<string, number>
}

export class EvalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvalError"
  }
}

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
}

type PureFn = { arity: number | [number, number]; fn: (...args: number[]) => number; help: string }

export const PURE_FUNCTIONS: Record<string, PureFn> = {
  sin: { arity: 1, fn: Math.sin, help: "sine (radians)" },
  cos: { arity: 1, fn: Math.cos, help: "cosine (radians)" },
  tan: { arity: 1, fn: Math.tan, help: "tangent (radians)" },
  asin: { arity: 1, fn: Math.asin, help: "arcsine" },
  acos: { arity: 1, fn: Math.acos, help: "arccosine" },
  atan: { arity: 1, fn: Math.atan, help: "arctangent" },
  atan2: { arity: 2, fn: Math.atan2, help: "atan2(y, x)" },
  sinh: { arity: 1, fn: Math.sinh, help: "hyperbolic sine" },
  cosh: { arity: 1, fn: Math.cosh, help: "hyperbolic cosine" },
  tanh: { arity: 1, fn: Math.tanh, help: "hyperbolic tangent" },

  sqrt: { arity: 1, fn: Math.sqrt, help: "square root" },
  cbrt: { arity: 1, fn: Math.cbrt, help: "cube root" },
  exp: { arity: 1, fn: Math.exp, help: "e^x" },
  ln: { arity: 1, fn: Math.log, help: "natural log" },
  log: { arity: 1, fn: Math.log10, help: "log base 10" },
  log2: { arity: 1, fn: Math.log2, help: "log base 2" },
  pow: { arity: 2, fn: Math.pow, help: "pow(base, exp)" },
  hypot: { arity: [2, 8], fn: (...a) => Math.hypot(...a), help: "hypot(a, b, …)" },

  abs: { arity: 1, fn: Math.abs, help: "absolute value" },
  sign: { arity: 1, fn: Math.sign, help: "-1, 0 or 1" },
  floor: { arity: 1, fn: Math.floor, help: "round down" },
  ceil: { arity: 1, fn: Math.ceil, help: "round up" },
  round: { arity: 1, fn: Math.round, help: "round to nearest" },
  trunc: { arity: 1, fn: Math.trunc, help: "drop decimals" },

  min: { arity: [2, 8], fn: (...a) => Math.min(...a), help: "min(a, b, …)" },
  max: { arity: [2, 8], fn: (...a) => Math.max(...a), help: "max(a, b, …)" },
  clamp: { arity: 3, fn: (x, lo, hi) => Math.min(Math.max(x, lo), hi), help: "clamp(x, lo, hi)" },

  deg: { arity: 1, fn: (x) => (x * 180) / Math.PI, help: "radians → degrees" },
  rad: { arity: 1, fn: (x) => (x * Math.PI) / 180, help: "degrees → radians" },
  wrap: { arity: 1, fn: (x) => ((((x + 180) % 360) + 360) % 360) - 180, help: "wrap degrees to ±180" },

  // --- WPILib MathUtil ---
  deadband: {
    arity: [2, 3],
    fn: (value, band, maxMagnitude = 1) => applyDeadband(value, band, maxMagnitude),
    help: "deadband(x, band[, max]) — WPILib applyDeadband",
  },
  inputModulus: {
    arity: 3,
    fn: (input, minimum, maximum) => inputModulus(input, minimum, maximum),
    help: "inputModulus(x, min, max) — wrap into a range",
  },
  angleModulus: {
    arity: 1,
    fn: (radians) => inputModulus(radians, -Math.PI, Math.PI),
    help: "angleModulus(rad) — wrap radians to ±π",
  },
  lerp: {
    arity: 3,
    fn: (start, end, t) => start + (end - start) * Math.min(Math.max(t, 0), 1),
    help: "lerp(a, b, t) — WPILib interpolate",
  },
  invLerp: {
    arity: 3,
    fn: (start, end, q) => {
      const range = end - start
      if (range <= 0) return 0
      return Math.max(0, q - start) / range
    },
    help: "invLerp(a, b, q) — WPILib inverseInterpolate",
  },
  isNear: {
    arity: 3,
    fn: (expected, actual, tolerance) => (Math.abs(expected - actual) < tolerance ? 1 : 0),
    help: "isNear(expected, actual, tol) — 1 or 0",
  },
  copyDirPow: {
    arity: [2, 3],
    fn: (value, exponent, maxMagnitude = 1) =>
      Math.sign(value) * Math.pow(Math.abs(value) / maxMagnitude, exponent) * maxMagnitude,
    help: "copyDirPow(x, exp[, max]) — sign-preserving curve",
  },

  // --- java.lang.Math ---
  copySign: { arity: 2, fn: (magnitude, sign) => Math.sign(sign || 1) * Math.abs(magnitude), help: "copySign(mag, sign)" },
  floorDiv: { arity: 2, fn: (x, y) => Math.floor(x / y), help: "floorDiv(x, y)" },
  floorMod: { arity: 2, fn: (x, y) => ((x % y) + y) % y, help: "floorMod(x, y) — sign of the divisor" },
  ieeeRem: { arity: 2, fn: (x, y) => x - y * Math.round(x / y), help: "IEEE remainder" },
  rint: {
    arity: 1,
    // Rounds half to even (banker's rounding), like Math.rint.
    fn: (x) => {
      const rounded = Math.round(x)
      return Math.abs(x % 1) === 0.5 && rounded % 2 !== 0 ? rounded - Math.sign(x) : rounded
    },
    help: "rint(x) — round half to even",
  },
  expm1: { arity: 1, fn: Math.expm1, help: "e^x − 1, accurate near 0" },
  log1p: { arity: 1, fn: Math.log1p, help: "ln(1 + x), accurate near 0" },
  fma: { arity: 3, fn: (a, b, c) => a * b + c, help: "fma(a, b, c) — a·b + c" },
  ulp: {
    arity: 1,
    fn: (x) => {
      if (!isFinite(x)) return Math.abs(x)
      const next = x === 0 ? Number.MIN_VALUE : Math.abs(x) * Number.EPSILON
      return next
    },
    help: "ulp(x) — spacing of doubles at x",
  },
}

// WPILib MathUtil.applyDeadband: below the band it gives 0, and above it
// rescales linearly so there is no jump at the edge.
function applyDeadband(value: number, deadband: number, maxMagnitude: number): number {
  if (Math.abs(value) < deadband) return 0
  if (maxMagnitude === deadband) return value
  const scaleFactor = 1 + deadband / (maxMagnitude - deadband)
  return value > 0
    ? scaleFactor * (value - deadband)
    : scaleFactor * (value + deadband)
}

function inputModulus(input: number, minimum: number, maximum: number): number {
  const modulus = maximum - minimum
  if (modulus <= 0) return input
  let result = input
  result -= Math.floor((result - minimum) / modulus) * modulus
  return result
}

export const TIME_FUNCTIONS: Record<string, { windowed: boolean; help: string }> = {
  d: { windowed: false, help: "d(x) — derivative over time" },
  derivative: { windowed: false, help: "alias of d(x)" },
  int: { windowed: false, help: "int(x) — integral over time" },
  integral: { windowed: false, help: "alias of int(x)" },
  avg: { windowed: true, help: "avg(x, seconds) — moving average" },
  rms: { windowed: true, help: "rms(x, seconds) — root mean square" },
  stddev: { windowed: true, help: "stddev(x, seconds) — standard deviation" },
  peak: { windowed: true, help: "peak(x, seconds) — max |value| in window" },
}

export const MATRIX_FUNCTIONS: Record<string, string> = {
  det: "det(M) — determinant",
  inv: "inv(M) — inverse",
  T: "T(M) — transpose",
  trace: "trace(M) — sum of the diagonal",
  norm: "norm(M) — Frobenius norm",
  normP1: "normP1(M) — induced 1-norm",
  eye: "eye(n) — identity matrix",
  zeros: "zeros(rows, cols)",
  ones: "ones(rows, cols)",
  rot2: "rot2(theta) — 2D rotation matrix",

  // Elemento a elemento (WPILib element*)
  elemTimes: "elemTimes(A, B) — element-wise product",
  elemDiv: "elemDiv(A, B) — element-wise quotient",
  elemPow: "elemPow(M, k) — element-wise power",
  elemPlus: "elemPlus(M, k) — add a scalar to every element",

  // Reducciones
  elemSum: "elemSum(M) — sum of all elements",
  mean: "mean(M) — average of all elements",
  elemMax: "elemMax(M) — largest element",
  elemMin: "elemMin(M) — smallest element",
  maxAbs: "maxAbs(M) — largest absolute element",

  // Estructura
  diag: "diag(M) — vector → diagonal matrix, matrix → diagonal",
  row: "row(M, i) — extract a row vector",
  col: "col(M, j) — extract a column vector",
  block: "block(M, row, col, height, width) — submatrix",
  isEqualTo: "isEqualTo(A, B, tol) — 1 or 0",

  // Descomposiciones y solvers
  msolve: "msolve(A, b) — solve A·x = b (least squares if not square)",
  chol: "chol(M) — Cholesky, lower triangular",
  mexp: "mexp(M) — matrix exponential",
}

export const SYMBOLIC_FUNCTIONS: Record<string, string> = {
  diff: "diff(f, x) — symbolic derivative",
  solve: "solve(f, x[, guess]) — numeric root of f = 0",
}

export function isKnownFunction(name: string): boolean {
  return name in PURE_FUNCTIONS
    || name in TIME_FUNCTIONS
    || name in MATRIX_FUNCTIONS
    || name in SYMBOLIC_FUNCTIONS
    || name === "D"
}

// --- Coercion ---------------------------------------------------------------

function asNumber(value: EqValue, context: string): number {
  if (isMatrix(value)) throw new EvalError(`${context} expects a scalar, got a ${value.rows}×${value.cols} matrix`)
  return value
}

function asMatrix(value: EqValue, context: string): Matrix {
  if (!isMatrix(value)) throw new EvalError(`${context} expects a matrix, got a scalar`)
  return value
}

// --- Muestreo ---------------------------------------------------------------

// The series' value at instant t, taking the nearest sample by binary search.
// Different topics' buffers share the same poll's timestamps, but a topic with
// no value is skipped, so they cannot be assumed aligned by index.
function sampleAt(points: TimeSeriesPoint[], t: number): number {
  if (points.length === 0) return NaN
  if (t <= points[0].t) return points[0].v
  if (t >= points[points.length - 1].t) return points[points.length - 1].v

  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].t <= t) lo = mid
    else hi = mid
  }
  return t - points[lo].t <= points[hi].t - t ? points[lo].v : points[hi].v
}

function timelineFor(node: Node, ctx: EvalContext): TimeSeriesPoint[] {
  const names = collectVariables(node)
  let longest: TimeSeriesPoint[] = []
  names.forEach(name => {
    const buffer = ctx.buffers[name]
    if (buffer && buffer.length > longest.length) longest = buffer
  })
  return longest
}

// --- Evaluation -------------------------------------------------------------

interface EvalState {
  ctx: EvalContext
  seriesCache: Map<Node, TimeSeriesPoint[]>
}

function checkArity(name: string, expected: number | [number, number], got: number) {
  if (typeof expected === "number") {
    if (got !== expected) throw new EvalError(`${name}() takes ${expected} argument${expected === 1 ? "" : "s"}, got ${got}`)
  } else if (got < expected[0] || got > expected[1]) {
    throw new EvalError(`${name}() takes ${expected[0]}–${expected[1]} arguments, got ${got}`)
  }
}

function applyBinary(op: string, left: EqValue, right: EqValue): EqValue {
  const bothMatrices = isMatrix(left) && isMatrix(right)

  if (op === "+" || op === "-") {
    if (bothMatrices) {
      return collapseScalar(op === "+" ? matAdd(left, right) : matSub(left, right))
    }
    if (isMatrix(left) || isMatrix(right)) {
      throw new EvalError(`Cannot ${op === "+" ? "add" : "subtract"} a matrix and a scalar`)
    }
    return op === "+" ? left + right : left - right
  }

  if (op === "*") {
    if (bothMatrices) return collapseScalar(matMul(left, right))
    if (isMatrix(left)) return collapseScalar(matScale(left, right as number))
    if (isMatrix(right)) return collapseScalar(matScale(right, left as number))
    return left * right
  }

  if (op === "/") {
    if (isMatrix(right)) throw new EvalError("Cannot divide by a matrix — use inv(M) explicitly")
    if (isMatrix(left)) return collapseScalar(matScale(left, 1 / (right as number)))
    return left / right
  }

  if (op === "^") {
    if (isMatrix(left)) {
      const exponent = asNumber(right, "matrix exponent")
      if (!Number.isInteger(exponent)) throw new EvalError("Matrix powers must be integers")
      // M^-1 is the inverse; M^n is n multiplications.
      if (exponent === -1) return collapseScalar(inverse(left))
      if (exponent < 0) throw new EvalError("Only ^-1 is supported for negative matrix powers")
      let result = identity(left.rows)
      for (let i = 0; i < exponent; i++) result = matMul(result, left)
      return collapseScalar(result)
    }
    return Math.pow(left as number, asNumber(right, "exponent"))
  }

  if (op === "%") {
    return asNumber(left, "modulo") % asNumber(right, "modulo")
  }

  throw new EvalError(`Unknown operator "${op}"`)
}

function evaluateAt(node: Node, t: number, state: EvalState): EqValue {
  switch (node.kind) {
    case "number":
      return node.value

    case "variable": {
      const override = state.ctx.overrides?.[node.name]
      if (override !== undefined) return override
      if (node.name in CONSTANTS) return CONSTANTS[node.name]
      const buffer = state.ctx.buffers[node.name]
      if (!buffer) throw new EvalError(`Unknown variable "${node.name}"`)
      return sampleAt(buffer, t)
    }

    case "unary": {
      const value = evaluateAt(node.operand, t, state)
      if (node.op === "+") return value
      return isMatrix(value) ? matScale(value, -1) : -value
    }

    case "binary":
      return applyBinary(node.op, evaluateAt(node.left, t, state), evaluateAt(node.right, t, state))

    case "matrix":
      return makeMatrix(node.rows.map(row =>
        row.map(entry => asNumber(evaluateAt(entry, t, state), "matrix entry")),
      ))

    case "call":
      return evaluateCall(node, t, state)
  }
}

function evaluateCall(node: Node & { kind: "call" }, t: number, state: EvalState): EqValue {
  const { name, args } = node

  if (name in TIME_FUNCTIONS) {
    return sampleAt(getSeries(node, state), t)
  }

  if (name === "solve") {
    return solveRoot(node, t, state)
  }

  if (name in MATRIX_FUNCTIONS) {
    switch (name) {
      case "eye":
        checkArity("eye", 1, args.length)
        return identity(asNumber(evaluateAt(args[0], t, state), "eye"))
      case "zeros":
      case "ones": {
        checkArity(name, 2, args.length)
        const rows = asNumber(evaluateAt(args[0], t, state), name)
        const cols = asNumber(evaluateAt(args[1], t, state), name)
        return filled(rows, cols, name === "ones" ? 1 : 0)
      }
      case "rot2":
        checkArity("rot2", 1, args.length)
        return rotation2d(asNumber(evaluateAt(args[0], t, state), "rot2"))

      // Dos matrices
      case "elemTimes":
      case "elemDiv":
      case "msolve": {
        checkArity(name, 2, args.length)
        const a = asMatrix(evaluateAt(args[0], t, state), `${name}()`)
        const b = asMatrix(evaluateAt(args[1], t, state), `${name}()`)
        if (name === "elemTimes") return collapseScalar(elementTimes(a, b))
        if (name === "elemDiv") return collapseScalar(elementDiv(a, b))
        return collapseScalar(solveLinear(a, b))
      }

      // Matriz + escalar
      case "elemPow":
      case "elemPlus":
      case "row":
      case "col": {
        checkArity(name, 2, args.length)
        const m = asMatrix(evaluateAt(args[0], t, state), `${name}()`)
        const k = asNumber(evaluateAt(args[1], t, state), `${name}()`)
        switch (name) {
          case "elemPow": return collapseScalar(elementPower(m, k))
          case "elemPlus": return collapseScalar(elementPlus(m, k))
          case "row": return collapseScalar(extractRow(m, k))
          default: return collapseScalar(extractColumn(m, k))
        }
      }

      case "block": {
        checkArity("block", 5, args.length)
        const m = asMatrix(evaluateAt(args[0], t, state), "block()")
        const [startRow, startCol, height, width] = args.slice(1)
          .map(arg => asNumber(evaluateAt(arg, t, state), "block()"))
        return collapseScalar(block(m, startRow, startCol, height, width))
      }

      case "isEqualTo": {
        checkArity("isEqualTo", 3, args.length)
        const a = asMatrix(evaluateAt(args[0], t, state), "isEqualTo()")
        const b = asMatrix(evaluateAt(args[1], t, state), "isEqualTo()")
        const tolerance = asNumber(evaluateAt(args[2], t, state), "isEqualTo()")
        return matIsEqual(a, b, tolerance) ? 1 : 0
      }

      // Una sola matriz
      default: {
        checkArity(name, 1, args.length)
        const m = asMatrix(evaluateAt(args[0], t, state), `${name}()`)
        switch (name) {
          case "det": return determinant(m)
          case "inv": return collapseScalar(inverse(m))
          case "T": return collapseScalar(transpose(m))
          case "trace": return trace(m)
          case "norm": return norm(m)
          case "normP1": return normP1(m)
          case "elemSum": return elementSum(m)
          case "mean": return matMean(m)
          case "elemMax": return elementMax(m)
          case "elemMin": return elementMin(m)
          case "maxAbs": return elementMaxAbs(m)
          case "diag": return collapseScalar(diagonal(m))
          case "chol": return collapseScalar(cholesky(m))
          case "mexp": return collapseScalar(matrixExp(m))
        }
      }
    }
  }

  const fn = PURE_FUNCTIONS[name]
  if (!fn) throw new EvalError(`Unknown function "${name}"`)
  checkArity(name, fn.arity, args.length)
  return fn.fn(...args.map(arg => asNumber(evaluateAt(arg, t, state), `${name}()`)))
}

// --- Operadores temporales --------------------------------------------------

function getSeries(node: Node & { kind: "call" }, state: EvalState): TimeSeriesPoint[] {
  const cached = state.seriesCache.get(node)
  if (cached) return cached

  const spec = TIME_FUNCTIONS[node.name]
  const expectedArgs = spec.windowed ? 2 : 1
  if (node.args.length !== expectedArgs) {
    throw new EvalError(`${node.name}() takes ${expectedArgs} argument${expectedArgs === 1 ? "" : "s"}, got ${node.args.length}`)
  }

  const target = node.args[0]
  const timeline = timelineFor(target, state.ctx)
  if (timeline.length === 0) {
    throw new EvalError(`${node.name}() needs a variable with history`)
  }

  state.seriesCache.set(node, [])
  const points = timeline.map(point => ({
    t: point.t,
    v: asNumber(evaluateAt(target, point.t, state), `${node.name}()`),
  }))

  let result: TimeSeriesPoint[]
  switch (node.name) {
    case "d":
    case "derivative":
      result = differentiateFinite(points)
      break
    case "int":
    case "integral":
      result = integrateTrapezoidal(points)
      break
    default: {
      const seconds = asNumber(evaluateAt(node.args[1], timeline[timeline.length - 1].t, state), node.name)
      if (!isFinite(seconds) || seconds <= 0) throw new EvalError(`${node.name}() needs a positive window in seconds`)
      result = windowedStat(points, seconds, node.name)
    }
  }

  state.seriesCache.set(node, result)
  return result
}

function windowedStat(points: TimeSeriesPoint[], seconds: number, kind: string): TimeSeriesPoint[] {
  const out: TimeSeriesPoint[] = []
  let start = 0

  for (let i = 0; i < points.length; i++) {
    while (points[i].t - points[start].t > seconds) start++
    const window = points.slice(start, i + 1).map(p => p.v)

    let value: number
    switch (kind) {
      case "avg":
        value = window.reduce((a, b) => a + b, 0) / window.length
        break
      case "rms":
        value = Math.sqrt(window.reduce((a, b) => a + b * b, 0) / window.length)
        break
      case "peak":
        value = Math.max(...window.map(Math.abs))
        break
      default: {
        const mean = window.reduce((a, b) => a + b, 0) / window.length
        const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length
        value = Math.sqrt(variance)
      }
    }
    out.push({ t: points[i].t, v: value })
  }

  return out
}

// --- solve(): root of f = 0 -------------------------------------------------

const SOLVE_TOLERANCE = 1e-10
const SOLVE_MAX_ITERATIONS = 80

// Newton-Raphson using the SYMBOLIC derivative when it can be obtained (it is
// exact and converges quadratically). If the expression cannot be
// differentiated symbolically —because of a clamp, a min, a temporal operator—
// it falls back to a central difference, which converges a bit worse but works
// all the same.
function solveRoot(node: Node & { kind: "call" }, t: number, state: EvalState): number {
  if (node.args.length < 2 || node.args.length > 3) {
    throw new EvalError("solve() takes solve(expression, variable[, guess])")
  }
  const target = node.args[1]
  if (target.kind !== "variable") {
    throw new EvalError("The second argument of solve() must be a variable name")
  }

  const variable = target.name
  const expression = node.args[0]
  const guess = node.args.length === 3
    ? asNumber(evaluateAt(node.args[2], t, state), "solve() guess")
    : 0

  let derivative: Node | null = null
  try {
    derivative = derive(expression, variable)
  } catch {
    derivative = null // se usa diferencia central
  }

  // Evaluates the expression substituting the unknown, without touching the real context.
  const evalWith = (expr: Node, value: number): number => {
    const scoped: EvalState = {
      ctx: { ...state.ctx, overrides: { ...state.ctx.overrides, [variable]: value } },
      seriesCache: new Map(),
    }
    return asNumber(evaluateAt(expr, t, scoped), "solve()")
  }

  let x = guess
  for (let i = 0; i < SOLVE_MAX_ITERATIONS; i++) {
    const fx = evalWith(expression, x)
    if (!isFinite(fx)) throw new EvalError("solve() diverged: the expression is not finite")
    if (Math.abs(fx) < SOLVE_TOLERANCE) return x

    let slope: number
    if (derivative) {
      slope = evalWith(derivative, x)
    } else {
      const h = Math.max(1e-7, Math.abs(x) * 1e-7)
      slope = (evalWith(expression, x + h) - evalWith(expression, x - h)) / (2 * h)
    }

    if (!isFinite(slope) || Math.abs(slope) < 1e-14) {
      throw new EvalError("solve() hit a flat slope — try a different guess")
    }

    const next = x - fx / slope
    if (Math.abs(next - x) < SOLVE_TOLERANCE) return next
    x = next
  }

  throw new EvalError(`solve() did not converge in ${SOLVE_MAX_ITERATIONS} iterations`)
}

// --- Public entry points ------------------------------------------------------

/** The expression's value at the most recent available instant. */
export function evaluateLatest(node: Node, ctx: EvalContext): EqValue {
  const state: EvalState = { ctx, seriesCache: new Map() }
  const timeline = timelineFor(node, ctx)
  const t = timeline.length > 0 ? timeline[timeline.length - 1].t : 0
  return evaluateAt(node, t, state)
}

/** The expression's whole time series (scalars only). */
export function evaluateSeries(node: Node, ctx: EvalContext): TimeSeriesPoint[] {
  const state: EvalState = { ctx, seriesCache: new Map() }
  const timeline = timelineFor(node, ctx)
  if (timeline.length === 0) return []
  return timeline.map(point => ({
    t: point.t,
    v: asNumber(evaluateAt(node, point.t, state), "series"),
  }))
}
