import { useEffect, useRef, useState } from "react"
import type { FieldConfig } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import {
  KeepOut, PathSpec, Sample, ScopedConstraint, Selection, Tool, Trajectory, ViewOptions, kindOf, rangeOf, sampleAt,
} from "./types"

interface Props {
  field: FieldConfig
  robot: RobotConfig
  spec: PathSpec | null
  /** Stage 1 on the current waypoints: the guess, live while editing. */
  guess: Trajectory | null
  /** The last generated trajectory. */
  generated: Trajectory | null
  /** The path changed since it was generated: drawn faded. */
  stale: boolean
  keepOut: KeepOut[]
  selected: Selection
  tool: Tool
  view: ViewOptions
  /** The speed that colors as "fastest" (the usable speed). */
  topSpeed: number
  playhead: number | null
  fitSignal: number
  onSelect: (s: Selection) => void
  onMoveWaypoint: (i: number, x: number, y: number, final: boolean) => void
  onRotateWaypoint: (i: number, headingDeg: number, final: boolean) => void
  /** A click on empty field with a placing tool. */
  onFieldClick: (x: number, y: number) => void
  /** A click on a waypoint with the constraint or event tool. */
  onWaypointClick: (i: number) => void
  onMoveKeepOut: (i: number, x: number, y: number, final: boolean) => void
  onResizeKeepOut: (i: number, r: number, final: boolean) => void
  onEditConstraint: (i: number, patch: Partial<ScopedConstraint>, final: boolean) => void
}

interface View { k: number; ox: number; oy: number }

type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "waypoint"; index: number; dx: number; dy: number }
  | { kind: "heading"; index: number }
  | { kind: "keepout"; index: number; dx: number; dy: number }
  | { kind: "radius"; index: number }
  | { kind: "shape"; index: number; handle: "move" | "radius" | "corner"; dx: number; dy: number }
  | { kind: "event"; index: number }

const HANDLE_R = 8
const HEADING_HANDLE_R = 5.5
export const COLORS = {
  start: "#1f7a1f",
  end: "#a83c3c",
  mid: "#2f6fdb",
  selected: "#d4a514",
  ink: "#1c1c1f",
  guess: "rgba(28, 28, 31, 0.55)",
  keepout: "rgba(194, 28, 28, 0.16)",
  keepoutEdge: "#c21c1c",
  keepin: "#1f7a1f",
  constraint: "#7c3aed",
  event: "#a1690a",
}

// Cool to warm: the ramp every scalar gradient uses, and the legend shows.
const RAMP: [number, [number, number, number]][] = [
  [0, [47, 111, 219]],
  [0.5, [28, 143, 120]],
  [0.8, [214, 160, 20]],
  [1, [194, 28, 28]],
]

export function rampColor(f: number): string {
  const x = Math.min(1, Math.max(0, f))
  for (let i = 1; i < RAMP.length; i++) {
    const [b, cb] = RAMP[i]
    const [a, ca] = RAMP[i - 1]
    if (x <= b) {
      const t = (x - a) / (b - a)
      const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * t))
      return `rgb(${c[0]},${c[1]},${c[2]})`
    }
  }
  return "rgb(194,28,28)"
}

export const RAMP_CSS = `linear-gradient(90deg, ${RAMP.map(([f]) => `${rampColor(f)} ${f * 100}%`).join(", ")})`

const SPLIT_COLORS = ["#2f6fdb", "#c2410c", "#1f7a1f", "#7c3aed", "#0e7490", "#a1690a"]

