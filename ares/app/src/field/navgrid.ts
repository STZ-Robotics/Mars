// The navigation grid: where the pathfinder may not take the robot.
//
// PathPlanner's layout, so one file works for both: square cells of
// `nodeSizeMeters` from the field's origin, `grid[row][col]` with the row
// along y and the column along x, and `true` for a cell the robot's CENTER
// may not enter (a blocked area already includes the robot's reach).
//
// Only the "?" segments obey it, in Ares's estimate and in AresLib's
// pathfinder on the robot; a path the user drew goes where it was drawn.

import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { KeepOut } from "../paths/types"

export interface NavGrid { nodeSizeMeters: number; grid: boolean[][] }

export type Cell = [number, number] // [col, row]

export const FIELD_SIZE = { lengthM: FIELDS[0].sizeMeters[0], widthM: FIELDS[0].sizeMeters[1] }

/** PathPlanner's default cell. */
export const DEFAULT_NODE_M = 0.3

export function emptyGrid(lengthM: number, widthM: number, node = DEFAULT_NODE_M): NavGrid {
  const cols = Math.ceil(lengthM / node), rows = Math.ceil(widthM / node)
  return { nodeSizeMeters: node, grid: Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false)) }
}

export const rows = (g: NavGrid) => g.grid.length
export const cols = (g: NavGrid) => (g.grid[0]?.length ?? 0)

/** The cell holding (x, y), or null off the grid. */
export function cellAt(g: NavGrid, x: number, y: number): Cell | null {
  const c = Math.floor(x / g.nodeSizeMeters), r = Math.floor(y / g.nodeSizeMeters)
  return c >= 0 && r >= 0 && r < rows(g) && c < cols(g) ? [c, r] : null
}

export function center(g: NavGrid, [c, r]: Cell): [number, number] {
  return [(c + 0.5) * g.nodeSizeMeters, (r + 0.5) * g.nodeSizeMeters]
}

/** Whether the robot's center may not be at (x, y). Off the grid is open. */
export function blockedAt(g: NavGrid, x: number, y: number): boolean {
  const cell = cellAt(g, x, y)
  return cell ? g.grid[cell[1]][cell[0]] : false
}

export function blockedCount(g: NavGrid): number {
  let n = 0
  for (const row of g.grid) for (const b of row) if (b) n++
  return n
}

/** A copy with these cells set to `value`. */
export function paint(g: NavGrid, cells: Iterable<Cell>, value: boolean): NavGrid {
  const grid = g.grid.map(r => r.slice())
  for (const [c, r] of cells) if (r >= 0 && r < grid.length && c >= 0 && c < grid[r].length) grid[r][c] = value
  return { ...g, grid }
}

/** The cells whose centers are within `radiusM` of (x, y), and always the one under it. */
export function brush(g: NavGrid, x: number, y: number, radiusM: number): Cell[] {
  const out: Cell[] = []
  const under = cellAt(g, x, y)
  if (under) out.push(under)
  const n = Math.ceil(radiusM / g.nodeSizeMeters) + 1
  const [c0, r0] = [Math.floor(x / g.nodeSizeMeters), Math.floor(y / g.nodeSizeMeters)]
  for (let r = r0 - n; r <= r0 + n; r++) {
    for (let c = c0 - n; c <= c0 + n; c++) {
      if (r < 0 || c < 0 || r >= rows(g) || c >= cols(g)) continue
      const [cx, cy] = center(g, [c, r])
      if (Math.hypot(cx - x, cy - y) <= radiusM) out.push([c, r])
    }
  }
  return out
}

/** The brush dragged from a to b: no gaps however fast the mouse moved. */
export function stroke(g: NavGrid, a: [number, number], b: [number, number], radiusM: number): Cell[] {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1])
  const n = Math.max(1, Math.ceil(d / (g.nodeSizeMeters / 3)))
  const out: Cell[] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    out.push(...brush(g, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, radiusM))
  }
  return out
}

/** The cells a box from a to b touches. */
export function box(g: NavGrid, a: [number, number], b: [number, number]): Cell[] {
  const lo = cellAt(g, Math.max(0, Math.min(a[0], b[0])), Math.max(0, Math.min(a[1], b[1])))
  const hi = [Math.min(cols(g) - 1, Math.floor(Math.max(a[0], b[0]) / g.nodeSizeMeters)), Math.min(rows(g) - 1, Math.floor(Math.max(a[1], b[1]) / g.nodeSizeMeters))]
  if (!lo || hi[0] < 0 || hi[1] < 0) return []
  const out: Cell[] = []
  for (let r = lo[1]; r <= hi[1]; r++) for (let c = lo[0]; c <= hi[0]; c++) out.push([c, r])
  return out
}

