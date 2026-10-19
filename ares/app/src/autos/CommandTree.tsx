import { ReactNode, useEffect, useRef, useState } from "react"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import type { PathSpec, PathStatus } from "../paths/types"
import { Auto, GROUPS, GroupType, ListKey, Step, StepPath, Trigger, duration, isGroup, moveStep, pathKey, updateList } from "./types"

// The auto as a tree of cards. Every group has a + that
// adds a command to it, its type can be changed in place, and any card can be
// dragged to another place, in its list or into another group.

/** What the robot code registers (see src-tauri/src/robot_code.rs). */
export interface RobotNames { root: string | null; commands: string[]; conditions: string[]; events: string[]; files: number }

interface Props {
  steps: Step[]
  onChange: (steps: Step[]) => void
  paths: PathSpec[]
  /** The other autos, for "Run auto". */
  autos: Auto[]
  durations: Map<string, number>
  status: Record<string, PathStatus>
  /** The robot code's names when it was found: what is not in it is flagged. */
  names: RobotNames | null
  onHoverPath: (key: string | null) => void
  /** What can be added (all by default): an event marker's command takes no paths. */
  allow?: Step["type"][]
  /** The root list's header (the auto's, by default). */
  rootLabel?: string
  rootHint?: string
  /** When each card runs in the preview (by card key), its warnings, and which run at the playhead. */
  timing?: ReadonlyMap<string, { start: number; end: number }>
  warnings?: ReadonlyMap<string, string[]>
  active?: ReadonlySet<string>
  /** The card picked with a click, for the keyboard (copy, paste, delete). */
  selected?: string | null
  onSelect?: (key: string | null) => void
}

/** What a path or a command dragged in from outside the tree carries. */
export const STEP_MIME = "application/x-ares-step"

const GROUP_LABEL: Record<GroupType, string> = {
  sequential: "Sequential Group", parallel: "Parallel Group", deadline: "Deadline Group", race: "Race Group",
}
const GROUP_HELP: Record<GroupType, string> = {
  sequential: "One after another.",
  parallel: "All at once; ends when every one has ended.",
  deadline: "All at once; ends when the FIRST one ends, cutting the rest. Put the path first and what happens during it after.",
  race: "All at once; ends when ANY one ends, cutting the rest.",
}
const COLOR: Record<string, string> = {
  path: "#2f6fdb", command: "#e95420", wait: "#68686f", sequential: "#52525b", parallel: "#0e7490",
  deadline: "#0e7490", race: "#0e7490", if: "#db2777", when: "#7c3aed", auto: "#0f766e",
}
const ICON: Record<string, string> = {
  path: "ti-route", command: "ti-terminal-2", wait: "ti-clock-pause", sequential: "ti-list-numbers", parallel: "ti-arrows-right",
  deadline: "ti-flag-2", race: "ti-flag-3", if: "ti-arrows-split-2", when: "ti-bolt", auto: "ti-list-details",
}

type Drag = { from: StepPath; index: number }

export default function CommandTree(p: Props) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const root = p.steps
  const editList = (at: StepPath, f: (l: Step[]) => Step[]) => p.onChange(updateList(root, at, f))
  const keyOf = (at: StepPath, i: number) => [...at, i].join("/")

  const ctx: Ctx = {
    ...p, drag, setDrag, over, setOver, editList, keyOf,
    collapsed: k => collapsed.has(k),
    toggle: k => setCollapsed(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n }),
    drop: (at, index, e) => {
      if (drag) p.onChange(moveStep(root, drag.from, drag.index, at, index))
      else {
        // From the lists beside the tree: a path or a robot command.
        try {
          const s = JSON.parse(e.dataTransfer.getData(STEP_MIME)) as Step
          if (s && typeof s.type === "string") p.onChange(updateList(root, at, l => [...l.slice(0, index), s, ...l.slice(index)]))
        } catch { /* not a step */ }
      }
      setDrag(null)
      setOver(null)
    },
  }

  const total = duration(root, p.durations, new Map(p.autos.map(a => [a.name, a])))
  return (
    <div style={{ padding: "6px 8px 10px" }} onDragEnd={() => { setDrag(null); setOver(null) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 2px 6px" }}>
        <i className="ti ti-list-numbers" style={{ color: COLOR.sequential, fontSize: 15 }} />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{p.rootLabel ?? "Sequential Group"}</span>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{p.rootHint ?? "the auto, top to bottom"}</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, fontFamily: "Consolas, 'Cascadia Mono', monospace", color: "var(--text-muted)" }}>{fmt(total.min, total.max)}</span>
        <AddMenu ctx={ctx} onPick={s => editList([], l => [...l, s])} big />
      </div>
      <ListView ctx={ctx} list={root} at={[]} />
    </div>
  )
}