// The field from above, in WPILib's frame (origin at the blue corner, X along
// the field, Y up the screen). It draws the photo, the keep-outs and the
// constraint shapes, the guess and the generated trajectory, the waypoints,
// the events and the playback robot, and turns mouse gestures into edits it
// hands back to the page.
export default function FieldView(props: Props) {
  const { field, robot, spec, guess, generated, stale, keepOut, selected, tool, view: opts, topSpeed, playhead, fitSignal } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ k: 50, ox: 0, oy: 0 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [hoverWp, setHoverWp] = useState<number | null>(null)
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

  const ready = size.w > 0 && size.h > 0
  useEffect(() => {
    if (!ready) return
    const margin = 40
    const k = Math.min((size.w - 2 * margin) / L, (size.h - 2 * margin) / W)
    setView({ k, ox: (size.w - L * k) / 2, oy: (size.h + W * k) / 2 })
  }, [fitSignal, ready, L, W])

  const toScreen = (x: number, y: number, v = view): [number, number] => [v.ox + x * v.k, v.oy - y * v.k]
  const toWorld = (sx: number, sy: number, v = view): [number, number] => [(sx - v.ox) / v.k, (v.oy - sy) / v.k]

  // Where a waypoint's heading is drawn: its own for a pose, else what the
  // trajectory does there.
  const reference = generated ?? guess
  const headingOf = (i: number): number => {
    const w = spec!.waypoints[i]
    if (kindOf(w) === "pose" && w.headingDeg !== undefined) return w.headingDeg * Math.PI / 180
    return headingNear(reference, w.x, w.y)
  }

  // --- Drawing ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !ready) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = "#e4e4e7"
    ctx.fillRect(0, 0, size.w, size.h)

    if (image && opts.field) {
      // The photo, placed by its calibration: field (0, 0) is the playing
      // area's bottom-left corner in pixels.
      const kImg = (field.bottomRight[0] - field.topLeft[0]) / L
      const [ix, iy] = toScreen(-field.topLeft[0] / kImg, field.bottomRight[1] / kImg)
      ctx.globalAlpha = 0.9
      ctx.drawImage(image, ix, iy, image.width * view.k / kImg, image.height * view.k / kImg)
      ctx.globalAlpha = 1
    }
    if (opts.grid) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)"
      ctx.lineWidth = 1
      for (let x = 0; x <= L; x += 1) line(ctx, toScreen(x, 0), toScreen(x, W))
      for (let y = 0; y <= W; y += 1) line(ctx, toScreen(0, y), toScreen(L, y))
    }
    {
      const [x0, y0] = toScreen(0, W)
      ctx.strokeStyle = "rgba(28,28,31,0.6)"
      ctx.lineWidth = 1
      ctx.strokeRect(x0, y0, L * view.k, W * view.k)
    }

    // Keep-outs shared by every path.
    const reach = Math.hypot(robot.bumper.lengthM, robot.bumper.widthM) / 2
    keepOut.forEach((c, i) => {
      const sel = selected?.kind === "keepout" && selected.index === i
      circle(ctx, toScreen, c.x, c.y, c.radiusM, view.k, COLORS.keepout, COLORS.keepoutEdge, sel ? 2 : 1.2)
      ctx.setLineDash([4, 4])
      circle(ctx, toScreen, c.x, c.y, c.radiusM + reach * 0.5, view.k, null, "rgba(194,28,28,0.35)", 1)
      ctx.setLineDash([])
      if (sel) handle(ctx, ...toScreen(c.x + c.radiusM, c.y), 4.5, "#ffffff", COLORS.keepoutEdge)
    })

    // Constraint shapes: faint for all, strong (with handles) for the selected.
    if (spec) {
      spec.scoped.forEach((c, i) => {
        const sel = selected?.kind === "constraint" && selected.index === i
        drawShape(ctx, toScreen, view.k, c, sel, c.enabled === false)
      })
    }

    // The guess, thin and dashed.
    if (guess && opts.guess) {
      ctx.setLineDash([6, 5])
      polyline(ctx, guess.samples.map(s => toScreen(s.x, s.y)), COLORS.guess, 1.3)
      ctx.setLineDash([])
    }

    // The generated trajectory, by the chosen gradient, and its mirror.
    if (generated && opts.trajectory) {
      ctx.globalAlpha = stale ? 0.35 : 1
      drawTrajectory(ctx, toScreen, generated, opts.gradient, topSpeed, 4)
      if (opts.flipped) {
        ctx.globalAlpha = stale ? 0.2 : 0.45
        const flip = (x: number, y: number) => toScreen(L - x, W - y)
        drawTrajectory(ctx, flip, generated, opts.gradient, topSpeed, 3)
      }
      ctx.globalAlpha = 1
      if (opts.samples) {
        for (const s of generated.samples) {
          const [x, y] = toScreen(s.x, s.y)
          ctx.beginPath()
          ctx.arc(x, y, 2.2, 0, Math.PI * 2)
          ctx.fillStyle = COLORS.ink
          ctx.fill()
        }
      }
    }

    // The selected constraint's scope, over the path.
    if (spec && selected?.kind === "constraint" && reference) {
      const c = spec.scoped[selected.index]
      if (c) {
        const [a, b] = rangeOf(c, spec.waypoints.length)
        const times = reference.waypointTimes
        if (times && times.length === spec.waypoints.length) {
          const pts = reference.samples.filter(s => s.t >= times[a] - 1e-9 && s.t <= times[b] + 1e-9).map(s => toScreen(s.x, s.y))
          ctx.globalAlpha = 0.35
          polyline(ctx, pts, COLORS.constraint, 12)
          ctx.globalAlpha = 1
        }
      }
    }

    // While placing a constraint: the range picked so far.
    if (spec && tool.kind === "constraint" && tool.from !== null) {
      const to = hoverWp ?? tool.from
      const [a, b] = [Math.min(tool.from, to), Math.max(tool.from, to)]
      ctx.setLineDash([3, 3])
      polyline(ctx, spec.waypoints.slice(a, b + 1).map(w => toScreen(w.x, w.y)), COLORS.constraint, 3)
      ctx.setLineDash([])
    }

    // Waypoints.
    if (spec && opts.waypoints) {
      const n = spec.waypoints.length
      spec.waypoints.forEach((w, i) => {
        const kind = kindOf(w)
        const isSel = selected?.kind === "waypoint" && selected.index === i
        const base = i === 0 ? COLORS.start : i === n - 1 ? COLORS.end : COLORS.mid
        const color = isSel ? COLORS.selected : base
        const [cx, cy] = toScreen(w.x, w.y)
        if (kind === "empty") {
          ctx.setLineDash([3, 3])
          handle(ctx, cx, cy, HANDLE_R - 1, "rgba(255,255,255,0.85)", color)
          ctx.setLineDash([])
        } else {
          const heading = headingOf(i)
          bumper(ctx, toScreen, w.x, w.y, heading, robot, color, kind === "pose" ? [] : [5, 4], isSel ? 2.2 : 1.4, isSel ? 0.14 : 0.06)
          if (kind === "pose") {
            const [hx, hy] = toScreen(w.x + Math.cos(heading) * robot.bumper.lengthM / 2, w.y + Math.sin(heading) * robot.bumper.lengthM / 2)
            handle(ctx, hx, hy, HEADING_HANDLE_R, color, "#ffffff")
          }
          handle(ctx, cx, cy, HANDLE_R, color, "#ffffff")
        }
        if (hoverWp === i && tool.kind !== "select" && tool.kind !== "waypoint") {
          ctx.beginPath()
          ctx.arc(cx, cy, HANDLE_R + 5, 0, Math.PI * 2)
          ctx.strokeStyle = COLORS.constraint
          ctx.lineWidth = 2
          ctx.stroke()
        }
        ctx.fillStyle = kind === "empty" ? color : "#ffffff"
        ctx.font = "600 9.5px 'Segoe UI', Arial, sans-serif"
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText(String(i + 1), cx, cy + 0.5)
        if (w.split && i > 0 && i < n - 1) {
          ctx.font = "600 9px 'Segoe UI', Arial, sans-serif"
          ctx.fillStyle = COLORS.ink
          ctx.fillText("✂", cx + 12, cy - 12)
        }
      })
    }

    // Events: a pin where they fire.
    if (spec) {
      (spec.events ?? []).forEach((e, i) => {
        const p = eventPoint(spec, generated, e, i)
        if (!p) return
        const [x, y] = toScreen(p.x, p.y)
        const sel = selected?.kind === "event" && selected.index === i
        pin(ctx, x, y, sel ? COLORS.selected : COLORS.event, e.name)
      })
    }

    // The playback robot, with each wheel's velocity.
    const traj = generated ?? guess
    if (traj && playhead !== null) {
      const s = sampleAt(traj, playhead)
      bumper(ctx, toScreen, s.x, s.y, s.heading, robot, COLORS.ink, [], 2, 0.22)
      moduleVectors(ctx, toScreen, s, robot)
    }
  }, [view, size, image, spec, guess, generated, stale, keepOut, selected, playhead, robot, field, opts, topSpeed, tool, hoverWp])

  // --- Interaction -----------------------------------------------------------
  const waypointAt = (sx: number, sy: number): number | null => {
    const p = propsRef.current
    if (!p.spec) return null
    for (let i = p.spec.waypoints.length - 1; i >= 0; i--) {
      const [cx, cy] = toScreen(p.spec.waypoints[i].x, p.spec.waypoints[i].y)
      if (Math.hypot(sx - cx, sy - cy) <= HANDLE_R + 3) return i
    }
    return null
  }

  const hit = (sx: number, sy: number): Drag | null => {
    const p = propsRef.current
    const [wx, wy] = toWorld(sx, sy)
    const near = (x: number, y: number, r = 8) => { const [hx, hy] = toScreen(x, y); return Math.hypot(sx - hx, sy - hy) <= r }
    // The selected constraint's handles first: they sit on top.
    if (p.spec && p.selected?.kind === "constraint") {
      const i = p.selected.index
      const c = p.spec.scoped[i]
      if (c && "x" in c) {
        if (c.type === "keepInCircle" || c.type === "keepOutCircle") {
          if (near(c.x + c.radiusM, c.y)) return { kind: "shape", index: i, handle: "radius", dx: 0, dy: 0 }
        }
        if (c.type === "keepInRectangle" && near(c.x + c.widthM, c.y + c.heightM)) {
          return { kind: "shape", index: i, handle: "corner", dx: 0, dy: 0 }
        }
        if (near(c.x, c.y, 10)) return { kind: "shape", index: i, handle: "move", dx: c.x - wx, dy: c.y - wy }
      }
    }
    if (p.spec && p.view.waypoints) {
      for (let i = p.spec.waypoints.length - 1; i >= 0; i--) {
        const w = p.spec.waypoints[i]
        if (kindOf(w) !== "pose") continue
        const h = headingOf(i)
        if (near(w.x + Math.cos(h) * robot.bumper.lengthM / 2, w.y + Math.sin(h) * robot.bumper.lengthM / 2, HEADING_HANDLE_R + 3)) {
          return { kind: "heading", index: i }
        }
      }
      const i = waypointAt(sx, sy)
      if (i !== null) {
        const w = p.spec.waypoints[i]
        return { kind: "waypoint", index: i, dx: w.x - wx, dy: w.y - wy }
      }
    }
    if (p.spec) {
      const events = p.spec.events ?? []
      for (let i = events.length - 1; i >= 0; i--) {
        const pt = eventPoint(p.spec, p.generated, events[i], i)
        if (pt && near(pt.x, pt.y, 12)) {
          const [ex, ey] = toScreen(pt.x, pt.y)
          if (sy <= ey + 4 && Math.abs(sx - ex) <= 9) return { kind: "event", index: i }
        }
      }
    }
    for (let i = p.keepOut.length - 1; i >= 0; i--) {
      const c = p.keepOut[i]
      if (p.selected?.kind === "keepout" && p.selected.index === i && near(c.x + c.radiusM, c.y)) return { kind: "radius", index: i }
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
    if (e.button !== 0) {
      drag.current = { kind: "pan", sx, sy, view }
      return
    }
    // Constraint and event tools only care about waypoints.
    if (p.tool.kind === "constraint" || p.tool.kind === "event") {
      const i = waypointAt(sx, sy)
      if (i !== null) p.onWaypointClick(i)
      else drag.current = { kind: "pan", sx, sy, view }
      return
    }
    const h = hit(sx, sy)
    if (h) {
      drag.current = h
      if (h.kind === "waypoint" || h.kind === "heading") p.onSelect({ kind: "waypoint", index: h.index })
      else if (h.kind === "keepout" || h.kind === "radius") p.onSelect({ kind: "keepout", index: h.index })
      else if (h.kind === "event") p.onSelect({ kind: "event", index: h.index })
      return
    }
    const [wx, wy] = toWorld(sx, sy)
    if (p.tool.kind === "waypoint" || p.tool.kind === "keepout") { p.onFieldClick(wx, wy); return }
    p.onSelect(null)
    drag.current = { kind: "pan", sx, sy, view }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const [sx, sy] = local(e)
    const [wx, wy] = toWorld(sx, sy)
    setCursor({ x: wx, y: wy })
    const p = propsRef.current
    if (p.tool.kind === "constraint" || p.tool.kind === "event") setHoverWp(waypointAt(sx, sy))
    else if (hoverWp !== null) setHoverWp(null)
    const d = drag.current
    if (d) applyDrag(d, sx, sy, wx, wy, false)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const [sx, sy] = local(e)
    const [wx, wy] = toWorld(sx, sy)
    applyDrag(d, sx, sy, wx, wy, true)
  }

  const shiftDown = useRef(false)
  useEffect(() => {
    const on = (e: KeyboardEvent) => { shiftDown.current = e.shiftKey }
    window.addEventListener("keydown", on)
    window.addEventListener("keyup", on)
    return () => { window.removeEventListener("keydown", on); window.removeEventListener("keyup", on) }
  }, [])

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
      case "shape": {
        const c = p.spec!.scoped[d.index]
        if (!("x" in c)) break
        if (d.handle === "move") p.onEditConstraint(d.index, { x: snap(wx + d.dx), y: snap(wy + d.dy) } as Partial<ScopedConstraint>, final)
        else if (d.handle === "radius") p.onEditConstraint(d.index, { radiusM: Math.max(0.05, snap(Math.hypot(wx - c.x, wy - c.y))) } as Partial<ScopedConstraint>, final)
        else p.onEditConstraint(d.index, { widthM: Math.max(0.1, snap(wx - c.x)), heightM: Math.max(0.1, snap(wy - c.y)) } as Partial<ScopedConstraint>, final)
        break
      }
      case "event":
        break
    }
  }

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

  const cursorStyle = tool.kind === "select" ? "default" : tool.kind === "constraint" || tool.kind === "event" ? (hoverWp !== null ? "pointer" : "default") : "crosshair"

  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block", cursor: cursorStyle, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setCursor(null); setHoverWp(null) }}
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

