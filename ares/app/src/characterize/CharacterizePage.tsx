import { ReactNode, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { RobotConfig } from "../robot/types"
import type { RobotTuning } from "../tune/model"
import { useToast } from "../ui/toasts"
import { BarButton as Button, useNtConnection } from "../ui/NtConnect"
import { CharacterizationDoc, NtValue, PREFIX, ROUTINES, Routine, RoutineState, fit, readRoutines, runTopic, slot0 } from "./model"

// The Characterize tab: the swerve's feedforward and wheel radius measured
// on the robot, with no logs and no SysId. AresLib's routines (the team's
// DriveCharacterizationCommand, generalized) run on the robot and publish
// as they go; this starts them, watches the points come in and the line
// through them, and puts the results where they are used.

const INFO: Record<Routine, { title: string; icon: string; does: string; needs: string; speedUnit: string; minSpeed: number }> = {
  Drive: {
    title: "Drive kS / kV", icon: "ti-steering-wheel",
    does: "Spins in place stepping the drives from 1 to 6 V, both ways, and fits |V| = kS + kV·rps. The wheels roll on the carpet with the robot's weight, so kS includes that friction. The gyro gives the wheel radius on the side.",
    needs: "About 1.5 m clear around the robot. About 30 s.",
    speedUnit: "rotor rps", minSpeed: 1,
  },
  Steer: {
    title: "Steer kS / kV", icon: "ti-rotate-clockwise",
    does: "The robot stays put; the modules turn stepping the steers from 0.3 to 2 V, both ways, and it fits |V| = kS + kV·rps of the module.",
    needs: "Nothing in the way of the wheels. About 15 s.",
    speedUnit: "module rps", minSpeed: 0.075,
  },
  WheelRadius: {
    title: "Wheel radius", icon: "ti-circle-dashed",
    does: "Spins slowly for six seconds: the gyro's angle times the modules' distance from the center is how far the treads rolled; over how far the wheels turned, that is their true radius. Worn treads read smaller, and odometry built on the nominal one overshoots.",
    needs: "About 1.5 m clear. About 8 s.",
    speedUnit: "", minSpeed: 0,
  },
}

export default function CharacterizePage({ robot, robotPath, onRobot }: { robot: RobotConfig; robotPath: string | null; onRobot: (r: RobotConfig) => void }) {
  const toast = useToast()
  const { connected, bar } = useNtConnection()
  const [routines, setRoutines] = useState<Record<Routine, RoutineState | null>>({ Drive: null, Steer: null, WheelRadius: null })
  const [tuning, setTuning] = useState<RobotTuning | null>(null)
  const [saved, setSaved] = useState<CharacterizationDoc>({})
  const announced = useRef<Record<string, string>>({})

  useEffect(() => {
    if (!robotPath) return
    let folder: string | null = null
    try { folder = localStorage.getItem(`ares.robotCode:${robotPath}`) } catch { /* none */ }
    invoke<RobotTuning>("robot_tuning", { robotPath, folder }).then(setTuning).catch(() => {})
    invoke<CharacterizationDoc | null>("characterization_open", { robotPath }).then(d => setSaved(d ?? {})).catch(() => {})
  }, [robotPath])

  // While connected, the routines' topics five times a second.
  useEffect(() => {
    if (!connected) { setRoutines({ Drive: null, Steer: null, WheelRadius: null }); return }
    const t = setInterval(async () => {
      try {
        const values = await invoke<Record<string, NtValue>>("nt_read", { prefix: PREFIX })
        const next = readRoutines(values)
        setRoutines(next)
        // Say when one finishes or fails.
        for (const r of ROUTINES) {
          const s = next[r]?.state
          if (s && announced.current[r] && announced.current[r] === "running" && s !== "running") {
            toast(s.startsWith("done") ? { kind: "success", title: `${INFO[r].title}: ${s}` } : { kind: s === "stopped" ? "stopped" : "error", title: `${INFO[r].title}: ${s}` })
          }
          if (s) announced.current[r] = s
        }
      } catch { /* keep polling */ }
    }, 200)
    return () => clearInterval(t)
  }, [connected])

  const run = async (r: Routine, on: boolean) => {
    try { await invoke("nt_set_boolean", { topic: runTopic(r), value: on }) } catch (e) { toast({ kind: "error", title: "Could not start it", body: String(e) }) }
  }

  const save = async (doc: CharacterizationDoc, what: string) => {
    if (!robotPath) return
    const next = { ...saved, ...doc }
    try {
      await invoke("characterization_save", { robotPath, doc: next })
      setSaved(next)
      toast({ kind: "success", title: `${what} saved`, body: "In characterization.json: the Tune tab starts from it." })
    } catch (e) {
      toast({ kind: "error", title: "Could not save it", body: String(e) })
    }
  }
  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text)
    toast({ kind: "info", title: `Copied ${what}`, body: "Paste it into TunerConstants." })
  }

  const anyRoutine = ROUTINES.some(r => routines[r])
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--bg-page)" }}>
      {bar(connected && !anyRoutine && <span style={{ color: "#b45309", fontSize: 11.5 }}>No routines published: the code must call AresCharacterization.publish(...)</span>)}

      <div className="ares-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14, alignContent: "start" }}>
        {ROUTINES.map(r => (
          <RoutineCard key={r} routine={r} st={routines[r]} connected={connected} onRun={on => run(r, on)}>
            <Results routine={r} st={routines[r]} tuning={tuning} robot={robot} saved={saved}
              onSave={save} onCopy={copy}
              onRadius={m => { onRobot({ ...robot, drivetrain: { ...robot.drivetrain, wheelRadiusM: m } }); toast({ kind: "info", title: `Wheel radius ${(m * 1000).toFixed(2)} mm in the robot`, body: "Save the robot (Ctrl+S); generate the paths again so they use it." }) }} />
          </RoutineCard>
        ))}
        <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6, padding: "0 2px" }}>
          On the robot: <code>AresCharacterization.publish(CtreSwerve.of(drivetrain).characterizable(TunerConstants.FrontLeft));</code> once, in RobotContainer.
          The routines need the robot <b>enabled in teleop</b> and stop on their own (and at the first sign of something wrong: a speed past their limit).
          Nothing is logged: the numbers come out of the robot and show here.
        </div>
      </div>
    </div>
  )
}

