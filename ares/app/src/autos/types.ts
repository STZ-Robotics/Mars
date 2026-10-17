// Autos: a tree of commands, as in PathPlanner's auto editor.
//
// The auto is a sequential group. Its commands are paths to follow, the robot
// code's NamedCommands, waits, and groups that hold more commands:
// sequential (one after another), parallel (all at once, until all end),
// deadline (all at once, until the first ends) and race (all at once, until
// any ends). Beyond PathPlanner: an if takes one list or the other on a
// NamedCondition, a when runs its commands alongside the rest once a time
// comes, the robot enters a zone or a condition holds, and an auto runs
// another auto. The robot code reads them from ares-index.json.

export type GroupType = "sequential" | "parallel" | "deadline" | "race"

export type Step =
  | { type: "path"; path: string; variant?: string }
  | { type: "wait"; seconds: number }
  /** A NamedCommand. `estimateS` only places it on the timeline; `alongside` is the old format (see migrate). */
  | { type: "command"; name: string; estimateS?: number; alongside?: boolean }
  | { type: GroupType; steps: Step[] }
  | { type: "if"; condition: string; then: Step[]; else: Step[] }
  | { type: "when"; trigger: Trigger; steps: Step[] }
  | { type: "auto"; auto: string }

export type Trigger =
  /** Seconds since the auto started (the match clock). */
  | { kind: "time"; atS: number }
  /** The robot's center enters this rectangle (blue coordinates; flipped on red). */
  | { kind: "zone"; x: number; y: number; widthM: number; heightM: number }
  /** A NamedCondition becomes true. */
  | { kind: "condition"; name: string }

/**
 * An auto. `resetOdometry`: whether it sets the robot's pose to its first
 * path's start (PathPlanner's "Reset Odometry"); unset, the robot code's
 * Config decides (yes by default). `folder` groups it in the list.
 */
export interface Auto { name: string; budgetS?: number; resetOdometry?: boolean; folder?: string; steps: Step[] }

export const DEFAULT_BUDGET_S = 15

export const GROUPS: GroupType[] = ["sequential", "parallel", "deadline", "race"]

export function isGroup(s: Step): s is Extract<Step, { type: GroupType }> {
  return (GROUPS as string[]).includes(s.type)
}

/** How long each path (or path@variant) takes, from its trajectory. */
export type Durations = ReadonlyMap<string, number>

export function pathKey(s: { path: string; variant?: string }): string {
  return s.variant ? `${s.path}@${s.variant}` : s.path
}

// --- The old format ----------------------------------------------------------

type OldParallel = { type: "parallel"; mode: "all" | "race" | "deadline"; branches: Step[][] }

/**
 * Autos saved before the command tree: a parallel step held lists
 * (`mode`, `branches`) and a command could run `alongside` the rest of its
 * list. Both become groups, the way PathPlanner would write them.
 */
export function migrate(steps: Step[]): Step[] {
  const out: Step[] = []
  for (let i = 0; i < steps.length; i++) {
    let s = steps[i] as Step | OldParallel
    if (s.type === "parallel" && "branches" in s) {
      const old = s as OldParallel
      s = {
        type: old.mode === "all" ? "parallel" : old.mode,
        steps: old.branches.map(b => (b.length === 1 ? b[0] : { type: "sequential", steps: b } as Step)),
      }
    }
    const step = s as Step
    if (step.type === "command" && step.alongside) {
      // It ran with everything after it and stopped with it: a deadline
      // whose deadline is the rest.
      const { alongside: _, ...cmd } = step
      const rest = migrate(steps.slice(i + 1))
      out.push(rest.length ? { type: "deadline", steps: [rest.length === 1 ? rest[0] : { type: "sequential", steps: rest }, cmd] } : cmd)
      break
    }
    out.push(withLists(step, migrate))
  }
  return out
}

function withLists(s: Step, f: (l: Step[]) => Step[]): Step {
  if (s.type === "if") return { ...s, then: f(s.then), else: f(s.else) }
  if (isGroup(s) || s.type === "when") return { ...s, steps: f(s.steps) }
  return s
}

export function migrateAuto(a: Auto): Auto {
  return { ...a, steps: migrate(a.steps ?? []) }
}

// --- Nested lists ------------------------------------------------------------

export type ListKey = "then" | "else" | "steps"

/** The command lists inside a command. */
export function children(s: Step): [ListKey, Step[]][] {
  if (s.type === "if") return [["then", s.then], ["else", s.else]]
  if (isGroup(s) || s.type === "when") return [["steps", s.steps]]
  return []
}

