import { ReactNode, useEffect, useState } from "react"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { Q, QInput } from "../ui/controls"
import { StopIcon, WaypointIcon, positionColor } from "./glyphs"
import {
  EventMarker, KeepOut, PathSpec, ScopedConstraint, Selection, Target, Trajectory, Waypoint, WaypointKind,
  constraintMeta, kindOf,
} from "./types"

interface Props {
  spec: PathSpec
  selected: NonNullable<Selection>
  keepOut: KeepOut[]
  trajectory: Trajectory | null
  stale: boolean
  onClose: () => void
  onWaypoint: (i: number, patch: Partial<Waypoint> | ((w: Waypoint) => Waypoint)) => void
  onSetKind: (i: number, kind: WaypointKind) => void
  onToggleStop: (i: number) => void
  stopOn: (i: number) => boolean
  waitOn: (i: number) => number
  onSetWait: (i: number, s: number) => void
  onConstraint: (i: number, patch: Partial<ScopedConstraint>) => void
  onEvent: (i: number, patch: Partial<EventMarker>) => void
  onKeepOut: (i: number, patch: Partial<KeepOut>) => void
  onDelete: () => void
  guessIntervals: (i: number) => number
}

const KINDS: { kind: WaypointKind; label: string; key: string }[] = [
  { kind: "pose", label: "Pose", key: "1" },
  { kind: "translation", label: "Translation", key: "2" },
  { kind: "empty", label: "Empty", key: "3" },
]

