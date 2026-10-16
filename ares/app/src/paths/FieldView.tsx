import { useEffect, useRef, useState } from "react"
import type { FieldConfig } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import { KeepOut, PathSpec, Sample, Selection, Tool, Trajectory, sampleAt } from "./types"

interface Props {
  field: FieldConfig
  robot: RobotConfig
  spec: PathSpec | null
  /** Stage 1: the spline, timed. Drawn thin and dashed. */
  spline: Trajectory | null
  /** Stage 2: the optimized trajectory, colored by speed. */
  planned: Trajectory | null
  keepOut: KeepOut[]
  selected: Selection
  tool: Tool
  /** Where the playback robot is, in seconds; null hides it. */
  playhead: number | null
  /** Changes when the view should refit the field. */
  fitSignal: number
  onSelect: (s: Selection) => void
  onMoveWaypoint: (i: number, x: number, y: number, final: boolean) => void
  onRotateWaypoint: (i: number, headingDeg: number, final: boolean) => void
  onAddWaypoint: (x: number, y: number) => void
  onAddKeepOut: (x: number, y: number) => void
  onMoveKeepOut: (i: number, x: number, y: number, final: boolean) => void
  onResizeKeepOut: (i: number, r: number, final: boolean) => void
}

interface View { k: number; ox: number; oy: number }

type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "waypoint"; index: number; dx: number; dy: number }
  | { kind: "heading"; index: number }
  | { kind: "keepout"; index: number; dx: number; dy: number }
  | { kind: "radius"; index: number }

const HANDLE_R = 8
const HEADING_HANDLE_R = 5.5
const COLORS = {
  start: "#1f7a1f",
  end: "#a83c3c",
  mid: "#2f6fdb",
  ink: "#1c1c1f",
  spline: "rgba(28, 28, 31, 0.55)",
  keepout: "rgba(194, 28, 28, 0.16)",
  keepoutEdge: "#c21c1c",
  select: "#2f6fdb",
}

// Speed along the trajectory, slow to fast: the same ramp the legend shows.
const SPEED_RAMP: [number, [number, number, number]][] = [
  [0, [47, 111, 219]],
  [0.5, [28, 143, 120]],
  [0.8, [214, 160, 20]],
  [1, [194, 28, 28]],
]

export function speedColor(f: number): string {
  const x = Math.min(1, Math.max(0, f))
  for (let i = 1; i < SPEED_RAMP.length; i++) {
    const [b, cb] = SPEED_RAMP[i]
    const [a, ca] = SPEED_RAMP[i - 1]
    if (x <= b) {
      const t = (x - a) / (b - a)
      const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * t))
      return `rgb(${c[0]},${c[1]},${c[2]})`
    }
  }
  return "rgb(194,28,28)"
}

export const SPEED_GRADIENT_CSS = `linear-gradient(90deg, ${SPEED_RAMP.map(([f]) => `${speedColor(f)} ${f * 100}%`).join(", ")})`

