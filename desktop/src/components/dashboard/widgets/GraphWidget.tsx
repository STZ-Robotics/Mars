import { useEffect, useRef, useState } from "react"

interface Props {
  value: number
  timeDisplayed: number
  color: string
  lineWidth: number
  minValue?: number
  maxValue?: number
  suffix: string
}

// Its own in-memory buffer (independent of NT polling). It samples the last
// received value at ~20Hz and draws a timeline-style SVG, in the same spirit as
// Elastic's Graph (fl_chart), but with no external dependencies.
export default function GraphWidget({ value, timeDisplayed, color, lineWidth, minValue, maxValue, suffix }: Props) {
  const pointsRef = useRef<{ t: number; v: number }[]>([])
  const valueRef = useRef(value)
  valueRef.current = value
  const [, forceTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      const windowStart = now - timeDisplayed * 1000
      const pts = pointsRef.current
      pts.push({ t: now, v: valueRef.current })
      // One point right before the window is kept so the line is not "born"
      // halfway through the plot; the rest is cut off.
      while (pts.length > 2 && pts[1].t < windowStart) pts.shift()
      forceTick(n => n + 1)
    }, 50) // ~20Hz de muestreo visual
    return () => clearInterval(interval)
  }, [timeDisplayed])

  const points = pointsRef.current
  if (points.length < 2) {
    return <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>Collecting data…</span>
  }

  const now = Date.now()
  const windowStart = now - timeDisplayed * 1000
  const visible = points.filter(p => p.t >= windowStart)
  if (visible.length < 2) {
    return <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>Collecting data…</span>
  }

  let yMin = minValue
  let yMax = maxValue
  if (yMin === undefined || yMax === undefined) {
    const values = visible.map(p => p.v)
    const dataMin = Math.min(...values)
    const dataMax = Math.max(...values)
    const range = dataMax - dataMin
    const pad = range === 0 ? Math.max(1, Math.abs(dataMax) * 0.1 || 1) : range * 0.1
    if (yMin === undefined) yMin = dataMin - pad
    if (yMax === undefined) yMax = dataMax + pad
  }
  if (yMax <= yMin) yMax = yMin + 1

  const W = 300, H = 130
  const toX = (t: number) => ((t - windowStart) / (timeDisplayed * 1000)) * W
  const toY = (v: number) => H - ((v - yMin!) / (yMax! - yMin!)) * H

  const path = visible.map((p, i) => `${i === 0 ? "M" : "L"} ${toX(p.t).toFixed(1)} ${toY(p.v).toFixed(1)}`).join(" ")

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "4px 8px", boxSizing: "border-box" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", flex: 1, display: "block", overflow: "visible" }}>
        <line x1={0} y1={H} x2={W} y2={H} stroke="var(--border-main)" strokeWidth={1} />
        <line x1={0} y1={0} x2={0} y2={H} stroke="var(--border-main)" strokeWidth={1} />
        <path d={path} fill="none" stroke={color} strokeWidth={lineWidth} vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--text-muted)", padding: "2px 2px 0" }}>
        <span>{yMin.toFixed(1)}{suffix}</span>
        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--text-primary)" }}>{value.toFixed(2)}{suffix}</span>
        <span>{yMax.toFixed(1)}{suffix}</span>
      </div>
    </div>
  )
}