function childList(s: Step, key: ListKey): Step[] | null {
  if (s.type === "if" && (key === "then" || key === "else")) return s[key]
  if ((isGroup(s) || s.type === "when") && key === "steps") return s.steps
  return null
}

function withChild(s: Step, key: ListKey, list: Step[]): Step {
  if (s.type === "if" && (key === "then" || key === "else")) return { ...s, [key]: list }
  if ((isGroup(s) || s.type === "when") && key === "steps") return { ...s, steps: list }
  return s
}

/** A list in the tree, addressed by (index, key) pairs from the root list. */
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

/** Whether list `inner` is `outer` or inside one of its commands. */
function within(inner: StepPath, outer: StepPath): boolean {
  return outer.length <= inner.length && outer.every((x, i) => x === inner[i])
}

/**
 * Moves the command at `from[index]` to position `toIndex` of list `to`
 * (positions counted before the move). A group cannot go inside itself.
 */
export function moveStep(steps: Step[], from: StepPath, fromIndex: number, to: StepPath, toIndex: number): Step[] {
  if (within(to, [...from, fromIndex])) return steps
  const moving = getList(steps, from)[fromIndex]
  if (!moving) return steps
  const sameList = to.length === from.length && within(to, from)
  // Taking it out first shifts what comes after it in its own list, and the
  // address of a list after it in the same parent.
  let target = [...to]
  let at = toIndex
  if (sameList && fromIndex < toIndex) at--
  if (!sameList && within(to, from) && to.length > from.length && (to[from.length] as number) > fromIndex) {
    target = [...to]
    target[from.length] = (to[from.length] as number) - 1
  }
  const removed = updateList(steps, from, l => l.filter((_, j) => j !== fromIndex))
  return updateList(removed, target, l => [...l.slice(0, at), moving, ...l.slice(at)])
}

// --- Time ----------------------------------------------------------------------

/**
 * The time a list of commands takes in sequence: [shortest, longest] over the
 * conditions' outcomes, and the paths in it with no trajectory yet.
 */
export function duration(steps: Step[], d: Durations, autos: ReadonlyMap<string, Auto>, seen: Set<string> = new Set()): { min: number; max: number; missing: string[] } {
  let min = 0, max = 0
  const missing: string[] = []
  for (const s of steps) {
    const r = durationOf(s, d, autos, seen)
    min += r.min
    max += r.max
    missing.push(...r.missing)
  }
  return { min, max, missing }
}

function durationOf(s: Step, d: Durations, autos: ReadonlyMap<string, Auto>, seen: Set<string>): { min: number; max: number; missing: string[] } {
  switch (s.type) {
    case "path": {
      const t = d.get(pathKey(s))
      return { min: t ?? 0, max: t ?? 0, missing: t === undefined ? [pathKey(s)] : [] }
    }
    case "wait":
      return { min: s.seconds, max: s.seconds, missing: [] }
    case "command":
      return s.alongside ? { min: 0, max: 0, missing: [] } : { min: s.estimateS ?? 0, max: s.estimateS ?? 0, missing: [] }
    case "sequential":
      return duration(s.steps, d, autos, seen)
    case "parallel": case "deadline": case "race": {
      const rs = s.steps.map(c => durationOf(c, d, autos, seen))
      const missing = rs.flatMap(r => r.missing)
      if (!rs.length) return { min: 0, max: 0, missing }
      const [min, max] = groupSpan(s.type, rs.map(r => r.min), rs.map(r => r.max))
      return { min, max, missing }
    }
    case "if": {
      const a = duration(s.then, d, autos, seen), b = duration(s.else, d, autos, seen)
      return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max), missing: [...a.missing, ...b.missing] }
    }
    case "when":
      // It runs alongside: the timeline does not wait for it.
      return { min: 0, max: 0, missing: duration(s.steps, d, autos, seen).missing }
    case "auto": {
      const inner = autos.get(s.auto)
      if (!inner || seen.has(s.auto)) return { min: 0, max: 0, missing: [] }
      return duration(inner.steps, d, autos, new Set([...seen, s.auto]))
    }
  }
}

function groupSpan(type: GroupType, mins: number[], maxs: number[]): [number, number] {
  if (type === "deadline") return [mins[0], maxs[0]]
  if (type === "race") return [Math.min(...mins), Math.min(...maxs)]
  return [Math.max(...mins), Math.max(...maxs)]
}

/** One way through an auto, for drawing and playback. */
export interface Leg {
  kind: "path" | "wait" | "command" | "event"
  label: string
  start: number
  end: number
  path?: string
  depth: number
  /** The card it comes from (its address, as keyOf writes it); a run auto's whole content is that card's. */
  key: string
}

