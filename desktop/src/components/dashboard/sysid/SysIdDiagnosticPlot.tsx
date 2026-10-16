import { useEffect, useRef } from "react"
import { RunDiagnostics, TEST_COLORS, TEST_LABELS } from "../../../utils/sysid/feedforward"

export type PlotMode = "fit" | "residual"

interface Props {
  diagnostics: RunDiagnostics[]
  /**
   * "fit"      -> measured vs predicted. A perfect fit falls on the 45° line.
   * "residual" -> error vs velocity. If there is structure (a curve, a step)
   *               the model is leaving physics out.
   */
  mode: PlotMode
  height?: number
}

const PADDING = { top: 10, right: 12, bottom: 26, left: 44 }
const POINT_RADIUS = 1.4
/** Samples drawn per run: 20k points kill the canvas and add nothing. */
const MAX_POINTS_PER_RUN = 1500

export default function SysIdDiagnosticPlot({ diagnostics, mode, height = 200 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef<() => void>(() => {})

  useEffect(() => {
    const draw = () => {
      const container = containerRef.current
      const canvas = canvasRef.current
      if (container && canvas) render(canvas, container, diagnostics, mode)
    }
    drawRef.current = draw
    draw()
  }, [diagnostics, mode])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => drawRef.current())
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={containerRef} style={{ width: "100%", height, position: "relative" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  )
}

/** Uniform subsampling: keeps the shape without drawing everything. */
function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const step = items.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)])
  return out
}

function niceStep(span: number, targetTicks: number): number {
  if (span <= 0 || !isFinite(span)) return 1
  const raw = span / targetTicks
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const normalized = raw / magnitude
  const nice = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1
  return nice * magnitude
}

