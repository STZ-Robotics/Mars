// Autos: sequences of paths and robot commands, the parent of paths.
//
// Steps run in order. A path step drives a path (or one of its variants); a
// wait waits; a command runs one of the robot code's NamedCommands (taking
// the time you estimate, or none if it runs alongside what follows); an
// if step takes one list or the other on a NamedCondition; an auto step
// runs another auto. A parallel step runs several lists at once; a when
// step arms a trigger and, when it fires, runs its list alongside whatever
// the auto is doing then. The robot code reads them from ares-index.json.

export type Step =
  | { type: "path"; path: string; variant?: string }
  | { type: "wait"; seconds: number }
  | { type: "command"; name: string; estimateS?: number; alongside?: boolean }
  | { type: "if"; condition: string; then: Step[]; else: Step[] }
  | { type: "auto"; auto: string }
  /**
   * The lists at once. `all` ends when every one has (WPILib's parallel),
   * `race` when the first one does, `deadline` when the first list does,
   * cutting the others.
   */
  | { type: "parallel"; mode: ParallelMode; branches: Step[][] }
  /** When the trigger fires (once, after this step is reached), its steps run alongside the rest. */
  | { type: "when"; trigger: Trigger; steps: Step[] }

export type ParallelMode = "all" | "race" | "deadline"

export type Trigger =
  /** Seconds since the auto started (the match clock). */
  | { kind: "time"; atS: number }
  /** The robot's center enters this rectangle (blue coordinates; flipped on red). */
  | { kind: "zone"; x: number; y: number; widthM: number; heightM: number }
  /** A NamedCondition becomes true. */
  | { kind: "condition"; name: string }

export interface Auto { name: string; budgetS?: number; steps: Step[] }

export const DEFAULT_BUDGET_S = 15

/** How long each path (or path@variant) takes, from its trajectory. */
export type Durations = ReadonlyMap<string, number>

export function pathKey(s: { path: string; variant?: string }): string {
  return s.variant ? `${s.path}@${s.variant}` : s.path
}

export type ListKey = "then" | "else" | "do" | `b${number}`

/** The step lists inside a step, by key: then/else, b0, b1… (parallel), do (when). */
export function children(s: Step): [ListKey, Step[]][] {
  if (s.type === "if") return [["then", s.then], ["else", s.else]]
  if (s.type === "parallel") return s.branches.map((b, k) => [`b${k}` as ListKey, b])
  if (s.type === "when") return [["do", s.steps]]
  return []
}

function childList(s: Step, key: ListKey): Step[] | null {
  if (s.type === "if" && (key === "then" || key === "else")) return s[key]
  if (s.type === "parallel" && key.startsWith("b")) return s.branches[Number(key.slice(1))] ?? null
  if (s.type === "when" && key === "do") return s.steps
  return null
}

function withChild(s: Step, key: ListKey, list: Step[]): Step {
  if (s.type === "if" && (key === "then" || key === "else")) return { ...s, [key]: list }
  if (s.type === "parallel" && key.startsWith("b")) {
    const k = Number(key.slice(1))
    return { ...s, branches: s.branches.map((b, j) => (j === k ? list : b)) }
  }
  if (s.type === "when" && key === "do") return { ...s, steps: list }
  return s
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
      case "parallel": {
        const rs = s.branches.map(b => duration(b, d, autos, seen))
        rs.forEach(r => missing.push(...r.missing))
        if (!rs.length) break
        const g = groupSpan(s.mode, rs.map(r => r.min), rs.map(r => r.max))
        min += g[0]
        max += g[1]
        break
      }
      case "when":
        // It runs alongside: the timeline does not wait for it.
        missing.push(...duration(s.steps, d, autos, seen).missing)
        break
    }
  }
  return { min, max, missing }
}

