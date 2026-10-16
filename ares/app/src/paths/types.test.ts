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