function line(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number]) {
  ctx.beginPath()
  ctx.moveTo(...a)
  ctx.lineTo(...b)
  ctx.stroke()
}

function polyline(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string, width: number) {
  if (pts.length < 2) return
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.stroke()
  ctx.lineCap = "butt"
}

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = stroke
  ctx.stroke()
}

function circle(ctx: CanvasRenderingContext2D, toScreen: ToScreen, x: number, y: number, r: number, k: number, fill: string | null, stroke: string, width: number) {
  const [cx, cy] = toScreen(x, y)
  ctx.beginPath()
  ctx.arc(cx, cy, r * k, 0, Math.PI * 2)
  if (fill) { ctx.fillStyle = fill; ctx.fill() }
  ctx.strokeStyle = stroke
  ctx.lineWidth = width
  ctx.stroke()
}

function drawShape(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, c: ScopedConstraint, sel: boolean, disabled: boolean) {
  const alpha = disabled ? 0.25 : sel ? 1 : 0.45
  ctx.globalAlpha = alpha
  switch (c.type) {
    case "keepInCircle":
      ctx.setLineDash([6, 4])
      circle(ctx, toScreen, c.x, c.y, c.radiusM, k, "rgba(31,122,31,0.06)", COLORS.keepin, sel ? 2 : 1.3)
      ctx.setLineDash([])
      if (sel) { handle(ctx, ...toScreen(c.x, c.y), 5, "#ffffff", COLORS.keepin); handle(ctx, ...toScreen(c.x + c.radiusM, c.y), 4.5, "#ffffff", COLORS.keepin) }
      break
    case "keepOutCircle":
      circle(ctx, toScreen, c.x, c.y, c.radiusM, k, COLORS.keepout, COLORS.constraint, sel ? 2 : 1.3)
      if (sel) { handle(ctx, ...toScreen(c.x, c.y), 5, "#ffffff", COLORS.constraint); handle(ctx, ...toScreen(c.x + c.radiusM, c.y), 4.5, "#ffffff", COLORS.constraint) }
      break
    case "keepInRectangle": {
      const [x0, y0] = toScreen(c.x, c.y + c.heightM)
      ctx.setLineDash([6, 4])
      ctx.fillStyle = "rgba(31,122,31,0.06)"
      ctx.fillRect(x0, y0, c.widthM * k, c.heightM * k)
      ctx.strokeStyle = COLORS.keepin
      ctx.lineWidth = sel ? 2 : 1.3
      ctx.strokeRect(x0, y0, c.widthM * k, c.heightM * k)
      ctx.setLineDash([])
      if (sel) { handle(ctx, ...toScreen(c.x, c.y), 5, "#ffffff", COLORS.keepin); handle(ctx, ...toScreen(c.x + c.widthM, c.y + c.heightM), 4.5, "#ffffff", COLORS.keepin) }
      break
    }
    case "pointAt": {
      const [x, y] = toScreen(c.x, c.y)
      ctx.strokeStyle = COLORS.constraint
      ctx.lineWidth = sel ? 2 : 1.3
      ctx.beginPath()
      ctx.arc(x, y, 9, 0, Math.PI * 2)
      ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y)
      ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14)
      ctx.stroke()
      if (sel) handle(ctx, x, y, 4, "#ffffff", COLORS.constraint)
      break
    }
    default:
      break
  }
  ctx.globalAlpha = 1
}

