import { describe, expect, it } from "vitest"
import { parseQuantity } from "./units"

describe("parseQuantity", () => {
  it("reads SI by default and the units teams use", () => {
    expect(parseQuantity("0.5", "length")).toBe(0.5)
    expect(parseQuantity("2in", "length")).toBeCloseTo(0.0508)
    expect(parseQuantity('2"', "length")).toBeCloseTo(0.0508)
    expect(parseQuantity("550 mm", "length")).toBeCloseTo(0.55)
    expect(parseQuantity("125 lb", "mass")).toBeCloseTo(56.699)
    expect(parseQuantity(".9", "plain")).toBe(0.9)
  })

  it("refuses what it cannot read", () => {
    expect(parseQuantity("two", "length")).toBeNull()
    expect(parseQuantity("2 parsecs", "length")).toBeNull()
    expect(parseQuantity("2kg", "length")).toBeNull()
    expect(parseQuantity("2in", "plain")).toBeNull()
  })
})
