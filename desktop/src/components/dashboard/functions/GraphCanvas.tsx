import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import { TimeSeriesPoint } from "../../../utils/functions/mathTransforms"
import { calcAxisStepSize } from "../../../utils/functions/axisTicks"
import { ErrorBandPoint } from "../../../utils/functions/seriesAlgebra"
import { PhasePoint, boundsOf } from "../../../utils/functions/phasePlot"
import { FunctionLineStyle } from "../../../store/appStore"

export type PlottedAxis = "left" | "right"

export interface PlottedSeries {
  id: string
  label: string
  color: string
  axis: PlottedAxis
  unit: string | null
  points: TimeSeriesPoint[]
  errorBand?: ErrorBandPoint[]
  visible: boolean
  lineStyle: FunctionLineStyle
  lineWidth: number
}

export interface GraphCanvasHandle {
  /** The plot's PNG exactly as it looks, for the export button. */
  toDataURL: () => string | null
}

interface Props {
  series: PlottedSeries[]
  windowSeconds: number
  isLive: boolean
  selectedTime: number | null
  title?: string
  showGrid?: boolean
  showLegend?: boolean
  /** Rangos fijos; null = autoescala con suavizado. */
  leftRange?: [number, number] | null
  rightRange?: [number, number] | null
  /** X-Y mode: each series is drawn against `phaseX` instead of against time. */
  phaseData?: { xLabel: string; xUnit: string | null; bySeries: Record<string, PhasePoint[]> } | null
}

const PADDING_TOP = 30
const PADDING_BOTTOM = 32
const PADDING_OUTER = 12
const AXIS_LABEL_GAP = 8
const AXIS_TICK_LEN = 5
const Y_SMOOTHING = 0.15
const Y_STEP_TARGET_PX = 50
const X_STEP_TARGET_PX = 90
const ERROR_BAND_ALPHA = 0.18
const POINT_RADIUS = 1.8

interface YRange { yMin: number; yMax: number }
interface SmoothState { left: YRange | null; right: YRange | null }

const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const smoothRef = useRef<SmoothState>({ left: null, right: null })
  const [cursorX, setCursorX] = useState<number | null>(null)

  // The state the draw loop reads lives in a ref so the rAF is not recreated on
  // every data frame (they arrive at 20Hz).
  const latest = useRef({ props, cursorX })
  useEffect(() => { latest.current = { props, cursorX } })

  useImperativeHandle(ref, () => ({
    toDataURL: () => canvasRef.current?.toDataURL("image/png") ?? null,
  }), [])

  useEffect(() => {
    let raf: number
    const draw = () => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (canvas && container) {
        renderFrame(canvas, container, latest.current.props, smoothRef, latest.current.cursorX)
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", position: "relative" }}
      onMouseMove={e => {
        const rect = e.currentTarget.getBoundingClientRect()
        setCursorX(e.clientX - rect.left)
      }}
      onMouseLeave={() => setCursorX(null)}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  )
})

export default GraphCanvas

function computeTargetRange(values: number[]): YRange {
  const b = boundsOf(values)
  return { yMin: b.min, yMax: b.max }
}

function smoothRange(prev: YRange | null, target: YRange): YRange {
  if (prev === null) return target
  return {
    yMin: prev.yMin + (target.yMin - prev.yMin) * Y_SMOOTHING,
    yMax: prev.yMax + (target.yMax - prev.yMax) * Y_SMOOTHING,
  }
}