function render(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  diagnostics: RunDiagnostics[],
  mode: PlotMode,
) {
  const width = container.clientWidth
  const height = container.clientHeight
  if (width === 0 || height === 0) return

  const dpr = window.devicePixelRatio || 1
  const pixelW = Math.round(width * dpr)
  const pixelH = Math.round(height * dpr)
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW
    canvas.height = pixelH
  }

  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const style = getComputedStyle(container)
  const colorText = style.getPropertyValue("--text-primary").trim() || "#1c1c1f"
  const colorMuted = style.getPropertyValue("--text-muted").trim() || "#68686f"
  const colorGrid = style.getPropertyValue("--grid-line").trim() || "rgba(0,0,0,0.06)"
  const colorBorder = style.getPropertyValue("--border-main").trim() || "#c8c8cc"
  const colorPage = style.getPropertyValue("--bg-page").trim() || "#ffffff"

  ctx.fillStyle = colorPage
  ctx.fillRect(0, 0, width, height)

  const runs = diagnostics.map(run => ({
    type: run.type,
    points: thin(run.points, MAX_POINTS_PER_RUN),
  }))

  const xy = runs.flatMap(run => run.points.map(p =>
    mode === "fit"
      ? { x: p.predicted, y: p.measured }
      : { x: p.velocity, y: p.residual },
  ))

  const graphLeft = PADDING.left
  const graphRight = width - PADDING.right
  const graphTop = PADDING.top
  const graphBottom = height - PADDING.bottom
  const graphWidth = Math.max(1, graphRight - graphLeft)
  const graphHeight = Math.max(1, graphBottom - graphTop)

  if (xy.length === 0) {
    ctx.fillStyle = colorMuted
    ctx.font = "11px 'Segoe UI', Arial, sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText("No usable samples", width / 2, height / 2)
    return
  }

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
  for (const p of xy) {
    if (p.x < xMin) xMin = p.x
    if (p.x > xMax) xMax = p.x
    if (p.y < yMin) yMin = p.y
    if (p.y > yMax) yMax = p.y
  }

  if (mode === "fit") {
    // Both axes are volts: they share a range so the ideal line really sits at
    // 45° and a deviation shows as such.
    const lo = Math.min(xMin, yMin)
    const hi = Math.max(xMax, yMax)
    xMin = yMin = lo
    xMax = yMax = hi
  } else {
    // The residual is centered on 0: otherwise a constant bias would seem to be
    // "in the middle" instead of being shifted.
    const extent = Math.max(Math.abs(yMin), Math.abs(yMax), 1e-6)
    yMin = -extent
    yMax = extent
  }

  const padSpan = (min: number, max: number) => {
    if (max - min < 1e-9) return [min - 1, max + 1] as const
    const margin = (max - min) * 0.06
    return [min - margin, max + margin] as const
  }
  ;[xMin, xMax] = padSpan(xMin, xMax)
  ;[yMin, yMax] = padSpan(yMin, yMax)

  const toX = (v: number) => graphLeft + ((v - xMin) / (xMax - xMin)) * graphWidth
  const toY = (v: number) => graphBottom - ((v - yMin) / (yMax - yMin)) * graphHeight

  // --- Grilla y ejes --------------------------------------------------------
  ctx.font = "9px 'Segoe UI', Arial, sans-serif"
  ctx.strokeStyle = colorGrid
  ctx.lineWidth = 1

  const xStep = niceStep(xMax - xMin, 6)
  const yStep = niceStep(yMax - yMin, 4)

  ctx.fillStyle = colorMuted
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  for (let v = Math.ceil(xMin / xStep) * xStep, guard = 0; v <= xMax && guard++ < 100; v += xStep) {
    const x = toX(v)
    ctx.strokeStyle = colorGrid
    ctx.beginPath()
    ctx.moveTo(x, graphTop)
    ctx.lineTo(x, graphBottom)
    ctx.stroke()
    ctx.fillText(v.toFixed(Math.abs(xStep) < 1 ? 2 : 1), x, graphBottom + 5)
  }

  ctx.textAlign = "right"
  ctx.textBaseline = "middle"
  for (let v = Math.ceil(yMin / yStep) * yStep, guard = 0; v <= yMax && guard++ < 100; v += yStep) {
    const y = toY(v)
    ctx.strokeStyle = colorGrid
    ctx.beginPath()
    ctx.moveTo(graphLeft, y)
    ctx.lineTo(graphRight, y)
    ctx.stroke()
    ctx.fillText(v.toFixed(Math.abs(yStep) < 1 ? 2 : 1), graphLeft - 5, y)
  }

  // --- Referencia -----------------------------------------------------------
  ctx.save()
  ctx.beginPath()
  ctx.rect(graphLeft, graphTop, graphWidth, graphHeight)
  ctx.clip()

  ctx.strokeStyle = colorText
  ctx.globalAlpha = 0.4
  ctx.setLineDash([4, 3])
  ctx.lineWidth = 1
  ctx.beginPath()
  if (mode === "fit") {
    // The y = x line: where the points would fall with a perfect fit.
    ctx.moveTo(toX(xMin), toY(xMin))
    ctx.lineTo(toX(xMax), toY(xMax))
  } else {
    // Residuo cero.
    ctx.moveTo(graphLeft, toY(0))
    ctx.lineTo(graphRight, toY(0))
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  // --- Puntos ---------------------------------------------------------------
  for (const run of runs) {
    ctx.fillStyle = TEST_COLORS[run.type]
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    for (const p of run.points) {
      const x = mode === "fit" ? toX(p.predicted) : toX(p.velocity)
      const y = mode === "fit" ? toY(p.measured) : toY(p.residual)
      ctx.moveTo(x + POINT_RADIUS, y)
      ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2)
    }
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.restore()

  ctx.strokeStyle = colorBorder
  ctx.lineWidth = 1
  ctx.strokeRect(graphLeft, graphTop, graphWidth, graphHeight)

  // --- Etiquetas de eje -----------------------------------------------------
  ctx.fillStyle = colorMuted
  ctx.font = "9px 'Segoe UI', Arial, sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "bottom"
  ctx.fillText(mode === "fit" ? "predicted (V)" : "velocity", (graphLeft + graphRight) / 2, height - 1)

  ctx.save()
  ctx.translate(9, (graphTop + graphBottom) / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  ctx.fillText(mode === "fit" ? "measured (V)" : "residual (V)", 0, 0)
  ctx.restore()
}

/** Legend shared by both plots. */
export function DiagnosticLegend({ diagnostics }: { diagnostics: RunDiagnostics[] }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: "2px 10px 6px" }}>
      {diagnostics.map(run => (
        <span key={run.type} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9.5, color: "var(--text-muted)" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: TEST_COLORS[run.type], flexShrink: 0 }} />
          {TEST_LABELS[run.type]}
          <span style={{ opacity: 0.7 }}>({run.points.length})</span>
        </span>
      ))}
    </div>
  )
}