const AROUND: Cell[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/** Every blocked area one cell bigger (or, with `by < 0`, smaller). */
export function grow(g: NavGrid, by = 1): NavGrid {
  let grid = g.grid
  for (let k = 0; k < Math.abs(by); k++) {
    const add = by > 0
    grid = grid.map((row, r) => row.map((b, c) => {
      if (b === add) return b
      // Grow: an open cell next to a blocked one closes. Shrink: a blocked
      // cell next to an open one (or the edge counts as blocked) opens.
      return AROUND.some(([dc, dr]) => {
        const v = grid[r + dr]?.[c + dc]
        return v === undefined ? false : v === add
      }) ? add : b
    }))
  }
  return { ...g, grid }
}

/**
 * The cells blocked on one alliance's side copied to the other's, under the
 * field's symmetry: draw one half, get both.
 */
export function symmetrize(g: NavGrid, how: "rotate" | "mirror", lengthM: number, widthM: number): NavGrid {
  const grid = g.grid.map(row => row.slice())
  for (let r = 0; r < rows(g); r++) {
    for (let c = 0; c < cols(g); c++) {
      if (!g.grid[r][c]) continue
      const [x, y] = center(g, [c, r])
      const image = cellAt(g, lengthM - x, how === "rotate" ? widthM - y : y)
      if (image) grid[image[1]][image[0]] = true
    }
  }
  return { ...g, grid }
}

/** Blocks the cells where the robot's center would put its bumper in a keep-out. */
export function blockKeepOuts(g: NavGrid, keepOut: KeepOut[], reachM: number): NavGrid {
  return {
    ...g,
    grid: g.grid.map((row, r) => row.map((b, c) => {
      if (b) return true
      const [x, y] = center(g, [c, r])
      return keepOut.some(k => Math.hypot(x - k.x, y - k.y) < k.radiusM + reachM)
    })),
  }
}

/** The same cells at another size: a new cell is blocked if the old grid was blocked at its center. */
export function resample(g: NavGrid, node: number, lengthM: number, widthM: number): NavGrid {
  const out = emptyGrid(lengthM, widthM, node)
  return { ...out, grid: out.grid.map((row, r) => row.map((_, c) => blockedAt(g, ...center(out, [c, r])))) }
}

/** Whether the straight line from a to b stays out of blocked cells (its ends may be in one). */
export function sees(g: NavGrid, a: [number, number], b: [number, number]): boolean {
  const step = Math.max(0.01, g.nodeSizeMeters / 4)
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)
  for (let i = 1; i < n; i++) {
    const f = i / n
    if (blockedAt(g, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)) return false
  }
  return true
}

/**
 * The way the pathfinder takes from a to b: A* over the open cells (eight
 * neighbors), straightened by line of sight, from a to b inclusive. Null if
 * there is none. The same search AresLib runs on the robot, so the preview is
 * what the robot will do from there.
 */
export function route(g: NavGrid, a: [number, number], b: [number, number]): [number, number][] | null {
  if (sees(g, a, b)) return [a, b]
  const start = cellAt(g, a[0], a[1]), goal = cellAt(g, b[0], b[1])
  if (!start || !goal) return null
  const W = cols(g), key = ([c, r]: Cell) => r * W + c
  const open = (cell: Cell) => cell[0] >= 0 && cell[1] >= 0 && cell[0] < W && cell[1] < rows(g)
    && (!g.grid[cell[1]][cell[0]] || key(cell) === key(start) || key(cell) === key(goal))
  const gs = new Map<number, number>([[key(start), 0]])
  const came = new Map<number, number>()
  const h = ([c, r]: Cell) => Math.hypot(c - goal[0], r - goal[1])
  // A binary heap would be faster; at PathPlanner's cell size the field is
  // ~1500 cells and this runs in a frame.
  const frontier: { f: number; cell: Cell }[] = [{ f: h(start), cell: start }]
  const closed = new Set<number>()
  let found = false
  while (frontier.length) {
    let best = 0
    for (let i = 1; i < frontier.length; i++) if (frontier[i].f < frontier[best].f) best = i
    const { cell } = frontier.splice(best, 1)[0]
    const k = key(cell)
    if (closed.has(k)) continue
    closed.add(k)
    if (k === key(goal)) { found = true; break }
    const gc = gs.get(k)!
    for (const [dc, dr] of AROUND) {
      const n: Cell = [cell[0] + dc, cell[1] + dr]
      if (!open(n)) continue
      // No cutting a blocked corner diagonally.
      if (dc && dr && (!open([cell[0] + dc, cell[1]]) || !open([cell[0], cell[1] + dr]))) continue
      const gn = gc + (dc && dr ? Math.SQRT2 : 1)
      if (gn < (gs.get(key(n)) ?? Infinity)) {
        gs.set(key(n), gn)
        came.set(key(n), k)
        frontier.push({ f: gn + h(n), cell: n })
      }
    }
  }
  if (!found) return null
  const cells: Cell[] = []
  for (let k: number | undefined = key(goal); k !== undefined; k = came.get(k)) cells.push([k % W, Math.floor(k / W)])
  cells.reverse()
  const pts: [number, number][] = [a, ...cells.slice(1, -1).map(c => center(g, c)), b]
  // Line of sight: keep only the corners the straight line cannot skip.
  const out: [number, number][] = [a]
  let i = 0
  while (i < pts.length - 1) {
    let j = pts.length - 1
    while (j > i + 1 && !sees(g, pts[i], pts[j])) j--
    out.push(pts[j])
    i = j
  }
  return out
}

export function routeLength(pts: [number, number][]): number {
  let d = 0
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return d
}