/** Each trajectory's event markers (by path key), for laying them on the timeline. */
export type Markers = ReadonlyMap<string, { name: string; t: number; endT?: number }[]>

/** The address of command `i` of list `at`, as the command tree keys its cards. */
export function stepKey(at: StepPath, i: number): string {
  return [...at, i].join("/")
}

/**
 * Walks the commands in time order, taking each condition's then (or else,
 * per `assume`), and lays them on a timeline, with the paths' event markers.
 */
export function legs(steps: Step[], d: Durations, autos: ReadonlyMap<string, Auto>, assume: (condition: string) => boolean, t0 = 0, depth = 0,
  seen: Set<string> = new Set(), markers: Markers = new Map(), at: StepPath = [], owner?: string): { legs: Leg[]; end: number } {
  const out: Leg[] = []
  let t = t0
  steps.forEach((s, i) => {
    const r = legsOf(s, d, autos, assume, t, depth, seen, markers, at, i, owner)
    out.push(...r.legs)
    t = r.end
  })
  return { legs: out, end: t }
}

function legsOf(s: Step, d: Durations, autos: ReadonlyMap<string, Auto>, assume: (c: string) => boolean, t: number, depth: number, seen: Set<string>,
  markers: Markers, at: StepPath, i: number, owner?: string): { legs: Leg[]; end: number } {
  const key = owner ?? stepKey(at, i)
  const inner = (list: Step[], k: ListKey, from: number) => legs(list, d, autos, assume, from, depth + 1, seen, markers, [...at, i, k], owner)
  switch (s.type) {
    case "path": {
      const len = d.get(pathKey(s)) ?? 0
      const events: Leg[] = (markers.get(pathKey(s)) ?? []).map(e => ({
        kind: "event", label: e.name, start: t + e.t, end: t + (e.endT ?? e.t), path: pathKey(s), depth, key,
      }))
      return { legs: [{ kind: "path", label: pathKey(s), start: t, end: t + len, path: pathKey(s), depth, key }, ...events], end: t + len }
    }
    case "wait":
      return { legs: [{ kind: "wait", label: `wait ${s.seconds} s`, start: t, end: t + s.seconds, depth, key }], end: t + s.seconds }
    case "command": {
      const len = s.alongside ? 0 : s.estimateS ?? 0
      return { legs: [{ kind: "command", label: s.name, start: t, end: t + len, depth, key }], end: t + len }
    }
    case "sequential":
      return inner(s.steps, "steps", t)
    case "parallel": case "deadline": case "race": {
      if (!s.steps.length) return { legs: [], end: t }
      const rs = s.steps.map((c, j) => legsOf(c, d, autos, assume, t, depth + 1, seen, markers, [...at, i, "steps"], j, owner))
      const ends = rs.map(r => r.end)
      const end = s.type === "deadline" ? ends[0] : s.type === "race" ? Math.min(...ends) : Math.max(...ends)
      // What a race or a deadline cuts short is drawn cut short.
      const out = rs.flatMap(r => r.legs.filter(l => l.start < end - 1e-9 || (l.end === l.start && l.start <= end + 1e-9)).map(l => ({ ...l, end: Math.min(l.end, end) })))
      return { legs: out, end }
    }
    case "if":
      return assume(s.condition) ? inner(s.then, "then", t) : inner(s.else, "else", t)
    case "when": {
      // Laid where it would fire if it fired as soon as it can (or at its time).
      const from = s.trigger.kind === "time" ? Math.max(t, s.trigger.atS) : t
      return { legs: inner(s.steps, "steps", from).legs, end: t }
    }
    case "auto": {
      const a = autos.get(s.auto)
      if (!a || seen.has(s.auto)) return { legs: [], end: t }
      return legs(a.steps, d, autos, assume, t, depth + 1, new Set([...seen, s.auto]), markers, [], key)
    }
  }
}

// --- What an auto uses ---------------------------------------------------------

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

/** The zones the auto's when commands watch, for drawing. */
export function zonesOf(steps: Step[]): Extract<Trigger, { kind: "zone" }>[] {
  const out: Extract<Trigger, { kind: "zone" }>[] = []
  for (const s of steps) {
    if (s.type === "when" && s.trigger.kind === "zone") out.push(s.trigger)
    for (const [, l] of children(s)) out.push(...zonesOf(l))
  }
  return out
}

export function newAuto(name: string): Auto {
  return { name, budgetS: DEFAULT_BUDGET_S, steps: [] }
}