// Choreo's floating config panel: whatever is selected, edited right over
// the field without leaving it.
export default function ConfigPanel(p: Props) {
  const { spec, selected } = p
  const n = spec.waypoints.length
  let body: ReactNode = null
  let title = ""
  let icon: ReactNode = null

  if (selected.kind === "waypoint") {
    const i = selected.index
    const w = spec.waypoints[i]
    if (!w) return null
    const kind = kindOf(w)
    const isEnd = i === 0 || i === n - 1
    title = `Waypoint ${i + 1}`
    icon = <WaypointIcon kind={kind} color={positionColor(i, n, false)} />
    body = (
      <>
        <div style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: "1px solid var(--border-light)" }}>
          {KINDS.map(k => {
            const on = kind === k.kind
            const off = k.kind === "empty" && isEnd
            return (
              <button key={k.kind} disabled={off} onClick={() => p.onSetKind(i, k.kind)}
                title={off ? "The first and last waypoints cannot be empty" : `${k.label} (Shift+${k.key})`}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, height: 26, fontSize: 11, cursor: off ? "default" : "pointer",
                  border: "1px solid var(--btn-classic-border)", borderRadius: 2, opacity: off ? 0.4 : 1,
                  background: on ? "var(--toolbar-active-bg)" : "var(--btn-classic-bg)", fontWeight: on ? 600 : 400,
                }}>
                <WaypointIcon kind={k.kind} color={on ? "#2f6fdb" : "#55565c"} size={13} /> {k.label}
              </button>
            )
          })}
        </div>
        <Q label="X" dim="length" unit="m" value={w.x} onChange={v => p.onWaypoint(i, { x: v })} />
        <Q label="Y" dim="length" unit="m" value={w.y} onChange={v => p.onWaypoint(i, { y: v })} />
        {kind === "pose" && <Q label="Heading" dim="plain" unit="°" value={w.headingDeg} onChange={v => p.onWaypoint(i, { headingDeg: v })} />}
        <PropertyRow label="Stop here">
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11 }}>
            <input type="checkbox" checked={p.stopOn(i)} onChange={() => p.onToggleStop(i)} />
            <StopIcon on={p.stopOn(i)} size={13} />
            <span style={{ color: "var(--text-muted)" }}>{p.stopOn(i) ? "at rest here" : "passes through"}</span>
          </label>
        </PropertyRow>
        {p.stopOn(i) && (
          <Q label="Wait here" dim="plain" unit="s" value={p.waitOn(i)} onChange={v => p.onSetWait(i, Math.max(0, v))}
            hint="How long the robot stays stopped before moving on (to score, to intake). Everything after it happens that much later." />
        )}
        {i < n - 1 && (
          <PropertyRow label="Samples to next">
            <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }} title="How many intervals the optimizer uses up to the next waypoint. More is finer and slower to solve.">
              <input type="checkbox" checked={w.intervals !== undefined}
                onChange={e => p.onWaypoint(i, x => {
                  if (!e.target.checked) { const { intervals: _, ...rest } = x; return rest }
                  return { ...x, intervals: p.guessIntervals(i) }
                })} />
              {w.intervals !== undefined
                ? <QInput dim="plain" integer value={w.intervals} onChange={v => p.onWaypoint(i, { intervals: Math.max(1, Math.round(v)) })} />
                : <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>automatic</span>}
            </div>
          </PropertyRow>
        )}
        {!isEnd && (
          <PropertyRow label="Split here">
            <input type="checkbox" checked={!!w.split} onChange={e => p.onWaypoint(i, { split: e.target.checked || undefined })} />
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>the robot code can run each part</span>
          </PropertyRow>
        )}
      </>
    )
  } else if (selected.kind === "constraint") {
    const c = spec.scoped[selected.index]
    if (!c) return null
    const meta = constraintMeta(c.type)
    title = meta.label
    icon = c.type === "stopPoint" ? <StopIcon /> : <i className={`ti ${meta.icon}`} style={{ fontSize: 15, color: "#7c3aed" }} />
    body = <ConstraintFields c={c} n={n} onChange={patch => p.onConstraint(selected.index, patch)} />
  } else if (selected.kind === "event") {
    const e = (spec.events ?? [])[selected.index]
    if (!e) return null
    title = "Event marker"
    icon = <i className="ti ti-map-pin-bolt" style={{ fontSize: 15, color: "#a1690a" }} />
    const fired = p.trajectory?.events?.[selected.index]
    body = (
      <>
        <PropertyRow label="Name"><TextInput value={e.name} onCommit={name => p.onEvent(selected.index, { name })} /></PropertyRow>
        <PropertyRow label="From waypoint"><TargetSelect value={e.target} n={n} onChange={t => t && p.onEvent(selected.index, { target: t })} /></PropertyRow>
        <Q label="Offset" dim="plain" unit="s" value={e.offsetS} onChange={v => p.onEvent(selected.index, { offsetS: v })} hint="Negative fires before the waypoint" />
        {fired && !p.stale && (
          <PropertyRow label="Fires at">
            <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11 }}>{fired.t.toFixed(3)} s</span>
          </PropertyRow>
        )}
      </>
    )
  } else if (selected.kind === "keepout") {
    const k = p.keepOut[selected.index]
    if (!k) return null
    title = `Keep-out ${selected.index + 1}`
    icon = <i className="ti ti-circle-off" style={{ fontSize: 15, color: "#c21c1c" }} />
    body = (
      <>
        <div style={{ padding: "5px 10px", fontSize: 10.5, color: "var(--text-muted)", borderBottom: "1px solid var(--border-light)" }}>On the field: every path avoids it.</div>
        <Q label="X" dim="length" unit="m" value={k.x} onChange={v => p.onKeepOut(selected.index, { x: v })} />
        <Q label="Y" dim="length" unit="m" value={k.y} onChange={v => p.onKeepOut(selected.index, { y: v })} />
        <Q label="Radius" dim="length" unit="m" value={k.radiusM} onChange={v => p.onKeepOut(selected.index, { radiusM: v })} />
      </>
    )
  }

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: "absolute", left: 12, bottom: 12, width: 330, background: "var(--bg-page)", border: "1px solid var(--border-dark)",
        boxShadow: "2px 2px 0 var(--shadow-soft)", zIndex: 5, maxHeight: "calc(100% - 60px)", display: "flex", flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 6px 5px 10px", background: "var(--bg-panel-header)", borderBottom: "1px solid var(--border-main)" }}>
        {icon}
        <span style={{ fontSize: 11.5, fontWeight: 600 }}>{title}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <SmallButton icon="ti-trash" title="Delete (Del)" onClick={p.onDelete} />
          <SmallButton icon="ti-x" title="Close (Esc)" onClick={p.onClose} />
        </span>
      </div>
      <div style={{ overflowY: "auto" }}>{body}</div>
    </div>
  )
}

