import { describe, expect, it } from "vitest"
import { allianceOf, newPathSpec } from "./types"

describe("whose path it is", () => {
  it("is the half its start is on", () => {
    const s = newPathSpec("p")
    expect(allianceOf({ ...s, waypoints: [{ x: 2, y: 4 }, { x: 10, y: 4 }] }, 16.54)).toBe("blue")
    expect(allianceOf({ ...s, waypoints: [{ x: 14, y: 4 }, { x: 3, y: 4 }] }, 16.54)).toBe("red")
  })
  it("skips an unknown start, and a path with nowhere to start has none", () => {
    const s = newPathSpec("p")
    expect(allianceOf({ ...s, waypoints: [{ x: 0, y: 0, kind: "unknown" }, { x: 13, y: 4 }] }, 16.54)).toBe("red")
    expect(allianceOf(null, 16.54)).toBeNull()
  })
})
