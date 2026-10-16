import { useEffect, useMemo, useRef, useState } from "react"
import type { Sample, Trajectory } from "./types"
import { PATHFIND } from "./FieldView"

// Under the field: what the robot does over time, lane by lane, on one time
// axis tied to the playback. Hovering a lane scrubs the robot on the field;
// clicking leaves the playhead there. Waypoints, events, splits and pathfind
// windows are marked across every lane.

interface Props {
  trajectory: Trajectory
  playhead: number | null
  /** The robot's limits, drawn as dashed lines where they apply. */
  limits: { speed: number; accel: number; current: number }
  onScrub: (t: number | null) => void
  onSeek: (t: number) => void
}

interface Lane {
  id: string
  label: string
  unit: string
  color: string
  value: (s: Sample) => number
  /** A ceiling worth seeing (the robot's limit), if any. */
  limit?: number
  /** Fixed scale top; otherwise from the data. */
  max?: number
  hint: string
}

const LANES_KEY = "ares.chartLanes"
const LANE_HEIGHT = 46
const AXIS_W = 58
const DEFAULT_LANES = ["speed", "accel", "grip"]

export default function Charts({ trajectory, playhead, limits, onScrub, onSeek }: Props) {
  const all: Lane[] = useMemo(() => [
    { id: "speed", label: "Speed", unit: "m/s", color: "#2f6fdb", value: s => Math.hypot(s.vx, s.vy), limit: limits.speed, hint: "How fast the chassis moves. Dashed: the usable speed." },
    { id: "accel", label: "Accel", unit: "m/s²", color: "#e95420", value: s => Math.hypot(s.ax, s.ay), limit: limits.accel, hint: "How hard it speeds up or brakes (magnitude). Dashed: the launch limit." },
    { id: "omega", label: "Turn", unit: "°/s", color: "#7c8a00", value: s => Math.abs(s.omega) * 180 / Math.PI, hint: "How fast it rotates." },
    { id: "heading", label: "Heading", unit: "°", color: "#0e7490", value: s => ((s.heading * 180 / Math.PI) % 360 + 540) % 360 - 180, hint: "Which way it faces (0° toward +X)." },
    { id: "current", label: "Current", unit: "A", color: "#a81818", value: s => Math.max(0, ...s.modules.map(m => Math.abs(m.currentA))), limit: limits.current, hint: "The most any drive motor draws. Dashed: the current limit." },
    { id: "grip", label: "Grip", unit: "%", color: "#16a34a", value: s => 100 * Math.max(0, ...s.modules.map(m => m.gripUsed)), limit: 100, max: 110, hint: "The most of its grip any wheel uses. 100% is the edge of slipping." },
  ], [limits.speed, limits.accel, limits.current])

  const [shown, setShown] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(LANES_KEY) ?? "null"); if (Array.isArray(v)) return v } catch { /* default */ }
    return DEFAULT_LANES
  })
  useEffect(() => { try { localStorage.setItem(LANES_KEY, JSON.stringify(shown)) } catch { /* not kept */ } }, [shown])
  const lanes = all.filter(l => shown.includes(l.id))

  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null)
  useEffect(() => {
    const el = host.current!
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const T = Math.max(trajectory.durationS, 1e-6)
  const height = lanes.length * LANE_HEIGHT + 18
  const plotW = Math.max(10, width - AXIS_W - 10)
  const tx = (t: number) => AXIS_W + (t / T) * plotW
  const xt = (x: number) => Math.min(T, Math.max(0, ((x - AXIS_W) / plotW) * T))

  useEffect(() => {
    const c = canvas.current
    if (!c || width === 0) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    const ctx = c.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const s = trajectory.samples

    // Windows and marks across every lane.
    const top = 2, bottom = lanes.length * LANE_HEIGHT
    for (const p of trajectory.pathfind ?? []) {
      const [a, b] = [tx(s[p.startSample].t), tx(s[p.endSample].t)]
      ctx.fillStyle = "rgba(22,163,74,0.09)"
      ctx.fillRect(a, top, b - a, bottom - top)
      ctx.fillStyle = PATHFIND
      ctx.font = "700 10px 'Segoe UI', Arial, sans-serif"
      ctx.textAlign = "center"
      ctx.fillText("? estimate", (a + b) / 2, bottom + 13)
    }
    ctx.lineWidth = 1
    ;(trajectory.waypointTimes ?? []).forEach((t, i) => {
      const x = tx(t)
      ctx.strokeStyle = "rgba(0,0,0,0.18)"
      ctx.setLineDash([2, 3])
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = "#55565c"
      ctx.font = "9.5px 'Segoe UI', Arial, sans-serif"
      ctx.textAlign = "center"
      ctx.fillText(String(i + 1), x, bottom + 13)
    })
    for (const e of trajectory.events ?? []) {
      const x = tx(e.t)
      if (e.endT !== undefined) {
        ctx.fillStyle = "rgba(161,105,10,0.12)"
        ctx.fillRect(x, top, tx(e.endT) - x, bottom - top)
      }
      ctx.strokeStyle = "#a1690a"
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke()
    }

    lanes.forEach((lane, li) => {
      const y0 = li * LANE_HEIGHT
      const vals = s.map(lane.value)
      const max = lane.max ?? Math.max(1e-6, ...vals, lane.limit ?? 0) * 1.08
      const min = lane.id === "heading" ? -180 : 0
      const top2 = lane.id === "heading" ? 180 : max
      const vy = (v: number) => y0 + LANE_HEIGHT - 4 - ((v - min) / (top2 - min)) * (LANE_HEIGHT - 10)
      // Lane frame and label.
      ctx.fillStyle = li % 2 ? "rgba(0,0,0,0.018)" : "transparent"
      ctx.fillRect(AXIS_W, y0, plotW, LANE_HEIGHT)
      ctx.fillStyle = lane.color
      ctx.font = "600 10px 'Segoe UI', Arial, sans-serif"
      ctx.textAlign = "left"
      ctx.textBaseline = "top"
      ctx.fillText(lane.label, 6, y0 + 5)
      ctx.fillStyle = "#68686f"
      ctx.font = "9px Consolas, 'Cascadia Mono', monospace"
      ctx.fillText(`${fmt(top2)} ${lane.unit}`, 6, y0 + 19)
      ctx.textBaseline = "alphabetic"
      ctx.fillText(`${fmt(min)}`, 6, y0 + LANE_HEIGHT - 4)
      // The limit.
      if (lane.limit && lane.limit <= top2) {
        ctx.strokeStyle = lane.color
        ctx.globalAlpha = 0.5
        ctx.setLineDash([4, 4])
        ctx.beginPath(); ctx.moveTo(AXIS_W, vy(lane.limit)); ctx.lineTo(AXIS_W + plotW, vy(lane.limit)); ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }
      // The curve, faded inside pathfind windows (an estimate).
      ctx.strokeStyle = lane.color
      ctx.lineWidth = 1.6
      ctx.beginPath()
      s.forEach((q, i) => {
        const x = tx(q.t), y = vy(vals[i])
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.strokeStyle = "rgba(0,0,0,0.08)"
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(AXIS_W, y0 + LANE_HEIGHT); ctx.lineTo(AXIS_W + plotW, y0 + LANE_HEIGHT); ctx.stroke()
    })

    // Playhead and hover.
    const mark = (t: number, color: string, w: number) => {
      const x = tx(t)
      ctx.strokeStyle = color
      ctx.lineWidth = w
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke()
    }
    if (playhead !== null) mark(playhead, "#1c1c1f", 1.5)
    if (hover) mark(hover.t, "rgba(28,28,31,0.45)", 1)
  }, [trajectory, lanes, width, height, playhead, hover])

  // Values at the hover time, for the readout.
  const readout = hover ? valuesAt(trajectory, hover.t, lanes) : null

  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid var(--border-main)", background: "var(--bg-page)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderBottom: "1px solid var(--border-light)", background: "var(--bg-panel)" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)", marginRight: 6 }}>Charts</span>
        {all.map(l => {
          const on = shown.includes(l.id)
          return (
            <button key={l.id} title={l.hint}
              onClick={() => setShown(v => (on ? v.filter(x => x !== l.id) : all.map(a => a.id).filter(id => id === l.id || v.includes(id))))}
              style={{
                fontSize: 10.5, padding: "1px 8px", height: 20, borderRadius: 10, cursor: "pointer",
                border: `1px solid ${on ? l.color : "var(--border-main)"}`, background: on ? `${l.color}18` : "transparent",
                color: on ? l.color : "var(--text-muted)", fontWeight: on ? 600 : 400,
              }}>
              {l.label}
            </button>
          )
        })}
        {readout && (
          <span style={{ marginLeft: "auto", fontSize: 10.5, fontFamily: "Consolas, 'Cascadia Mono', monospace", color: "var(--text-secondary)", display: "flex", gap: 12 }}>
            <span>t {hover!.t.toFixed(3)} s</span>
            {readout.map(r => <span key={r.label} style={{ color: r.color }}>{r.label} {fmt(r.value)} {r.unit}</span>)}
          </span>
        )}
      </div>
      <div ref={host} style={{ position: "relative" }}>
        {lanes.length === 0 ? (
          <div style={{ padding: 10, fontSize: 11, color: "var(--text-muted)" }}>Pick what to plot above.</div>
        ) : (
          <canvas
            ref={canvas}
            style={{ width: "100%", height, display: "block", cursor: "crosshair" }}
            onPointerMove={e => {
              const r = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - r.left
              if (x < AXIS_W) { setHover(null); onScrub(null); return }
              const t = xt(x)
              setHover({ t, x })
              onScrub(t)
            }}
            onPointerLeave={() => { setHover(null); onScrub(null) }}
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect()
              onSeek(xt(e.clientX - r.left))
            }}
          />
        )}
      </div>
    </div>
  )
}

function valuesAt(t: Trajectory, time: number, lanes: Lane[]) {
  const s = t.samples
  let lo = 0, hi = s.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (s[mid].t <= time) lo = mid
    else hi = mid
  }
  const q = Math.abs(s[hi].t - time) < Math.abs(s[lo].t - time) ? s[hi] : s[lo]
  return lanes.map(l => ({ label: l.label, unit: l.unit, color: l.color, value: l.value(q) }))
}

function fmt(v: number): string {
  const a = Math.abs(v)
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)
}
