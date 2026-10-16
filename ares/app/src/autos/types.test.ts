import { describe, expect, it } from "vitest"
import { Auto, conditionsOf, duration, getList, legs, namesOf, Step, updateList } from "./types"

const d = new Map([["A", 2], ["B", 3], ["C", 1.5], ["B@fast", 2.5]])
const steps: Step[] = [
  { type: "path", path: "A" },
  { type: "command", name: "shoot", estimateS: 0.5 },
  { type: "if", condition: "hasNote", then: [{ type: "path", path: "B" }], else: [{ type: "path", path: "C" }, { type: "wait", seconds: 0.25 }] },
  { type: "command", name: "intake", alongside: true },
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
    expect(r.legs.map(l => l.label)).toEqual(["A", "shoot", "C", "wait 0.25 s", "intake"])
    expect(r.end).toBeCloseTo(4.25)
  })
  it("nest autos without looping", () => {
    const inner: Auto = { name: "inner", steps: [{ type: "path", path: "B", variant: "fast" }, { type: "auto", auto: "inner" }] }
    const autos = new Map([["inner", inner]])
    expect(duration([{ type: "auto", auto: "inner" }], d, autos).max).toBeCloseTo(2.5)
    expect(conditionsOf(steps, autos)).toEqual(["hasNote"])
  })
  it("edit nested lists", () => {
    const at = [2, "else"] as const
    expect(getList(steps, [...at]).length).toBe(2)
    const next = updateList(steps, [...at], l => [...l, { type: "wait", seconds: 1 }])
    expect(getList(next, [...at]).length).toBe(3)
    expect(getList(steps, [...at]).length).toBe(2)
  })
})

describe("parallel and when", () => {
  const group = (mode: "all" | "race" | "deadline"): Step => ({
    type: "parallel", mode, branches: [[{ type: "path", path: "A" }], [{ type: "wait", seconds: 3 }]],
  })
  it("time a group by its mode", () => {
    expect(duration([group("all")], d, new Map()).max).toBeCloseTo(3)
    expect(duration([group("race")], d, new Map()).max).toBeCloseTo(2)
    expect(duration([group("deadline")], d, new Map()).max).toBeCloseTo(2)
  })
  it("lay a group out, cutting what a race cuts", () => {
    const r = legs([group("race"), { type: "path", path: "C" }], d, new Map(), () => true)
    expect(r.end).toBeCloseTo(3.5)
    const wait = r.legs.find(l => l.kind === "wait")!
    expect(wait.end).toBeCloseTo(2)
  })
  it("a when step takes no time and lands at its time", () => {
    const steps: Step[] = [
      { type: "when", trigger: { kind: "time", atS: 1 }, steps: [{ type: "command", name: "spin", estimateS: 0.5 }] },
      { type: "path", path: "A" },
    ]
    const r = legs(steps, d, new Map(), () => true)
    expect(r.end).toBeCloseTo(2)
    expect(r.legs.find(l => l.label === "spin")!.start).toBeCloseTo(1)
    expect(duration(steps, d, new Map()).max).toBeCloseTo(2)
  })
  it("edit lists inside groups and whens, and list what the robot code must have", () => {
    const steps: Step[] = [group("all"), { type: "when", trigger: { kind: "condition", name: "seesTag" }, steps: [] }]
    const next = updateList(steps, [1, "do"], l => [...l, { type: "command", name: "aim" }])
    const n2 = updateList(next, [0, "b1"], l => [...l, { type: "command", name: "shoot" }])
    expect(getList(n2, [0, "b1"]).length).toBe(2)
    expect(getList(n2, [1, "do"]).length).toBe(1)
    const names = namesOf(n2, new Map())
    expect(names.commands.sort()).toEqual(["aim", "shoot"])
    expect(names.conditions).toEqual(["seesTag"])
    expect(names.paths).toEqual(["A"])
  })
})
