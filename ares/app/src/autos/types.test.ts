import { describe, expect, it } from "vitest"
import { Auto, conditionsOf, duration, getList, legs, migrate, moveStep, namesOf, Step, updateList } from "./types"

const d = new Map([["A", 2], ["B", 3], ["C", 1.5], ["B@fast", 2.5]])
const steps: Step[] = [
  { type: "path", path: "A" },
  { type: "command", name: "shoot", estimateS: 0.5 },
  { type: "if", condition: "hasNote", then: [{ type: "path", path: "B" }], else: [{ type: "path", path: "C" }, { type: "wait", seconds: 0.25 }] },
]

describe("autos", () => {
  it("time the shortest and longest way through", () => {
    const r = duration(steps, d, new Map())
    expect(r.min).toBeCloseTo(2 + 0.5 + 1.75)
    expect(r.max).toBeCloseTo(2 + 0.5 + 3)
    expect(r.missing).toEqual([])
  })
  it("report paths not generated", () => {
    expect(duration([{ type: "path", path: "Z" }], d, new Map()).missing).toEqual(["Z"])
  })
  it("lay one way on a timeline", () => {
    const r = legs(steps, d, new Map(), c => c !== "hasNote")
    expect(r.legs.map(l => l.label)).toEqual(["A", "shoot", "C", "wait 0.25 s"])
    expect(r.end).toBeCloseTo(4.25)
  })
  it("nest autos without looping", () => {
    const inner: Auto = { name: "inner", steps: [{ type: "path", path: "B", variant: "fast" }, { type: "auto", auto: "inner" }] }
    const autos = new Map([["inner", inner]])
    expect(duration([{ type: "auto", auto: "inner" }], d, autos).max).toBeCloseTo(2.5)
    expect(conditionsOf(steps, autos)).toEqual(["hasNote"])
  })
  it("edit nested lists", () => {
    expect(getList(steps, [2, "else"]).length).toBe(2)
    const next = updateList(steps, [2, "else"], l => [...l, { type: "wait", seconds: 1 }])
    expect(getList(next, [2, "else"]).length).toBe(3)
    expect(getList(steps, [2, "else"]).length).toBe(2)
  })
})

describe("command groups", () => {
  const group = (type: "parallel" | "deadline" | "race"): Step => ({
    type, steps: [{ type: "path", path: "A" }, { type: "wait", seconds: 3 }],
  })
  it("time a group by its type", () => {
    expect(duration([group("parallel")], d, new Map()).max).toBeCloseTo(3)
    expect(duration([group("race")], d, new Map()).max).toBeCloseTo(2)
    expect(duration([group("deadline")], d, new Map()).max).toBeCloseTo(2)
    const seq: Step = { type: "sequential", steps: [{ type: "path", path: "A" }, { type: "path", path: "C" }] }
    expect(duration([{ type: "parallel", steps: [seq, { type: "wait", seconds: 1 }] }], d, new Map()).max).toBeCloseTo(3.5)
  })
  it("lay a group out, cutting what a race cuts", () => {
    const r = legs([group("race"), { type: "path", path: "C" }], d, new Map(), () => true)
    expect(r.end).toBeCloseTo(3.5)
    expect(r.legs.find(l => l.kind === "wait")!.end).toBeCloseTo(2)
  })
  it("a when takes no time and lands at its time", () => {
    const s: Step[] = [
      { type: "when", trigger: { kind: "time", atS: 1 }, steps: [{ type: "command", name: "spin", estimateS: 0.5 }] },
      { type: "path", path: "A" },
    ]
    const r = legs(s, d, new Map(), () => true)
    expect(r.end).toBeCloseTo(2)
    expect(r.legs.find(l => l.label === "spin")!.start).toBeCloseTo(1)
  })
  it("list what the robot code must have", () => {
    const s: Step[] = [
      { type: "deadline", steps: [{ type: "path", path: "A" }, { type: "command", name: "intake" }] },
      { type: "when", trigger: { kind: "condition", name: "seesTag" }, steps: [{ type: "command", name: "aim" }] },
    ]
    const names = namesOf(s, new Map())
    expect(names.commands.sort()).toEqual(["aim", "intake"])
    expect(names.conditions).toEqual(["seesTag"])
    expect(names.paths).toEqual(["A"])
  })
})

