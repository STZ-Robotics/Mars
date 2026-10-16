import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import { Card, Toggle } from "../ui/controls"
import { drawFieldBackground } from "../paths/FieldView"
import { fieldSketch } from "../paths/fieldSketch"
import { DEFAULT_VIEW, FieldDoc, PathEntry, PathStatus, PlanResult, PathSpec, Trajectory, ViewOptions, sampleAt } from "../paths/types"
import { useVariables } from "../vars/context"
import { useToast } from "../ui/toasts"
import { applyScope, evaluateAll, withOverrides } from "../vars/variables"
import { Auto, DEFAULT_BUDGET_S, Leg, Step, Trigger, children, conditionsOf, duration, legs, migrateAuto, namesOf, newAuto, pathKey, zonesOf } from "./types"
import CommandTree, { RobotNames } from "./CommandTree"

interface Props {
  robot: RobotConfig
  robotPath: string | null
}

const SIDEBAR_WIDTH = 400

const CODE_KEY = (robotPath: string) => `ares.robotCode:${robotPath}`
const LEG_COLORS = ["#2f6fdb", "#e95420", "#16a34a", "#db2777", "#0e7490", "#ca8a04", "#7c8a00", "#a81818"]

// The Autos tab: paths and robot commands in sequence, the parents of paths.
export default function AutosPage({ robot, robotPath }: Props) {
  if (!robotPath) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-page)" }}>
        <Card><div style={{ fontSize: 12 }}>Save the robot first: autos live in the project's folder, in autos/.</div></Card>
      </div>
    )
  }
  return <Editor robot={robot} robotPath={robotPath} />
}