function drawTrajectory(ctx: CanvasRenderingContext2D, toScreen: ToScreen, t: Trajectory, gradient: ViewOptions["gradient"], topSpeed: number, width: number) {
  const s = t.samples
  if (s.length < 2) return
  const accMax = Math.max(1e-6, ...s.map(q => Math.hypot(q.ax, q.ay)))
  const wMax = Math.max(1e-6, ...s.map(q => Math.abs(q.omega)))
  const dts = s.slice(1).map((q, i) => q.t - s[i].t)
  const [dtMin, dtMax] = [Math.min(...dts), Math.max(...dts)]
  const splits = t.splits ?? []
  const colorAt = (i: number): string => {
    const q = s[i]
    switch (gradient) {
      case "none": return "#2f6fdb"
      case "velocity": return rampColor(Math.hypot(q.vx, q.vy) / topSpeed)
      case "progress": return rampColor(q.t / Math.max(t.durationS, 1e-6))
      case "acceleration": return rampColor(Math.hypot(q.ax, q.ay) / accMax)
      case "interval": return rampColor(dtMax - dtMin < 1e-9 ? 0.5 : 1 - (dts[Math.min(i, dts.length - 1)] - dtMin) / (dtMax - dtMin))
      case "angular": return rampColor(Math.abs(q.omega) / wMax)
      case "splits": return SPLIT_COLORS[splits.filter(k => k <= i).length % SPLIT_COLORS.length]
    }
  }
  ctx.lineWidth = width
  ctx.lineCap = "round"
  for (let i = 1; i < s.length; i++) {
    const [x0, y0] = toScreen(s[i - 1].x, s[i - 1].y)
    const [x1, y1] = toScreen(s[i].x, s[i].y)
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.strokeStyle = colorAt(i)
    ctx.stroke()
  }
  ctx.lineCap = "butt"
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

function pin(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string) {
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - 6, y - 12)
  ctx.arc(x, y - 15, 6.5, Math.PI * 0.8, Math.PI * 0.2)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = "#ffffff"
  ctx.lineWidth = 1.2
  ctx.stroke()
  ctx.font = "600 10px 'Segoe UI', Arial, sans-serif"
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  const w = ctx.measureText(label).width
  ctx.fillStyle = "rgba(255,255,255,0.92)"
  ctx.fillRect(x + 9, y - 22, w + 8, 14)
  ctx.fillStyle = COLORS.ink
  ctx.fillText(label, x + 13, y - 15)
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

/** Where an event fires: on the generated trajectory when there is one,
 *  otherwise at its waypoint. */
function eventPoint(spec: PathSpec, generated: Trajectory | null, e: NonNullable<PathSpec["events"]>[number], i: number): { x: number; y: number } | null {
  const fired = generated?.events?.[i]
  if (generated && fired && fired.name === e.name) {
    const s = sampleAt(generated, fired.t)
    return { x: s.x, y: s.y }
  }
  const n = spec.waypoints.length
  const idx = e.target === "first" ? 0 : e.target === "last" ? n - 1 : Math.min(e.target.index, n - 1)
  const w = spec.waypoints[idx]
  return w ? { x: w.x, y: w.y } : null
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
