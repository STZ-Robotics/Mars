// The project's variables (variables.json, next to the robot.json) and what
// they do to the documents.
//
// A variable is a number with a dimension or a pose; each value is a formula
// that may use other variables. Fields anywhere in the project that hold
// "=formula" keep it in their object's `exprs` map (by field name, dotted
// for nested robot fields) beside the number it gives. When a variable
// changes, every document is re-evaluated and the numbers rewritten: the
// robot code and Ares' Rust side only ever read numbers.

import { Dim, Pose, Scope, Value, evaluate, referencedNames } from "./expr"

export type Variable =
  | { name: string; kind: "number"; dim: Dim; value: string }
  | { name: string; kind: "pose"; x: string; y: string; heading: string }

export interface VariablesDoc { variables: Variable[] }

export interface Evaluated {
  scope: Map<string, Value>
  /** Per variable: why it has no value, if it has none. */
  errors: Map<string, string>
}

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Values of every variable, each after the ones it uses; cycles are errors. */
export function evaluateAll(vars: Variable[]): Evaluated {
  const scope = new Map<string, Value>()
  const errors = new Map<string, string>()
  const byName = new Map(vars.map(v => [v.name, v]))
  const state = new Map<string, "visiting" | "done">()
  const formulas = (v: Variable) => (v.kind === "number" ? [v.value] : [v.x, v.y, v.heading])

  const visit = (name: string, chain: string[]): boolean => {
    const s = state.get(name)
    if (s === "done") return scope.has(name)
    if (s === "visiting") {
      errors.set(name, `uses itself: ${[...chain, name].join(" → ")}`)
      return false
    }
    const v = byName.get(name)
    if (!v) return false
    state.set(name, "visiting")
    for (const dep of formulas(v).flatMap(referencedNames)) {
      if (byName.has(dep) && !visit(dep, [...chain, name]) && !errors.has(name)) {
        errors.set(name, `depends on "${dep}", which has no value`)
      }
    }
    state.set(name, "done")
    if (errors.has(name)) return false
    const one = (text: string, dim: Dim) => evaluate(text, scope, dim)
    if (v.kind === "number") {
      const r = one(v.value, v.dim)
      if (r.ok) scope.set(name, r.value)
      else errors.set(name, r.error)
    } else {
      const [x, y, h] = [one(v.x, "length"), one(v.y, "length"), one(v.heading, "angle")]
      if (x.ok && y.ok && h.ok) scope.set(name, { x: x.value, y: y.value, heading: h.value } as Pose)
      else errors.set(name, [x, y, h].map(r => (r.ok ? "" : r.error)).filter(Boolean)[0])
    }
    return scope.has(name)
  }
  for (const v of vars) visit(v.name, [])
  return { scope, errors }
}

/** The dimension of a field, from its name. */
export function dimOf(key: string): Dim {
  const last = key.split(".").pop()!
  if (/^(x|y|xM|yM|radiusM|widthM|heightM|toleranceM|lengthM|wheelRadiusM|cogHeightM)$/.test(last)) return "length"
  if (/(headingDeg|toleranceDeg)$/.test(last)) return "angle"
  if (/(dps|DegPerS|maxAngularVelocityDps)$/i.test(last)) return "angular"
  if (/(mps|maxVelocityMps)$/.test(last) && !/mps2/i.test(last)) return "speed"
  if (/mps2$/i.test(last)) return "accel"
  if (/massKg$/.test(last)) return "mass"
  if (/(offsetS|durationS|waitS)$/.test(last)) return "time"
  if (/CurrentLimitA$/.test(last)) return "current"
  return "plain"
}

function setPath(obj: Record<string, unknown>, path: string, value: number) {
  const keys = path.split(".")
  let o: Record<string, unknown> = obj
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== "object" || o[k] === null) return
    o = o[k] as Record<string, unknown>
  }
  o[keys[keys.length - 1]] = value
}

/**
 * Every object in `doc` with an `exprs` map gets its fields re-evaluated.
 * Returns the new document (or the same one if nothing changed) and the
 * fields whose formula failed.
 */
export function applyScope<T>(doc: T, scope: Scope): { doc: T; changed: boolean; errors: string[] } {
  let changed = false
  const errors: string[] = []
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let any = false
      const out = v.map(x => { const y = walk(x); if (y !== x) any = true; return y })
      return any ? out : v
    }
    if (typeof v !== "object" || v === null) return v
    const o = v as Record<string, unknown>
    let next: Record<string, unknown> | null = null
    for (const [k, child] of Object.entries(o)) {
      if (k === "exprs") continue
      const w = walk(child)
      if (w !== child) { next ??= { ...o }; next[k] = w }
    }
    const exprs = o.exprs as Record<string, string> | undefined
    if (exprs) {
      for (const [field, formula] of Object.entries(exprs)) {
        const r = evaluate(formula, scope, dimOf(field))
        if (!r.ok) { errors.push(`${field}: ${r.error}`); continue }
        const cur = field.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], next ?? o)
        if (typeof cur !== "number" || Math.abs(cur - r.value) > 1e-12) {
          next ??= structuredClone(o)
          setPath(next, field, r.value)
        }
      }
    }
    if (next) changed = true
    return next ?? o
  }
  const out = walk(doc) as T
  return { doc: out, changed, errors }
}