function Editor({ robot, robotPath }: { robot: RobotConfig; robotPath: string }) {
  const field = FIELDS[0]
  const [autos, setAutos] = useState<Auto[]>([])
  const [current, setCurrent] = useState<{ auto: Auto; savedName: string | null } | null>(null)
  const [paths, setPaths] = useState<PathSpec[]>([])
  const [status, setStatus] = useState<Record<string, PathStatus>>({})
  const [trajs, setTrajs] = useState<Record<string, Trajectory | null>>({})
  const [assume, setAssume] = useState<Record<string, boolean>>({})
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [commit, setCommit] = useState(0)
  const { scope, variables } = useVariables()
  const toast = useToast()
  const stopRequested = useRef(false)

  // The robot code: above the project, or a folder picked by hand (kept per
  // project on this machine).
  const [codeFolder, setCodeFolder] = useState<string | null>(() => { try { return localStorage.getItem(CODE_KEY(robotPath)) } catch { return null } })
  const [names, setNames] = useState<RobotNames | null>(null)
  const readNames = useCallback(() => {
    invoke<RobotNames>("robot_names", { robotPath, folder: codeFolder }).then(setNames).catch(() => setNames(null))
  }, [robotPath, codeFolder])
  useEffect(readNames, [readNames])
  const pickCodeFolder = async () => {
    const f = await open({ directory: true, title: "The robot project (the folder with build.gradle)" })
    if (typeof f !== "string") return
    try { localStorage.setItem(CODE_KEY(robotPath), f) } catch { /* not remembered */ }
    setCodeFolder(f)
  }

  const auto = current?.auto ?? null
  const autoMap = useMemo(() => new Map(autos.map(a => [a.name, a])), [autos])

  const refresh = useCallback(async () => {
    const [list, entries] = await Promise.all([
      invoke<Auto[]>("autos_list", { robotPath }).then(l => l.map(migrateAuto)).catch(() => [] as Auto[]),
      invoke<PathEntry[]>("paths_list", { robotPath }).catch(() => [] as PathEntry[]),
    ])
    setAutos(list)
    setPaths(entries.flatMap(e => (e.spec ? [e.spec] : [])))
    const field = await invoke<FieldDoc>("field_open", { robotPath }).catch(() => null)
    const st = field ? await invoke<PathStatus[]>("paths_status", { robotPath, robot, field }).catch(() => [] as PathStatus[]) : []
    setStatus(Object.fromEntries(st.map(q => [q.name, q])))
    return list
  }, [robotPath, robot])

  useEffect(() => {
    refresh().then(list => { if (list[0]) setCurrent({ auto: list[0], savedName: list[0].name }) })
  }, [robotPath])

  // The trajectories the open auto uses (and those of autos it runs).
  const keys = useMemo(() => {
    const out = new Set<string>()
    const walk = (steps: Step[], seen: Set<string>) => {
      for (const s of steps) {
        if (s.type === "path") out.add(pathKey(s))
        for (const [, list] of children(s)) walk(list, seen)
        if (s.type === "auto" && !seen.has(s.auto)) walk(autoMap.get(s.auto)?.steps ?? [], new Set([...seen, s.auto]))
      }
    }
    walk(auto?.steps ?? [], new Set())
    return [...out].sort()
  }, [auto, autoMap])
  const keysKey = keys.join("|")
  const [trajVersion, setTrajVersion] = useState(0)
  useEffect(() => {
    let alive = true
    Promise.all(keys.map(k => invoke<Trajectory | null>("trajectory_open", { robotPath, name: k }).catch(() => null)))
      .then(ts => { if (alive) setTrajs(Object.fromEntries(keys.map((k, i) => [k, ts[i]]))) })
    return () => { alive = false }
  }, [keysKey, trajVersion])

  const durations = useMemo(() => new Map(Object.entries(trajs).flatMap(([k, t]) => (t ? [[k, t.durationS] as [string, number]] : []))), [trajs])
  const conditions = useMemo(() => (auto ? conditionsOf(auto.steps, autoMap) : []), [auto, autoMap])
  const range = useMemo(() => (auto ? duration(auto.steps, durations, autoMap) : { min: 0, max: 0, missing: [] }), [auto, durations, autoMap])
  const timeline = useMemo(() => (auto ? legs(auto.steps, durations, autoMap, c => assume[c] ?? true) : { legs: [], end: 0 }), [auto, durations, autoMap, assume])
  const budget = auto?.budgetS ?? DEFAULT_BUDGET_S
  const zones = useMemo(() => (auto ? zonesOf(auto.steps) : []), [auto])

  // What this auto asks of the robot code that it does not register: a step
  // that would do nothing on the robot. Event markers on its paths count
  // when neither a command nor an ares.event trigger has their name.
  const unregistered = useMemo(() => {
    if (!auto || !names?.root) return null
    const used = namesOf(auto.steps, autoMap)
    const events = new Set<string>()
    for (const k of used.paths) for (const e of trajs[k]?.events ?? []) events.add(e.name)
    return {
      commands: used.commands.filter(c => !names.commands.includes(c)),
      conditions: used.conditions.filter(c => !names.conditions.includes(c)),
      events: [...events].filter(e => !names.commands.includes(e) && !names.events.includes(e)).sort(),
    }
  }, [auto, autoMap, names, trajs])

  // --- Editing, saved shortly after -----------------------------------------
  // Undo and redo, per auto (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y).
  const history = useRef<{ name: string; undo: Auto[]; redo: Auto[] }>({ name: "", undo: [], redo: [] })
  const edit = (f: (a: Auto) => Auto) => {
    setCurrent(c => {
      if (!c) return c
      const h = history.current
      if (h.name !== c.auto.name) { h.name = c.auto.name; h.undo = []; h.redo = [] }
      h.undo.push(c.auto)
      if (h.undo.length > 100) h.undo.shift()
      h.redo = []
      return { ...c, auto: f(c.auto) }
    })
    setCommit(c => c + 1)
  }
  const travel = (dir: "undo" | "redo") => {
    setCurrent(c => {
      const h = history.current
      if (!c || h.name !== c.auto.name) return c
      const from = dir === "undo" ? h.undo : h.redo, to = dir === "undo" ? h.redo : h.undo
      const prev = from.pop()
      if (!prev) return c
      to.push(c.auto)
      return { ...c, auto: { ...prev, name: c.auto.name } }
    })
    setCommit(c => c + 1)
  }
  const travelRef = useRef(travel)
  travelRef.current = travel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === "z") { e.preventDefault(); travelRef.current(e.shiftKey ? "redo" : "undo") }
      else if (k === "y") { e.preventDefault(); travelRef.current("redo") }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const [hoverPath, setHoverPath] = useState<string | null>(null)
  useEffect(() => {
    if (!commit || !current) return
    const t = setTimeout(async () => {
      try {
        await invoke("auto_save", { robotPath, auto: current.auto, previous: current.savedName })
        setCurrent(c => (c && c.auto.name === current.auto.name ? { ...c, savedName: current.auto.name } : c))
        setNote("Saved")
        const list = await invoke<Auto[]>("autos_list", { robotPath })
        setAutos(list.map(migrateAuto))
      } catch (e) {
        setNote(String(e))
      }
    }, 400)
    return () => clearTimeout(t)
  }, [commit])

  const unique = (base: string) => {
    let name = base
    for (let i = 2; autos.some(a => a.name.toLowerCase() === name.toLowerCase()); i++) name = `${base} ${i}`
    return name
  }
  const create = () => { setCurrent({ auto: newAuto(unique("New auto")), savedName: null }); setCommit(c => c + 1) }
  const duplicate = () => { if (auto) { setCurrent({ auto: { ...structuredClone(auto), name: unique(`${auto.name} copy`) }, savedName: null }); setCommit(c => c + 1) } }
  const remove = async () => {
    if (!current || !window.confirm(`Delete the auto "${current.auto.name}"?`)) return
    if (current.savedName) await invoke("auto_delete", { robotPath, name: current.savedName })
    const list = await refresh()
    setCurrent(list[0] ? { auto: list[0], savedName: list[0].name } : null)
  }

  // Generate what the auto needs: its paths (and variants) that are missing
  // or out of date, a path before what continues from it.
  const generateNeeded = async () => {
    if (!auto) return
    if (busy) { stopRequested.current = true; invoke("plan_cancel").catch(() => {}); return }
    stopRequested.current = false
    setBusy(true)
    let stopped = false
    const byName = new Map(paths.map(p => [p.name, p]))
    const needed = new Set<string>()
    const add = (name: string) => {
      const p = byName.get(name)
      if (!p || needed.has(name)) return
      if (p.continuesFrom) add(p.continuesFrom)
      needed.add(name)
    }
    keys.forEach(k => add(k.split("@")[0]))
    const field = await invoke<FieldDoc>("field_open", { robotPath })
    const fieldSize = { lengthM: FIELDS[0].sizeMeters[0], widthM: FIELDS[0].sizeMeters[1] }
    let done = 0
    const failed: string[] = []
    for (const name of needed) {
      if (stopRequested.current) { stopped = true; break }
      const p = byName.get(name)!
      const variantsNeeded = keys.filter(k => k.startsWith(`${name}@`)).map(k => k.slice(name.length + 1))
      const jobs: [PathSpec, string | null][] = []
      // The base when it is missing or out of date (or what continues from
      // it would start from a stale end); variants have no status, so the
      // ones in use are generated.
      if (!status[name]?.generated || status[name]?.outdated) jobs.push([applyScope(p, scope).doc, null])
      for (const v of variantsNeeded) {
        const def = p.variants?.find(q => q.name === v)
        if (def) jobs.push([applyScope(p, evaluateAll(withOverrides(variables, def.overrides)).scope).doc, v])
      }
      for (const [spec, v] of jobs) {
        if (stopRequested.current) { stopped = true; break }
        setNote(`Generating ${name}${v ? "@" + v : ""}…`)
        try {
          await invoke<PlanResult>("path_plan", { robot, spec, field, fieldSize, robotPath, variant: v })
          done++
        } catch (e) {
          if (String(e).includes("Generation stopped")) { stopped = true; break }
          failed.push(`${name}${v ? "@" + v : ""}: ${String(e)}`)
        }
      }
      if (stopped) break
    }
    setBusy(false)
    setNote(failed.length ? failed.join(" · ") : `Generated ${done}`)
    const plural = (k: number) => `${k} trajector${k === 1 ? "y" : "ies"}`
    if (stopped) toast({ kind: "stopped", title: "Stopped generating", body: `${plural(done)} done before the stop.` })
    else if (failed.length) toast({ kind: "error", title: `Generated ${plural(done)}, ${failed.length} failed`, body: failed.join(" · ") })
    else toast({ kind: "success", title: done ? `Generated ${plural(done)} for "${auto.name}"` : `"${auto.name}" is up to date` })
    await refresh()
    setTrajVersion(v => v + 1)
  }

  // --- Playback over the whole auto -----------------------------------------
  useEffect(() => {
    if (!playing) return
    let frame = 0, last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      let stop = false
      setPlayhead(p => {
        const next = (p ?? 0) + dt
        if (next >= timeline.end) { stop = true; return timeline.end }
        return next
      })
      if (stop) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, timeline.end])

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ width: SIDEBAR_WIDTH, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--border-light)" }}>
          <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4 }}>Auto</div>
          {auto ? <TextField value={auto.name} big onCommit={name => edit(a => ({ ...a, name }))} /> : <div style={{ fontSize: 15, fontWeight: 600 }}>No auto</div>}
          <div style={{ fontSize: 10, color: note.startsWith("Saved") || note.startsWith("Generated") || !note ? "var(--text-header-subtitle)" : "var(--status-error)", marginTop: 5 }}>
            {note || `${autos.length} in this project`}
          </div>
        </div>
        <div className="ares-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <Heading label="Autos" count={autos.length}>
            <SmallIcon icon="ti-plus" title="New auto" onClick={create} />
            <SmallIcon icon="ti-copy" title="Duplicate auto" onClick={duplicate} />
            <SmallIcon icon="ti-trash" title="Delete auto" onClick={remove} />
          </Heading>
          {autos.length === 0 && !current && <None>No autos yet. Make one with +.</None>}
          {autos.map(a => {
            const active = current?.savedName === a.name
            const r = duration(a.steps, durations, autoMap)
            return (
              <Row key={a.name} active={active} onClick={() => { setCurrent({ auto: a, savedName: a.name }); setPlayhead(null) }}>
                <i className="ti ti-list-details" style={{ fontSize: 14 }} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                {active && <span style={{ fontSize: 10, fontFamily: "Consolas, 'Cascadia Mono', monospace", opacity: 0.85 }}>{fmtRange(r.min, r.max)}</span>}
              </Row>
            )
          })}
          {current && current.savedName === null && <Row active><i className="ti ti-list-details" /> {current.auto.name}</Row>}

          {auto && (
            <>
              <Heading label="Commands">
                <SmallIcon icon="ti-arrow-back-up" title="Undo (Ctrl+Z)" onClick={() => travel("undo")} />
                <SmallIcon icon="ti-arrow-forward-up" title="Redo (Ctrl+Shift+Z)" onClick={() => travel("redo")} />
              </Heading>
              <CommandTree
                steps={auto.steps}
                onChange={steps => edit(a => ({ ...a, steps }))}
                paths={paths}
                autos={autos.filter(a => a.name !== auto.name)}
                durations={durations}
                status={status}
                names={names?.root ? names : null}
                onHoverPath={setHoverPath}
              />
              <Heading label="Robot code">
                <SmallIcon icon="ti-refresh" title="Read the robot code again" onClick={readNames} />
                <SmallIcon icon="ti-folder" title="Pick the robot project by hand" onClick={pickCodeFolder} />
              </Heading>
              {!names?.root ? (
                <None>
                  No robot project above this one (Ares projects live in the robot's src/main/deploy/ares/), so names are not checked.
                  Pick the robot project with the folder button.
                </None>
              ) : (
                <div style={{ padding: "6px 12px", fontSize: 11, lineHeight: 1.55 }}>
                  <div style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={names.root}>
                    {names.root} · {names.files} files · {names.commands.length} commands · {names.conditions.length} conditions
                  </div>
                  {unregistered && unregistered.commands.length + unregistered.conditions.length + unregistered.events.length === 0 ? (
                    <div style={{ color: "#16a34a" }}><i className="ti ti-circle-check" /> Everything this auto asks for is registered.</div>
                  ) : unregistered && (
                    <>
                      {unregistered.commands.length > 0 && <Missing kind="Commands" names={unregistered.commands} hint={'ares.registerCommand("name", command)'} />}
                      {unregistered.conditions.length > 0 && <Missing kind="Conditions" names={unregistered.conditions} hint={'ares.registerCondition("name", () -> ...)'} />}
                      {unregistered.events.length > 0 && <Missing kind="Event markers" names={unregistered.events} hint={'a command with its name, or ares.event("name")'} />}
                    </>
                  )}
                </div>
              )}
              <datalist id="ares-commands">{(names?.commands ?? []).map(c => <option key={c} value={c} />)}</datalist>
              <datalist id="ares-conditions">{(names?.conditions ?? []).map(c => <option key={c} value={c} />)}</datalist>
              <Heading label="Settings" />
              <div style={{ padding: "6px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }} title="The time the auto must fit in. FRC's autonomous period is 15 s.">
                <span style={{ flex: 1 }}>Time budget</span>
                <NumberField value={budget} onCommit={v => edit(a => ({ ...a, budgetS: v }))} /> s
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 10px", background: "var(--bg-menubar)", borderBottom: "1px solid var(--border-main)" }}>
          {conditions.length > 0 ? (
            <>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }} title="Which way each condition goes in this preview. On the robot, the robot code decides.">Preview with:</span>
              {conditions.map(c => {
                const v = assume[c] ?? true
                return (
                  <button key={c} onClick={() => setAssume(a => ({ ...a, [c]: !v }))} title={`${c} is ${v ? "true" : "false"} in this preview. Click to flip it.`}
                    style={{ fontSize: 11, padding: "2px 10px", height: 24, borderRadius: 12, cursor: "pointer", border: `1px solid ${v ? "#16a34a" : "#a81818"}`, background: v ? "rgba(22,163,74,0.1)" : "rgba(168,24,24,0.08)", color: v ? "#16a34a" : "#a81818", fontWeight: 600 }}>
                    ◆ {c} = {v ? "true" : "false"}
                  </button>
                )
              })}
            </>
          ) : <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Add steps on the left: paths, waits, commands, conditions.</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {busy ? (
              <button onClick={generateNeeded} title="Stop generating: the solver stops at its next iteration"
                style={{ display: "flex", alignItems: "center", gap: 6, height: 26, padding: "0 12px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", border: "1px solid #a81818", borderRadius: 2, background: "#c21c1c", color: "#ffffff" }}>
                <i className="ti ti-player-stop" /> Stop
              </button>
            ) : (
              <span title="Generate the paths (and variants) this auto uses that are missing or out of date, in order.">
                <Toggle on={false} onClick={generateNeeded} icon="ti-wand" label={range.missing.length ? `Generate ${range.missing.length} missing` : "Generate paths"} />
              </span>
            )}
          </span>
        </div>
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          <AutoField field={field} robot={robot} legs={timeline.legs} trajs={trajs} playhead={playhead} zones={zones} hovered={hoverPath} />
        </div>
        <Timeline legs={timeline.legs} end={timeline.end} range={range} budget={budget} playhead={playhead} playing={playing}
          onPlay={() => { if (!playing && (playhead === null || playhead >= timeline.end - 1e-3)) setPlayhead(0); setPlaying(p => !p) }}
          onSeek={t => { setPlaying(false); setPlayhead(t) }} />
      </div>
    </div>
  )
}

// --- The field, with the auto's paths in order ---------------------------------

function AutoField({ field, robot, legs: lgs, trajs, playhead, zones, hovered }: {
  field: typeof FIELDS[number]; robot: RobotConfig; legs: Leg[]; trajs: Record<string, Trajectory | null>; playhead: number | null
  zones: Extract<Trigger, { kind: "zone" }>[]
  /** The path under the pointer in the command tree: drawn on top, the rest faded. */
  hovered: string | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [sketch, setSketch] = useState<HTMLCanvasElement | null>(null)
  const view: ViewOptions = useMemo(() => {
    try { return { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem("ares.pathView") ?? "{}") } } catch { return DEFAULT_VIEW }
  }, [])
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
    const margin = 40
    const k = Math.min((size.w - 2 * margin) / L, (size.h - 2 * margin) / W)
    const ox = (size.w - L * k) / 2, oy = (size.h + W * k) / 2
    const toScreen = (x: number, y: number): [number, number] => [ox + x * k, oy - y * k]
    drawFieldBackground(ctx, size, toScreen, k, field, image, sketch, view)

    // The zones the auto's when steps watch.
    for (const z of zones) {
      const [x0, y0] = toScreen(z.x, z.y + z.heightM)
      ctx.fillStyle = "rgba(124,58,237,0.12)"
      ctx.strokeStyle = "#7c3aed"
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.fillRect(x0, y0, z.widthM * k, z.heightM * k)
      ctx.strokeRect(x0, y0, z.widthM * k, z.heightM * k)
      ctx.setLineDash([])
      label(ctx, x0 + z.widthM * k / 2, y0, "when inside", "#7c3aed", -8)
    }

    // Each path in its color, numbered at its start; gaps where a path does
    // not start where the one before it ended.
    let prevEnd: { x: number; y: number; heading: number } | null = null
    let n = 0
    for (const leg of lgs) {
      if (leg.kind !== "path" || !leg.path) continue
      const t = trajs[leg.path]
      const color = LEG_COLORS[n % LEG_COLORS.length]
      n++
      if (!t) continue
      const pts = t.samples.map(q => toScreen(q.x, q.y))
      ctx.globalAlpha = hovered && hovered !== leg.path ? 0.25 : 1
      ctx.strokeStyle = "rgba(255,255,255,0.9)"
      ctx.lineWidth = hovered === leg.path ? 10 : 7
      ctx.lineCap = "round"
      stroke(ctx, pts)
      ctx.strokeStyle = color
      ctx.lineWidth = 3.5
      stroke(ctx, pts)
      const s0 = t.samples[0], s1 = t.samples[t.samples.length - 1]
      if (prevEnd) {
        const gap = Math.hypot(s0.x - prevEnd.x, s0.y - prevEnd.y)
        const turn = Math.abs(((((s0.heading - prevEnd.heading) * 180 / Math.PI) % 360) + 540) % 360 - 180)
        if (gap > 0.05 || turn > 3) {
          ctx.setLineDash([5, 4])
          ctx.strokeStyle = "#c21c1c"
          ctx.lineWidth = 2
          stroke(ctx, [toScreen(prevEnd.x, prevEnd.y), toScreen(s0.x, s0.y)])
          ctx.setLineDash([])
          label(ctx, ...toScreen(s0.x, s0.y), `⚠ ${gap.toFixed(2)} m · ${turn.toFixed(0)}° from the previous end`, "#c21c1c", 22)
        }
      }
      const [sx, sy] = toScreen(s0.x, s0.y)
      ctx.beginPath()
      ctx.arc(sx, sy, 10, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = "#ffffff"
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = "#ffffff"
      ctx.font = "700 11px 'Segoe UI', Arial, sans-serif"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(String(n), sx, sy + 0.5)
      label(ctx, sx, sy, leg.label, color, -18)
      ctx.globalAlpha = 1
      prevEnd = { x: s1.x, y: s1.y, heading: s1.heading }
    }

    // The robot at the playhead.
    if (playhead !== null) {
      const leg = lgs.find(l => l.kind === "path" && playhead >= l.start && playhead <= l.end) ??
        [...lgs].reverse().find(l => l.kind === "path" && l.end <= playhead)
      const t = leg?.path ? trajs[leg.path] : null
      if (t && leg) {
        const s = sampleAt(t, Math.min(playhead - leg.start, t.durationS))
        const [cx, cy] = toScreen(s.x, s.y)
        const hl = robot.bumper.lengthM / 2 * k, hw = robot.bumper.widthM / 2 * k
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(-s.heading)
        ctx.fillStyle = "rgba(34,211,238,0.35)"
        ctx.fillRect(-hl, -hw, 2 * hl, 2 * hw)
        ctx.strokeStyle = "#0e7490"
        ctx.lineWidth = 2.5
        ctx.strokeRect(-hl, -hw, 2 * hl, 2 * hw)
        ctx.beginPath()
        ctx.moveTo(hl, -hw)
        ctx.lineTo(hl, hw)
        ctx.lineWidth = 5
        ctx.stroke()
        ctx.restore()
      }
    }
  }, [size, image, sketch, lgs, trajs, playhead, robot, field, view, zones, hovered])

  return (
    <div ref={host} style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  )
}

function stroke(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  if (pts.length < 2) return
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.stroke()
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, dy: number) {
  ctx.font = "600 10px 'Segoe UI', Arial, sans-serif"
  const w = ctx.measureText(text).width + 10
  ctx.fillStyle = "rgba(255,255,255,0.94)"
  ctx.fillRect(x - w / 2, y + dy - 8, w, 16)
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.strokeRect(x - w / 2, y + dy - 8, w, 16)
  ctx.fillStyle = color
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(text, x, y + dy + 0.5)
}

// --- The timeline ----------------------------------------------------------------

function Timeline({ legs: lgs, end, range, budget, playhead, playing, onPlay, onSeek }: {
  legs: Leg[]; end: number; range: { min: number; max: number; missing: string[] }; budget: number
  playhead: number | null; playing: boolean; onPlay: () => void; onSeek: (t: number) => void
}) {
  const span = Math.max(budget, range.max, end, 1) * 1.04
  const pct = (t: number) => `${(100 * t) / span}%`
  const over = range.max > budget
  let n = 0
  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid var(--border-main)", background: "var(--bg-panel)", padding: "8px 14px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <button onClick={onPlay} title="Play the auto (this preview's conditions)"
          style={{ width: 30, height: 24, border: "1px solid var(--btn-classic-border)", background: "var(--btn-classic-bg)", borderRadius: 2, cursor: "pointer" }}>
          <i className={`ti ${playing ? "ti-player-pause" : "ti-player-play"}`} />
        </button>
        <span style={{ fontSize: 11, fontFamily: "Consolas, 'Cascadia Mono', monospace" }}>{(playhead ?? 0).toFixed(2)} / {end.toFixed(2)} s</span>
        <span style={{ fontSize: 11, color: over ? "var(--status-error)" : "var(--text-secondary)", fontWeight: over ? 700 : 400 }}
          title="Shortest and longest way through, over every condition. Commands count their estimate.">
          {fmtRange(range.min, range.max)} of {budget} s{over ? ` · ${(range.max - budget).toFixed(2)} s over in the worst case` : ""}
        </span>
        {range.missing.length > 0 && <span style={{ fontSize: 11, color: "var(--status-error)" }}>· not generated: {range.missing.join(", ")}</span>}
      </div>
      <div style={{ position: "relative", height: 30, background: "var(--bg-page)", border: "1px solid var(--border-main)", cursor: "pointer" }}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onSeek(Math.min(end, ((e.clientX - r.left) / r.width) * span)) }}>
        {lgs.map((l, i) => {
          const color = l.kind === "path" ? LEG_COLORS[n++ % LEG_COLORS.length] : l.kind === "wait" ? "#9ca3af" : "#e95420"
          const w = Math.max(l.end - l.start, l.kind === "command" ? 0 : 0)
          return (
            <div key={i} title={`${l.label}: ${l.start.toFixed(2)} → ${l.end.toFixed(2)} s`}
              style={{
                position: "absolute", left: pct(l.start), width: w > 0 ? pct(w) : 3, top: l.kind === "path" ? 3 : 8, bottom: l.kind === "path" ? 3 : 8,
                background: l.kind === "path" ? `${color}d0` : color, borderRight: "1px solid #ffffff", overflow: "hidden",
                fontSize: 9.5, color: "#ffffff", fontWeight: 600, padding: "0 4px", whiteSpace: "nowrap", lineHeight: "22px",
              }}>
              {l.kind === "path" && w > 0.6 ? l.label : ""}
            </div>
          )
        })}
        <div style={{ position: "absolute", left: pct(budget), top: -4, bottom: -4, width: 2, background: "#a81818" }} title={`Budget: ${budget} s`} />
        {playhead !== null && <div style={{ position: "absolute", left: pct(playhead), top: -4, bottom: -4, width: 2, background: "#1c1c1f" }} />}
      </div>
    </div>
  )
}

