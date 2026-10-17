import { ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import type { NtValue } from "../characterize/model"
import { drawFieldBackground } from "../paths/FieldView"
import { fieldSketch } from "../paths/fieldSketch"
import { loadView } from "../paths/PathsPage"
import { BarButton, useNtConnection } from "../ui/NtConnect"
import { LiveState, Pose, Sample, readLive, sample } from "./model"

// The Live tab: the robot as AresLib reports it, as PathPlanner's telemetry
// shows it. The path being driven, where the trajectory says to be (the
// target) and where the robot is, with its trail; the speed it is asked for
// against the speed it has, and how far off it is, over the last seconds.

const COMMANDED = "#e95420"
const ACTUAL = "#2f6fdb"
const WINDOW_S = 12

export default function LivePage({ robot }: { robot: RobotConfig }) {
  const { connected, bar } = useNtConnection()
  const [live, setLive] = useState<LiveState | null>(null)
  const [history, setHistory] = useState<Sample[]>([])
  const [trail, setTrail] = useState<Pose[]>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  pausedRef.current = paused
  // How far off the robot got on the path running now.
  const worst = useRef<{ path: string; err: number }>({ path: "", err: 0 })

  useEffect(() => {
    if (!connected) return
    const started = performance.now()
    const t = setInterval(async () => {
      if (pausedRef.current) return
      try {
        const values = await invoke<Record<string, NtValue>>("nt_read", { prefix: "/Ares/" })
        const s = readLive(values)
        setLive(s)
        const now = (performance.now() - started) / 1000
        setHistory(h => [...h, sample(now, s)].filter(k => k.t > now - WINDOW_S))
        if (s.robot) setTrail(tr => [...tr, s.robot!].slice(-600))
        if (s.active !== worst.current.path) worst.current = { path: s.active, err: 0 }
        if (s.active) worst.current.err = Math.max(worst.current.err, s.errorM)
      } catch { /* keep polling */ }
    }, 50)
    return () => clearInterval(t)
  }, [connected])

  const nothing = connected && live && !live.robot
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--bg-page)" }}>
      {bar(
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <BarButton icon={paused ? "ti-player-play" : "ti-player-pause"} onClick={() => setPaused(p => !p)}>{paused ? "Resume" : "Pause"}</BarButton>
          <BarButton icon="ti-eraser" onClick={() => { setTrail([]); setHistory([]) }}>Clear trail</BarButton>
        </span>,
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <LiveField robot={robot} live={live} trail={trail} />
          <div style={{ position: "absolute", left: 10, top: 10, background: "rgba(255,255,255,0.94)", border: "1px solid var(--border-main)", padding: "6px 10px", fontSize: 11, lineHeight: 1.6 }}>
            <div><span style={{ color: COMMANDED }}>━</span> the path being driven</div>
            <div><span style={{ color: COMMANDED }}>┅</span> where the trajectory says to be</div>
            <div><span style={{ color: ACTUAL }}>■</span> the robot, and its trail</div>
          </div>
          {!connected && <Center>Connect to the robot (or the simulation) to see it drive.</Center>}
          {nothing && <Center>Connected, but nothing under /Ares: is the robot code running AresLib?</Center>}
        </div>
        <StatusColumn live={live} worst={worst.current} connected={connected} />
      </div>
      <div style={{ height: 190, flexShrink: 0, display: "flex", borderTop: "1px solid var(--border-main)" }}>
        <LineChart title="Speed" unit="m/s" history={history} series={[["cmdV", COMMANDED, "commanded"], ["measV", ACTUAL, "actual"]]} />
        <LineChart title="Turn rate" unit="rad/s" history={history} series={[["cmdW", COMMANDED, "commanded"], ["measW", ACTUAL, "actual"]]} symmetric />
        <LineChart title="Off the trajectory" unit="m" history={history} series={[["err", ACTUAL, "error"]]} />
      </div>
    </div>
  )
}

function StatusColumn({ live, worst, connected }: { live: LiveState | null; worst: { path: string; err: number }; connected: boolean }) {
  const row = (label: string, value: ReactNode) => (
    <div style={{ display: "flex", padding: "5px 14px", borderBottom: "1px solid var(--border-light)", fontSize: 11.5 }}>
      <span style={{ color: "var(--text-secondary)", flex: 1 }}>{label}</span>
      <span style={{ fontFamily: "Consolas, monospace", color: "var(--text-primary)", textAlign: "right" }}>{value}</span>
    </div>
  )
  const v = live ? Math.hypot(live.measured[0] ?? 0, live.measured[1] ?? 0) : 0
  return (
    <div style={{ width: 280, flexShrink: 0, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)", overflowY: "auto" }}>
      <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--border-light)" }}>
        <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase" }}>Driving</div>
        <div style={{ fontSize: 17, fontWeight: 700, marginTop: 3, color: live?.active ? "var(--text-primary)" : "var(--text-muted)" }}>
          {!connected ? "—" : live?.active || "No path running"}
        </div>
        {live?.active && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>t = {live.timeS.toFixed(2)} s</div>}
      </div>
      {row("Off the trajectory", live?.active ? `${(live.errorM * 100).toFixed(1)} cm` : "—")}
      {row("…at most, this path", worst.path ? `${(worst.err * 100).toFixed(1)} cm` : "—")}
      {row("Speed", live ? `${v.toFixed(2)} m/s` : "—")}
      {row("Times it replanned", live ? String(live.replans) : "—")}
      {row("Events now", live?.events.length ? live.events.join(", ") : "—")}
      {row("Robot", live?.robot ? `${live.robot.x.toFixed(2)}, ${live.robot.y.toFixed(2)} m · ${(live.robot.heading * 180 / Math.PI).toFixed(0)}°` : "—")}
      <div style={{ padding: "10px 14px", fontSize: 10.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
        <b>Gains</b> {live?.gainsSource ? `from ${live.gainsSource}` : ""}<br />
        {live?.translation.length ? <>translation kP {live.translation[0].toFixed(3)} kD {live.translation[2].toFixed(3)}<br />rotation kP {live.rotation[0]?.toFixed(3)} kD {live.rotation[2]?.toFixed(3)}</> : "—"}
      </div>
    </div>
  )
}

function Center({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", background: "rgba(255,255,255,0.95)", border: "1px solid var(--border-main)", padding: "10px 16px", fontSize: 12, color: "var(--text-secondary)" }}>
      {children}
    </div>
  )
}

/** The whole field, with what AresLib reports on it. */
function LiveField({ robot, live, trail }: { robot: RobotConfig; live: LiveState | null; trail: Pose[] }) {
  const field = FIELDS[0]
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
    const line = (pts: Pose[], color: string, width: number, dash: number[] = []) => {
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
    const bumper = (p: Pose, stroke: string, fill: string | null, dash: number[] = []) => {
      const [cx, cy] = toScreen(p.x, p.y)
      const hl = robot.bumper.lengthM / 2 * k, hw = robot.bumper.widthM / 2 * k
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
    if (live?.path.length) {
      line(live.path, "rgba(255,255,255,0.9)", 7)
      line(live.path, COMMANDED, 3)
    }
    // The trail, cut where the pose jumped (an odometry reset at the start
    // of an auto, a vision correction): no line across the field.
    let piece: Pose[] = []
    for (const p of trail) {
      const last = piece[piece.length - 1]
      if (last && Math.hypot(p.x - last.x, p.y - last.y) > 0.5) { line(piece, "rgba(47,111,219,0.55)", 2); piece = [] }
      piece.push(p)
    }
    line(piece, "rgba(47,111,219,0.55)", 2)
    if (live?.target && live.active) bumper(live.target, COMMANDED, null, [6, 4])
    if (live?.robot) bumper(live.robot, ACTUAL, "rgba(47,111,219,0.28)")
    // From where it should be to where it is.
    if (live?.target && live.robot && live.active) {
      const a = toScreen(live.target.x, live.target.y), b = toScreen(live.robot.x, live.robot.y)
      ctx.strokeStyle = "#1c1c1f"
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
    }
  }, [size, image, sketch, live, trail, view, robot])
  return (
    <div ref={host} style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  )
}

/** One measure over the last seconds; one or two series, with a legend and a hover readout. */
function LineChart({ title, unit, history, series, symmetric }: { title: string; unit: string; history: Sample[]; series: [keyof Sample, string, string][]; symmetric?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(300)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = host.current!
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const h = 150, pad = { l: 40, r: 10, t: 8, b: 20 }
  const t1 = history.length ? history[history.length - 1].t : WINDOW_S, t0 = t1 - WINDOW_S
  const vals = history.flatMap(s => series.map(([k]) => s[k] as number))
  const top = Math.max(0.1, ...vals.map(Math.abs)) * 1.15
  const lo = symmetric ? -top : 0
  const sx = (t: number) => pad.l + (t - t0) / WINDOW_S * (w - pad.l - pad.r)
  const sy = (v: number) => pad.t + (1 - (v - lo) / (top - lo)) * (h - pad.t - pad.b)
  const hp = hover !== null ? history[hover] : null
  return (
    <div style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--border-light)", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px 0", fontSize: 11 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 10, color: "var(--text-secondary)" }}>
          {series.length > 1 && series.map(([, color, label]) => (
            <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 14, borderTop: `2px solid ${color}` }} />{label}</span>
          ))}
        </span>
      </div>
      <div ref={host} style={{ position: "absolute", left: 0, right: 0, top: 24, bottom: 0 }}>
        <svg width={w} height={h} onMouseLeave={() => setHover(null)}
          onMouseMove={e => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            const t = t0 + (e.clientX - r.left - pad.l) / (w - pad.l - pad.r) * WINDOW_S
            let best = -1, d = Infinity
            history.forEach((s, i) => { const x = Math.abs(s.t - t); if (x < d) { d = x; best = i } })
            setHover(best >= 0 ? best : null)
          }}>
          {[lo, (lo + top) / 2, top].map(v => (
            <g key={v}>
              <line x1={pad.l} x2={w - pad.r} y1={sy(v)} y2={sy(v)} stroke="rgba(0,0,0,0.08)" />
              <text x={pad.l - 5} y={sy(v) + 3} textAnchor="end" fontSize={9.5} fill="var(--text-secondary)">{v.toFixed(Math.abs(top) < 1 ? 2 : 1)}</text>
            </g>
          ))}
          <text x={pad.l} y={h - 5} fontSize={9.5} fill="var(--text-secondary)">−{WINDOW_S} s</text>
          <text x={w - pad.r} y={h - 5} textAnchor="end" fontSize={9.5} fill="var(--text-secondary)">now · {unit}</text>
          {series.map(([k, color]) => (
            <path key={k} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round"
              d={history.map((s, i) => `${i ? "L" : "M"}${sx(s.t)},${sy(s[k] as number)}`).join("")} />
          ))}
          {hp && <line x1={sx(hp.t)} x2={sx(hp.t)} y1={pad.t} y2={h - pad.b} stroke="var(--text-muted)" />}
        </svg>
        {hp && (
          <div style={{ position: "absolute", left: Math.min(sx(hp.t) + 8, w - 150), top: 6, background: "var(--bg-page)", border: "1px solid var(--border-dark)", padding: "3px 7px", fontSize: 10.5, pointerEvents: "none" }}>
            {series.map(([k, , label]) => <div key={label}>{label} {(hp[k] as number).toFixed(3)} {unit}</div>)}
            {hp.active && <div style={{ color: "var(--text-muted)" }}>{hp.active}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