function ConstraintFields({ c, n, onChange }: { c: ScopedConstraint; n: number; onChange: (patch: Partial<ScopedConstraint>) => void }) {
  const meta = constraintMeta(c.type)
  const set = (patch: Record<string, unknown>) => onChange(patch as Partial<ScopedConstraint>)
  return (
    <>
      <div style={{ padding: "5px 10px", fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.45, borderBottom: "1px solid var(--border-light)" }}>{meta.hint}</div>
      <PropertyRow label="Enabled">
        <input type="checkbox" checked={c.enabled !== false} onChange={e => set({ enabled: e.target.checked ? undefined : false })} />
      </PropertyRow>
      <PropertyRow label={meta.scope === "waypoint" ? "Waypoint" : "From"}>
        <TargetSelect value={c.from} n={n} onChange={from => from && set({ from })} />
      </PropertyRow>
      {meta.scope !== "waypoint" && (
        <PropertyRow label="To">
          <TargetSelect value={c.to} n={n} allowNone={meta.scope === "both"} onChange={to => set({ to })} />
        </PropertyRow>
      )}
      {c.type === "stopPoint" && (
        <Q label="Wait" dim="plain" unit="s" value={c.waitS ?? 0} onChange={v => set({ waitS: v > 0 ? v : undefined })}
          hint="How long the robot stays stopped before moving on. Everything after it happens that much later." />
      )}
      {c.type === "maxVelocity" && <Q label="Max velocity" dim="plain" unit="m/s" value={c.mps} onChange={v => set({ mps: v })} />}
      {c.type === "maxAcceleration" && <Q label="Max acceleration" dim="plain" unit="m/s²" value={c.mps2} onChange={v => set({ mps2: v })} />}
      {c.type === "maxAngularVelocity" && <Q label="Max angular velocity" dim="plain" unit="°/s" value={c.dps} onChange={v => set({ dps: v })} />}
      {c.type === "pointAt" && (
        <>
          <Q label="Target X" dim="length" unit="m" value={c.x} onChange={v => set({ x: v })} />
          <Q label="Target Y" dim="length" unit="m" value={c.y} onChange={v => set({ y: v })} />
          <Q label="Tolerance" dim="plain" unit="°" value={c.toleranceDeg} onChange={v => set({ toleranceDeg: v })} />
          <PropertyRow label="Face">
            <select style={propertyInputStyle} value={c.flip ? "back" : "front"} onChange={e => set({ flip: e.target.value === "back" })}>
              <option value="front">Front toward it</option>
              <option value="back">Back toward it</option>
            </select>
          </PropertyRow>
        </>
      )}
      {(c.type === "keepInCircle" || c.type === "keepOutCircle") && (
        <>
          <Q label="Center X" dim="length" unit="m" value={c.x} onChange={v => set({ x: v })} />
          <Q label="Center Y" dim="length" unit="m" value={c.y} onChange={v => set({ y: v })} />
          <Q label="Radius" dim="length" unit="m" value={c.radiusM} onChange={v => set({ radiusM: v })} />
        </>
      )}
      {c.type === "keepInRectangle" && (
        <>
          <Q label="X (left)" dim="length" unit="m" value={c.x} onChange={v => set({ x: v })} />
          <Q label="Y (bottom)" dim="length" unit="m" value={c.y} onChange={v => set({ y: v })} />
          <Q label="Width" dim="length" unit="m" value={c.widthM} onChange={v => set({ widthM: v })} />
          <Q label="Height" dim="length" unit="m" value={c.heightM} onChange={v => set({ heightM: v })} />
        </>
      )}
      {c.type === "keepInLane" && <Q label="Tolerance" dim="length" unit="m" value={c.toleranceM} onChange={v => set({ toleranceM: v })} />}
    </>
  )
}

export function TargetSelect({ value, n, onChange, allowNone }: { value: Target | undefined; n: number; onChange: (t: Target | undefined) => void; allowNone?: boolean }) {
  const enc = (t: Target | undefined) => (t === undefined ? "none" : typeof t === "string" ? t : `i:${t.index}`)
  const dec = (s: string): Target | undefined => (s === "none" ? undefined : s === "first" || s === "last" ? s : { index: Number(s.slice(2)) })
  return (
    <select style={propertyInputStyle} value={enc(value)} onChange={e => onChange(dec(e.target.value))}>
      {allowNone && <option value="none">— (just the first waypoint)</option>}
      <option value="first">First (follows the start)</option>
      <option value="last">Last (follows the end)</option>
      {Array.from({ length: n }, (_, i) => <option key={i} value={`i:${i}`}>Waypoint {i + 1}</option>)}
    </select>
  )
}

/** Commits on Enter or blur, like the quantity inputs. */
export function TextInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value) }
  return (
    <input style={propertyInputStyle} value={text} onChange={e => setText(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
  )
}

function SmallButton({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button title={title} onClick={onClick}
      style={{ width: 22, height: 22, border: "none", background: "transparent", borderRadius: 2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,0,0,0.08)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
      <i className={`ti ${icon}`} style={{ fontSize: 14 }} />
    </button>
  )
}