/** Every formula in `doc` (and in the variables) with `old` renamed to `name`. */
export function renameInFormulas<T>(doc: T, old: string, name: string): T {
  const re = new RegExp(`(^|[^A-Za-z0-9_.])${old}(?![A-Za-z0-9_])`, "g")
  const fix = (f: string) => f.replace(re, `$1${name}`)
  const walk = (v: unknown, inExprs: boolean): unknown => {
    if (typeof v === "string") return inExprs ? fix(v) : v
    if (Array.isArray(v)) return v.map(x => walk(x, inExprs))
    if (typeof v !== "object" || v === null) return v
    return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, walk(c, inExprs || k === "exprs")]))
  }
  return walk(doc, false) as T
}

export function renameVariable(vars: Variable[], old: string, name: string): Variable[] {
  const re = new RegExp(`(^|[^A-Za-z0-9_.])${old}(?![A-Za-z0-9_])`, "g")
  const fix = (f: string) => f.replace(re, `$1${name}`)
  return vars.map(v => {
    const renamed = v.name === old ? { ...v, name } : v
    return renamed.kind === "number"
      ? { ...renamed, value: fix(renamed.value) }
      : { ...renamed, x: fix(renamed.x), y: fix(renamed.y), heading: fix(renamed.heading) }
  })
}

/** How many formulas in `docs` use `name`. */
export function usesOf(docs: unknown[], name: string): number {
  let n = 0
  const walk = (v: unknown, inExprs: boolean) => {
    if (typeof v === "string") { if (inExprs && referencedNames(v).includes(name)) n++; return }
    if (Array.isArray(v)) return v.forEach(x => walk(x, inExprs))
    if (typeof v === "object" && v !== null) Object.entries(v).forEach(([k, c]) => walk(c, inExprs || k === "exprs"))
  }
  docs.forEach(d => walk(d, false))
  return n
}

/** The formula a field holds, if any. */
export function exprOf(obj: { exprs?: Record<string, string> } | null | undefined, key: string): string | undefined {
  return obj?.exprs?.[key]
}

/** `obj` with field `key` set to a number, or to a formula and its value. */
export function withField<T extends { exprs?: Record<string, string> }>(obj: T, key: string, value: number | undefined, expr?: string): T {
  const exprs = { ...(obj.exprs ?? {}) }
  if (expr) exprs[key] = expr
  else delete exprs[key]
  const out = { ...obj, exprs: Object.keys(exprs).length ? exprs : undefined } as T
  if (key.includes(".")) {
    const copy = structuredClone(out) as Record<string, unknown>
    if (value !== undefined) setPath(copy, key, value)
    return copy as T
  }
  ;(out as Record<string, unknown>)[key] = value
  return out
}

/** The pose variable a waypoint is linked to: x and y are exactly =name.x, =name.y. */
export function linkedPose(w: { exprs?: Record<string, string> }): string | null {
  const mx = w.exprs?.x?.match(/^=\s*([A-Za-z_][A-Za-z0-9_]*)\.x\s*$/)
  const my = w.exprs?.y?.match(/^=\s*([A-Za-z_][A-Za-z0-9_]*)\.y\s*$/)
  return mx && my && mx[1] === my[1] ? mx[1] : null
}

/** A waypoint linked to pose `name` (heading too when it has one), at its values. */
export function linkToPose<T extends { x: number; y: number; headingDeg?: number; exprs?: Record<string, string> }>(w: T, name: string, pose: { x: number; y: number; heading: number }, withHeading: boolean): T {
  const exprs: Record<string, string> = { ...(w.exprs ?? {}), x: `=${name}.x`, y: `=${name}.y` }
  if (withHeading) exprs.headingDeg = `=${name}.heading`
  return { ...w, x: pose.x, y: pose.y, ...(withHeading ? { headingDeg: pose.heading } : {}), exprs }
}

/** The waypoint without formulas on `keys` (it was moved by hand). */
export function dropExprs<T extends { exprs?: Record<string, string> }>(w: T, keys: string[]): T {
  if (!w.exprs) return w
  const exprs = { ...w.exprs }
  for (const k of keys) delete exprs[k]
  return { ...w, exprs: Object.keys(exprs).length ? exprs : undefined }
}

/** A number as a variable's value text. */
export function numberText(v: number): string {
  return String(Number(v.toFixed(4)))
}