describe("the old format", () => {
  it("turns lists in parallel into groups", () => {
    const old = [{ type: "parallel", mode: "deadline", branches: [[{ type: "path", path: "A" }], [{ type: "command", name: "x" }, { type: "wait", seconds: 1 }]] }] as unknown as Step[]
    expect(migrate(old)).toEqual([{
      type: "deadline", steps: [{ type: "path", path: "A" }, { type: "sequential", steps: [{ type: "command", name: "x" }, { type: "wait", seconds: 1 }] }],
    }])
  })
  it("turns a command alongside the rest into a deadline on the rest", () => {
    const old: Step[] = [{ type: "path", path: "A" }, { type: "command", name: "spin", alongside: true }, { type: "path", path: "B" }, { type: "path", path: "C" }]
    expect(migrate(old)).toEqual([
      { type: "path", path: "A" },
      { type: "deadline", steps: [{ type: "sequential", steps: [{ type: "path", path: "B" }, { type: "path", path: "C" }] }, { type: "command", name: "spin" }] },
    ])
    // The timing is the same as before.
    expect(duration(migrate(old), d, new Map()).max).toBeCloseTo(duration(old, d, new Map()).max)
  })
})

describe("moving commands", () => {
  const tree: Step[] = [
    { type: "path", path: "A" },
    { type: "parallel", steps: [{ type: "command", name: "x" }] },
    { type: "path", path: "B" },
  ]
  const label = (s: Step) => (s.type === "path" ? s.path : s.type)
  it("within a list, both ways", () => {
    expect(moveStep(tree, [], 0, [], 3).map(label)).toEqual(["parallel", "B", "A"])
    expect(moveStep(tree, [], 2, [], 0).map(label)).toEqual(["B", "A", "parallel"])
  })
  it("into a group after it and out to the root", () => {
    const into = moveStep(tree, [], 0, [1, "steps"], 0)
    expect(into.length).toBe(2)
    expect(getList(into, [0, "steps"]).map(s => s.type)).toEqual(["path", "command"])
    const out = moveStep(tree, [1, "steps"], 0, [], 3)
    expect(out.map(s => s.type)).toEqual(["path", "parallel", "path", "command"])
    expect(getList(out, [1, "steps"]).length).toBe(0)
  })
  it("never a group into itself", () => {
    expect(moveStep(tree, [], 1, [1, "steps"], 0)).toBe(tree)
  })
})

describe("the timeline's legs", () => {
  const d = new Map([["A", 2], ["B", 3]])
  it("know their card and carry the paths' event markers", () => {
    const steps: Step[] = [
      { type: "path", path: "A" },
      { type: "deadline", steps: [{ type: "path", path: "B" }, { type: "command", name: "spin" }] },
    ]
    const markers = new Map([["A", [{ name: "intake", t: 0.5, endT: 1.5 }]], ["B", [{ name: "late", t: 2.9 }, { name: "never", t: 3.5 }]]])
    const r = legs(steps, d, new Map(), () => true, 0, 0, new Set(), markers)
    const byLabel = Object.fromEntries(r.legs.map(l => [l.label, l]))
    expect(byLabel.A.key).toBe("0")
    expect(byLabel.B.key).toBe("1/steps/0")
    expect(byLabel.spin.key).toBe("1/steps/1")
    expect(byLabel.intake).toMatchObject({ kind: "event", start: 0.5, end: 1.5, key: "0" })
    expect(byLabel.late.start).toBeCloseTo(4.9)
    // Past the end of the path: never reached.
    expect(byLabel.never).toBeUndefined()
  })
  it("give a run auto's whole content to its card", () => {
    const inner = { name: "In", steps: [{ type: "path", path: "A" }, { type: "wait", seconds: 1 }] as Step[] }
    const r = legs([{ type: "wait", seconds: 1 }, { type: "auto", auto: "In" }], d, new Map([["In", inner]]), () => true)
    expect(r.legs.filter(l => l.start >= 1).every(l => l.key === "1")).toBe(true)
    expect(r.end).toBe(4)
  })
})