// The field from above, in WPILib's frame (origin at the blue corner, X along
// the field, Y up the screen). It draws the photo, the keep-outs, the spline
// and the optimized trajectory, the robot at each waypoint, and the playback
// robot; and it turns mouse gestures into edits it hands back to the page.
export default function FieldView(props: Props) {
  const { field, robot, spec, spline, planned, keepOut, selected, tool, playhead, fitSignal } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ k: 50, ox: 0, oy: 0 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<Drag | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const [L, W] = field.sizeMeters

  useEffect(() => {
    const img = new Image()
    img.onload = () => setImage(img)
    img.src = field.imageUrl
  }, [field.imageUrl])

  useEffect(() => {
    const el = hostRef.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit the field with a margin whenever asked, and on the first real size.
  const ready = size.w > 0 && size.h > 0
  useEffect(() => {
    if (!ready) return
    const margin = 40
    const k = Math.min((size.w - 2 * margin) / L, (size.h - 2 * margin) / W)
    setView({ k, ox: (size.w - L * k) / 2, oy: (size.h + W * k) / 2 })
  }, [fitSignal, ready, L, W])

  const toScreen = (x: number, y: number, v = view): [number, number] => [v.ox + x * v.k, v.oy - y * v.k]
  const toWorld = (sx: number, sy: number, v = view): [number, number] => [(sx - v.ox) / v.k, (v.oy - sy) / v.k]

  // --- Drawing ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    ctx.fillStyle = "#e4e4e7"
    ctx.fillRect(0, 0, size.w, size.h)

    // The photo, placed by its calibration: field (0, 0) is the playing area's
    // bottom-left corner in pixels.
    if (image) {
      const kImg = (field.bottomRight[0] - field.topLeft[0]) / L
      const [ix, iy] = toScreen(-field.topLeft[0] / kImg, field.bottomRight[1] / kImg)
      ctx.globalAlpha = 0.9
      ctx.drawImage(image, ix, iy, image.width * view.k / kImg, image.height * view.k / kImg)
      ctx.globalAlpha = 1
    }
    // The playing area's edge: the walls the bumper must stay inside.
    {
      const [x0, y0] = toScreen(0, W)
      ctx.strokeStyle = "rgba(28,28,31,0.6)"
      ctx.lineWidth = 1
      ctx.strokeRect(x0, y0, L * view.k, W * view.k)
    }

    // Keep-outs: the zone itself, and a faint ring where the bumper's center
    // can actually get to.
    const reach = Math.hypot(robot.bumper.lengthM, robot.bumper.widthM) / 2
    keepOut.forEach((c, i) => {
      const [cx, cy] = toScreen(c.x, c.y)
      ctx.beginPath()
      ctx.arc(cx, cy, c.radiusM * view.k, 0, Math.PI * 2)
      ctx.fillStyle = COLORS.keepout
      ctx.fill()
      ctx.strokeStyle = COLORS.keepoutEdge
      ctx.lineWidth = selected?.kind === "keepout" && selected.index === i ? 2 : 1.2
      ctx.stroke()
      ctx.beginPath()
      ctx.setLineDash([4, 4])
      ctx.arc(cx, cy, (c.radiusM + reach * 0.5) * view.k, 0, Math.PI * 2)
      ctx.strokeStyle = "rgba(194,28,28,0.35)"
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
      if (selected?.kind === "keepout" && selected.index === i) {
        const [hx, hy] = toScreen(c.x + c.radiusM, c.y)
        handle(ctx, hx, hy, 4.5, "#ffffff", COLORS.keepoutEdge)
      }
    })

    // Stage 1: the spline, thin and dashed, under everything else.
    if (spline) {
      ctx.beginPath()
      spline.samples.forEach((s, i) => {
        const [x, y] = toScreen(s.x, s.y)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.setLineDash([6, 5])
      ctx.strokeStyle = COLORS.spline
      ctx.lineWidth = 1.3
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Stage 2: the optimized trajectory, colored by speed against the free
    // speed, so "red" means "as fast as this robot goes".
    if (planned) {
      const vmax = maxWheelSpeed(robot)
      ctx.lineWidth = 4
      ctx.lineCap = "round"
      for (let i = 1; i < planned.samples.length; i++) {
        const a = planned.samples[i - 1], b = planned.samples[i]
        const [x0, y0] = toScreen(a.x, a.y)
        const [x1, y1] = toScreen(b.x, b.y)
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
        ctx.strokeStyle = speedColor(Math.hypot(b.vx, b.vy) / vmax)
        ctx.stroke()
      }
      ctx.lineCap = "butt"
    }

    // The robot at each waypoint: solid outline where the heading is fixed,
    // dashed where the planner chooses it (drawn at the heading it chose).
    if (spec) {
      const n = spec.waypoints.length
      const reference = planned ?? spline
      spec.waypoints.forEach((w, i) => {
        const fixed = w.headingDeg !== undefined
        const heading = fixed ? w.headingDeg! * Math.PI / 180 : headingNear(reference, w.x, w.y)
        const color = i === 0 ? COLORS.start : i === n - 1 ? COLORS.end : COLORS.mid
        const isSel = selected?.kind === "waypoint" && selected.index === i
        bumper(ctx, toScreen, w.x, w.y, heading, robot, color, fixed ? [] : [5, 4], isSel ? 2.2 : 1.4, isSel ? 0.14 : 0.06)
        // Heading handle on the front face.
        const [hx, hy] = toScreen(w.x + Math.cos(heading) * robot.bumper.lengthM / 2, w.y + Math.sin(heading) * robot.bumper.lengthM / 2)
        handle(ctx, hx, hy, HEADING_HANDLE_R, fixed ? color : "#ffffff", color)
        const [cx, cy] = toScreen(w.x, w.y)
        handle(ctx, cx, cy, HANDLE_R, isSel ? COLORS.select : color, "#ffffff")
        ctx.fillStyle = "#ffffff"
        ctx.font = "600 9.5px 'Segoe UI', Arial, sans-serif"
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText(String(i + 1), cx, cy + 0.5)
      })
    }

    // The playback robot: filled, with each wheel's velocity.
    const traj = planned ?? spline
    if (traj && playhead !== null) {
      const s = sampleAt(traj, playhead)
      bumper(ctx, toScreen, s.x, s.y, s.heading, robot, COLORS.ink, [], 2, 0.22)
      moduleVectors(ctx, toScreen, s, robot)
    }
  }, [view, size, image, spec, spline, planned, keepOut, selected, playhead, robot, field])

  // --- Interaction -----------------------------------------------------------
  const hit = (sx: number, sy: number): Drag | null => {
    const p = propsRef.current
    const [wx, wy] = toWorld(sx, sy)
    if (p.spec) {
      const reference = p.planned ?? p.spline
      for (let i = p.spec.waypoints.length - 1; i >= 0; i--) {
        const w = p.spec.waypoints[i]
        const heading = w.headingDeg !== undefined ? w.headingDeg * Math.PI / 180 : headingNear(reference, w.x, w.y)
        const [hx, hy] = toScreen(w.x + Math.cos(heading) * robot.bumper.lengthM / 2, w.y + Math.sin(heading) * robot.bumper.lengthM / 2)
        if (Math.hypot(sx - hx, sy - hy) <= HEADING_HANDLE_R + 3) return { kind: "heading", index: i }
      }
      for (let i = p.spec.waypoints.length - 1; i >= 0; i--) {
        const w = p.spec.waypoints[i]
        const [cx, cy] = toScreen(w.x, w.y)
        if (Math.hypot(sx - cx, sy - cy) <= HANDLE_R + 3) return { kind: "waypoint", index: i, dx: w.x - wx, dy: w.y - wy }
      }
    }
    for (let i = p.keepOut.length - 1; i >= 0; i--) {
      const c = p.keepOut[i]
      if (p.selected?.kind === "keepout" && p.selected.index === i) {
        const [hx, hy] = toScreen(c.x + c.radiusM, c.y)
        if (Math.hypot(sx - hx, sy - hy) <= 8) return { kind: "radius", index: i }
      }
      if (Math.hypot(wx - c.x, wy - c.y) <= c.radiusM) return { kind: "keepout", index: i, dx: c.x - wx, dy: c.y - wy }
    }
    return null
  }

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const [sx, sy] = local(e)
    const p = propsRef.current
    canvasRef.current!.setPointerCapture(e.pointerId)
    // Middle or right button: always pan.
    if (e.button !== 0) {
      drag.current = { kind: "pan", sx, sy, view }
      return
    }
    const h = hit(sx, sy)
    if (h) {
      const d = h
      drag.current = d
      if (d.kind === "waypoint" || d.kind === "heading") p.onSelect({ kind: "waypoint", index: d.index })
      if (d.kind === "keepout" || d.kind === "radius") p.onSelect({ kind: "keepout", index: d.index })
      return
    }
    const [wx, wy] = toWorld(sx, sy)
    if (p.tool === "waypoint") { p.onAddWaypoint(wx, wy); return }
    if (p.tool === "keepout") { p.onAddKeepOut(wx, wy); return }
    p.onSelect(null)
    drag.current = { kind: "pan", sx, sy, view }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const [sx, sy] = local(e)
    const [wx, wy] = toWorld(sx, sy)
    setCursor({ x: wx, y: wy })
    const d = drag.current
    if (!d) return
    applyDrag(d, sx, sy, wx, wy, false)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const [sx, sy] = local(e)
    const [wx, wy] = toWorld(sx, sy)
    applyDrag(d, sx, sy, wx, wy, true)
  }

  const applyDrag = (d: Drag, sx: number, sy: number, wx: number, wy: number, final: boolean) => {
    const p = propsRef.current
    const snap = (v: number) => Math.round(v * 1000) / 1000
    switch (d.kind) {
      case "pan":
        setView({ ...d.view, ox: d.view.ox + sx - d.sx, oy: d.view.oy + sy - d.sy })
        break
      case "waypoint":
        p.onMoveWaypoint(d.index, snap(wx + d.dx), snap(wy + d.dy), final)
        break
      case "heading": {
        const w = p.spec!.waypoints[d.index]
        let deg = Math.atan2(wy - w.y, wx - w.x) * 180 / Math.PI
        // Shift snaps to 15°, the angles a driver thinks in.
        if (shiftDown.current) deg = Math.round(deg / 15) * 15
        p.onRotateWaypoint(d.index, Math.round(deg * 10) / 10, final)
        break
      }
      case "keepout":
        p.onMoveKeepOut(d.index, snap(wx + d.dx), snap(wy + d.dy), final)
        break
      case "radius": {
        const c = p.keepOut[d.index]
        p.onResizeKeepOut(d.index, Math.max(0.05, snap(Math.hypot(wx - c.x, wy - c.y))), final)
        break
      }
    }
  }

  const shiftDown = useRef(false)
  useEffect(() => {
    const on = (e: KeyboardEvent) => { shiftDown.current = e.shiftKey }
    window.addEventListener("keydown", on)
    window.addEventListener("keyup", on)
    return () => { window.removeEventListener("keydown", on); window.removeEventListener("keyup", on) }
  }, [])

  // Zoom about the cursor. Attached by hand: React's wheel listener is
  // passive and cannot stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const [sx, sy] = local(e)
      setView(v => {
        const k = Math.min(600, Math.max(10, v.k * Math.exp(-e.deltaY * 0.0015)))
        const [wx, wy] = [(sx - v.ox) / v.k, (v.oy - sy) / v.k]
        return { k, ox: sx - wx * k, oy: sy + wy * k }
      })
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [])

  const cursorStyle = tool === "select" ? (drag.current?.kind === "pan" ? "grabbing" : "default") : "crosshair"

  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block", cursor: cursorStyle, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onContextMenu={e => e.preventDefault()}
      />
      {cursor && (
        <div style={{ position: "absolute", right: 10, top: 8, fontSize: 10.5, fontFamily: "Consolas, 'Cascadia Mono', monospace", color: "var(--text-secondary)", background: "rgba(255,255,255,0.85)", padding: "1px 6px", border: "1px solid var(--border-light)" }}>
          x {cursor.x.toFixed(2)} m · y {cursor.y.toFixed(2)} m
        </div>
      )}
    </div>
  )
}

