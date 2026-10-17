import { describe, expect, it } from "vitest"
import { afterInsert, afterRemove, newPathSpec, rangeOf, PathSpec } from "./types"

const spec = (): PathSpec => ({
  ...newPathSpec("t"),
  scoped: [
    { type: "stopPoint", from: "first" },
    { type: "maxVelocity", mps: 2, from: { index: 1 }, to: { index: 2 } },
    { type: "stopPoint", from: { index: 1 } },
  ],
  events: [{ name: "intake", target: { index: 2 }, offsetS: 0 }],
})

describe("waypoint targets follow edits", () => {
  it("shift on insert", () => {
    const r = afterInsert(spec(), 1)
    expect(r.scoped[1]).toMatchObject({ from: { index: 2 }, to: { index: 3 } })
    expect(r.scoped[0].from).toBe("first")
    expect(r.events![0].target).toEqual({ index: 3 })
  })

  it("drop what pointed at a removed waypoint and shift the rest", () => {
    const r = afterRemove(spec(), 1)
    expect(r.scoped.length).toBe(1)
    expect(r.events![0].target).toEqual({ index: 1 })
  })

  it("ranges are ordered and resolved", () => {
    expect(rangeOf({ type: "maxVelocity", mps: 1, from: "last", to: { index: 0 } }, 4)).toEqual([0, 3])
  })
})

import { afterMove, stopAt, toggleStop } from "./types"

describe("moving and stopping", () => {
  it("targets follow a moved waypoint", () => {
    const s = spec()
    const r = afterMove(s, 1, 2)
    // Waypoint 1 is now at 2, and 2 at 1.
    expect(r.scoped[1]).toMatchObject({ from: { index: 2 }, to: { index: 1 } })
    expect(r.events![0].target).toEqual({ index: 1 })
  })

  it("toggles a stop on and off", () => {
    const s = { ...newPathSpec("t"), scoped: [] }
    const on = toggleStop(s, 1)
    expect(stopAt(on, 1)).toBe(0)
    expect(stopAt(toggleStop(on, 1), 1)).toBe(-1)
    expect(toggleStop(s, 0).scoped[0].from).toBe("first")
  })
})

import { moveControl, setManual } from "./types"

describe("manual segments", () => {
  it("start with controls along the tangent and stay smooth when one moves", () => {
    let s = setManual(newPathSpec("t"), 0, true)
    s = setManual(s, 1, true)
    const w1 = s.waypoints[1]
    expect(w1.prevControl).toBeDefined()
    expect(w1.nextControl).toBeDefined()
    s = moveControl(s, 1, "next", w1.x + 1, w1.y + 1, false)
    const m = s.waypoints[1]
    // prev is on the opposite side of the same line.
    const a = Math.atan2(m.nextControl![1] - m.y, m.nextControl![0] - m.x)
    const b = Math.atan2(m.prevControl![1] - m.y, m.prevControl![0] - m.x)
    expect(Math.abs(Math.abs(a - b) - Math.PI)).toBeLessThan(1e-9)
  })
})

import { segmentMode, setSegmentMode } from "./types"

describe("segment modes", () => {
  it("cycle cleanly between optimized, manual and pathfind", () => {
    let s = setSegmentMode(newPathSpec("t"), 0, "manual")
    expect(segmentMode(s.waypoints[0])).toBe("manual")
    s = setSegmentMode(s, 0, "pathfind")
    expect(segmentMode(s.waypoints[0])).toBe("pathfind")
    expect(s.waypoints[0].manualNext).toBeUndefined()
    s = setSegmentMode(s, 0, "optimized")
    expect(segmentMode(s.waypoints[0])).toBe("optimized")
  })
})

import { mirrorPath, moveWaypoints } from "./types"

describe("mirroring and moving", () => {
  it("mirrors across the alliance and back", () => {
    const s = newPathSpec("t")
    const m = mirrorPath(s, "alliance", 16, 8)
    expect(m.waypoints[0]).toMatchObject({ x: 14, y: 4, headingDeg: 180 })
    expect(mirrorPath(m, "alliance", 16, 8).waypoints[0]).toMatchObject({ x: 2, y: 4, headingDeg: 0 })
    expect(mirrorPath(s, "vertical", 16, 8).waypoints[1]).toMatchObject({ x: 5, y: 2.5 })
  })
  it("moves a group and drops their position formulas", () => {
    const s = { ...newPathSpec("t") }
    s.waypoints[0] = { ...s.waypoints[0], exprs: { x: "=hub.x", headingDeg: "=hub.heading" } }
    const m = moveWaypoints(s, [0, 1], 1, -1)
    expect(m.waypoints[0]).toMatchObject({ x: 3, y: 3 })
    expect(m.waypoints[0].exprs).toEqual({ headingDeg: "=hub.heading" })
    expect(m.waypoints[2]).toBe(s.waypoints[2])
  })
})

describe("point-at", () => {
  it("names the side that aims, and mirrors it", async () => {
    const { facingDeg, sideName, mirrorPath } = await import("./types")
    expect(sideName(facingDeg({ flip: true }))).toBe("Back")
    expect(sideName(facingDeg({ offsetDeg: 90 }))).toBe("Left")
    expect(facingDeg({ flip: true, offsetDeg: 90 })).toBe(-90)
    const s = {
      name: "P", waypoints: [{ x: 1, y: 1 }, { x: 5, y: 1 }], constraints: {},
      scoped: [{ type: "pointAt" as const, x: 3, y: 6, toleranceDeg: 5, offsetDeg: 90, from: "first" as const, to: "last" as const }],
    }
    const m = mirrorPath(s, "vertical", 16, 8).scoped[0] as { x: number; y: number; offsetDeg?: number }
    // Across the field: the target goes to the other side, and the left side aiming becomes the right.
    expect(m).toMatchObject({ x: 3, y: 2, offsetDeg: -90 })
  })
})
