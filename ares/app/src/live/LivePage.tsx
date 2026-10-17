import { ReactNode, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { RobotConfig } from "../robot/types"
import type { NtValue } from "../characterize/model"
import FieldCanvas from "../ui/FieldCanvas"
import TimeChart from "../ui/TimeChart"
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
            <div><span style={{ color: "#7c3aed" }}>┅</span> where to place it for the auto picked</div>
          </div>
          {!connected && <Center>Connect to the robot (or the simulation) to see it drive.</Center>}
          {nothing && <Center>Connected, but nothing under /Ares: is the robot code running AresLib?</Center>}
        </div>
        <StatusColumn live={live} worst={worst.current} connected={connected} />
      </div>
      <div style={{ height: 190, flexShrink: 0, display: "flex", borderTop: "1px solid var(--border-main)" }}>
        <TimeChart title="Speed" unit="m/s" rows={history} span={WINDOW_S} series={[["cmdV", COMMANDED, "commanded"], ["measV", ACTUAL, "actual"]]} />
        <TimeChart title="Turn rate" unit="rad/s" rows={history} span={WINDOW_S} series={[["cmdW", COMMANDED, "commanded"], ["measW", ACTUAL, "actual"]]} symmetric />
        <TimeChart title="Off the trajectory" unit="m" rows={history} span={WINDOW_S} series={[["err", ACTUAL, "error"]]} />
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
      {row("Auto picked", live?.auto || "—")}
      {live?.autoStart && live.auto && live.auto !== "None" && row("…starts at", `${live.autoStart.x.toFixed(2)}, ${live.autoStart.y.toFixed(2)} m · ${(live.autoStart.heading * 180 / Math.PI).toFixed(0)}°`)}
      {live?.autoStart && live.robot && live.auto && live.auto !== "None" && !live.active && row("…the robot is off by", `${(Math.hypot(live.robot.x - live.autoStart.x, live.robot.y - live.autoStart.y) * 100).toFixed(0)} cm`)}
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
  const { lengthM, widthM } = robot.bumper
  return (
    <FieldCanvas deps={[live, trail, robot]} draw={({ ctx, toScreen, line, trail: drawTrail, bumper }) => {
      if (live?.path.length) {
        line(live.path, "rgba(255,255,255,0.9)", 7)
        line(live.path, COMMANDED, 3)
      }
      drawTrail(trail, "rgba(47,111,219,0.55)", 2)
      // Before the match: where the robot goes for the auto picked.
      if (live?.autoStart && !live.active && live.auto && live.auto !== "None") {
        bumper(live.autoStart, lengthM, widthM, "#7c3aed", "rgba(124,58,237,0.12)", [5, 4])
      }
      if (live?.target && live.active) bumper(live.target, lengthM, widthM, COMMANDED, null, [6, 4])
      if (live?.robot) bumper(live.robot, lengthM, widthM, ACTUAL, "rgba(47,111,219,0.28)")
      // From where it should be to where it is.
      if (live?.target && live.robot && live.active) {
        const a = toScreen(live.target.x, live.target.y), b = toScreen(live.robot.x, live.robot.y)
        ctx.strokeStyle = "#1c1c1f"
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
      }
    }} />
  )
}
