import type { NavGrid } from "./navgrid"

type ToScreen = (x: number, y: number) => [number, number]

export const NAVGRID_COLOR = "#7c3aed"

/**
 * The blocked cells, one rectangle per run of a row, and their outline. Faint
 * under the paths, strong in the editor.
 */
export function drawNavGrid(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, g: NavGrid, strong: boolean) {
  const n = g.nodeSizeMeters
  ctx.save()
  ctx.fillStyle = strong ? "rgba(124,58,237,0.38)" : "rgba(124,58,237,0.13)"
  for (let r = 0; r < g.grid.length; r++) {
    const row = g.grid[r]
    let c = 0
    while (c < row.length) {
      if (!row[c]) { c++; continue }
      const c0 = c
      while (c < row.length && row[c]) c++
      const [sx, sy] = toScreen(c0 * n, (r + 1) * n)
      ctx.fillRect(sx, sy, (c - c0) * n * k, n * k)
    }
  }
  // The edge between blocked and open, so a region reads as a shape.
  ctx.strokeStyle = strong ? "rgba(91,33,182,0.9)" : "rgba(124,58,237,0.35)"
  ctx.lineWidth = strong ? 1.2 : 0.8
  ctx.beginPath()
  const at = (r: number, c: number) => g.grid[r]?.[c] ?? false
  for (let r = 0; r < g.grid.length; r++) {
    for (let c = 0; c < g.grid[r].length; c++) {
      if (!g.grid[r][c]) continue
      const edges: [number, number, number, number][] = []
      if (!at(r - 1, c)) edges.push([c, r, c + 1, r])
      if (!at(r + 1, c)) edges.push([c, r + 1, c + 1, r + 1])
      if (!at(r, c - 1)) edges.push([c, r, c, r + 1])
      if (!at(r, c + 1)) edges.push([c + 1, r, c + 1, r + 1])
      for (const [x0, y0, x1, y1] of edges) {
        const a = toScreen(x0 * n, y0 * n), b = toScreen(x1 * n, y1 * n)
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
      }
    }
  }
  ctx.stroke()
  ctx.restore()
}

/** Faint lines between the cells, when they are big enough on screen to tell apart. */
export function drawCells(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, g: NavGrid) {
  const n = g.nodeSizeMeters
  if (n * k < 7) return
  const rows = g.grid.length, cols = g.grid[0]?.length ?? 0
  ctx.save()
  ctx.strokeStyle = "rgba(91,33,182,0.12)"
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let c = 0; c <= cols; c++) {
    const a = toScreen(c * n, 0), b = toScreen(c * n, rows * n)
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1])
  }
  for (let r = 0; r <= rows; r++) {
    const a = toScreen(0, r * n), b = toScreen(cols * n, r * n)
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1])
  }
  ctx.stroke()
  ctx.restore()
}