interface Ctx extends Props {
  drag: Drag | null
  setDrag: (d: Drag | null) => void
  over: string | null
  setOver: (k: string | null) => void
  editList: (at: StepPath, f: (l: Step[]) => Step[]) => void
  keyOf: (at: StepPath, i: number) => string
  collapsed: (k: string) => boolean
  toggle: (k: string) => void
  drop: (at: StepPath, index: number, e: React.DragEvent) => void
}

function ListView({ ctx, list, at, deadlineFirst }: { ctx: Ctx; list: Step[]; at: StepPath; deadlineFirst?: boolean }) {
  if (!list.length) {
    return (
      <DropZone ctx={ctx} at={at} index={0} empty>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)", fontStyle: "italic" }}>Empty: add with + or drop a command here</span>
      </DropZone>
    )
  }
  return (
    <div>
      <DropZone ctx={ctx} at={at} index={0} />
      {list.map((s, i) => (
        <div key={i}>
          <Card ctx={ctx} s={s} at={at} i={i} badge={deadlineFirst && i === 0 ? "deadline" : undefined} />
          <DropZone ctx={ctx} at={at} index={i + 1} />
        </div>
      ))}
    </div>
  )
}

function DropZone({ ctx, at, index, empty, children }: { ctx: Ctx; at: StepPath; index: number; empty?: boolean; children?: ReactNode }) {
  const k = `drop:${[...at, index].join("/")}`
  const active = ctx.over === k
  return (
    <div
      onDragOver={e => { if (ctx.drag || e.dataTransfer.types.includes(STEP_MIME)) { e.preventDefault(); if (ctx.over !== k) ctx.setOver(k) } }}
      onDragLeave={() => { if (ctx.over === k) ctx.setOver(null) }}
      onDrop={e => { e.preventDefault(); ctx.drop(at, index, e) }}
      style={empty
        ? { padding: "8px 10px", border: `1px dashed ${active ? "#e95420" : "var(--border-main)"}`, borderRadius: 4, margin: "3px 0", background: active ? "rgba(233,84,32,0.08)" : "transparent" }
        : { height: ctx.drag || active ? 8 : 4, margin: "0 2px", borderRadius: 2, background: active ? "#e95420" : "transparent", transition: "height 80ms" }}>
      {children}
    </div>
  )
}

