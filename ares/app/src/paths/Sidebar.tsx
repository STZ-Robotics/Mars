import { ReactNode, useState } from "react"
import { GLYPH, StopIcon, WaypointIcon, positionColor } from "./glyphs"
import {
  PathEntry, PathSpec, Selection, WaypointKind, constraintChip, constraintMeta, kindOf, rangeOf, stopAt, targetLabel,
} from "./types"

interface Props {
  entries: PathEntry[]
  activeName: string | null
  unsavedName: string | null
  spec: PathSpec | null
  selected: Selection
  onOpen: (e: PathEntry) => void
  onNewPath: () => void
  onDuplicatePath: () => void
  onDeletePath: () => void
  onSelect: (s: Selection) => void
  onHover: (s: Selection) => void
  onSetKind: (i: number, kind: WaypointKind) => void
  onToggleStop: (i: number) => void
  onMoveWaypoint: (from: number, to: number) => void
  onDeleteWaypoint: (i: number) => void
  onToggleConstraint: (i: number) => void
  onDeleteConstraint: (i: number) => void
  onDeleteEvent: (i: number) => void
  /** Rendered after the lists, in the same scroll. */
  children?: ReactNode
}

const NEXT_KIND: Record<WaypointKind, WaypointKind> = { pose: "translation", translation: "empty", empty: "pose" }
const KIND_LABEL: Record<WaypointKind, string> = { pose: "Pose", translation: "Translation", empty: "Empty" }

