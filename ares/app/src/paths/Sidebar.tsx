import { ReactNode, useState } from "react"
import type { RobotNames } from "../autos/CommandTree"
import { markerLink } from "../autos/robotNames"
import { FolderRow, ITEM_MIME, LooseDrop, groupByFolder } from "../ui/Folders"
import { GLYPH, StopIcon, WaypointIcon, positionColor } from "./glyphs"
import { linkedPose } from "../vars/variables"
import {
  PathEntry, PathSpec, PathStatus, SegmentMode, Selection, WaypointKind, constraintChip, constraintMeta, kindOf, rangeOf, segmentMode, stopAt, targetLabel, waitAt,
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
  onCycleSegment: (i: number) => void
  onMoveWaypoint: (from: number, to: number) => void
  onDeleteWaypoint: (i: number) => void
  onToggleConstraint: (i: number) => void
  onDeleteConstraint: (i: number) => void
  onDeleteEvent: (i: number) => void
  /** The robot code's names, for marking the event markers that do nothing on the robot. */
  robotNames?: RobotNames | null
  /** Folders (PathPlanner's path folders): the project's, and moving paths into them. */
  folders: string[]
  folderOpen: (name: string) => boolean
  onToggleFolder: (name: string) => void
  onMoveToFolder: (path: string, folder: string | undefined) => void
  onAddFolder: () => void
  onRenameFolder: (from: string, to: string) => void
  onDeleteFolder: (name: string) => void
  onDeleteRotation: (i: number) => void
  /** Per path: generated and up to date. */
  status: Record<string, PathStatus>
  onGenerateMany: (which: "outdated" | "all") => void
  /** Rendered after the lists, in the same scroll. */
  children?: ReactNode
}

const NEXT_KIND: Record<WaypointKind, WaypointKind> = { pose: "translation", translation: "empty", empty: "pose", unknown: "continue", continue: "pose" }
/** The first waypoint cycles through the start kinds too. */
const NEXT_START: Record<WaypointKind, WaypointKind> = { pose: "translation", translation: "unknown", unknown: "continue", continue: "pose", empty: "pose" }
export const KIND_LABEL: Record<WaypointKind, string> = { pose: "Pose", translation: "Translation", empty: "Empty", unknown: "Unknown start", continue: "Continue" }