function formatTick(v: number, unit: string | null): string {
  const abs = Math.abs(v)
  let text: string
  if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) text = v.toExponential(1).replace("+", "")
  else if (v % 1 === 0) text = v.toString()
  else text = v.toFixed(2)
  return unit ? `${text} ${unit}` : text
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "")
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function renderFrame(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  props: Props,
  smoothRef: React.MutableRefObject<SmoothState>,
  cursorX: number | null,
) {
  const {
    series, windowSeconds, selectedTime, title = "Function Plot",
    showGrid = true, showLegend = true, leftRange: leftLock, rightRange: rightLock, phaseData,
  } = props

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
  const colorPanel = style.getPropertyValue("--bg-page").trim() || "#ffffff"

  ctx.fillStyle = colorPanel
  ctx.fillRect(0, 0, width, height)

  const visibleSeries = series.filter(s => s.visible)
  const isPhase = phaseData != null

  // --- Rangos ---------------------------------------------------------------
  const valuesFor = (axis: PlottedAxis): number[] => {
    const out: number[] = []
    visibleSeries.filter(s => s.axis === axis).forEach(s => {
      if (isPhase) (phaseData!.bySeries[s.id] ?? []).forEach(p => out.push(p.y))
      else s.points.forEach(p => out.push(p.v))
    })
    return out
  }

  const resolve = (axis: PlottedAxis, lock: [number, number] | null | undefined): YRange => {
    if (lock) return { yMin: lock[0], yMax: lock[1] }
    const target = computeTargetRange(valuesFor(axis))
    const smoothed = smoothRange(smoothRef.current[axis], target)
    smoothRef.current[axis] = smoothed
    return smoothed
  }

  const leftRange = resolve("left", leftLock)
  const rightRange = resolve("right", rightLock)

  const hasLeft = visibleSeries.some(s => s.axis === "left") || series.length === 0
  const hasRight = visibleSeries.some(s => s.axis === "right")

  const leftUnit = visibleSeries.find(s => s.axis === "left")?.unit ?? null
  const rightUnit = visibleSeries.find(s => s.axis === "right")?.unit ?? null

  // --- Layout ---------------------------------------------------------------
  ctx.font = "10px 'Segoe UI', Arial, sans-serif"
  const measureAxis = (range: YRange, unit: string | null) => {
    const step = calcAxisStepSize([range.yMin, range.yMax], height - PADDING_TOP - PADDING_BOTTOM, Y_STEP_TARGET_PX)
    let w = 0
    let v = Math.ceil(range.yMin / step) * step
    let guard = 0
    while (v <= range.yMax && guard++ < 200) {
      w = Math.max(w, ctx.measureText(formatTick(v, unit)).width)
      v += step
    }
    return { step, width: Math.ceil(w) }
  }

  const leftAxis = measureAxis(leftRange, leftUnit)
  const rightAxis = measureAxis(rightRange, rightUnit)

  const graphTop = PADDING_TOP
  const graphBottom = height - PADDING_BOTTOM
  const graphLeft = PADDING_OUTER + (hasLeft ? leftAxis.width + AXIS_LABEL_GAP + AXIS_TICK_LEN : 0)
  const graphRight = width - PADDING_OUTER - (hasRight ? rightAxis.width + AXIS_LABEL_GAP + AXIS_TICK_LEN : 0)
  const graphWidth = Math.max(1, graphRight - graphLeft)
  const graphHeight = Math.max(1, graphBottom - graphTop)

  // --- Eje X ----------------------------------------------------------------
  let xMin: number
  let xMax: number
  let xUnit: string | null = null

  if (isPhase) {
    const xs: number[] = []
    visibleSeries.forEach(s => (phaseData!.bySeries[s.id] ?? []).forEach(p => xs.push(p.x)))
    const b = boundsOf(xs)
    xMin = b.min
    xMax = b.max
    xUnit = phaseData!.xUnit
  } else {
    let latest = -Infinity
    visibleSeries.forEach(s => {
      const last = s.points[s.points.length - 1]
      if (last && last.t > latest) latest = last.t
    })
    if (!isFinite(latest)) latest = selectedTime !== null ? selectedTime / 1e6 : 0
    xMax = latest
    xMin = latest - windowSeconds
  }

  const toX = (v: number) => graphLeft + ((v - xMin) / (xMax - xMin || 1)) * graphWidth
  const toY = (v: number, r: YRange) =>
    graphBottom - ((v - r.yMin) / (r.yMax - r.yMin || 1)) * graphHeight

  ctx.save()
  ctx.beginPath()
  ctx.rect(graphLeft, graphTop, graphWidth, graphHeight)
  ctx.clip()

  // --- Grilla ---------------------------------------------------------------
  const xStep = calcAxisStepSize([xMin, xMax], graphWidth, X_STEP_TARGET_PX)
  if (showGrid) {
    ctx.strokeStyle = colorGrid
    ctx.lineWidth = 1
    let xTick = Math.ceil(xMin / xStep) * xStep
    let guard = 0
    while (xTick <= xMax && guard++ < 200) {
      const x = toX(xTick)
      ctx.beginPath()
      ctx.moveTo(x, graphTop)
      ctx.lineTo(x, graphBottom)
      ctx.stroke()
      xTick += xStep
    }
    const gridRange = hasLeft ? leftRange : rightRange
    const gridStep = hasLeft ? leftAxis.step : rightAxis.step
    let v = Math.ceil(gridRange.yMin / gridStep) * gridStep
    guard = 0
    while (v <= gridRange.yMax && guard++ < 200) {
      const y = toY(v, gridRange)
      ctx.beginPath()
      ctx.moveTo(graphLeft, y)
      ctx.lineTo(graphRight, y)
      ctx.stroke()
      v += gridStep
    }
  }

  // --- Banda de error -------------------------------------------------------
  if (!isPhase) {
    visibleSeries.forEach(s => {
      if (!s.errorBand || s.errorBand.length < 2) return
      const range = s.axis === "left" ? leftRange : rightRange
      ctx.beginPath()
      s.errorBand.forEach((p, i) => {
        const x = toX(p.t)
        const y = toY(p.actual, range)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      for (let k = s.errorBand.length - 1; k >= 0; k--) {
        ctx.lineTo(toX(s.errorBand[k].t), toY(s.errorBand[k].target, range))
      }
      ctx.closePath()
      ctx.fillStyle = hexToRgba(s.color, ERROR_BAND_ALPHA)
      ctx.fill()
    })
  }

  // --- Series ---------------------------------------------------------------
  visibleSeries.forEach(s => {
    const range = s.axis === "left" ? leftRange : rightRange
    const pts: { x: number; y: number }[] = isPhase
      ? (phaseData!.bySeries[s.id] ?? []).map(p => ({ x: toX(p.x), y: toY(p.y, range) }))
      : s.points.map(p => ({ x: toX(p.t), y: toY(p.v, range) }))

    if (pts.length === 0) return

    ctx.strokeStyle = s.color
    ctx.fillStyle = s.color
    ctx.lineWidth = s.lineWidth
    ctx.lineJoin = "round"
    ctx.lineCap = "round"

    if (s.lineStyle === "points") {
      pts.forEach(p => {
        ctx.beginPath()
        ctx.arc(p.x, p.y, POINT_RADIUS + s.lineWidth * 0.3, 0, Math.PI * 2)
        ctx.fill()
      })
      return
    }
    if (pts.length < 2) return

    ctx.beginPath()
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y)
      // "stepped" holds the value until the next sample, which is right for
      // signals that only change when the robot publishes them.
      else if (s.lineStyle === "stepped") { ctx.lineTo(p.x, pts[i - 1].y); ctx.lineTo(p.x, p.y) }
      else ctx.lineTo(p.x, p.y)
    })
    ctx.stroke()
  })

  ctx.restore()

  // --- Crosshair ------------------------------------------------------------
  if (cursorX !== null && cursorX >= graphLeft && cursorX <= graphRight && visibleSeries.length > 0) {
    ctx.strokeStyle = colorMuted
    ctx.globalAlpha = 0.45
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cursorX, graphTop)
    ctx.lineTo(cursorX, graphBottom)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    const xValue = xMin + ((cursorX - graphLeft) / graphWidth) * (xMax - xMin)
    drawCursorReadout(ctx, {
      series: visibleSeries, phaseData, xValue, isPhase,
      leftRange, rightRange, toY, cursorX, graphTop, graphRight, graphLeft,
      colorText, colorPanel, colorBorder, xUnit,
    })
  }

  // --- Ejes -----------------------------------------------------------------
  ctx.font = "10px 'Segoe UI', Arial, sans-serif"
  ctx.strokeStyle = colorBorder
  ctx.fillStyle = colorMuted
  ctx.lineWidth = 1

  const drawYAxis = (range: YRange, step: number, unit: string | null, side: "left" | "right") => {
    ctx.textAlign = side === "left" ? "right" : "left"
    ctx.textBaseline = "middle"
    let v = Math.ceil(range.yMin / step) * step
    let guard = 0
    while (v <= range.yMax && guard++ < 200) {
      const y = toY(v, range)
      const anchor = side === "left" ? graphLeft : graphRight
      const dir = side === "left" ? -1 : 1
      ctx.fillText(formatTick(v, unit), anchor + dir * (AXIS_TICK_LEN + AXIS_LABEL_GAP), y)
      ctx.beginPath()
      ctx.moveTo(anchor, y)
      ctx.lineTo(anchor + dir * AXIS_TICK_LEN, y)
      ctx.stroke()
      v += step
    }
  }
  if (hasLeft) drawYAxis(leftRange, leftAxis.step, leftUnit, "left")
  if (hasRight) drawYAxis(rightRange, rightAxis.step, rightUnit, "right")

  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  let xTick = Math.ceil(xMin / xStep) * xStep
  let guard = 0
  while (xTick <= xMax && guard++ < 200) {
    const x = toX(xTick)
    // In time mode the axis is labeled RELATIVE to the present: an absolute
    // server timestamp (tens of thousands of seconds) says nothing.
    const label = isPhase ? formatTick(xTick, xUnit) : `${(xTick - xMax).toFixed(xStep < 1 ? 1 : 0)}s`
    ctx.fillText(label, x, graphBottom + 8)
    ctx.beginPath()
    ctx.moveTo(x, graphBottom)
    ctx.lineTo(x, graphBottom + AXIS_TICK_LEN)
    ctx.stroke()
    xTick += xStep
  }

  ctx.strokeStyle = colorBorder
  ctx.strokeRect(graphLeft, graphTop, graphWidth, graphHeight)

  // --- Title and legend -----------------------------------------------------
  ctx.fillStyle = colorText
  ctx.font = "bold 12px 'Segoe UI', Arial, sans-serif"
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"
  ctx.fillText(isPhase ? `${title} — X: ${phaseData!.xLabel}` : title, graphLeft, 18)

  if (showLegend && visibleSeries.length > 0) {
    ctx.font = "10px 'Segoe UI', Arial, sans-serif"
    ctx.textAlign = "right"
    let x = graphRight
    for (let i = visibleSeries.length - 1; i >= 0; i--) {
      const s = visibleSeries[i]
      const w = ctx.measureText(s.label).width
      ctx.fillStyle = s.color
      ctx.fillText(s.label, x, 18)
      ctx.fillRect(x - w - 12, 11, 8, 3)
      x -= w + 22
      if (x < graphLeft + 60) break
    }
  }

  if (series.length === 0) {
    ctx.fillStyle = colorMuted
    ctx.font = "12px 'Segoe UI', Arial, sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText("Drag a numeric topic here to plot it", (graphLeft + graphRight) / 2, (graphTop + graphBottom) / 2)
  }
}

