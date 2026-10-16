// Autos: sequences of paths and robot commands, the parent of paths.
//
// Steps run in order. A path step drives a path (or one of its variants); a
// wait waits; a command runs one of the robot code's NamedCommands (taking
// the time you estimate, or none if it runs alongside what follows); an
// if step takes one list or the other on a NamedCondition; an auto step
// runs another auto. The robot code reads them from ares-index.json.

export type Step =
  | { type: "path"; path: string; variant?: string }
  | { type: "wait"; seconds: number }
  | { type: "command"; name: string; estimateS?: number; alongside?: boolean }
  | { type: "if"; condition: string; then: Step[]; else: Step[] }
  | { type: "auto"; auto: string }

export interface Auto { name: string; budgetS?: number; steps: Step[] }

export const DEFAULT_BUDGET_S = 15

/** How long each path (or path@variant) takes, from its trajectory. */
export type Durations = ReadonlyMap<string, number>

export function pathKey(s: { path: string; variant?: string }): string {
  return s.variant ? `${s.path}@${s.variant}` : s.path
}

/**
 * The time a list of steps takes: [shortest, longest] over the conditions'
 * outcomes, and whether some path in it has no trajectory yet.
 */
export function duration(steps: Step[], d: Durations, autos: ReadonlyMap<string, Auto>, seen: Set<string> = new Set()): { min: number; max: number; missing: string[] } {
  let min = 0, max = 0
  const missing: string[] = []
  for (const s of steps) {
    switch (s.type) {
      case "path": {
        const t = d.get(pathKey(s))
        if (t === undefined) missing.push(pathKey(s))
        min += t ?? 0
        max += t ?? 0
        break
      }
      case "wait":
        min += s.seconds
        max += s.seconds
        break
      case "command":
        if (!s.alongside) { min += s.estimateS ?? 0; max += s.estimateS ?? 0 }
        break
      case "if": {
        const a = duration(s.then, d, autos, seen), b = duration(s.else, d, autos, seen)
        min += Math.min(a.min, b.min)
        max += Math.max(a.max, b.max)
        missing.push(...a.missing, ...b.missing)
        break
      }
      case "auto": {
        const inner = autos.get(s.auto)
        if (!inner || seen.has(s.auto)) break
        const r = duration(inner.steps, d, autos, new Set([...seen, s.auto]))
        min += r.min
        max += r.max
        missing.push(...r.missing)
        break
      }
    }
  }
  return { min, max, missing }
}

/** One way through an auto, for drawing and playback. */
export interface Leg { kind: "path" | "wait" | "command"; label: string; start: number; end: number; path?: string; depth: number }

/**
 * Walks the steps in time order, taking each condition's then (or else, per
 * `assume`), and lays them on a timeline.
 */
export function legs(steps: Step[], d: Durations, autos: ReadonlyMap<string, Auto>, assume: (condition: string) => boolean, t0 = 0, depth = 0, seen: Set<string> = new Set()): { legs: Leg[]; end: number } {
  const out: Leg[] = []
  let t = t0
  for (const s of steps) {
    if (s.type === "path") {
      const len = d.get(pathKey(s)) ?? 0
      out.push({ kind: "path", label: pathKey(s), start: t, end: t + len, path: pathKey(s), depth })
      t += len
    } else if (s.type === "wait") {
      out.push({ kind: "wait", label: `wait ${s.seconds} s`, start: t, end: t + s.seconds, depth })
      t += s.seconds
    } else if (s.type === "command") {
      const len = s.alongside ? 0 : s.estimateS ?? 0
      out.push({ kind: "command", label: s.name, start: t, end: t + len, depth })
      t += len
    } else if (s.type === "if") {
      const r = legs(assume(s.condition) ? s.then : s.else, d, autos, assume, t, depth + 1, seen)
      out.push(...r.legs)
      t = r.end
    } else if (s.type === "auto") {
      const inner = autos.get(s.auto)
      if (!inner || seen.has(s.auto)) continue
      const r = legs(inner.steps, d, autos, assume, t, depth + 1, new Set([...seen, s.auto]))
      out.push(...r.legs)
      t = r.end
    }
  }
  return { legs: out, end: t }
}

/** Every condition an auto checks, in order of appearance (nested too). */
export function conditionsOf(steps: Step[], autos: ReadonlyMap<string, Auto>, seen: Set<string> = new Set()): string[] {
  const out: string[] = []
  for (const s of steps) {
    if (s.type === "if") out.push(s.condition, ...conditionsOf(s.then, autos, seen), ...conditionsOf(s.else, autos, seen))
    if (s.type === "auto" && !seen.has(s.auto)) out.push(...conditionsOf(autos.get(s.auto)?.steps ?? [], autos, new Set([...seen, s.auto])))
  }
  return [...new Set(out)]
}

/** Every step list in an auto, addressed by a path of indices, for editing. */
export type StepPath = (number | "then" | "else")[]

export function getList(steps: Step[], at: StepPath): Step[] {
  let list = steps
  for (let k = 0; k < at.length; k += 2) {
    const s = list[at[k] as number]
    if (!s || s.type !== "if") return []
    list = s[at[k + 1] as "then" | "else"]
  }
  return list
}

/** `steps` with the list at `at` replaced by `f(list)`. */
export function updateList(steps: Step[], at: StepPath, f: (list: Step[]) => Step[]): Step[] {
  if (at.length === 0) return f(steps)
  const [i, branch, ...rest] = at as [number, "then" | "else", ...StepPath]
  return steps.map((s, j) => (j === i && s.type === "if" ? { ...s, [branch]: updateList(s[branch], rest, f) } : s))
}

export function newAuto(name: string): Auto {
  return { name, budgetS: DEFAULT_BUDGET_S, steps: [] }
}
