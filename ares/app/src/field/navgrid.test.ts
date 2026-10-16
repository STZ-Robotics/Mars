import { describe, expect, it } from "vitest"
import {
  blockKeepOuts, blockedAt, blockedCount, box, brush, cellAt, cols, emptyGrid, grow, paint, resample, route,
  routeLength, rows, sees, stroke, symmetrize,
} from "./navgrid"

const L = 16.54, W = 8.07

describe("navgrid", () => {
  it("has PathPlanner's layout: rows along y, columns along x", () => {
    const g = emptyGrid(L, W, 0.3)
    expect(rows(g)).toBe(27)
    expect(cols(g)).toBe(56)
    expect(cellAt(g, 0.31, 0.01)).toEqual([1, 0])
    const p = paint(g, [[1, 0]], true)
    expect(blockedAt(p, 0.45, 0.1)).toBe(true)
    expect(blockedAt(p, 0.1, 0.45)).toBe(false)
    expect(g.grid[0][1]).toBe(false) // a copy, not an edit
  })

  it("brushes, strokes without gaps and boxes", () => {
    const g = emptyGrid(L, W, 0.3)
    expect(brush(g, 3, 3, 0).length).toBe(1)
    expect(new Set(brush(g, 3, 3, 0.5).map(String)).size).toBeGreaterThan(5)
    const line = paint(g, stroke(g, [1, 4], [10, 4], 0), true)
    for (let x = 1; x <= 10; x += 0.1) expect(blockedAt(line, x, 4)).toBe(true)
    expect(box(g, [1, 1], [1.9, 1.5]).length).toBe(4 * 3) // cols 3..6, rows 3..5
  })

  it("grows and shrinks", () => {
    const g = paint(emptyGrid(L, W, 0.3), [[10, 10]], true)
    expect(blockedCount(grow(g))).toBe(9)
    expect(blockedCount(grow(grow(g), -1))).toBe(1)
  })

  it("copies one side to the other under the field's symmetry", () => {
    const g = paint(emptyGrid(L, W, 0.3), [[1, 1]], true) // near blue's bottom-left
    const rot = symmetrize(g, "rotate", L, W)
    expect(blockedAt(rot, L - 0.45, W - 0.45)).toBe(true)
    const mir = symmetrize(g, "mirror", L, W)
    expect(blockedAt(mir, L - 0.45, 0.45)).toBe(true)
    expect(blockedCount(mir)).toBe(2)
  })

  it("blocks around keep-outs by the robot's reach", () => {
    const g = blockKeepOuts(emptyGrid(L, W, 0.3), [{ x: 8, y: 4, radiusM: 1 }], 0.5)
    expect(blockedAt(g, 8, 4)).toBe(true)
    expect(blockedAt(g, 9.3, 4)).toBe(true)
    expect(blockedAt(g, 9.7, 4)).toBe(false)
  })

  it("resamples to another cell size", () => {
    const g = paint(emptyGrid(L, W, 0.3), box(emptyGrid(L, W, 0.3), [3, 3], [5, 5]), true)
    const fine = resample(g, 0.1, L, W)
    expect(fine.nodeSizeMeters).toBe(0.1)
    expect(blockedAt(fine, 4, 4)).toBe(true)
    expect(blockedAt(fine, 6, 4)).toBe(false)
  })

  it("routes around a wall and every leg is clear", () => {
    const g0 = emptyGrid(L, W, 0.3)
    // A wall across the field at x = 8 with a gap near the top.
    const g = paint(g0, box(g0, [7.9, 0], [8.2, 6.5]), true)
    const a: [number, number] = [4, 2], b: [number, number] = [12, 2]
    expect(sees(g, a, b)).toBe(false)
    const r = route(g, a, b)!
    expect(r[0]).toEqual(a)
    expect(r[r.length - 1]).toEqual(b)
    expect(r.length).toBeGreaterThan(2)
    for (let i = 1; i < r.length; i++) expect(sees(g, r[i - 1], r[i])).toBe(true)
    expect(Math.max(...r.map(p => p[1]))).toBeGreaterThan(6.5)
    expect(routeLength(r)).toBeGreaterThan(8)
    // A clear line is just the line.
    expect(route(g, [1, 1], [3, 1])).toEqual([[1, 1], [3, 1]])
  })

  it("says when there is no way", () => {
    const g0 = emptyGrid(L, W, 0.3)
    const g = paint(g0, box(g0, [7.9, 0], [8.2, W]), true)
    expect(route(g, [4, 2], [12, 2])).toBeNull()
  })
})