type ToScreen = (x: number, y: number) => [number, number]

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = stroke
  ctx.stroke()
}

function bumper(
  ctx: CanvasRenderingContext2D, toScreen: ToScreen, x: number, y: number, heading: number,
  robot: RobotConfig, color: string, dash: number[], width: number, fillAlpha: number,
) {
  const hl = robot.bumper.lengthM / 2, hw = robot.bumper.widthM / 2
  const c = Math.cos(heading), s = Math.sin(heading)
  const corners = [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([bx, by]) => toScreen(x + c * bx - s * by, y + s * bx + c * by))
  ctx.beginPath()
  corners.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)))
  ctx.closePath()
  ctx.globalAlpha = fillAlpha
  ctx.fillStyle = color
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.setLineDash(dash)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
  ctx.setLineDash([])
  // The front face, thicker: which way the robot faces at a glance.
  ctx.beginPath()
  ctx.moveTo(...corners[0])
  ctx.lineTo(...corners[1])
  ctx.lineWidth = width + 2
  ctx.stroke()
}

function moduleVectors(ctx: CanvasRenderingContext2D, toScreen: ToScreen, s: Sample, robot: RobotConfig) {
  const c = Math.cos(s.heading), sn = Math.sin(s.heading)
  const scale = 0.12 // meters of arrow per m/s
  robot.drivetrain.modules.forEach(m => {
    const rx = c * m.xM - sn * m.yM, ry = sn * m.xM + c * m.yM
    const vx = s.vx - s.omega * ry, vy = s.vy + s.omega * rx
    const [x0, y0] = toScreen(s.x + rx, s.y + ry)
    const [x1, y1] = toScreen(s.x + rx + vx * scale, s.y + ry + vy * scale)
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.strokeStyle = "#2f6fdb"
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x0, y0, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = "#1c1c1f"
    ctx.fill()
  })
}

/** The trajectory's heading where it passes closest to (x, y). */
function headingNear(traj: Trajectory | null, x: number, y: number): number {
  if (!traj) return 0
  let best = traj.samples[0], d = Infinity
  for (const s of traj.samples) {
    const e = (s.x - x) ** 2 + (s.y - y) ** 2
    if (e < d) { d = e; best = s }
  }
  return best.heading
}

/** The fastest a wheel rolls, from the motor's free speed (Kraken-class
 *  numbers are close enough for coloring when the backend has not said). */
function maxWheelSpeed(robot: RobotConfig): number {
  const FREE_RPM: Record<string, number> = { kraken_x60: 6000, falcon500: 6380, neo: 5676, neo550: 11000, cim: 5330 }
  const d = robot.drivetrain
  return (FREE_RPM[d.driveMotor] ?? 6000) * Math.PI / 30 / d.driveGearRatio * d.wheelRadiusM
}