// Choreo's sidebar: the project's paths, then the open path's waypoints,
// constraints and event markers as lists. Every row says what it is at a
// glance (the same glyphs as the field) and the common edits are one click
// on the row itself: a waypoint's type, its stop, deleting it, dragging it
// to reorder. Hovering a row lights it up on the field.
export default function Sidebar(p: Props) {
  const spec = p.spec
  const n = spec?.waypoints.length ?? 0
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null)

  return (
    <div className="ares-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <Heading label="Paths" count={p.entries.length}>
        <IconButton icon="ti-plus" title="New path" onClick={p.onNewPath} />
        <IconButton icon="ti-copy" title="Duplicate path" onClick={p.onDuplicatePath} disabled={!spec} />
        <IconButton icon="ti-trash" title="Delete path" onClick={p.onDeletePath} disabled={!spec} />
      </Heading>
      <div style={{ maxHeight: 150, overflowY: "auto" }}>
        {p.entries.length === 0 && !p.unsavedName && <None>No paths yet.</None>}
        {p.entries.map(e => (
          <Item key={e.name} active={p.activeName === e.name} onClick={() => p.onOpen(e)} title={e.error ?? undefined}>
            <i className={`ti ${e.error ? "ti-alert-triangle" : "ti-route"}`} style={{ fontSize: 14, color: e.error ? "var(--status-error)" : "var(--icon-tree)" }} />
            <Label>{e.name}</Label>
          </Item>
        ))}
        {p.unsavedName && (
          <Item active>
            <i className="ti ti-route" style={{ fontSize: 14 }} />
            <Label>{p.unsavedName}</Label>
          </Item>
        )}
      </div>

      {spec && (
        <>
          <Heading label="Waypoints" count={n} />
          <div onMouseLeave={() => p.onHover(null)}>
            {spec.waypoints.map((w, i) => {
              const kind = kindOf(w)
              const sel = p.selected?.kind === "waypoint" && p.selected.index === i
              const stop = stopAt(spec, i) >= 0
              const color = positionColor(i, n, false)
              const isEnd = i === 0 || i === n - 1
              const over = drag && drag.over === i && drag.from !== i
              return (
                <Item
                  key={i}
                  active={sel}
                  onClick={() => p.onSelect({ kind: "waypoint", index: i })}
                  onMouseEnter={() => p.onHover({ kind: "waypoint", index: i })}
                  draggable
                  onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDrag({ from: i, over: null }) }}
                  onDragOver={e => { e.preventDefault(); if (drag && drag.over !== i) setDrag({ ...drag, over: i }) }}
                  onDrop={e => { e.preventDefault(); if (drag && drag.from !== i) p.onMoveWaypoint(drag.from, i); setDrag(null) }}
                  onDragEnd={() => setDrag(null)}
                  style={over ? { boxShadow: `inset 0 ${drag!.from < i ? -2 : 2}px 0 ${GLYPH.selected}` } : undefined}
                >
                  <i className="ti ti-grip-vertical" style={{ fontSize: 12, color: "var(--text-light)", cursor: "grab" }} title="Drag to reorder" />
                  <RowButton
                    title={`${KIND_LABEL[kind]}. Click for ${KIND_LABEL[NEXT_KIND[kind]]}${isEnd && NEXT_KIND[kind] === "empty" ? " (not at an end: skips to Pose)" : ""}`}
                    onClick={() => p.onSetKind(i, isEnd && NEXT_KIND[kind] === "empty" ? "pose" : NEXT_KIND[kind])}
                  >
                    <WaypointIcon kind={kind} color={sel ? "#ffffff" : color} />
                  </RowButton>
                  <Label>
                    {KIND_LABEL[kind]}
                    {kind === "pose" && w.headingDeg !== undefined && <Dim sel={sel}> {Math.round(w.headingDeg)}°</Dim>}
                    {w.split && <Dim sel={sel}> · split</Dim>}
                    {w.intervals !== undefined && <Dim sel={sel}> · {w.intervals} samples</Dim>}
                  </Label>
                  <span style={{ fontSize: 10.5, fontWeight: 600, width: 18, textAlign: "right", color: sel ? "#ffffff" : color }}>{i + 1}</span>
                  <RowButton title={stop ? "Stops here. Click to keep moving" : "Does not stop. Click to stop here"} onClick={() => p.onToggleStop(i)}>
                    <StopIcon on={stop} />
                  </RowButton>
                  <RowButton title={n > 2 ? "Delete waypoint" : "A path needs two waypoints"} onClick={() => n > 2 && p.onDeleteWaypoint(i)}>
                    <i className="ti ti-trash" style={{ fontSize: 13, opacity: n > 2 ? 0.75 : 0.25 }} />
                  </RowButton>
                </Item>
              )
            })}
          </div>

          <Heading label="Constraints" count={spec.scoped.length} />
          <div onMouseLeave={() => p.onHover(null)}>
            {spec.scoped.length === 0 && <None>None. Add one from the toolbar.</None>}
            {spec.scoped.map((c, i) => {
              const meta = constraintMeta(c.type)
              const [a, b] = rangeOf(c, n)
              const sel = p.selected?.kind === "constraint" && p.selected.index === i
              const on = c.enabled !== false
              return (
                <Item key={i} active={sel} dim={!on}
                  onClick={() => p.onSelect({ kind: "constraint", index: i })}
                  onMouseEnter={() => p.onHover({ kind: "constraint", index: i })}>
                  {c.type === "stopPoint" ? <StopIcon /> : <i className={`ti ${meta.icon}`} style={{ fontSize: 14, color: sel ? "#ffffff" : "#7c3aed" }} />}
                  <Label>
                    {meta.label}
                    {c.type !== "stopPoint" && <Dim sel={sel}> {constraintChip(c).replace(/^≤ /, "≤")}</Dim>}
                  </Label>
                  <span style={{ fontSize: 10, opacity: 0.85 }}>{a === b ? `${a + 1}` : `${a + 1} → ${b + 1}`}</span>
                  <RowButton title={on ? "Disable" : "Enable"} onClick={() => p.onToggleConstraint(i)}>
                    <i className={`ti ${on ? "ti-eye" : "ti-eye-off"}`} style={{ fontSize: 13, opacity: 0.75 }} />
                  </RowButton>
                  <RowButton title="Delete constraint" onClick={() => p.onDeleteConstraint(i)}>
                    <i className="ti ti-trash" style={{ fontSize: 13, opacity: 0.75 }} />
                  </RowButton>
                </Item>
              )
            })}
          </div>

          <Heading label="Event markers" count={(spec.events ?? []).length} />
          <div onMouseLeave={() => p.onHover(null)}>
            {(spec.events ?? []).length === 0 && <None>None. Event tool (E), then click a waypoint.</None>}
            {(spec.events ?? []).map((e, i) => {
              const sel = p.selected?.kind === "event" && p.selected.index === i
              return (
                <Item key={i} active={sel} onClick={() => p.onSelect({ kind: "event", index: i })} onMouseEnter={() => p.onHover({ kind: "event", index: i })}>
                  <i className="ti ti-map-pin-bolt" style={{ fontSize: 14, color: sel ? "#ffffff" : "#a1690a" }} />
                  <Label>{e.name}</Label>
                  <span style={{ fontSize: 10, opacity: 0.85 }}>{targetLabel(e.target)} {e.offsetS >= 0 ? "+" : ""}{e.offsetS.toFixed(2)} s</span>
                  <RowButton title="Delete event" onClick={() => p.onDeleteEvent(i)}>
                    <i className="ti ti-trash" style={{ fontSize: 13, opacity: 0.75 }} />
                  </RowButton>
                </Item>
              )
            })}
          </div>
        </>
      )}
      {p.children}
    </div>
  )
}