/** How long a parallel group lasts, from its branches' shortest and longest. */
function groupSpan(mode: ParallelMode, mins: number[], maxs: number[]): [number, number] {
  if (mode === "deadline") return [mins[0], maxs[0]]
  if (mode === "race") return [Math.min(...mins), Math.min(...maxs)]
  return [Math.max(...mins), Math.max(...maxs)]
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
    } else if (s.type === "parallel") {
      if (!s.branches.length) continue
      const rs = s.branches.map(b => legs(b, d, autos, assume, t, depth + 1, seen))
      const ends = rs.map(r => r.end)
      const end = s.mode === "deadline" ? ends[0] : s.mode === "race" ? Math.min(...ends) : Math.max(...ends)
      // What a race or a deadline cuts short is drawn cut short.
      for (const r of rs) out.push(...r.legs.filter(l => l.start < end - 1e-9 || l.end === l.start).map(l => ({ ...l, end: Math.min(l.end, end) })))
      t = end
    } else if (s.type === "when") {
      // Laid where it would fire if it fired as soon as it can (or at its time).
      const at = s.trigger.kind === "time" ? Math.max(t, s.trigger.atS) : t
      out.push(...legs(s.steps, d, autos, assume, at, depth + 1, seen).legs)
    }
  }
  return { legs: out, end: t }
}

/** Every condition an auto checks with an if, in order of appearance (nested too). */
export function conditionsOf(steps: Step[], autos: ReadonlyMap<string, Auto>, seen: Set<string> = new Set()): string[] {
  const out: string[] = []
  for (const s of steps) {
    if (s.type === "if") out.push(s.condition)
    for (const [, list] of children(s)) out.push(...conditionsOf(list, autos, seen))
    if (s.type === "auto" && !seen.has(s.auto)) out.push(...conditionsOf(autos.get(s.auto)?.steps ?? [], autos, new Set([...seen, s.auto])))
  }
  return [...new Set(out)]
}

/** Every name an auto asks the robot code for (and every path it drives), nested autos included. */
export function namesOf(steps: Step[], autos: ReadonlyMap<string, Auto>): { commands: string[]; conditions: string[]; paths: string[] } {
  const commands = new Set<string>(), conditions = new Set<string>(), paths = new Set<string>()
  const walk = (list: Step[], seen: Set<string>) => {
    for (const s of list) {
      if (s.type === "command") commands.add(s.name)
      if (s.type === "if") conditions.add(s.condition)
      if (s.type === "when" && s.trigger.kind === "condition") conditions.add(s.trigger.name)
      if (s.type === "path") paths.add(pathKey(s))
      for (const [, l] of children(s)) walk(l, seen)
      if (s.type === "auto" && !seen.has(s.auto)) walk(autos.get(s.auto)?.steps ?? [], new Set([...seen, s.auto]))
    }
  }
  walk(steps, new Set())
  return { commands: [...commands], conditions: [...conditions], paths: [...paths] }
}

/** The zones the auto's when steps watch, for drawing. */
export function zonesOf(steps: Step[]): Extract<Trigger, { kind: "zone" }>[] {
  const out: Extract<Trigger, { kind: "zone" }>[] = []
  for (const s of steps) {
    if (s.type === "when" && s.trigger.kind === "zone") out.push(s.trigger)
    for (const [, l] of children(s)) out.push(...zonesOf(l))
  }
  return out
}

/** Every step list in an auto, addressed by a path of (step index, list key) pairs, for editing. */
export type StepPath = (number | ListKey)[]

export function getList(steps: Step[], at: StepPath): Step[] {
  let list = steps
  for (let k = 0; k < at.length; k += 2) {
    const s = list[at[k] as number]
    const next = s ? childList(s, at[k + 1] as ListKey) : null
    if (!next) return []
    list = next
  }
  return list
}

/** `steps` with the list at `at` replaced by `f(list)`. */
export function updateList(steps: Step[], at: StepPath, f: (list: Step[]) => Step[]): Step[] {
  if (at.length === 0) return f(steps)
  const [i, key, ...rest] = at as [number, ListKey, ...StepPath]
  return steps.map((s, j) => {
    if (j !== i) return s
    const list = childList(s, key)
    return list ? withChild(s, key, updateList(list, rest, f)) : s
  })
}

export function newAuto(name: string): Auto {
  return { name, budgetS: DEFAULT_BUDGET_S, steps: [] }
}
