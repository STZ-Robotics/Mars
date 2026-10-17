import { ReactNode, useEffect, useState } from "react"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { Q, QInput } from "../ui/controls"
import { bindField } from "../vars/bind"
import { linkedPose } from "../vars/variables"
import { StopIcon, WaypointIcon, positionColor } from "./glyphs"
import CommandTree, { RobotNames } from "../autos/CommandTree"
import { markerLink } from "../autos/robotNames"
import type { Step } from "../autos/types"
import {
  facingDeg,
  EventMarker, KeepOut, PathSpec, PathfindOptions, RotationTarget, ScopedConstraint, SlowZone, SegmentMode, Selection, Target, Trajectory, Waypoint, WaypointKind,
  constraintMeta, kindOf, segmentMode,
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
  onSetSegment: (i: number, mode: SegmentMode) => void
  onPathfind: (i: number, patch: Partial<PathfindOptions>) => void
  onConstraint: (i: number, patch: Partial<ScopedConstraint>) => void
  /** The same, with a function of the current one (formula-aware fields). */
  onConstraintFn: (i: number, f: (c: ScopedConstraint) => ScopedConstraint) => void
  onEvent: (i: number, patch: Partial<EventMarker>) => void
  onEventFn: (i: number, f: (e: EventMarker) => EventMarker) => void
  onKeepOut: (i: number, patch: Partial<KeepOut>) => void
  onKeepOutFn: (i: number, f: (k: KeepOut) => KeepOut) => void
  /** Index of the stop constraint on waypoint i, or -1. */
  stopIndexOf: (i: number) => number
  onDelete: () => void
  guessIntervals: (i: number) => number
  /** The project's other paths, for "continue from". */
  otherPaths: string[]
  onContinueFrom: (name: string | undefined) => void
  /** Pose variables, for linking a waypoint to one. */
  poses: { name: string; computed: boolean }[]
  onLink: (i: number, name: string | null) => void
  onSaveAsPose: (i: number) => void
  onBranch: (i: number) => void
  zones: SlowZone[]
  onZoneFn: (i: number, f: (z: SlowZone) => SlowZone) => void
  onRotationFn: (i: number, f: (r: RotationTarget) => RotationTarget) => void
  /** The robot code's names, when it was found: what a marker's name links to. */
  robotNames: RobotNames | null
}

