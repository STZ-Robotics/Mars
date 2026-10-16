// Expressions in numeric fields, Onshape style: a field that starts with
// "=" is a formula (=hub.x - 0.5, =vmax * 0.8, =2in + 3cm, =min(a, b));
// anything else is a plain number.
//
// Literals may carry a unit; it converts to the field's canonical unit for
// its dimension (meters, degrees, kilograms, seconds), so =24in in a length
// field is 0.6096. Names are the project's variables; a pose variable has
// .x, .y and .heading.

export type Dim = "length" | "angle" | "mass" | "time" | "speed" | "accel" | "angular" | "current" | "plain"

export const DIM_LABEL: Record<Dim, string> = {
  length: "Length (m)", angle: "Angle (°)", mass: "Mass (kg)", time: "Time (s)", speed: "Speed (m/s)",
  accel: "Acceleration (m/s²)", angular: "Turn rate (°/s)", current: "Current (A)", plain: "Number",
}

export const DIM_UNIT: Record<Dim, string> = {
  length: "m", angle: "°", mass: "kg", time: "s", speed: "m/s", accel: "m/s²", angular: "°/s", current: "A", plain: "",
}

const UNITS: Record<string, [Dim, number]> = {
  m: ["length", 1], cm: ["length", 0.01], mm: ["length", 0.001], in: ["length", 0.0254], '"': ["length", 0.0254], ft: ["length", 0.3048],
  deg: ["angle", 1], "°": ["angle", 1], rad: ["angle", 180 / Math.PI],
  kg: ["mass", 1], g: ["mass", 0.001], lb: ["mass", 0.45359237], lbs: ["mass", 0.45359237],
  s: ["time", 1], ms: ["time", 0.001],
  A: ["current", 1],
  "%": ["plain", 0.01],
}

export interface Pose { x: number; y: number; heading: number }
export type Value = number | Pose
export type Scope = ReadonlyMap<string, Value>

export type Result = { ok: true; value: number } | { ok: false; error: string }

const FUNCS: Record<string, (...a: number[]) => number> = {
  abs: Math.abs, min: Math.min, max: Math.max, sqrt: Math.sqrt, hypot: Math.hypot,
  round: Math.round, floor: Math.floor, ceil: Math.ceil,
  // Trigonometry in degrees, like every angle in Ares.
  sin: d => Math.sin(d * Math.PI / 180), cos: d => Math.cos(d * Math.PI / 180), tan: d => Math.tan(d * Math.PI / 180),
  atan2: (y, x) => Math.atan2(y, x) * 180 / Math.PI,
}
const CONSTS: Record<string, number> = { pi: Math.PI }

export function isExpr(text: string): boolean {
  return text.trimStart().startsWith("=")
}

/** The names an expression refers to (variables, without .x/.y). */
export function referencedNames(expr: string): string[] {
  const out = new Set<string>()
  const body = expr.replace(/^\s*=/, "")
  for (const m of body.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const name = m[0]
    const before = body[m.index! - 1]
    if (before === ".") continue
    if (name in FUNCS || name in CONSTS || name in UNITS) continue
    // A unit right after a number (2in) is not a name.
    if (m.index! > 0 && /[0-9.]/.test(body[m.index! - 1])) continue
    out.add(name)
  }
  return [...out]
}

/** Evaluates `text` (with or without the leading "=") for a field of `dim`. */
export function evaluate(text: string, scope: Scope, dim: Dim = "plain"): Result {
  const src = text.replace(/^\s*=/, "")
  let i = 0
  const fail = (msg: string): never => { throw new Error(msg) }
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++ }
  const peek = () => { ws(); return src[i] }

  const primary = (): number => {
    ws()
    const c = src[i]
    if (c === "(") {
      i++
      const v = expr()
      if (peek() !== ")") fail("a ( is not closed")
      i++
      return v
    }
    if (c === "-") { i++; return -factor() }
    if (c === "+") { i++; return factor() }
    if (/[0-9.]/.test(c ?? "")) {
      const m = src.slice(i).match(/^(\d+\.?\d*|\.\d+)(e-?\d+)?/i)!
      i += m[0].length
      return Number(m[0])
    }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)
    if (id) {
      const name = id[0]
      i += name.length
      if (peek() === "(" && name in FUNCS) {
        i++
        const args: number[] = []
        if (peek() !== ")") {
          args.push(expr())
          while (peek() === ",") { i++; args.push(expr()) }
        }
        if (peek() !== ")") fail(`${name}( is not closed`)
        i++
        return FUNCS[name](...args)
      }
      if (name in CONSTS) return CONSTS[name]
      const v = scope.get(name)
      if (v === undefined) fail(`there is no variable "${name}"`)
      if (peek() === ".") {
        i++
        const f = src.slice(i).match(/^[A-Za-z_]+/)
        if (!f) fail(`${name}. needs x, y or heading`)
        i += f![0].length
        if (typeof v === "number") fail(`"${name}" is a number, not a pose`)
        const field = f![0] as keyof Pose
        if (!["x", "y", "heading"].includes(field)) fail(`a pose has x, y and heading, not "${field}"`)
        return (v as Pose)[field]
      }
      if (typeof v !== "number") fail(`"${name}" is a pose: use ${name}.x, ${name}.y or ${name}.heading`)
      return v as number
    }
    return fail(c === undefined ? "the formula ends too soon" : `unexpected "${c}"`)
  }
  // An optional unit right after a value: 2in, (a + b)cm, pi rad.
  const unit = (v: number): number => {
    const u = src.slice(i).match(/^\s*(mm|cm|ms|in|ft|deg|rad|kg|lbs|lb|m|g|s|A|°|"|%)(?![A-Za-z0-9_])/)
    if (!u) return v
    const [udim, k] = UNITS[u[1]]
    if (udim !== "plain" && udim !== dim && dim !== "plain") fail(`"${u[1]}" is a ${udim} unit, this field is ${dim}`)
    i += u[0].length
    return v * k
  }
  const factor = (): number => {
    let v = unit(primary())
    while (peek() === "^") { i++; v = v ** unit(primary()) }
    return v
  }
  const term = (): number => {
    let v = factor()
    for (let c = peek(); c === "*" || c === "/"; c = peek()) {
      i++
      const r = factor()
      v = c === "*" ? v * r : v / r
    }
    return v
  }
  const expr = (): number => {
    let v = term()
    for (let c = peek(); c === "+" || c === "-"; c = peek()) {
      i++
      const r = term()
      v = c === "+" ? v + r : v - r
    }
    return v
  }

  try {
    if (src.trim() === "") return { ok: false, error: "empty formula" }
    const v = expr()
    if (peek() !== undefined) fail(`unexpected "${src[i]}"`)
    if (!Number.isFinite(v)) fail("the result is not a number")
    return { ok: true, value: v }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