function Card({ ctx, s, at, i, badge }: { ctx: Ctx; s: Step; at: StepPath; i: number; badge?: string }) {
  const set = (next: Step) => ctx.editList(at, l => l.map((x, j) => (j === i ? next : x)))
  const del = () => ctx.editList(at, l => l.filter((_, j) => j !== i))
  const dup = () => ctx.editList(at, l => [...l.slice(0, i + 1), structuredClone(s), ...l.slice(i + 1)])
  const k = ctx.keyOf(at, i)
  const color = COLOR[s.type]
  const dragging = ctx.drag && ctx.keyOf(ctx.drag.from, ctx.drag.index) === k
  const nested = s.type === "if" || s.type === "when" || isGroup(s)
  const open = !ctx.collapsed(k)
  const autoMap = new Map(ctx.autos.map(a => [a.name, a]))
  const time = duration([s], ctx.durations, autoMap)
  const when = ctx.timing?.get(k)
  const warns = ctx.warnings?.get(k) ?? []
  const running = ctx.active?.has(k) ?? false
  const picked = ctx.selected === k

  return (
    <div
      onMouseEnter={() => s.type === "path" && ctx.onHoverPath(pathKey(s))}
      onMouseLeave={() => s.type === "path" && ctx.onHoverPath(null)}
      style={{
        borderTop: `1px solid ${picked ? "#2f6fdb" : "var(--border-main)"}`, borderRight: `1px solid ${picked ? "#2f6fdb" : "var(--border-main)"}`,
        borderBottom: `1px solid ${picked ? "#2f6fdb" : "var(--border-main)"}`, borderLeft: `3px solid ${color}`, borderRadius: 4,
        background: running ? "rgba(34,211,238,0.14)" : s.type === "path" ? "rgba(47,111,219,0.06)" : "var(--bg-page)", opacity: dragging ? 0.4 : 1,
        boxShadow: picked ? "0 0 0 1px #2f6fdb" : running ? "0 0 0 2px rgba(14,116,144,0.55)" : "0 1px 2px rgba(0,0,0,0.05)",
        transition: "background 120ms",
      }}>
      <div
        onClick={e => {
          // Not when editing a field in it.
          const tag = (e.target as HTMLElement).tagName
          if (tag !== "INPUT" && tag !== "SELECT" && tag !== "BUTTON" && tag !== "I") ctx.onSelect?.(picked ? null : k)
        }}
        draggable
        onDragStart={e => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k); ctx.setDrag({ from: at, index: i }) }}
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 4px 5px 4px", minHeight: 30 }}>
        <i className="ti ti-grip-vertical" title="Drag to move it (into a group, too)" style={{ cursor: "grab", color: "var(--text-light)", fontSize: 14 }} />
        {nested && (
          <button onClick={() => ctx.toggle(k)} title={open ? "Collapse" : "Expand"}
            style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, color: "var(--text-muted)", width: 14 }}>
            <i className={`ti ti-chevron-right ares-chevron${open ? " open" : ""}`} />
          </button>
        )}
        <i className={`ti ${ICON[s.type]}`} style={{ color, fontSize: 15 }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          <Content ctx={ctx} s={s} set={set} />
          {badge && <span title="This one sets when the group ends" style={{ fontSize: 9.5, fontWeight: 700, color: "#0e7490", border: "1px solid #0e7490", borderRadius: 8, padding: "0 6px" }}>DEADLINE</span>}
        </div>
        {warns.length > 0 && <i className="ti ti-alert-triangle" title={warns.join("\n")} style={{ color: "#d97706", fontSize: 14 }} />}
        {when ? (
          <span title={`Runs from ${when.start.toFixed(2)} s to ${when.end.toFixed(2)} s after the auto starts (this preview's conditions)`}
            style={{ fontSize: 10, fontFamily: "Consolas, 'Cascadia Mono', monospace", color: running ? "#0e7490" : "var(--text-muted)", fontWeight: running ? 700 : 400, whiteSpace: "nowrap" }}>
            {when.start.toFixed(1)}→{when.end.toFixed(1)} s
          </span>
        ) : nested && s.type !== "if" && <span style={{ fontSize: 10, fontFamily: "Consolas, 'Cascadia Mono', monospace", color: "var(--text-muted)" }}>{s.type === "when" ? "alongside" : fmt(time.min, time.max)}</span>}
        {(isGroup(s) || s.type === "when") && <AddMenu ctx={ctx} onPick={c => set({ ...s, steps: [...s.steps, c] } as Step)} />}
        <IconBtn icon="ti-copy" title="Duplicate" onClick={dup} />
        <IconBtn icon="ti-trash" title="Remove" onClick={del} danger />
      </div>
      {warns.length > 0 && (
        <div style={{ padding: "0 8px 5px 30px", fontSize: 10.5, color: "#b45309", lineHeight: 1.4 }}>
          {warns.map((w, j) => <div key={j}>{w}</div>)}
        </div>
      )}
      {nested && open && (
        <div style={{ padding: "0 6px 6px 22px" }}>
          {s.type === "if" ? (
            <>
              <Branch label="THEN" hint="when the condition is true" color="#16a34a" onAdd={c => set({ ...s, then: [...s.then, c] })} ctx={ctx} />
              <ListView ctx={ctx} list={s.then} at={[...at, i, "then" as ListKey]} />
              <Branch label="ELSE" hint="when it is false" color="#a81818" onAdd={c => set({ ...s, else: [...s.else, c] })} ctx={ctx} />
              <ListView ctx={ctx} list={s.else} at={[...at, i, "else" as ListKey]} />
            </>
          ) : (
            <div style={{ borderLeft: `2px solid ${color}33`, paddingLeft: 6 }}>
              <ListView ctx={ctx} list={(s as { steps: Step[] }).steps} at={[...at, i, "steps" as ListKey]} deadlineFirst={s.type === "deadline"} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Branch({ label, hint, color, onAdd, ctx }: { label: string; hint: string; color: string; onAdd: (s: Step) => void; ctx: Ctx }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color }}>{label}</span>
      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{hint}</span>
      <span style={{ marginLeft: "auto" }}><AddMenu ctx={ctx} onPick={onAdd} /></span>
    </div>
  )
}

/** What a card shows and edits, by its kind. */
function Content({ ctx, s, set }: { ctx: Ctx; s: Step; set: (s: Step) => void }) {
  const missing = (list: string[], n: string, how: string) => (ctx.names && !list.includes(n) ? `"${n}" is not registered in the robot code (${how}): on the robot it does nothing` : undefined)
  switch (s.type) {
    case "path": {
      const p = ctx.paths.find(q => q.name === s.path)
      const t = ctx.durations.get(pathKey(s))
      const st = ctx.status[s.path]
      return (
        <>
          <select style={{ ...propertyInputStyle, flex: 1, minWidth: 120 }} value={s.path} onChange={e => set({ type: "path", path: e.target.value })}>
            {!p && <option value={s.path}>{s.path} (missing)</option>}
            {ctx.paths.map(q => <option key={q.name} value={q.name}>{q.name}</option>)}
          </select>
          {(p?.variants?.length ?? 0) > 0 && (
            <select style={{ ...propertyInputStyle, width: 96 }} value={s.variant ?? ""} onChange={e => set({ ...s, variant: e.target.value || undefined })}>
              <option value="">Base</option>
              {p!.variants!.map(v => <option key={v.name} value={v.name}>◇ {v.name}</option>)}
            </select>
          )}
          <span style={{ fontSize: 10, fontFamily: "Consolas, 'Cascadia Mono', monospace", color: t === undefined ? "var(--status-error)" : st?.outdated ? "#d97706" : "var(--text-muted)" }}
            title={t === undefined ? "Not generated" : st?.outdated ? "Out of date" : "Up to date"}>
            {t === undefined ? "not generated" : `${t.toFixed(2)} s`}
          </span>
        </>
      )
    }
    case "command":
      return (
        <>
          <TextField value={s.name} list="ares-commands" width={150} warn={missing(ctx.names?.commands ?? [], s.name, "ares.registerCommand")} onCommit={name => set({ ...s, name })} />
          <span title="How long you expect it to take, only for the timeline: the robot code decides" style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--text-muted)" }}>
            ≈<NumberField value={s.estimateS ?? 0} onCommit={v => set({ ...s, estimateS: v > 0 ? v : undefined })} />s
          </span>
        </>
      )
    case "wait":
      return <><span style={{ fontSize: 12 }}>Wait</span><NumberField value={s.seconds} onCommit={v => set({ ...s, seconds: Math.max(0, v) })} /><span style={{ fontSize: 11 }}>s</span></>
    case "sequential": case "parallel": case "deadline": case "race":
      return (
        <select style={{ ...propertyInputStyle, width: 150, fontWeight: 600 }} value={s.type} title={GROUP_HELP[s.type]}
          onChange={e => set({ type: e.target.value as GroupType, steps: s.steps })}>
          {GROUPS.map(g => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
        </select>
      )
    case "if":
      return (
        <>
          <span style={{ fontSize: 12, fontWeight: 600, color: COLOR.if }}>If</span>
          <TextField value={s.condition} list="ares-conditions" width={150} warn={missing(ctx.names?.conditions ?? [], s.condition, "ares.registerCondition")} onCommit={condition => set({ ...s, condition })} />
        </>
      )
    case "when":
      return (
        <>
          <span style={{ fontSize: 12, fontWeight: 600, color: COLOR.when }}>When</span>
          <select style={{ ...propertyInputStyle, width: 116 }} value={s.trigger.kind} onChange={e => set({ ...s, trigger: defaultTrigger(e.target.value as Trigger["kind"]) })}>
            <option value="time">the time is</option>
            <option value="zone">it enters</option>
            <option value="condition">this holds</option>
          </select>
          <TriggerFields trigger={s.trigger} warn={s.trigger.kind === "condition" ? missing(ctx.names?.conditions ?? [], s.trigger.name, "ares.registerCondition") : undefined}
            onChange={trigger => set({ ...s, trigger })} />
        </>
      )
    case "auto":
      return (
        <>
          <span style={{ fontSize: 12 }}>Run</span>
          <select style={{ ...propertyInputStyle, flex: 1 }} value={s.auto} onChange={e => set({ type: "auto", auto: e.target.value })}>
            {!ctx.autos.some(a => a.name === s.auto) && <option value={s.auto}>{s.auto} (missing)</option>}
            {ctx.autos.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
        </>
      )
  }
}

export function defaultTrigger(kind: Trigger["kind"]): Trigger {
  if (kind === "zone") return { kind, x: 5, y: 2, widthM: 2, heightM: 2 }
  if (kind === "condition") return { kind, name: "hasNote" }
  return { kind: "time", atS: 10 }
}

function TriggerFields({ trigger, warn, onChange }: { trigger: Trigger; warn?: string; onChange: (t: Trigger) => void }) {
  const unit = (text: string) => <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{text}</span>
  if (trigger.kind === "time") {
    return <span title="Seconds since the auto started" style={{ display: "flex", alignItems: "center", gap: 3 }}><NumberField value={trigger.atS} onCommit={v => onChange({ ...trigger, atS: Math.max(0, v) })} />{unit("s")}</span>
  }
  if (trigger.kind === "condition") return <TextField value={trigger.name} list="ares-conditions" width={130} warn={warn} onCommit={name => onChange({ ...trigger, name })} />
  return (
    <span title="A rectangle on the field (blue's coordinates; flipped on red): its bottom-left corner, width and height, in meters" style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
      {unit("x")}<NumberField value={trigger.x} onCommit={x => onChange({ ...trigger, x })} />
      {unit("y")}<NumberField value={trigger.y} onCommit={y => onChange({ ...trigger, y })} />
      {unit("w")}<NumberField value={trigger.widthM} onCommit={v => onChange({ ...trigger, widthM: Math.max(0.1, v) })} />
      {unit("h")}<NumberField value={trigger.heightM} onCommit={v => onChange({ ...trigger, heightM: Math.max(0.1, v) })} />
    </span>
  )
}

/** The + menu: what can go into a group. */
function AddMenu({ ctx, onPick, big }: { ctx: Ctx; onPick: (s: Step) => void; big?: boolean }) {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!host.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener("mousedown", close)
    return () => window.removeEventListener("mousedown", close)
  }, [open])
  const pick = (s: Step) => { onPick(s); setOpen(false) }
  const firstCommand = ctx.names?.commands[0] ?? "command"
  const firstCondition = ctx.names?.conditions[0] ?? "hasNote"
  const item = (icon: string, color: string, label: string, hint: string, s: () => Step | null) => {
    // The kind is the one this icon stands for.
    const kind = Object.keys(ICON).find(k => ICON[k] === icon) as Step["type"]
    if (ctx.allow && !ctx.allow.includes(kind)) return null
    return (
    <div onClick={() => { const v = s(); if (v) pick(v) }}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--tree-hover-bg)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
      <i className={`ti ${icon}`} style={{ color, fontSize: 15, width: 16 }} />
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{hint}</span>
    </div>
    )
  }
  const sep = (label: string) => <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--text-header-eyebrow)", padding: "6px 12px 2px", textTransform: "uppercase" }}>{label}</div>
  return (
    <span ref={host} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} title="Add a command"
        style={{ display: "flex", alignItems: "center", gap: 4, height: big ? 24 : 22, padding: big ? "0 9px" : "0 6px", fontSize: 11, cursor: "pointer",
          border: "1px solid var(--btn-classic-border)", borderRadius: 3, background: open ? "var(--toolbar-active-bg)" : "var(--btn-classic-bg)", color: "#e95420", fontWeight: 600 }}>
        <i className="ti ti-plus" />{big && " Add"}
      </button>
      {open && (
        <div className="ares-pop from-right" style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 50, width: 290, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "0 8px 22px rgba(0,0,0,0.18)", borderRadius: 4, padding: "4px 0" }}>
          {sep("Commands")}
          {item(ICON.path, COLOR.path, "Follow Path", "drive a path", () => (ctx.paths[0] ? { type: "path", path: ctx.paths[0].name } : null))}
          {item(ICON.command, COLOR.command, "Named Command", "from the robot code", () => ({ type: "command", name: firstCommand }))}
          {item(ICON.wait, COLOR.wait, "Wait", "a fixed time", () => ({ type: "wait", seconds: 0.5 }))}
          {sep("Groups")}
          {item(ICON.sequential, COLOR.sequential, "Sequential Group", "one after another", () => ({ type: "sequential", steps: [] }))}
          {item(ICON.parallel, COLOR.parallel, "Parallel Group", "all, until all end", () => ({ type: "parallel", steps: [] }))}
          {item(ICON.deadline, COLOR.deadline, "Deadline Group", "all, until the first ends", () => ({ type: "deadline", steps: [] }))}
          {item(ICON.race, COLOR.race, "Race Group", "all, until any ends", () => ({ type: "race", steps: [] }))}
          {sep("More")}
          {item(ICON.if, COLOR.if, "If", "a condition picks", () => ({ type: "if", condition: firstCondition, then: [], else: [] }))}
          {item(ICON.when, COLOR.when, "When", "a time, a zone, a condition", () => ({ type: "when", trigger: defaultTrigger("time"), steps: [] }))}
          {item(ICON.auto, COLOR.auto, "Run Auto", "another auto here", () => (ctx.autos[0] ? { type: "auto", auto: ctx.autos[0].name } : null))}
        </div>
      )}
    </span>
  )
}

