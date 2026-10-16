import { describe, expect, it } from "vitest"
import { evaluate, isExpr, referencedNames, Scope } from "./expr"

const scope: Scope = new Map<string, number | { x: number; y: number; heading: number }>([
  ["vmax", 4],
  ["hub", { x: 4.6, y: 4.0, heading: 180 }],
])
const val = (t: string, dim: Parameters<typeof evaluate>[2] = "plain") => {
  const r = evaluate(t, scope, dim)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe("expressions", () => {
  it("are marked with =", () => {
    expect(isExpr("=vmax")).toBe(true)
    expect(isExpr("4.2")).toBe(false)
  })
  it("do arithmetic with precedence and parentheses", () => {
    expect(val("=1 + 2 * 3")).toBe(7)
    expect(val("=(1 + 2) * 3")).toBe(9)
    expect(val("=-2 ^ 2")).toBe(-4)
    expect(val("=10 / 4 - 1")).toBe(1.5)
  })
  it("read variables and pose fields", () => {
    expect(val("=vmax * 0.8")).toBeCloseTo(3.2)
    expect(val("=hub.x - 0.5", "length")).toBeCloseTo(4.1)
    expect(val("=hub.heading", "angle")).toBe(180)
  })
  it("convert units to the field's", () => {
    expect(val("=24in", "length")).toBeCloseTo(0.6096)
    expect(val("=1m + 50cm", "length")).toBeCloseTo(1.5)
    expect(val("=pi rad", "angle")).toBeCloseTo(180)
    expect(evaluate("=2kg", scope, "length").ok).toBe(false)
  })
  it("call functions, trig in degrees", () => {
    expect(val("=min(3, vmax, 5)")).toBe(3)
    expect(val("=hypot(3, 4)")).toBe(5)
    expect(val("=sin(90)")).toBeCloseTo(1)
    expect(val("=atan2(1, 1)")).toBeCloseTo(45)
  })
  it("explain what is wrong", () => {
    expect(evaluate("=nope + 1", scope)).toEqual({ ok: false, error: 'there is no variable "nope"' })
    expect(evaluate("=hub", scope).ok).toBe(false)
    expect(evaluate("=vmax.x", scope).ok).toBe(false)
    expect(evaluate("=(1 + 2", scope).ok).toBe(false)
  })
  it("list the names they use", () => {
    expect(referencedNames("=hub.x + vmax * 2in - sin(a)").sort()).toEqual(["a", "hub", "vmax"])
  })
})
