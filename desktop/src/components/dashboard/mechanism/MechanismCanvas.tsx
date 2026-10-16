import { useEffect, useRef } from "react"
import { MechanismSettings } from "../../../store/appStore"
import { MechanismState, MechanismPoint } from "../../../utils/field/mechanismExtraction"

interface Props {
  state: MechanismState | null
  settings: MechanismSettings
}

// Minimum on-screen width: a ligament published with weight 0 still has to
// show, otherwise the user believes the data is not arriving.
const MIN_STROKE = 1

export default function MechanismCanvas({ state, settings }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef<() => void>(() => {})

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const draw = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      if (width === 0 || height === 0) return

      const dpr = window.devicePixelRatio || 1
      const pixelW = Math.round(width * dpr)
      const pixelH = Math.round(height * dpr)
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
        canvas.width = pixelW
        canvas.height = pixelH
      }

      const ctx = canvas.getContext("2d")
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.lineCap = "round"
      ctx.lineJoin = "round"

      if (state === null) return

      // The Mechanism2d canvas has an aspect ratio of its own (dims): it is
      // centered inside the container without distorting it, just like
      // AdvantageScope's panel does.
      const [mechWidth, mechHeight] = state.dimensions
      const scale = Math.min(width / mechWidth, height / mechHeight)
      const renderW = mechWidth * scale
      const renderH = mechHeight * scale
      const offsetX = (width - renderW) / 2
      const offsetY = (height - renderH) / 2

      // Mechanism coordinates (X right, Y UP) -> screen pixels.
      const toPx = (point: MechanismPoint): [number, number] => [
        offsetX + point[0] * scale,
        offsetY + renderH - point[1] * scale,
      ]

      ctx.fillStyle = settings.useTopicBackground ? state.backgroundColor : "#101014"
      ctx.fillRect(offsetX, offsetY, renderW, renderH)

      if (settings.showGrid) drawGrid(ctx, mechWidth, mechHeight, toPx)
      if (settings.showOrigin) drawOrigin(ctx, mechWidth, mechHeight, toPx)

      state.lines.forEach(line => {
        const start = toPx(line.start)
        const end = toPx(line.end)
        const stroke = Math.max(MIN_STROKE, line.weight * settings.weightScale)

        ctx.strokeStyle = line.color
        ctx.lineWidth = stroke
        ctx.beginPath()
        ctx.moveTo(start[0], start[1])
        ctx.lineTo(end[0], end[1])
        ctx.stroke()

        // Dots at the joints: without them, two ligaments at very different
        // angles look like a broken line with no pivot.
        if (settings.showJoints) {
          ctx.fillStyle = line.color
          ;[start, end].forEach(([x, y]) => {
            ctx.beginPath()
            ctx.arc(x, y, stroke / 2, 0, Math.PI * 2)
            ctx.fill()
          })
        }
      })

      // The canvas' frame, so it is clear where the space declared in dims ends
      // even if the published background is almost the same as the app's.
      ctx.strokeStyle = "rgba(255,255,255,0.18)"
      ctx.lineWidth = 1
      ctx.strokeRect(offsetX + 0.5, offsetY + 0.5, renderW - 1, renderH - 1)
    }

    drawRef.current = draw
    draw()
  }, [state, settings])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => drawRef.current())
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  )
}

// Grid in mechanism units: a "round" step (1, 2, 5, 10...) that leaves between
// 6 and 15 divisions on the longest side.
function gridStep(span: number): number {
  const raw = span / 10
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const normalized = raw / magnitude
  const nice = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1
  return nice * magnitude
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  mechWidth: number,
  mechHeight: number,
  toPx: (p: MechanismPoint) => [number, number],
) {
  const step = gridStep(Math.max(mechWidth, mechHeight))
  if (!isFinite(step) || step <= 0) return

  ctx.strokeStyle = "rgba(255,255,255,0.10)"
  ctx.lineWidth = 1

  for (let x = step; x < mechWidth; x += step) {
    const top = toPx([x, mechHeight])
    const bottom = toPx([x, 0])
    ctx.beginPath()
    ctx.moveTo(top[0], top[1])
    ctx.lineTo(bottom[0], bottom[1])
    ctx.stroke()
  }

  for (let y = step; y < mechHeight; y += step) {
    const left = toPx([0, y])
    const right = toPx([mechWidth, y])
    ctx.beginPath()
    ctx.moveTo(left[0], left[1])
    ctx.lineTo(right[0], right[1])
    ctx.stroke()
  }
}

// Axes at the drawing's (0,0) — a Mechanism2d's origin is the BOTTOM LEFT
// corner, not the center, and that confuses people when placing roots.
function drawOrigin(
  ctx: CanvasRenderingContext2D,
  mechWidth: number,
  mechHeight: number,
  toPx: (p: MechanismPoint) => [number, number],
) {
  const origin = toPx([0, 0])
  const xEnd = toPx([mechWidth * 0.12, 0])
  const yEnd = toPx([0, mechHeight * 0.12])

  ctx.lineWidth = 1.5

  ctx.strokeStyle = "#d63b3b"
  ctx.beginPath()
  ctx.moveTo(origin[0], origin[1])
  ctx.lineTo(xEnd[0], xEnd[1])
  ctx.stroke()

  ctx.strokeStyle = "#1f9e4a"
  ctx.beginPath()
  ctx.moveTo(origin[0], origin[1])
  ctx.lineTo(yEnd[0], yEnd[1])
  ctx.stroke()
}
