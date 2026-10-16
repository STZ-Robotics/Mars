import { describe, expect, it } from "vitest"
import { Auto, conditionsOf, duration, getList, legs, Step, updateList } from "./types"

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
