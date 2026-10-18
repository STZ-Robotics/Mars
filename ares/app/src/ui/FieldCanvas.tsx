import { useEffect, useMemo, useRef, useState } from "react"
import { drawFieldBackground } from "../paths/FieldView"
import { fieldSketch } from "../paths/fieldSketch"
import { loadView } from "../paths/PathsPage"
import { useField } from "./field"

export interface XYH { x: number; y: number; heading: number }

/** What a FieldCanvas hands its drawing: the context in field meters, and pens. */
export interface Pen {
  ctx: CanvasRenderingContext2D
  toScreen: (x: number, y: number) => [number, number]
  /** Pixels per meter. */
  k: number
  line: (pts: { x: number; y: number }[], color: string, width: number, dash?: number[]) => void
  /** A line cut where the poses jump more than half a meter (an odometry reset, a vision fix). */
  trail: (pts: { x: number; y: number }[], color: string, width: number) => void
  bumper: (p: XYH, lengthM: number, widthM: number, stroke: string, fill: string | null, dash?: number[]) => void
}

/** The whole field, drawn as the Paths tab draws it, with `draw` on top. */
export default function FieldCanvas({ draw, deps }: { draw: (pen: Pen) => void; deps: unknown[] }) {
  const { field } = useField()
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [sketch, setSketch] = useState<HTMLCanvasElement | null>(null)
  const view = useMemo(() => loadView(), [])
  const [L, W] = field.sizeMeters
  useEffect(() => {
    const img = new Image()
    img.onload = () => { setImage(img); fieldSketch(img).then(setSketch) }
    img.src = field.imageUrl
  }, [field.imageUrl])
  useEffect(() => {
    const el = host.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const c = canvas.current
    if (!c || size.w === 0) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr
    c.height = size.h * dpr
    const ctx = c.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const margin = 30
    const k = Math.min((size.w - 2 * margin) / L, (size.h - 2 * margin) / W)
    const ox = (size.w - L * k) / 2, oy = (size.h + W * k) / 2
    const toScreen = (x: number, y: number): [number, number] => [ox + x * k, oy - y * k]
    drawFieldBackground(ctx, size, toScreen, k, field, image, sketch, view)
    const line: Pen["line"] = (pts, color, width, dash = []) => {
      if (pts.length < 2) return
      ctx.setLineDash(dash)
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.lineJoin = "round"
      ctx.lineCap = "round"
      ctx.beginPath()
      pts.forEach((p, i) => { const [sx, sy] = toScreen(p.x, p.y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy) })
      ctx.stroke()
      ctx.setLineDash([])
    }
    const trail: Pen["trail"] = (pts, color, width) => {
      let piece: { x: number; y: number }[] = []
      for (const p of pts) {
        const last = piece[piece.length - 1]
        if (last && Math.hypot(p.x - last.x, p.y - last.y) > 0.5) { line(piece, color, width); piece = [] }
        piece.push(p)
      }
      line(piece, color, width)
    }
    const bumper: Pen["bumper"] = (p, lengthM, widthM, stroke, fill, dash = []) => {
      const [cx, cy] = toScreen(p.x, p.y)
      const hl = lengthM / 2 * k, hw = widthM / 2 * k
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(-p.heading)
      ctx.setLineDash(dash)
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(-hl, -hw, 2 * hl, 2 * hw) }
      ctx.strokeStyle = stroke
      ctx.lineWidth = 2.5
      ctx.strokeRect(-hl, -hw, 2 * hl, 2 * hw)
      ctx.setLineDash([])
      // The front.
      ctx.beginPath()
      ctx.moveTo(hl, -hw)
      ctx.lineTo(hl, hw)
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.restore()
    }
    draw({ ctx, toScreen, k, line, trail, bumper })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, image, sketch, view, ...deps])
  return (
    <div ref={host} style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  )
}