function RoutineCard({ routine, st, connected, onRun, children }: { routine: Routine; st: RoutineState | null; connected: boolean; onRun: (on: boolean) => void; children: ReactNode }) {
  const info = INFO[routine]
  const running = st?.state === "running"
  const failed = st && !running && st.state !== "idle" && !st.state.startsWith("done") && st.state !== "stopped"
  return (
    <div style={{ border: "1px solid var(--border-main)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border-light)" }}>
        <i className={`ti ${info.icon}`} style={{ fontSize: 18, color: "#e95420" }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{info.title}</span>
        <span style={{ marginLeft: "auto" }}>
          {running
            ? <Button icon="ti-player-stop" danger onClick={() => onRun(false)}>Stop</Button>
            : <Button icon="ti-player-play" primary disabled={!connected || !st} onClick={() => onRun(true)}>Run</Button>}
        </span>
      </div>
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>
        {info.does}<br /><b>Needs:</b> {info.needs}
      </div>
      <div style={{ padding: "0 12px 6px", display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
        <span style={{ color: failed ? "#c21c1c" : running ? "#2f6fdb" : "var(--text-muted)", fontWeight: running || failed ? 600 : 400 }}>
          {!connected ? "connect to a robot" : !st ? "not on this robot" : st.state}
        </span>
        <div style={{ flex: 1, height: 4, background: "var(--border-light)", borderRadius: 2 }}>
          <div style={{ width: `${(st?.progress ?? 0) * 100}%`, height: "100%", background: "#2f6fdb", borderRadius: 2, transition: "width 200ms" }} />
        </div>
      </div>
      {children}
    </div>
  )
}

function Results({ routine, st, tuning, robot, saved, onSave, onCopy, onRadius }: {
  routine: Routine; st: RoutineState | null; tuning: RobotTuning | null; robot: RobotConfig; saved: CharacterizationDoc
  onSave: (d: CharacterizationDoc, what: string) => void; onCopy: (text: string, what: string) => void; onRadius: (m: number) => void
}) {
  const info = INFO[routine]
  if (routine === "WheelRadius") {
    const measured = st?.results.WheelRadiusM ?? st?.live
    return (
      <div style={{ padding: "6px 12px 12px", fontSize: 11.5 }}>
        <Compare rows={[
          ["Measured", measured !== undefined ? `${(measured * 1000).toFixed(2)} mm` : "—", true],
          ["robot.json", `${(robot.drivetrain.wheelRadiusM * 1000).toFixed(2)} mm`, false],
          ["TunerConstants", tuning?.wheelRadiusM ? `${(tuning.wheelRadiusM * 1000).toFixed(2)} mm` : "—", false],
          ["Last saved", saved.wheelRadiusM ? `${(saved.wheelRadiusM.value * 1000).toFixed(2)} mm` : "—", false],
        ]} />
        {st?.results.WheelRadiusM !== undefined && (
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <Button icon="ti-robot" onClick={() => onRadius(st.results.WheelRadiusM)}>Use in robot.json</Button>
            <Button icon="ti-device-floppy" onClick={() => onSave({ wheelRadiusM: { value: st.results.WheelRadiusM, at: Date.now() } }, "Wheel radius")}>Save</Button>
            <Button icon="ti-copy" onClick={() => onCopy(`private static final Distance kWheelRadius = Meters.of(${st.results.WheelRadiusM.toFixed(5)});`, "kWheelRadius")}>Copy for TunerConstants</Button>
          </div>
        )}
      </div>
    )
  }
  const live = st ? fit(st.volts, st.speed.map(Math.abs), info.minSpeed) : null
  const kS = st?.results.kS ?? live?.kS, kV = st?.results.kV ?? live?.kV, r2 = st?.results.R2 ?? live?.r2
  const now = routine === "Drive" ? { kS: tuning?.driveKs, kV: tuning?.driveKv, kP: tuning?.driveKp } : { kS: tuning?.steerKs, kV: tuning?.steerKv, kP: tuning?.steerKp }
  const last = routine === "Drive" ? saved.drive : saved.steer
  const done = st?.results.kV !== undefined
  return (
    <div style={{ padding: "0 12px 12px", fontSize: 11.5 }}>
      <SweepChart st={st} kS={kS} kV={kV} unit={info.speedUnit} minSpeed={info.minSpeed} />
      <Compare rows={[
        ["kS", fmtV(kS, "V"), true, fmtV(now.kS, "V")],
        ["kV", fmtV(kV, `V/${info.speedUnit.split(" ")[1] ?? "rps"}`), true, fmtV(now.kV, "")],
        ["R²", r2 !== undefined ? r2.toFixed(4) : "—", false, ""],
        ...(routine === "Drive" ? [
          ["kV, theory", fmtV(st?.results.kVTheory, ""), false, ""] as [string, string, boolean, string],
          ["Wheel radius (gyro)", st?.results.WheelRadiusM ? `${(st.results.WheelRadiusM * 1000).toFixed(2)} mm` : "—", false, ""] as [string, string, boolean, string],
        ] : []),
        ["Last saved", last ? `kS ${last.kS.toFixed(4)} · kV ${last.kV.toFixed(4)}` : "—", false, ""],
      ]} header={["", "measured", "TunerConstants"]} />
      {r2 !== undefined && r2 < 0.99 && done && <div style={{ color: "#b45309", marginTop: 6 }}><i className="ti ti-alert-triangle" /> R² under 0.99: a dusty carpet or a tired battery. Charge it and run again.</div>}
      {done && kS !== undefined && kV !== undefined && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <Button icon="ti-copy" onClick={() => onCopy(slot0(routine === "Drive" ? "driveGains" : "steerGains", kS, kV, now.kP ?? null, null), routine === "Drive" ? "driveGains" : "steerGains")}>Copy Slot0</Button>
          <Button icon="ti-device-floppy" onClick={() => onSave(routine === "Drive"
            ? { drive: { kS, kV, r2: r2 ?? 0, wheelRadiusM: st?.results.WheelRadiusM, at: Date.now() } }
            : { steer: { kS, kV, r2: r2 ?? 0, at: Date.now() } }, routine === "Drive" ? "Drive kS/kV" : "Steer kS/kV")}>Save (Tune uses it)</Button>
        </div>
      )}
    </div>
  )
}

/** The measured points and the line through them: speed across, |volts| up. */
function SweepChart({ st, kS, kV, unit, minSpeed }: { st: RoutineState | null; kS?: number; kV?: number; unit: string; minSpeed: number }) {
  const host = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(340)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = host.current!
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const h = 170, pad = { l: 36, r: 12, t: 10, b: 26 }
  const speeds = (st?.speed ?? []).map(Math.abs)
  const volts = (st?.volts ?? []).map(Math.abs)
  const xMax = Math.max(1e-6, ...speeds) * 1.1, yMax = Math.max(1, ...volts) * 1.1
  const sx = (v: number) => pad.l + v / xMax * (w - pad.l - pad.r)
  const sy = (v: number) => pad.t + (1 - v / yMax) * (h - pad.t - pad.b)
  const forward = (i: number) => (st?.volts[i] ?? 0) >= 0
  return (
    <div ref={host} style={{ position: "relative", margin: "4px 0" }}>
      <svg width={w} height={h} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        {[0, yMax / 2, yMax].map(v => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={sy(v)} y2={sy(v)} stroke="rgba(0,0,0,0.08)" />
            <text x={pad.l - 5} y={sy(v) + 3} textAnchor="end" fontSize={9.5} fill="var(--text-secondary)">{v.toFixed(1)} V</text>
          </g>
        ))}
        <text x={w - pad.r} y={h - 8} textAnchor="end" fontSize={9.5} fill="var(--text-secondary)">{unit} → {xMax.toFixed(xMax < 10 ? 2 : 0)}</text>
        <text x={pad.l} y={h - 8} fontSize={9.5} fill="var(--text-secondary)">0</text>
        {kS !== undefined && kV !== undefined && Number.isFinite(kS) && Number.isFinite(kV) && (
          <g>
            <line x1={sx(minSpeed)} y1={sy(kS + kV * minSpeed)} x2={sx(xMax)} y2={sy(kS + kV * xMax)} stroke="#e95420" strokeWidth={2} />
            <text x={sx(xMax * 0.62)} y={sy(kS + kV * xMax * 0.62) + 18} fontSize={10} fontWeight={600} fill="var(--text-primary)">
              {kS.toFixed(3)} V + {kV.toFixed(4)}·speed
            </text>
          </g>
        )}
        {speeds.map((s, i) => (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <circle cx={sx(s)} cy={sy(volts[i])} r={9} fill="transparent" />
            <circle cx={sx(s)} cy={sy(volts[i])} r={4.5} fill={forward(i) ? "#2f6fdb" : "var(--bg-page)"} stroke="#2f6fdb" strokeWidth={2} />
          </g>
        ))}
      </svg>
      <div style={{ position: "absolute", left: pad.l + 4, top: 4, fontSize: 10, color: "var(--text-secondary)", display: "flex", gap: 10 }}>
        <span><span style={{ color: "#2f6fdb" }}>●</span> forward</span>
        <span><span style={{ color: "#2f6fdb" }}>○</span> reverse</span>
        <span><span style={{ color: "#e95420" }}>━</span> fit</span>
      </div>
      {hover !== null && st && (
        <div style={{ position: "absolute", left: sx(speeds[hover]) + 10, top: sy(volts[hover]) - 10, background: "var(--bg-page)", border: "1px solid var(--border-dark)", padding: "3px 7px", fontSize: 10.5, pointerEvents: "none", whiteSpace: "nowrap" }}>
          {st.volts[hover].toFixed(2)} V → {st.speed[hover].toFixed(3)} {unit}
        </div>
      )}
      {!st?.speed.length && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--text-muted)" }}>
          The points show here as each step settles.
        </div>
      )}
    </div>
  )
}

function Compare({ rows, header }: { rows: ([string, string, boolean] | [string, string, boolean, string])[]; header?: string[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
      {header && <thead><tr style={{ color: "var(--text-muted)", fontSize: 10 }}>{header.map((h, i) => <th key={i} style={{ textAlign: i ? "right" : "left", fontWeight: 400, padding: "2px 0" }}>{h}</th>)}</tr></thead>}
      <tbody>
        {rows.map(([label, value, strong, now]) => (
          <tr key={label} style={{ borderTop: "1px solid var(--border-light)" }}>
            <td style={{ padding: "3px 0", color: "var(--text-secondary)" }}>{label}</td>
            <td style={{ textAlign: "right", fontFamily: "Consolas, monospace", fontWeight: strong ? 700 : 400, color: "var(--text-primary)" }}>{value}</td>
            {now !== undefined && <td style={{ textAlign: "right", fontFamily: "Consolas, monospace", color: "var(--text-muted)" }}>{now}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function fmtV(v: number | null | undefined, unit: string) {
  return v === undefined || v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(4)}${unit ? " " + unit : ""}`
}