// --- Small pieces ------------------------------------------------------------------

function fmtRange(min: number, max: number) {
  return Math.abs(max - min) < 1e-3 ? `${max.toFixed(2)} s` : `${min.toFixed(2)}–${max.toFixed(2)} s`
}

function Heading({ label, count, children }: { label: string; count?: number; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 6px 0 12px", background: "var(--bg-panel-header)", borderTop: "1px solid var(--border-main)", borderBottom: "1px solid var(--border-main)" }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)" }}>{label}</span>
      {count !== undefined && <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 6 }}>{count}</span>}
      <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>{children}</span>
    </div>
  )
}

function Row({ children, active, onClick }: { children: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <div onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 7, height: 28, padding: "0 10px", fontSize: 12, cursor: onClick ? "pointer" : "default", borderBottom: "1px solid var(--border-light)",
        background: active ? "var(--tree-selection-bg)" : "transparent", color: active ? "var(--tree-selection-fg)" : "var(--text-primary)" }}>
      {children}
    </div>
  )
}

function None({ children }: { children: ReactNode }) {
  return <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>{children}</div>
}

function SmallIcon({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button title={title} onClick={onClick}
      style={{ width: 22, height: 22, border: "none", background: "transparent", borderRadius: 3, cursor: "pointer", opacity: 0.75, display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,0,0,0.08)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
      <i className={`ti ${icon}`} style={{ fontSize: 14 }} />
    </button>
  )
}

function TextField({ value, onCommit, big, list, warn }: { value: string; onCommit: (v: string) => void; big?: boolean; list?: string; warn?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input style={{ ...propertyInputStyle, width: big ? "100%" : 120, fontSize: big ? 15 : 11, fontWeight: big ? 600 : 400, height: big ? 26 : 20, ...(warn ? { borderColor: "#d97706", background: "rgba(217,119,6,0.08)" } : {}) }}
      list={list} title={warn}
      value={text} onChange={e => setText(e.target.value)}
      onBlur={() => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value) }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
  )
}

function Missing({ kind, names, hint }: { kind: string; names: string[]; hint: string }) {
  return (
    <div style={{ marginTop: 4, color: "#b45309" }} title={`Not registered in the robot code: on the robot this does nothing and raises an alert. Register it with ${hint}.`}>
      <i className="ti ti-alert-triangle" /> {kind} not in the robot code: <b>{names.join(", ")}</b>
    </div>
  )
}

function NumberField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <input style={{ ...propertyInputStyle, width: 52, fontFamily: "Consolas, 'Cascadia Mono', monospace" }}
      value={text} onChange={e => setText(e.target.value)}
      onBlur={() => { const v = Number(text); if (Number.isFinite(v)) onCommit(v); else setText(String(value)) }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
  )
}