function IconBtn({ icon, title, onClick, danger }: { icon: string; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button title={title} onClick={onClick}
      style={{ width: 22, height: 22, border: "none", background: "transparent", borderRadius: 3, cursor: "pointer", color: danger ? "#c21c1c" : "var(--icon-tree)", opacity: 0.7, display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "rgba(0,0,0,0.06)" }}
      onMouseLeave={e => { e.currentTarget.style.opacity = "0.7"; e.currentTarget.style.background = "transparent" }}>
      <i className={`ti ${icon}`} style={{ fontSize: 14 }} />
    </button>
  )
}

function TextField({ value, onCommit, list, warn, width }: { value: string; onCommit: (v: string) => void; list?: string; warn?: string; width?: number }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      <input style={{ ...propertyInputStyle, width: width ?? 120, fontSize: 11.5, height: 22, ...(warn ? { borderColor: "#d97706", background: "rgba(217,119,6,0.08)" } : {}) }}
        list={list} title={warn} value={text} onChange={e => setText(e.target.value)}
        onBlur={() => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value) }}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
      {warn && <i className="ti ti-alert-triangle" title={warn} style={{ color: "#d97706" }} />}
    </span>
  )
}

function NumberField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <input style={{ ...propertyInputStyle, width: 50, fontFamily: "Consolas, 'Cascadia Mono', monospace" }}
      value={text} onChange={e => setText(e.target.value)}
      onBlur={() => { const v = Number(text); if (Number.isFinite(v)) onCommit(v); else setText(String(value)) }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
  )
}

function fmt(min: number, max: number) {
  return Math.abs(max - min) < 1e-3 ? `${max.toFixed(2)} s` : `${min.toFixed(2)}–${max.toFixed(2)} s`
}