function Heading({ label, count, children }: { label: string; count?: number; children?: ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", height: 30, padding: "0 6px 0 12px", flexShrink: 0,
      background: "var(--bg-panel-header)", borderTop: "1px solid var(--border-main)", borderBottom: "1px solid var(--border-main)",
    }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)" }}>{label}</span>
      {count !== undefined && <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 6 }}>{count}</span>}
      <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>{children}</span>
    </div>
  )
}

function Item({ children, active, dim, onClick, onMouseEnter, title, style, ...drag }: {
  children: ReactNode; active?: boolean; dim?: boolean; onClick?: () => void; onMouseEnter?: () => void; title?: string
  style?: React.CSSProperties
  draggable?: boolean
  onDragStart?: React.DragEventHandler; onDragOver?: React.DragEventHandler; onDrop?: React.DragEventHandler; onDragEnd?: React.DragEventHandler
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onClick}
      title={title}
      onMouseEnter={() => { setHover(true); onMouseEnter?.() }}
      onMouseLeave={() => setHover(false)}
      {...drag}
      style={{
        display: "flex", alignItems: "center", gap: 7, height: 28, padding: "0 6px 0 8px", fontSize: 12, cursor: onClick ? "pointer" : "default",
        background: active ? "var(--tree-selection-bg)" : hover ? "var(--tree-hover-bg)" : "transparent",
        color: active ? "var(--tree-selection-fg)" : "var(--text-primary)",
        opacity: dim ? 0.5 : 1, borderBottom: "1px solid var(--border-light)", flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{children}</span>
}

function Dim({ children, sel }: { children: ReactNode; sel: boolean }) {
  return <span style={{ color: sel ? "rgba(255,255,255,0.8)" : "var(--text-muted)", fontSize: 11 }}>{children}</span>
}

function None({ children }: { children: ReactNode }) {
  return <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>{children}</div>
}

function RowButton({ children, title, onClick }: { children: ReactNode; title: string; onClick: () => void }) {
  return (
    <span
      title={title}
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 3, cursor: "pointer" }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,0,0,0.08)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </span>
  )
}

export function IconButton({ icon, title, onClick, disabled }: { icon: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{ width: 24, height: 24, border: "none", background: "transparent", borderRadius: 3, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.35 : 0.8, display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseEnter={e => !disabled && (e.currentTarget.style.background = "rgba(0,0,0,0.08)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <i className={`ti ${icon}`} style={{ fontSize: 15 }} />
    </button>
  )
}
