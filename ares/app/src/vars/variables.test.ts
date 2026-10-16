import { describe, expect, it } from "vitest"
import { applyScope, evaluateAll, renameInFormulas, renameVariable, usesOf, Variable, withField } from "./variables"

const vars: Variable[] = [
  { name: "hub", kind: "pose", x: "4.6", y: "=half_w", heading: "180" },
  { name: "half_w", kind: "number", dim: "length", value: "=8.07 / 2" },
  { name: "vfast", kind: "number", dim: "speed", value: "4.2" },
  { name: "a", kind: "number", dim: "plain", value: "=b + 1" },
  { name: "b", kind: "number", dim: "plain", value: "=a + 1" },
]

describe("variables", () => {
  it("evaluate in dependency order and catch cycles", () => {
    const { scope, errors } = evaluateAll(vars)
    expect(scope.get("hub")).toEqual({ x: 4.6, y: 4.035, heading: 180 })
    expect(errors.has("a") && errors.has("b")).toBe(true)
  })

  it("rewrite the numbers behind formulas, anywhere in a document", () => {
    const { scope } = evaluateAll(vars)
    const spec = {
      waypoints: [
        { x: 0, y: 0, exprs: { x: "=hub.x - 0.5", y: "=hub.y" } },
        { x: 9, y: 9 },
      ],
      constraints: { maxVelocityMps: 1, exprs: { maxVelocityMps: "=vfast * 0.5" } },
    }
    const r = applyScope(spec, scope)
    expect(r.changed).toBe(true)
    expect(r.doc.waypoints[0]).toMatchObject({ x: 4.1, y: 4.035 })
    expect(r.doc.constraints.maxVelocityMps).toBeCloseTo(2.1)
    expect(r.doc.waypoints[1]).toBe(spec.waypoints[1])
    expect(applyScope(r.doc, scope).changed).toBe(false)
  })

  it("handle dotted robot fields", () => {
    const { scope } = evaluateAll(vars)
    const robot = { drivetrain: { wheelRadiusM: 0 }, exprs: { "drivetrain.wheelRadiusM": "=2in" } }
    expect(applyScope(robot, scope).doc.drivetrain.wheelRadiusM).toBeCloseTo(0.0508)
  })

  it("rename everywhere and count uses", () => {
    const doc = { w: [{ exprs: { x: "=hub.x + hub_offset" } }] }
    const renamed = renameInFormulas(doc, "hub", "speaker")
    expect(renamed.w[0].exprs.x).toBe("=speaker.x + hub_offset")
    expect(renameVariable(vars, "half_w", "hw").find(v => v.name === "hub")).toMatchObject({ y: "=hw" })
    expect(usesOf([doc], "hub")).toBe(1)
    expect(usesOf([doc], "hub_offset")).toBe(1)
  })

  it("set a field as a number or a formula", () => {
    const w = withField({ x: 1, exprs: { x: "=a" } } as { x: number; exprs?: Record<string, string> }, "x", 2)
    expect(w).toEqual({ x: 2, exprs: undefined })
    expect(withField({ x: 1 } as { x: number; exprs?: Record<string, string> }, "x", 4.1, "=hub.x - 0.5").exprs).toEqual({ x: "=hub.x - 0.5" })
  })
})

import { withOverrides } from "./variables"

describe("variant overrides", () => {
  it("set numbers and swap poses", () => {
    const base: Variable[] = [
      { name: "note1", kind: "pose", x: "2", y: "3", heading: "0" },
      { name: "note2", kind: "pose", x: "5", y: "6", heading: "90" },
      { name: "target", kind: "pose", x: "=note1.x", y: "=note1.y", heading: "=note1.heading" },
      { name: "vmax", kind: "number", dim: "speed", value: "4" },
    ]
    const { scope } = evaluateAll(withOverrides(base, { target: "=note2", vmax: "2.5" }))
    expect(scope.get("target")).toEqual({ x: 5, y: 6, heading: 90 })
    expect(scope.get("vmax")).toBe(2.5)
  })
})