const KINDS: { kind: WaypointKind; label: string; key: string }[] = [
  { kind: "pose", label: "Pose", key: "1" },
  { kind: "translation", label: "Translation", key: "2" },
  { kind: "empty", label: "Empty", key: "3" },
]
/** The first waypoint can also be a start kind. */
const START_KINDS: { kind: WaypointKind; label: string; hint: string }[] = [
  { kind: "unknown", label: "Unknown start", hint: "The robot can start anywhere and pathfinds to the next waypoint. This position is only the likely start, for the estimate." },
  { kind: "continue", label: "Continue", hint: "Start where the previous path ended, at its speed. Pick the path to take its end pose." },
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
        {i === 0 && (
          <div style={{ display: "flex", gap: 4, padding: "6px 8px 0" }}>
            {START_KINDS.map(k => {
              const on = kind === k.kind
              return (
                <button key={k.kind} onClick={() => p.onSetKind(i, k.kind)} title={k.hint}
                  style={{
                    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, height: 26, fontSize: 11, cursor: "pointer",
                    border: "1px solid var(--btn-classic-border)", borderRadius: 2,
                    background: on ? "var(--toolbar-active-bg)" : "var(--btn-classic-bg)", fontWeight: on ? 600 : 400,
                  }}>
                  <WaypointIcon kind={k.kind} color="#55565c" size={13} /> {k.label}
                </button>
              )
            })}
          </div>
        )}
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
        {kind === "continue" && (
          <div title="The path this one continues: it starts at that path's generated end pose and speed. Without one, the robot starts from wherever the last path left it.">
            <PropertyRow label="Continue from">
              <select style={propertyInputStyle} value={p.spec.continuesFrom ?? ""} onChange={e => p.onContinueFrom(e.target.value || undefined)}>
                <option value="">— wherever the robot is</option>
                {p.otherPaths.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </PropertyRow>
          </div>
        )}
        {kind === "unknown" && (
          <div style={{ padding: "5px 10px", fontSize: 10.5, color: "#16a34a", lineHeight: 1.45, background: "rgba(22,163,74,0.06)", borderBottom: "1px solid var(--border-light)" }}>
            The robot pathfinds from wherever it is to waypoint 2. Put this point where it will most likely be: Ares estimates the route from here.
          </div>
        )}
        {kind !== "continue" || !p.spec.continuesFrom ? (
          <div title="Link this waypoint to a pose variable: moving either moves both, in every path that uses it.">
            <PropertyRow label="Pose variable">
              <span style={{ display: "flex", gap: 4, width: "100%" }}>
                <select style={propertyInputStyle} value={linkedPose(w) ?? ""} onChange={e => p.onLink(i, e.target.value || null)}>
                  <option value="">— not linked</option>
                  {p.poses.map(q => <option key={q.name} value={q.name}>⛓ {q.name}{q.computed ? " (formula)" : ""}</option>)}
                </select>
                <button onClick={() => p.onSaveAsPose(i)} title="Make this position a new pose variable and link to it"
                  style={{ fontSize: 10.5, padding: "0 6px", height: 20, border: "1px solid var(--btn-classic-border)", borderRadius: 2, background: "var(--btn-classic-bg)", cursor: "pointer", whiteSpace: "nowrap" }}>
                  + new
                </button>
              </span>
            </PropertyRow>
          </div>
        ) : null}
        <Q label="X" dim="length" unit="m" {...bindField(w, "x", f => p.onWaypoint(i, f))} />
        <Q label="Y" dim="length" unit="m" {...bindField(w, "y", f => p.onWaypoint(i, f))} />
        {(kind === "pose" || (kind === "continue" && w.headingDeg !== undefined)) && <Q label="Heading" dim="plain" unit="°" {...bindField(w, "headingDeg", f => p.onWaypoint(i, f))} />}
        <PropertyRow label="Stop here">
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11 }}>
            <input type="checkbox" checked={p.stopOn(i)} onChange={() => p.onToggleStop(i)} />
            <StopIcon on={p.stopOn(i)} size={13} />
            <span style={{ color: "var(--text-muted)" }}>{p.stopOn(i) ? "at rest here" : "passes through"}</span>
          </label>
        </PropertyRow>
        {p.stopOn(i) && (
          <Q label="Wait here" dim="plain" unit="s"
            {...(p.stopIndexOf(i) >= 0
              ? bindField(p.spec.scoped[p.stopIndexOf(i)], "waitS", f => p.onConstraintFn(p.stopIndexOf(i), f))
              : { value: p.waitOn(i), onChange: (v: number) => p.onSetWait(i, Math.max(0, v)) })}
            hint="How long the robot stays stopped before moving on (to score, to intake). Everything after it happens that much later." />
        )}
        {i < n - 1 && (
          <div title="Optimized: the optimizer shapes the curve to the next waypoint. Manual: you draw it with two handles (PathPlanner style) and the optimizer only times it. Pathfind: not planned; the robot finds its way there at run time from wherever it is, and Ares shows the likely route.">
            <PropertyRow label="Curve to next">
              <select style={propertyInputStyle} value={segmentMode(w)} onChange={e => p.onSetSegment(i, e.target.value as SegmentMode)}>
                <option value="optimized">Optimized (free shape)</option>
                <option value="manual">Manual (I draw it) ✎</option>
                <option value="pathfind">Pathfind at run time ?</option>
              </select>
            </PropertyRow>
          </div>
        )}
        {i < n - 1 && w.pathfindNext && (
          <>
            <div style={{ padding: "5px 10px", fontSize: 10.5, color: "#16a34a", lineHeight: 1.45, borderBottom: "1px solid var(--border-light)", background: "rgba(22,163,74,0.06)" }}>
              The robot pathfinds to waypoint {i + 2} with these limits. The path stops at both ends of this segment; the green route is Ares' estimate.
            </div>
            <Q label="Pathfind max speed" dim="plain" unit="m/s" optional hint="Empty: what the robot can do"
              {...bindField(w.pathfindNext, "maxVelocityMps", f => p.onWaypoint(i, x => ({ ...x, pathfindNext: f(x.pathfindNext ?? {}) })))} />
            <Q label="Pathfind max accel" dim="plain" unit="m/s²" optional hint="Empty: what the robot can do"
              {...bindField(w.pathfindNext, "maxAccelerationMps2", f => p.onWaypoint(i, x => ({ ...x, pathfindNext: f(x.pathfindNext ?? {}) })))} />
            <Q label="Pathfind max turn" dim="plain" unit="°/s" optional hint="Empty: what the robot can do"
              {...bindField(w.pathfindNext, "maxAngularVelocityDps", f => p.onWaypoint(i, x => ({ ...x, pathfindNext: f(x.pathfindNext ?? {}) })))} />
            <PropertyRow label="Enter moving">
              <input type="checkbox" checked={!!w.pathfindNext.keepMovingIn} onChange={e => p.onPathfind(i, { keepMovingIn: e.target.checked || undefined })} />
              <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>the part before does not stop at waypoint {i + 1}</span>
            </PropertyRow>
            <PropertyRow label="Leave moving">
              <input type="checkbox" checked={!!w.pathfindNext.keepMovingOut} onChange={e => p.onPathfind(i, { keepMovingOut: e.target.checked || undefined })} />
              <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>the part after starts at speed at waypoint {i + 2}</span>
            </PropertyRow>
          </>
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
                ? <QInput dim="plain" integer {...bindField(w, "intervals", f => p.onWaypoint(i, x => { const y = f(x); return { ...y, intervals: Math.max(1, Math.round(y.intervals ?? 1)) } }))} />
                : <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>automatic</span>}
            </div>
          </PropertyRow>
        )}
        {!isEnd && (
          <div title="Split the trajectory here: the part from here to the next split is a section the robot code can run on its own, by name.">
            <PropertyRow label="Section starts here">
              <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                <input type="checkbox" checked={!!(w.split || w.section)}
                  onChange={e => p.onWaypoint(i, x => (e.target.checked ? { ...x, split: true } : { ...x, split: undefined, section: undefined }))} />
                {(w.split || w.section) && (
                  <TextInput value={w.section ?? ""} onCommit={name => p.onWaypoint(i, x => ({ ...x, section: name || undefined, split: true }))} />
                )}
              </span>
            </PropertyRow>
          </div>
        )}
        {i < n - 1 && (
          <PropertyRow label="">
            <button onClick={() => p.onBranch(i)} title="Fork here: a new path that starts at this waypoint, at the robot's state there, taken when a condition from the robot code holds."
              style={{ fontSize: 10.5, padding: "0 8px", height: 20, border: "1px solid var(--btn-classic-border)", borderRadius: 2, background: "var(--btn-classic-bg)", cursor: "pointer" }}>
              ◆ Branch here…
            </button>
          </PropertyRow>
        )}
      </>
    )
  } else if (selected.kind === "constraint") {
    const c = spec.scoped[selected.index]
    if (!c) return null
    const meta = constraintMeta(c.type)
    title = meta.label
    icon = c.type === "stopPoint" ? <StopIcon /> : <i className={`ti ${meta.icon}`} style={{ fontSize: 15, color: "#e95420" }} />
    body = <ConstraintFields c={c} n={n} onChange={patch => p.onConstraint(selected.index, patch)} onUpdate={f => p.onConstraintFn(selected.index, f)} />
  } else if (selected.kind === "event") {
    const e = (spec.events ?? [])[selected.index]
    if (!e) return null
    title = "Event marker"
    icon = <i className="ti ti-map-pin-bolt" style={{ fontSize: 15, color: "#a1690a" }} />
    const fired = p.trajectory?.events?.[selected.index]
    body = (
      <>
        <PropertyRow label="Name"><TextInput value={e.name} list="ares-marker-names" onCommit={name => p.onEvent(selected.index, { name })} /></PropertyRow>
        <datalist id="ares-marker-names">
          {[...new Set([...(p.robotNames?.commands ?? []), ...(p.robotNames?.events ?? [])])].sort().map(c => <option key={c} value={c} />)}
        </datalist>
        <PropertyRow label="From waypoint"><TargetSelect value={e.target} n={n} onChange={t => t && p.onEvent(selected.index, { target: t })} /></PropertyRow>
        <Q label="Offset" dim="plain" unit="s" hint="Negative fires before the waypoint" {...bindField(e, "offsetS", f => p.onEventFn(selected.index, f))} />
        <Q label="Duration" dim="plain" unit="s" optional hint="Empty: a moment. A duration makes it a zone (PathPlanner's zoned events): from the start to start + duration."
          {...bindField(e, "durationS", f => p.onEventFn(selected.index, f))} />
        {fired && !p.stale && (
          <PropertyRow label="Fires at">
            <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11 }}>{fired.t.toFixed(3)} s</span>
          </PropertyRow>
        )}
        <MarkerCommand marker={e} names={p.robotNames} onChange={command => p.onEventFn(selected.index, m => {
          const { command: _, ...rest } = m
          return command ? { ...rest, command } : rest
        })} />
      </>
    )
  } else if (selected.kind === "zone") {
    const z = p.zones[selected.index]
    if (!z) return null
    const bz = (key: string) => bindField(z, key, f => p.onZoneFn(selected.index, f))
    title = `Slow zone ${selected.index + 1}`
    icon = <i className="ti ti-square-half" style={{ fontSize: 15, color: "#ca8a04" }} />
    body = (
      <>
        <div style={{ padding: "5px 10px", fontSize: 10.5, color: "var(--text-muted)", borderBottom: "1px solid var(--border-light)" }}>
          On the field: every path that passes through drives under these caps there.
        </div>
        <PropertyRow label="Name"><TextInput value={z.name ?? ""} onCommit={name => p.onZoneFn(selected.index, q => ({ ...q, name: name || undefined }))} /></PropertyRow>
        <PropertyRow label="Shape">
          <select style={propertyInputStyle} value={z.shape} onChange={e => p.onZoneFn(selected.index, q => (e.target.value === "circle"
            ? { name: q.name, maxVelocityMps: q.maxVelocityMps, maxAccelerationMps2: q.maxAccelerationMps2, shape: "circle", x: q.shape === "rectangle" ? q.x + q.widthM / 2 : q.x, y: q.shape === "rectangle" ? q.y + q.heightM / 2 : q.y, radiusM: q.shape === "rectangle" ? Math.max(q.widthM, q.heightM) / 2 : q.radiusM }
            : { name: q.name, maxVelocityMps: q.maxVelocityMps, maxAccelerationMps2: q.maxAccelerationMps2, shape: "rectangle", x: q.shape === "circle" ? q.x - q.radiusM : q.x, y: q.shape === "circle" ? q.y - q.radiusM : q.y, widthM: q.shape === "circle" ? 2 * q.radiusM : q.widthM, heightM: q.shape === "circle" ? 2 * q.radiusM : q.heightM }))}>
            <option value="rectangle">Rectangle</option>
            <option value="circle">Circle</option>
          </select>
        </PropertyRow>
        <Q label={z.shape === "rectangle" ? "X (left)" : "Center X"} dim="length" unit="m" {...bz("x")} />
        <Q label={z.shape === "rectangle" ? "Y (bottom)" : "Center Y"} dim="length" unit="m" {...bz("y")} />
        {z.shape === "rectangle" ? (
          <>
            <Q label="Width" dim="length" unit="m" {...bz("widthM")} />
            <Q label="Height" dim="length" unit="m" {...bz("heightM")} />
          </>
        ) : <Q label="Radius" dim="length" unit="m" {...bz("radiusM")} />}
        <Q label="Max speed" dim="plain" unit="m/s" optional {...bz("maxVelocityMps")} hint="Empty: no speed cap here" />
        <Q label="Max accel" dim="plain" unit="m/s²" optional {...bz("maxAccelerationMps2")} hint="Empty: no acceleration cap here" />
      </>
    )
  } else if (selected.kind === "rotation") {
    const r = (p.spec.rotationTargets ?? [])[selected.index]
    if (!r) return null
    const br = (key: string) => bindField(r, key, f => p.onRotationFn(selected.index, f))
    title = "Rotation target"
    icon = <i className="ti ti-rotate-clockwise-2" style={{ fontSize: 15, color: "#e95420" }} />
    body = (
      <>
        <div style={{ padding: "5px 10px", fontSize: 10.5, color: "var(--text-muted)", borderBottom: "1px solid var(--border-light)", lineHeight: 1.45 }}>
          A heading the robot hits partway along a segment, without a waypoint there (PathPlanner's rotation targets).
        </div>
        <PropertyRow label="Segment">
          <select style={propertyInputStyle} value={r.segment} onChange={e => p.onRotationFn(selected.index, q => ({ ...q, segment: Number(e.target.value) }))}>
            {Array.from({ length: Math.max(0, n - 1) }, (_, j) => <option key={j} value={j}>Waypoint {j + 1} → {j + 2}</option>)}
          </select>
        </PropertyRow>
        <Q label="Along the segment" dim="plain" unit="%" value={Math.round(r.fraction * 1000) / 10}
          onChange={v => p.onRotationFn(selected.index, q => ({ ...q, fraction: Math.min(1, Math.max(0, v / 100)) }))} hint="0% is the segment's start, 100% its end (by time)." />
        <Q label="Heading" dim="plain" unit="°" {...br("headingDeg")} />
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
        <Q label="X" dim="length" unit="m" {...bindField(k, "x", f => p.onKeepOutFn(selected.index, f))} />
        <Q label="Y" dim="length" unit="m" {...bindField(k, "y", f => p.onKeepOutFn(selected.index, f))} />
        <Q label="Radius" dim="length" unit="m" {...bindField(k, "radiusM", f => p.onKeepOutFn(selected.index, f))} />
      </>
    )
  }

  return (
    <div
      className="ares-rise"
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

function ConstraintFields({ c, n, onChange, onUpdate }: {
  c: ScopedConstraint; n: number; onChange: (patch: Partial<ScopedConstraint>) => void; onUpdate: (f: (c: ScopedConstraint) => ScopedConstraint) => void
}) {
  const meta = constraintMeta(c.type)
  const set = (patch: Record<string, unknown>) => onChange(patch as Partial<ScopedConstraint>)
  const b = (key: string) => bindField(c, key, onUpdate)
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
        <Q label="Wait" dim="plain" unit="s" {...b("waitS")}
          hint="How long the robot stays stopped before moving on. Everything after it happens that much later." />
      )}
      {c.type === "maxVelocity" && <Q label="Max velocity" dim="plain" unit="m/s" {...b("mps")} />}
      {c.type === "maxAcceleration" && <Q label="Max acceleration" dim="plain" unit="m/s²" {...b("mps2")} />}
      {c.type === "maxAngularVelocity" && <Q label="Max angular velocity" dim="plain" unit="°/s" {...b("dps")} />}
      {c.type === "pointAt" && (
        <>
          <Q label="Target X" dim="length" unit="m" {...b("x")} />
          <Q label="Target Y" dim="length" unit="m" {...b("y")} />
          <Q label="Tolerance" dim="plain" unit="°" {...b("toleranceDeg")} />
          <PropertyRow label="Aims">
            <select style={propertyInputStyle} value={[0, 90, 180, -90].includes(facingDeg(c)) ? String(facingDeg(c)) : "other"}
              onChange={e => set({ flip: false, offsetDeg: e.target.value === "other" ? 45 : Number(e.target.value) })}>
              <option value="0">The front</option>
              <option value="90">The left side</option>
              <option value="180">The back</option>
              <option value="-90">The right side</option>
              <option value="other">Another angle</option>
            </select>
          </PropertyRow>
          {![0, 90, 180, -90].includes(facingDeg(c)) && (
            <PropertyRow label="Angle from the front">
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <QInput dim="plain" value={facingDeg(c)} onChange={v => set({ flip: false, offsetDeg: v })} />°
              </span>
            </PropertyRow>
          )}
          <div style={{ padding: "2px 10px 6px", fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.4 }}>
            PathPlanner's point-towards zone: between the two waypoints the robot turns so that side faces the target (a shooter, an intake). Counterclockwise is positive.
          </div>
        </>
      )}
      {(c.type === "keepInCircle" || c.type === "keepOutCircle") && (
        <>
          <Q label="Center X" dim="length" unit="m" {...b("x")} />
          <Q label="Center Y" dim="length" unit="m" {...b("y")} />
          <Q label="Radius" dim="length" unit="m" {...b("radiusM")} />
        </>
      )}
      {c.type === "keepInRectangle" && (
        <>
          <Q label="X (left)" dim="length" unit="m" {...b("x")} />
          <Q label="Y (bottom)" dim="length" unit="m" {...b("y")} />
          <Q label="Width" dim="length" unit="m" {...b("widthM")} />
          <Q label="Height" dim="length" unit="m" {...b("heightM")} />
        </>
      )}
      {c.type === "keepInLane" && <Q label="Tolerance" dim="length" unit="m" {...b("toleranceM")} />}
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
export function TextInput({ value, onCommit, list }: { value: string; onCommit: (v: string) => void; list?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value) }
  return (
    <input style={propertyInputStyle} list={list} value={text} onChange={e => setText(e.target.value)} onBlur={commit}
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

/**
 * What the marker does on the robot: the robot code's command with its name,
 * or a command built here (PathPlanner's way), and whether the robot code has
 * anything by that name at all.
 */
function MarkerCommand({ marker, names, onChange }: { marker: { name: string; command?: Step }; names: RobotNames | null; onChange: (c: Step | undefined) => void }) {
  const link = markerLink(marker, names)
  const steps = marker.command ? (marker.command.type === "sequential" ? marker.command.steps : [marker.command]) : []
  const status: Record<typeof link.kind, [string, string, string]> = {
    built: ["ti-circle-check", "#16a34a", `Runs the command below. ares.event("${marker.name}") is true while it lasts.`],
    command: ["ti-circle-check", "#16a34a", `Runs "${marker.name}", registered in the robot code.`],
    trigger: ["ti-circle-check", "#16a34a", `Fires ares.event("${marker.name}") in the robot code.`],
    nothing: ["ti-alert-triangle", "#b45309", `Nothing in the robot code is called "${marker.name}": on the robot this marker does nothing. Register a command with that name, react to ares.event("${marker.name}"), or build its command here.`],
    unknown: ["ti-help-circle", "var(--text-muted)", "The robot code was not found (Autos → Robot code), so the name is not checked."],
  }
  const [icon, color, text] = status[link.kind]
  const tab = (on: boolean, label: string, onClick: () => void) => (
    <button onClick={onClick}
      style={{ flex: 1, height: 24, fontSize: 11, cursor: "pointer", border: "1px solid var(--btn-classic-border)", fontWeight: on ? 700 : 400,
        background: on ? "var(--toolbar-active-bg)" : "var(--btn-classic-bg)", color: on ? "var(--text-primary)" : "var(--text-secondary)" }}>
      {label}
    </button>
  )
  return (
    <div style={{ padding: "8px 10px 4px", borderTop: "1px solid var(--border-light)", marginTop: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)", marginBottom: 6 }}>On the robot</div>
      <div style={{ display: "flex", gap: 0, marginBottom: 6 }}>
        {tab(!marker.command, "By its name", () => onChange(undefined))}
        {tab(!!marker.command, "Build a command", () => !marker.command && onChange({ type: "sequential", steps: names?.commands.includes(marker.name) ? [{ type: "command", name: marker.name }] : [] }))}
      </div>
      <div style={{ display: "flex", gap: 6, fontSize: 11, lineHeight: 1.45, color: link.kind === "nothing" ? color : "var(--text-secondary)" }}>
        <i className={`ti ${icon}`} style={{ color, marginTop: 2 }} />
        <span>{text}</span>
      </div>
      {marker.command && (
        <div style={{ margin: "4px -8px 0" }}>
          <CommandTree steps={steps} onChange={s => onChange({ type: "sequential", steps: s })}
            paths={[]} autos={[]} durations={new Map()} status={{}} names={names} onHoverPath={() => {}}
            allow={["command", "wait", "sequential", "parallel", "deadline", "race", "if"]}
            rootLabel="Runs" rootHint={marker.command && steps.length ? "top to bottom" : "add what it does"} />
          {marker.command && !steps.length && <div style={{ fontSize: 10.5, color: "#b45309", padding: "0 10px" }}>Empty: the marker does nothing yet.</div>}
          <datalist id="ares-commands">{(names?.commands ?? []).map(c => <option key={c} value={c} />)}</datalist>
          <datalist id="ares-conditions">{(names?.conditions ?? []).map(c => <option key={c} value={c} />)}</datalist>
        </div>
      )}
    </div>
  )
}
