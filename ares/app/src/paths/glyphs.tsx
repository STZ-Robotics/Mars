// One visual language for waypoints and constraints, drawn the same on the
// field (canvas) and in the lists (SVG), so what a row shows is what the
// field shows:
//
// - Pose: a square with a filled heading triangle (the robot, facing).
// - Translation: a filled circle (a position, any heading).
// - Empty: a dashed ring (only shapes the guess).
// - Stop: a red octagon.
//
// Colors are positional: green is the start, red the end, purple
// the rest, yellow the selection.

import type { WaypointKind } from "./types"

export const GLYPH = {
  start: "#1f7a1f",
  end: "#c21c1c",
  mid: "#3b82f6",
  selected: "#d4a514",
  stop: "#c21c1c",
  ink: "#1c1c1f",
  pathfind: "#16a34a",
  linked: "#0e7490",
}

export function positionColor(i: number, n: number, selected: boolean): string {
  if (selected) return GLYPH.selected
  if (i === 0) return GLYPH.start
  if (i === n - 1) return GLYPH.end
  return GLYPH.mid
}

export function WaypointIcon({ kind, color, size = 16 }: { kind: WaypointKind; color: string; size?: number }) {
  const c = size / 2
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block", flexShrink: 0 }} aria-hidden>
      {kind === "pose" && (
        <>
          <rect x={1.5} y={1.5} width={size - 3} height={size - 3} rx={1.5} fill="none" stroke={color} strokeWidth={1.6} />
          <polygon points={`${size - 3.5},${c} ${c - 1},${c - size * 0.26} ${c - 1},${c + size * 0.26}`} fill={color} />
        </>
      )}
      {kind === "translation" && <circle cx={c} cy={c} r={c - 2} fill={color} />}
      {kind === "empty" && <circle cx={c} cy={c} r={c - 2} fill="none" stroke={color} strokeWidth={1.6} strokeDasharray="2.6 2" />}
      {kind === "unknown" && (
        <>
          <circle cx={c} cy={c} r={c - 1.5} fill="none" stroke={GLYPH.pathfind} strokeWidth={1.6} strokeDasharray="2.6 2" />
          <text x={c} y={c + size * 0.2} textAnchor="middle" fontSize={size * 0.62} fontWeight={800} fill={GLYPH.pathfind}>?</text>
        </>
      )}
      {kind === "continue" && (
        <>
          <circle cx={c} cy={c} r={c - 1.5} fill="none" stroke={GLYPH.linked} strokeWidth={1.6} />
          <text x={c} y={c + size * 0.2} textAnchor="middle" fontSize={size * 0.6} fontWeight={800} fill={GLYPH.linked}>↪</text>
        </>
      )}
    </svg>
  )
}

export function StopIcon({ size = 14, on = true }: { size?: number; on?: boolean }) {
  const pts = octagon(size / 2, size / 2, size / 2 - 1).map(p => p.join(",")).join(" ")
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block", flexShrink: 0 }} aria-hidden>
      <polygon points={pts} fill={on ? GLYPH.stop : "none"} stroke={on ? "#ffffff" : "var(--text-light)"} strokeWidth={on ? 1 : 1.3} strokeDasharray={on ? undefined : "2 1.6"} />
      {on && <rect x={size * 0.3} y={size * 0.45} width={size * 0.4} height={size * 0.1} fill="#ffffff" />}
    </svg>
  )
}

/**
 * An AprilTag: a black square on a white border with a few data bits, as a 36h11 tag reads at a
 * glance. Marks the See AprilTags constraint in the lists and on its stretch of path.
 */
const TAG_BITS = [
  [1, 0, 1, 1],
  [0, 1, 0, 0],
  [1, 1, 0, 1],
  [0, 0, 1, 1],
]

export function AprilTagIcon({ size = 14, inverted = false }: { size?: number; inverted?: boolean }) {
  const cell = size / 8
  const ink = inverted ? "#ffffff" : "#111114"
  const paper = inverted ? "#111114" : "#ffffff"
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block", flexShrink: 0 }} aria-hidden>
      <rect x={0} y={0} width={size} height={size} fill={paper} stroke={ink} strokeWidth={0.8} />
      <rect x={cell} y={cell} width={size - 2 * cell} height={size - 2 * cell} fill={ink} />
      {TAG_BITS.flatMap((row, r) => row.map((b, c) => (b ? <rect key={`${r}-${c}`} x={(c + 2) * cell} y={(r + 2) * cell} width={cell} height={cell} fill={paper} /> : null)))}
    </svg>
  )
}

/** The same AprilTag, on the canvas, centered at (x, y). */
export function drawAprilTag(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const cell = size / 8
  const x0 = x - size / 2, y0 = y - size / 2
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(x0, y0, size, size)
  ctx.strokeStyle = "#111114"
  ctx.lineWidth = 1
  ctx.strokeRect(x0, y0, size, size)
  ctx.fillStyle = "#111114"
  ctx.fillRect(x0 + cell, y0 + cell, size - 2 * cell, size - 2 * cell)
  ctx.fillStyle = "#ffffff"
  TAG_BITS.forEach((row, r) => row.forEach((b, c) => { if (b) ctx.fillRect(x0 + (c + 2) * cell, y0 + (r + 2) * cell, cell, cell) }))
}

function octagon(cx: number, cy: number, r: number): [number, number][] {
  return Array.from({ length: 8 }, (_, i) => {
    const a = Math.PI / 8 + (i * Math.PI) / 4
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  })
}

// --- Canvas ----------------------------------------------------------------------

export function drawStop(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath()
  octagon(x, y, r).forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)))
  ctx.closePath()
  ctx.fillStyle = GLYPH.stop
  ctx.fill()
  ctx.strokeStyle = "#ffffff"
  ctx.lineWidth = 1.2
  ctx.stroke()
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(x - r * 0.42, y - r * 0.12, r * 0.84, r * 0.24)
}

type ChipSink = (x: number, y: number, text: string, color: string, filled: boolean) => void
let chipSink: ChipSink | null = null

/** While set, chips go here instead of onto the canvas: the 3D view floats them over the field. */
export function sinkChips(sink: ChipSink | null) {
  chipSink = sink
}

/** A small rounded label chip, for constraint summaries on the field. */
export function drawChip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, filled = false) {
  if (chipSink) { chipSink(x, y, text, color, filled); return }
  ctx.font = "600 9.5px 'Segoe UI', Arial, sans-serif"
  const w = ctx.measureText(text).width + 10
  const h = 15
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 3)
  ctx.fillStyle = filled ? color : "rgba(255,255,255,0.94)"
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.2
  ctx.stroke()
  ctx.fillStyle = filled ? "#ffffff" : color
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(text, x, y + 0.5)
}

/** The heading triangle inside a pose waypoint's square. */
export function drawHeadingTriangle(ctx: CanvasRenderingContext2D, cx: number, cy: number, angle: number, r: number, color: string) {
  // Screen angle: canvas Y grows down.
  const a = -angle
  const tip = [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
  const back = r * 0.55
  const side = r * 0.6
  const bx = cx - Math.cos(a) * back * 0.2, by = cy - Math.sin(a) * back * 0.2
  const l = [bx + Math.cos(a + Math.PI / 2) * side, by + Math.sin(a + Math.PI / 2) * side]
  const rr = [bx + Math.cos(a - Math.PI / 2) * side, by + Math.sin(a - Math.PI / 2) * side]
  ctx.beginPath()
  ctx.moveTo(tip[0], tip[1])
  ctx.lineTo(l[0], l[1])
  ctx.lineTo(rr[0], rr[1])
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}