// A box with each series' value at the cursor's position. It is what turns the
// plot into something measurable instead of just something to look at.
function drawCursorReadout(
  ctx: CanvasRenderingContext2D,
  o: {
    series: PlottedSeries[]
    phaseData: Props["phaseData"]
    xValue: number
    isPhase: boolean
    leftRange: YRange
    rightRange: YRange
    toY: (v: number, r: YRange) => number
    cursorX: number
    graphTop: number
    graphLeft: number
    graphRight: number
    colorText: string
    colorPanel: string
    colorBorder: string
    xUnit: string | null
  },
) {
  const rows: { label: string; value: string; color: string }[] = []

  for (const s of o.series) {
    let value: number | null = null
    if (o.isPhase) {
      const pts = o.phaseData!.bySeries[s.id] ?? []
      let best: PhasePoint | null = null
      let bestDist = Infinity
      for (const p of pts) {
        const d = Math.abs(p.x - o.xValue)
        if (d < bestDist) { bestDist = d; best = p }
      }
      value = best ? best.y : null
    } else {
      // The last sample at or before the cursor: it is the value the robot had
      // at that instant, not a made-up interpolation.
      let found: number | null = null
      for (const p of s.points) {
        if (p.t <= o.xValue) found = p.v
        else break
      }
      value = found
    }
    if (value === null) continue
    rows.push({ label: s.label, value: formatTick(value, s.unit), color: s.color })
  }
  if (rows.length === 0) return

  ctx.font = "10px 'Segoe UI', Arial, sans-serif"
  const lineH = 13
  const padding = 6
  const boxW = Math.max(...rows.map(r => ctx.measureText(`${r.label}  ${r.value}`).width)) + padding * 2 + 10
  const boxH = rows.length * lineH + padding * 2

  // It flips to the other side of the cursor if it does not fit on the right.
  let boxX = o.cursorX + 10
  if (boxX + boxW > o.graphRight) boxX = o.cursorX - 10 - boxW
  if (boxX < o.graphLeft) boxX = o.graphLeft
  const boxY = o.graphTop + 6

  ctx.fillStyle = o.colorPanel
  ctx.globalAlpha = 0.94
  ctx.fillRect(boxX, boxY, boxW, boxH)
  ctx.globalAlpha = 1
  ctx.strokeStyle = o.colorBorder
  ctx.lineWidth = 1
  ctx.strokeRect(boxX, boxY, boxW, boxH)

  rows.forEach((r, i) => {
    const y = boxY + padding + i * lineH + lineH / 2
    ctx.fillStyle = r.color
    ctx.fillRect(boxX + padding, y - 2, 6, 4)
    ctx.fillStyle = o.colorText
    ctx.textAlign = "left"
    ctx.textBaseline = "middle"
    ctx.fillText(r.label, boxX + padding + 11, y)
    ctx.textAlign = "right"
    ctx.fillText(r.value, boxX + boxW - padding, y)
  })
}