// Choreo's sidebar: the project's paths, then the open path's waypoints,
// constraints and event markers as lists. Every row says what it is at a
// glance (the same glyphs as the field) and the common edits are one click
// on the row itself: a waypoint's type, its stop, deleting it, dragging it
// to reorder. Hovering a row lights it up on the field.
export default function Sidebar(p: Props) {
  const row = ({ entry: e, depth }: { entry: PathEntry; depth: number }) => {
    const st = p.status[e.name]
    const sp = e.spec
    const isBranch = !!sp?.continuesFrom && sp.continuesAt !== undefined
    const isChain = !!sp?.continuesFrom && sp.continuesAt === undefined
    const active = p.activeName === e.name
    const dot = !st?.generated ? "var(--text-light)" : st.outdated ? "#d97706" : "#16a34a"
    return (
      <Item key={e.name} active={active} onClick={() => p.onOpen(e)}
        draggable onDragStart={ev => { ev.dataTransfer.setData(ITEM_MIME, e.name); ev.dataTransfer.effectAllowed = "move" }}
        title={e.error ?? `${e.name}${isBranch ? `: branch of ${sp!.continuesFrom} at waypoint ${sp!.continuesAt! + 1}, when ${sp!.condition ?? "?"}` : isChain ? `: continues ${sp!.continuesFrom}` : ""}. ${!st?.generated ? "Not generated." : st.outdated ? "Out of date: generate again." : "Up to date."}`}
        style={{ paddingLeft: 8 + depth * 16 }}>
        {e.error ? <i className="ti ti-alert-triangle" style={{ fontSize: 14, color: "var(--status-error)" }} />
          : isBranch ? <span style={{ color: active ? "#ffffff" : "#db2777", fontSize: 12, width: 14, textAlign: "center" }}>◆</span>
          : isChain ? <span style={{ color: active ? "#ffffff" : "#0e7490", fontSize: 13, width: 14, textAlign: "center" }}>↪</span>
          : <i className="ti ti-route" style={{ fontSize: 14, color: active ? "#ffffff" : "var(--icon-tree)" }} />}
        <Label>
          {e.name}
          {isBranch && sp!.condition && <Dim sel={active}> · if {sp!.condition}</Dim>}
          {(sp?.variants?.length ?? 0) > 0 && <Dim sel={active}> · {sp!.variants!.length} variant{sp!.variants!.length > 1 ? "s" : ""}</Dim>}
        </Label>
        {st?.durationS != null && <span style={{ fontSize: 10, opacity: 0.8, fontFamily: "Consolas, 'Cascadia Mono', monospace" }}>{st.durationS.toFixed(2)} s</span>}
        <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, flexShrink: 0, boxShadow: active ? "0 0 0 1.5px #ffffff" : undefined }} />
      </Item>
    )
  }
  const spec = p.spec
  const n = spec?.waypoints.length ?? 0
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null)

  return (
    <div className="ares-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <Heading label="Paths" count={p.entries.length}>
        <IconButton icon="ti-refresh-alert" title="Generate all outdated: every path not generated, or generated from something that changed, in order (a path before what continues from it)" onClick={() => p.onGenerateMany("outdated")} />
        <IconButton icon="ti-stack-2" title="Generate all: every path and variant, in order" onClick={() => p.onGenerateMany("all")} />
        <IconButton icon="ti-folder-plus" title="New folder (drag paths onto it)" onClick={p.onAddFolder} />
        <IconButton icon="ti-plus" title="New path" onClick={p.onNewPath} />
        <IconButton icon="ti-copy" title="Duplicate path" onClick={p.onDuplicatePath} disabled={!spec} />
        <IconButton icon="ti-trash" title="Delete path" onClick={p.onDeletePath} disabled={!spec} />
      </Heading>
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {p.entries.length === 0 && !p.unsavedName && <None>No paths yet.</None>}
        {(() => {
          // Each path goes with the top of its chain: branches stay under their path.
          const rows = tree(p.entries)
          const chains: { entry: PathEntry; depth: number }[][] = []
          for (const r of rows) { if (r.depth === 0 || !chains.length) chains.push([r]); else chains[chains.length - 1].push(r) }
          const { groups, loose } = groupByFolder(chains, c => c[0].entry.spec?.folder, p.folders)
          return (
            <>
              {groups.map(([f, cs]) => (
                <div key={`folder:${f}`}>
                  <FolderRow name={f} count={cs.reduce((n, c) => n + c.length, 0)} open={p.folderOpen(f)} onToggle={() => p.onToggleFolder(f)}
                    onDropItem={name => p.onMoveToFolder(name, f)} onRename={to => p.onRenameFolder(f, to)} onDelete={() => p.onDeleteFolder(f)} />
                  {p.folderOpen(f) && cs.flat().map(r => row({ ...r, depth: r.depth + 1 }))}
                </div>
              ))}
              <LooseDrop onDropItem={name => p.onMoveToFolder(name, undefined)}>
                {loose.flat().map(row)}
              </LooseDrop>
            </>
          )
        })()}
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
              const over = drag && drag.over === i && drag.from !== i
              return (
                <Item
                  key={i}
                  active={sel}
                  title={`Waypoint ${i + 1}: ${KIND_LABEL[kind]}${stop ? (waitAt(spec, i) > 0 ? `, stops ${waitAt(spec, i)} s` : ", stops") : ""}. Click to edit, drag to reorder.`}
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
                    title={`${KIND_LABEL[kind]}. Click for ${KIND_LABEL[nextKind(i, n, kind)]}`}
                    onClick={() => p.onSetKind(i, nextKind(i, n, kind))}
                  >
                    <WaypointIcon kind={kind} color={sel ? "#ffffff" : color} />
                  </RowButton>
                  <Label>
                    {KIND_LABEL[kind]}
                    {kind === "pose" && w.headingDeg !== undefined && <Dim sel={sel}> {Math.round(w.headingDeg)}°</Dim>}
                    {linkedPose(w) && <Dim sel={sel}> · ⛓ {linkedPose(w)}</Dim>}
                    {i === 0 && kind === "continue" && spec.continuesFrom && <Dim sel={sel}> · after {spec.continuesFrom}</Dim>}
                    {waitAt(spec, i) > 0 && <Dim sel={sel}> · waits {waitAt(spec, i)} s</Dim>}
                    {(w.split || w.section) && <Dim sel={sel}> · ✂ {w.section ?? "split"}</Dim>}
                    {segmentMode(w) === "manual" && <Dim sel={sel}> · ✎ manual →</Dim>}
                    {segmentMode(w) === "pathfind" && <Dim sel={sel}> · ? pathfind →</Dim>}
                    {w.intervals !== undefined && <Dim sel={sel}> · {w.intervals} samples</Dim>}
                  </Label>
                  <span style={{ fontSize: 10.5, fontWeight: 600, width: 18, textAlign: "right", color: sel ? "#ffffff" : color }}>{i + 1}</span>
                  {i < n - 1 ? (
                    <RowButton title={SEGMENT_HELP[segmentMode(w)]} onClick={() => p.onCycleSegment(i)}>
                      <SegmentIcon mode={segmentMode(w)} sel={sel} />
                    </RowButton>
                  ) : <span style={{ width: 22 }} />}
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
                <Item key={i} active={sel} dim={!on} title={`${meta.label}: ${meta.hint}`}
                  onClick={() => p.onSelect({ kind: "constraint", index: i })}
                  onMouseEnter={() => p.onHover({ kind: "constraint", index: i })}>
                  {c.type === "stopPoint" ? <StopIcon /> : <i className={`ti ${meta.icon}`} style={{ fontSize: 14, color: sel ? "#ffffff" : "#e95420" }} />}
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

          {(spec.rotationTargets ?? []).length > 0 && (
            <>
              <Heading label="Rotation targets" count={(spec.rotationTargets ?? []).length} />
              <div onMouseLeave={() => p.onHover(null)}>
                {(spec.rotationTargets ?? []).map((r, i) => {
                  const sel = p.selected?.kind === "rotation" && p.selected.index === i
                  return (
                    <Item key={i} active={sel} title="A heading to hit partway along a segment. Click to edit, or drag its arrow on the field."
                      onClick={() => p.onSelect({ kind: "rotation", index: i })} onMouseEnter={() => p.onHover({ kind: "rotation", index: i })}>
                      <i className="ti ti-rotate-clockwise-2" style={{ fontSize: 14, color: sel ? "#ffffff" : "#e95420" }} />
                      <Label>{r.headingDeg.toFixed(0)}°</Label>
                      <span style={{ fontSize: 10, opacity: 0.85 }}>{r.segment + 1} → {r.segment + 2} · {Math.round(r.fraction * 100)}%</span>
                      <RowButton title="Delete rotation target" onClick={() => p.onDeleteRotation(i)}>
                        <i className="ti ti-trash" style={{ fontSize: 13, opacity: 0.75 }} />
                      </RowButton>
                    </Item>
                  )
                })}
              </div>
            </>
          )}

          <Heading label="Event markers" count={(spec.events ?? []).length} />
          <div onMouseLeave={() => p.onHover(null)}>
            {(spec.events ?? []).length === 0 && <None>None. Event tool (E), then click a waypoint.</None>}
            {(spec.events ?? []).map((e, i) => {
              const sel = p.selected?.kind === "event" && p.selected.index === i
              return (
                <Item key={i} active={sel} onClick={() => p.onSelect({ kind: "event", index: i })} onMouseEnter={() => p.onHover({ kind: "event", index: i })}>
                  <i className="ti ti-map-pin-bolt" style={{ fontSize: 14, color: sel ? "#ffffff" : "#a1690a" }} />
                  <Label>{e.name}{e.durationS ? <Dim sel={sel}> · {e.durationS} s zone</Dim> : null}</Label>
                  <MarkerBadge link={markerLink(e, p.robotNames ?? null).kind} sel={sel} />
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

const SEGMENT_HELP: Record<SegmentMode, string> = {
  optimized: "To the next waypoint: the optimizer shapes the curve. Click to draw it yourself",
  manual: "To the next waypoint: your curve (manual), the optimizer only times it. Click to pathfind there at run time instead",
  pathfind: "To the next waypoint: the robot pathfinds at run time (?), Ares estimates the route. Click to let the optimizer shape it",
}

function SegmentIcon({ mode, sel }: { mode: SegmentMode; sel: boolean }) {
  if (mode === "pathfind") {
    return (
      <span style={{ width: 15, height: 15, borderRadius: 8, background: "#16a34a", color: "#ffffff", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: sel ? "0 0 0 1.5px #ffffff" : undefined }}>?</span>
    )
  }
  if (mode === "manual") return <i className="ti ti-pencil" style={{ fontSize: 13, color: sel ? "#ffffff" : "#e95420" }} />
  return <i className="ti ti-wave-sine" style={{ fontSize: 13, color: sel ? "rgba(255,255,255,0.8)" : "var(--text-light)" }} />
}

/**
 * The paths as a tree: what continues or branches from a path hangs under
 * it. Paths whose parent is missing (or a cycle) stay at the root.
 */
function tree(entries: PathEntry[]): { entry: PathEntry; depth: number }[] {
  const names = new Set(entries.map(e => e.name))
  const children = new Map<string, PathEntry[]>()
  const roots: PathEntry[] = []
  for (const e of entries) {
    const parent = e.spec?.continuesFrom
    if (parent && names.has(parent) && parent !== e.name) children.set(parent, [...(children.get(parent) ?? []), e])
    else roots.push(e)
  }
  const out: { entry: PathEntry; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (e: PathEntry, depth: number) => {
    if (seen.has(e.name)) return
    seen.add(e.name)
    out.push({ entry: e, depth })
    // Branches in fork order, then continuations.
    const kids = (children.get(e.name) ?? []).slice().sort((a, b) => (a.spec?.continuesAt ?? 1e9) - (b.spec?.continuesAt ?? 1e9))
    kids.forEach(k => walk(k, depth + 1))
  }
  roots.forEach(r => walk(r, 0))
  entries.forEach(e => walk(e, 0))
  return out
}

/** The next kind when cycling a waypoint's type from its row. */
function nextKind(i: number, n: number, kind: WaypointKind): WaypointKind {
  if (i === 0) return NEXT_START[kind]
  const k = NEXT_KIND[kind]
  return (i === n - 1 && k === "empty") || k === "unknown" || k === "continue" ? "pose" : k
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

/** What a marker does on the robot, at a glance. */
function MarkerBadge({ link, sel }: { link: ReturnType<typeof markerLink>["kind"]; sel: boolean }) {
  if (link === "unknown") return null
  const [icon, color, title] = link === "built" ? ["ti-terminal-2", "#e95420", "Runs the command built on it"]
    : link === "command" ? ["ti-link", "#16a34a", "Runs the robot code's command with its name"]
    : link === "trigger" ? ["ti-bolt", "#16a34a", "Fires an ares.event trigger in the robot code"]
    : ["ti-alert-triangle", "#d97706", "Nothing in the robot code has this name: it does nothing on the robot"]
  return <i className={`ti ${icon}`} title={title} style={{ fontSize: 13, color: sel ? "#ffffff" : color }} />
}
