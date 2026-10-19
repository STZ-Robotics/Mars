import { ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { FIELDS } from "@desktop/utils/field/fieldImages"
import type { RobotConfig } from "../robot/types"
import type { FieldDoc } from "../paths/types"
import { drawFieldBackground, drawOccluders, drawTags } from "../paths/FieldView"
import { estimateOccluders, occludersFor, tagsForField, type Occluder } from "../vision/vision"
import { QInput } from "../ui/controls"
import { fieldSketch } from "../paths/fieldSketch"
import { loadView } from "../paths/PathsPage"
import { Toggle } from "../ui/controls"
import { useToast } from "../ui/toasts"
import { drawCells, drawNavGrid, NAVGRID_COLOR } from "./drawNavGrid"
import {
  DEFAULT_NODE_M, NavGrid, blockKeepOuts, blockedAt, blockedCount, box, cols, emptyGrid, grow, paint,
  resample, route, routeLength, rows, stroke, symmetrize,
} from "./navgrid"
import { useField } from "../ui/field"

// The Field tab: what is true of the field for every path. For now, the
// navigation grid (navgrid.json): the cells the pathfinder keeps the
// robot's center out of, for the "?" segments in Ares and for AresLib's
// pathfinder on the robot. Keep-outs and slow zones are still drawn in Paths
// and shown here for reference.

type Shape = "brush" | "box"
type Tool = { kind: "paint"; shape: Shape; block: boolean } | { kind: "route" }

const SIDEBAR_WIDTH = 300
const SAVE_DELAY_MS = 400
const CELL_SIZES = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]

interface View { k: number; ox: number; oy: number }

export default function FieldPage({ robot, robotPath }: { robot: RobotConfig; robotPath: string | null }) {
  const toast = useToast()
  const { field, size: FIELD_SIZE } = useField()
  const [L, W] = field.sizeMeters
  const [doc, setDoc] = useState<FieldDoc | null>(null)
  const grid = doc?.navgrid
  const [tool, setTool] = useState<Tool>({ kind: "paint", shape: "brush", block: true })
  const [brushM, setBrushM] = useState(0)
  const [symmetry, setSymmetry] = useState<"rotate" | "mirror">("rotate")
  const [routeAB, setRouteAB] = useState<{ a: [number, number]; b?: [number, number] } | null>(null)
  const history = useRef<{ undo: (NavGrid | undefined)[]; redo: (NavGrid | undefined)[] }>({ undo: [], redo: [] })
  const [showKeepOuts, setShowKeepOutsState] = useState(() => { try { return localStorage.getItem("ares.navgridKeepOuts") === "1" } catch { return false } })
  const setShowKeepOuts = (on: boolean) => { setShowKeepOutsState(on); try { localStorage.setItem("ares.navgridKeepOuts", on ? "1" : "0") } catch { /* not remembered */ } }
  const [, setTick] = useState(0)
  const reach = Math.hypot(robot.bumper.lengthM, robot.bumper.widthM) / 2

  useEffect(() => {
    history.current = { undo: [], redo: [] }
    if (!robotPath) { setDoc(null); return }
    invoke<FieldDoc>("field_open", { robotPath }).then(setDoc).catch(e => toast({ kind: "error", title: "Could not open the field", body: String(e) }))
  }, [robotPath])

  // Saved a moment after the last change. Only the navgrid is this page's:
  // the rest of field.json is re-read, so a keep-out a formula moved meanwhile
  // is not put back.
  const firstSave = useRef(true)
  useEffect(() => {
    if (!robotPath || !doc) return
    if (firstSave.current) { firstSave.current = false; return }
    const t = setTimeout(async () => {
      try {
        const now = await invoke<FieldDoc>("field_open", { robotPath })
        await invoke("field_save", { robotPath, field: { ...now, navgrid: doc.navgrid, occluders: doc.occluders }, fieldSize: FIELD_SIZE })
      } catch (e) {
        toast({ kind: "error", title: "Could not save the field", body: String(e) })
      }
    }, SAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [doc?.navgrid, doc?.occluders])

  /** Changes the grid; `record` puts the old one on the undo stack (once per gesture). */
  const setGrid = useCallback((f: (g: NavGrid | undefined) => NavGrid | undefined, record: boolean) => {
    setDoc(d => {
      if (!d) return d
      if (record) {
        history.current.undo.push(d.navgrid)
        if (history.current.undo.length > 100) history.current.undo.shift()
        history.current.redo = []
        setTick(t => t + 1)
      }
      return { ...d, navgrid: f(d.navgrid) }
    })
  }, [])

  const travel = (dir: "undo" | "redo") => {
    const h = history.current
    const from = dir === "undo" ? h.undo : h.redo, to = dir === "undo" ? h.redo : h.undo
    if (!from.length || !doc) return
    to.push(doc.navgrid)
    const g = from.pop()
    setDoc(d => (d ? { ...d, navgrid: g } : d))
    setTick(t => t + 1)
  }

  const create = (node: number) => setGrid(() => emptyGrid(L, W, node), true)

  const importGrid = async () => {
    const path = await open({ multiple: false, title: "Import a navgrid.json", filters: [{ name: "navgrid.json", extensions: ["json"] }] })
    if (typeof path !== "string") return
    try {
      const g = await invoke<NavGrid>("navgrid_import", { path })
      setGrid(() => fitTo(g, L, W), true)
      toast({ kind: "success", title: "Navgrid imported", body: `${cols(g)} × ${rows(g)} cells of ${g.nodeSizeMeters} m, ${blockedCount(g)} blocked.` })
    } catch (e) {
      toast({ kind: "error", title: "Could not import it", body: String(e) })
    }
  }

  const exportGrid = async () => {
    if (!grid) return
    const path = await save({ title: "Export the navgrid.json", defaultPath: "navgrid.json", filters: [{ name: "navgrid.json", extensions: ["json"] }] })
    if (!path) return
    try {
      await invoke("navgrid_export", { path, grid, fieldSize: FIELD_SIZE })
      toast({ kind: "success", title: "Navgrid exported", body: path })
    } catch (e) {
      toast({ kind: "error", title: "Could not export it", body: String(e) })
    }
  }

  // Keys: B / E brush, R box, T route, G grow (Shift: shrink), undo/redo.
  const keys = useRef({ travel, setGrid, grid })
  keys.current = { travel, setGrid, grid }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); keys.current.travel(e.shiftKey ? "redo" : "undo"); return }
      if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); keys.current.travel("redo"); return }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (k === "b") setTool(t => ({ kind: "paint", shape: t.kind === "paint" ? t.shape : "brush", block: true }))
      else if (k === "e") setTool(t => ({ kind: "paint", shape: t.kind === "paint" ? t.shape : "brush", block: false }))
      else if (k === "r") setTool(t => ({ kind: "paint", shape: "box", block: t.kind === "paint" ? t.block : true }))
      else if (k === "t") setTool({ kind: "route" })
      else if (k === "g" && keys.current.grid) keys.current.setGrid(g => (g ? grow(g, e.shiftKey ? -1 : 1) : g), true)
      else if (k === "escape") setRouteAB(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (!robotPath) {
    return <Empty>Open a robot (File → Open robot…) to edit its field.</Empty>
  }
  if (!doc) return <Empty>Loading the field…</Empty>

  const total = grid ? rows(grid) * cols(grid) : 0
  const blocked = grid ? blockedCount(grid) : 0
  const path = routeAB?.b && grid ? route(grid, routeAB.a, routeAB.b) : null
  const h = history.current

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ width: SIDEBAR_WIDTH, flexShrink: 0, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--border-light)" }}>
          <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4, display: "flex", alignItems: "center" }}>
            Field
            <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
              <IconButton icon="ti-arrow-back-up" title="Undo (Ctrl+Z)" onClick={() => travel("undo")} disabled={h.undo.length === 0} />
              <IconButton icon="ti-arrow-forward-up" title="Redo (Ctrl+Shift+Z)" onClick={() => travel("redo")} disabled={h.redo.length === 0} />
            </span>
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Navigation grid</div>
          <div style={{ fontSize: 10, color: "var(--text-header-subtitle)", marginTop: 5 }}>
            {L} × {W} m · {doc.keepOut.length} keep-out{doc.keepOut.length === 1 ? "" : "s"} (drawn in Paths)
          </div>
          {doc.keepOut.length > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}
              title="The keep-outs drawn in Paths, as faint outlines under the grid: only to compare. The grid alone is what the pathfinder uses on the robot.">
              <input type="checkbox" checked={showKeepOuts} onChange={e => setShowKeepOuts(e.target.checked)} /> Show the keep-outs under the grid
            </label>
          )}
        </div>

        <Structures
          drawn={doc.occluders ?? null}
          estimated={estimateOccluders(tagsForField(field.key))}
          onChange={occluders => setDoc(d => (d ? { ...d, occluders } : d))}
        />

        <Heading label="Navgrid" />
        <Help>
          Where the <b>pathfinder</b> may not take the robot: the <b style={{ color: "#16a34a" }}>?</b> segments in Ares, and AresLib on the robot.
          A path you draw goes where you draw it. A blocked cell is one the robot's <b>center</b> cannot enter, so paint an obstacle
          <b> plus the robot's reach</b> ({reach.toFixed(2)} m from its center to a bumper corner): <i>Grow</i> adds a cell all around.
          The standard navgrid.json format.
        </Help>
        {!grid ? (
          <div style={{ padding: "4px 12px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            <Button icon="ti-grid-4x4" onClick={() => create(DEFAULT_NODE_M)}>Create a navgrid ({DEFAULT_NODE_M} m cells)</Button>
            <Button icon="ti-file-import" onClick={importGrid}>Import a navgrid.json…</Button>
          </div>
        ) : (
          <>
            <PropertyRow label="Cells">
              <span style={{ fontSize: 11 }}>{cols(grid)} × {rows(grid)}</span>
              <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: 6 }}>{blocked} blocked ({total ? Math.round(100 * blocked / total) : 0}%)</span>
            </PropertyRow>
            <PropertyRow label="Cell size">
              <select style={propertyInputStyle} value={grid.nodeSizeMeters}
                onChange={e => { const n = Number(e.target.value); setGrid(g => (g ? resample(g, n, L, W) : g), true) }}>
                {[...new Set([...CELL_SIZES, grid.nodeSizeMeters])].sort((a, b) => a - b).map(s => (
                  <option key={s} value={s}>{s} m{s === DEFAULT_NODE_M ? " (standard)" : ""}</option>
                ))}
              </select>
            </PropertyRow>
            <div style={{ padding: "2px 12px 6px", fontSize: 10, color: "var(--text-muted)" }}>
              Smaller cells fit tighter gaps; the robot searches more of them. Changing it resamples what is painted.
            </div>

            <Heading label="Edit" />
            <div style={{ padding: "8px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <Button icon="ti-arrows-maximize" title="Every blocked area one cell bigger (G)" onClick={() => setGrid(g => (g ? grow(g, 1) : g), true)}>Grow</Button>
              <Button icon="ti-arrows-minimize" title="Every blocked area one cell smaller (Shift+G)" onClick={() => setGrid(g => (g ? grow(g, -1) : g), true)}>Shrink</Button>
              <Button icon="ti-circle-off" title="Block where the robot's center would put its bumper in a keep-out" onClick={() => setGrid(g => (g ? blockKeepOuts(g, doc.keepOut, reach) : g), true)}>From keep-outs</Button>
              <Button icon="ti-eraser" title="Open every cell" onClick={() => setGrid(g => (g ? emptyGrid(L, W, g.nodeSizeMeters) : g), true)}>Clear all</Button>
            </div>
            <PropertyRow label="Other alliance">
              <select style={{ ...propertyInputStyle, width: 120 }} value={symmetry} onChange={e => setSymmetry(e.target.value as "rotate" | "mirror")}>
                <option value="rotate">Rotated (2026)</option>
                <option value="mirror">Mirrored</option>
              </select>
              <Button icon="ti-arrows-exchange" title="Copy what is blocked to the other alliance's side, under the field's symmetry: draw one half, get both"
                onClick={() => setGrid(g => (g ? symmetrize(g, symmetry, L, W) : g), true)}>Copy</Button>
            </PropertyRow>

            <Heading label="File" />
            <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              <Button icon="ti-file-import" onClick={importGrid}>Import a navgrid.json…</Button>
              <Button icon="ti-file-export" onClick={exportGrid}>Export navgrid.json…</Button>
              <Button icon="ti-trash" onClick={() => { if (window.confirm("Delete the navgrid? The pathfinder will only avoid the keep-outs.")) setGrid(() => undefined, true) }}>Delete the navgrid</Button>
            </div>
            <Help>
              Saved in <code>field.json</code>, and as <code>navgrid.json</code> next to the robot, where AresLib reads it after a deploy.
              The <b>?</b> segments that use it are marked out of date when it changes; the other paths are not.
            </Help>
          </>
        )}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 4, padding: "0 10px", background: "var(--bg-menubar)", borderBottom: "1px solid var(--border-main)" }}>
          {grid ? (
            <>
              <span title="Brush (B): paint cells; drag for a stroke. E erases with it."><Toggle on={tool.kind === "paint" && tool.shape === "brush"} onClick={() => setTool(t => ({ kind: "paint", shape: "brush", block: t.kind === "paint" ? t.block : true }))} icon="ti-brush" label="Brush" /></span>
              <span title="Box (R): drag a rectangle of cells."><Toggle on={tool.kind === "paint" && tool.shape === "box"} onClick={() => setTool(t => ({ kind: "paint", shape: "box", block: t.kind === "paint" ? t.block : true }))} icon="ti-square-dashed" label="Box" /></span>
              <Sep />
              <span title="Block (B): what you paint is closed to the pathfinder."><Toggle on={tool.kind === "paint" && tool.block} onClick={() => setTool(t => ({ kind: "paint", shape: t.kind === "paint" ? t.shape : "brush", block: true }))} icon="ti-ban" label="Block" /></span>
              <span title="Clear (E): what you paint is open again. Right-drag pans."><Toggle on={tool.kind === "paint" && !tool.block} onClick={() => setTool(t => ({ kind: "paint", shape: t.kind === "paint" ? t.shape : "brush", block: false }))} icon="ti-eraser" label="Clear" /></span>
              <Sep />
              <span title="The brush's radius: 0 paints one cell" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                Size
                <input type="range" min={0} max={1.2} step={0.05} value={brushM} onChange={e => setBrushM(Number(e.target.value))} style={{ width: 90 }} />
                <span style={{ width: 44, color: "var(--text-muted)" }}>{brushM === 0 ? "1 cell" : `${brushM.toFixed(2)} m`}</span>
              </span>
              <Sep />
              <span title="Route (T): click a start, then a goal: the way the pathfinder takes between them, as AresLib finds it. Esc clears it.">
                <Toggle on={tool.kind === "route"} onClick={() => { setTool({ kind: "route" }); setRouteAB(null) }} icon="ti-route-2" label="Test route" />
              </span>
              {tool.kind === "route" && (
                <span style={{ fontSize: 11, color: path === null && routeAB?.b ? "var(--status-error)" : "var(--text-muted)", marginLeft: 6 }}>
                  {!routeAB ? "Click where the robot starts" : !routeAB.b ? "Now click the goal" : path ? `${routeLength(path).toFixed(2)} m, ${path.length - 2} corner${path.length === 3 ? "" : "s"}` : "There is no way there"}
                </span>
              )}
            </>
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>No navgrid yet: the pathfinder only avoids the keep-outs and the walls.</span>
          )}
        </div>
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          <GridCanvas
            field={field} robot={robot} grid={grid} doc={doc} tool={tool} brushM={brushM} reach={reach} showKeepOuts={showKeepOuts}
            route={path} routeAB={routeAB}
            onPaint={(cells, block, first) => setGrid(g => (g ? paint(g, cells, block) : g), first)}
            onBox={(a, b, block) => setGrid(g => (g ? paint(g, box(g, a, b), block) : g), true)}
            onRoutePoint={p => setRouteAB(r => (!r || r.b ? { a: p } : { a: r.a, b: p }))}
          />
        </div>
      </div>
    </div>
  )
}

/** A grid from elsewhere, sized to this field (rows and columns added or cut). */
function fitTo(g: NavGrid, L: number, W: number): NavGrid {
  const out = emptyGrid(L, W, g.nodeSizeMeters)
  return { ...out, grid: out.grid.map((row, r) => row.map((_, c) => g.grid[r]?.[c] ?? false)) }
}

function GridCanvas(p: {
  field: (typeof FIELDS)[number]
  robot: RobotConfig
  grid: NavGrid | undefined
  doc: FieldDoc
  tool: Tool
  brushM: number
  reach: number
  /** The keep-outs under the grid, faint, to compare; off by default (they cluttered the grid). */
  showKeepOuts: boolean
  route: [number, number][] | null
  routeAB: { a: [number, number]; b?: [number, number] } | null
  onPaint: (cells: [number, number][], block: boolean, first: boolean) => void
  onBox: (a: [number, number], b: [number, number], block: boolean) => void
  onRoutePoint: (p: [number, number]) => void
}) {
  const { field, grid, tool } = p
  const [L, W] = field.sizeMeters
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ k: 50, ox: 0, oy: 0 })
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [sketch, setSketch] = useState<HTMLCanvasElement | null>(null)
  const [cursor, setCursor] = useState<[number, number] | null>(null)
  const [boxDraft, setBoxDraft] = useState<{ a: [number, number]; b: [number, number] } | null>(null)
  const drag = useRef<{ kind: "paint"; last: [number, number] } | { kind: "box"; a: [number, number] } | { kind: "pan"; sx: number; sy: number; v: View } | null>(null)
  const opts = useRef(loadView()).current

  useEffect(() => {
    const img = new Image()
    img.onload = () => { setImage(img); fieldSketch(img).then(setSketch) }
    img.src = field.imageUrl
  }, [field.imageUrl])

  useEffect(() => {
    const el = hostRef.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (!size.w || !size.h) return
    const margin = 40
    const k = Math.min((size.w - 2 * margin) / L, (size.h - 2 * margin) / W)
    setView({ k, ox: (size.w - L * k) / 2, oy: (size.h + W * k) / 2 })
  }, [size.w, size.h, L, W])
  useEffect(fit, [size.w > 0 && size.h > 0])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === "INPUT" || el.tagName === "SELECT") return
      if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) fit()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fit])

  const toScreen = (x: number, y: number, v = view): [number, number] => [v.ox + x * v.k, v.oy - y * v.k]
  const toWorld = (sx: number, sy: number, v = view): [number, number] => [(sx - v.ox) / v.k, (v.oy - sy) / v.k]

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.w || !size.h) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawFieldBackground(ctx, size, toScreen, view.k, field, image, sketch, opts)
    // The field's AprilTags: where the cameras will look.
    // The structures (drawn, or estimated from the tags) and the tags on them.
    drawOccluders(ctx, toScreen, view.k, occludersFor(p.doc.occluders, tagsForField(field.key)))
    drawTags(ctx, toScreen, view.k, tagsForField(field.key), new Map())

    // Keep-outs, only when asked: a faint outline of each, to compare.
    if (p.showKeepOuts) {
      for (const c of p.doc.keepOut) {
        const [cx, cy] = toScreen(c.x, c.y)
        ctx.strokeStyle = "rgba(194,28,28,0.45)"
        ctx.lineWidth = 1
        ctx.setLineDash([3, 4])
        ctx.beginPath(); ctx.arc(cx, cy, c.radiusM * view.k, 0, 2 * Math.PI); ctx.stroke()
        ctx.setLineDash([])
      }
    }

    if (grid) {
      drawCells(ctx, toScreen, view.k, grid)
      drawNavGrid(ctx, toScreen, view.k, grid, true)
    }

    if (boxDraft && tool.kind === "paint") {
      const [x0, y0] = toScreen(Math.min(boxDraft.a[0], boxDraft.b[0]), Math.max(boxDraft.a[1], boxDraft.b[1]))
      const [x1, y1] = toScreen(Math.max(boxDraft.a[0], boxDraft.b[0]), Math.min(boxDraft.a[1], boxDraft.b[1]))
      ctx.fillStyle = tool.block ? "rgba(124,58,237,0.18)" : "rgba(255,255,255,0.35)"
      ctx.strokeStyle = NAVGRID_COLOR
      ctx.setLineDash([5, 4])
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
      ctx.setLineDash([])
    }

    // The test route: green like a "?" segment, with its corners.
    if (p.routeAB) {
      const dot = (q: [number, number], fill: string) => {
        const [sx, sy] = toScreen(q[0], q[1])
        ctx.fillStyle = fill; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke()
      }
      if (p.route) {
        ctx.strokeStyle = "#16a34a"
        ctx.lineWidth = 3
        ctx.beginPath()
        p.route.forEach((q, i) => { const [sx, sy] = toScreen(q[0], q[1]); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy) })
        ctx.stroke()
        // The band the bumper sweeps around it.
        ctx.strokeStyle = "rgba(22,163,74,0.18)"
        ctx.lineWidth = 2 * Math.max(p.robot.bumper.lengthM, p.robot.bumper.widthM) / 2 * view.k
        ctx.lineJoin = "round"; ctx.lineCap = "round"
        ctx.stroke()
        p.route.slice(1, -1).forEach(q => dot(q, "#16a34a"))
      }
      dot(p.routeAB.a, "#2f6fdb")
      if (p.routeAB.b) dot(p.routeAB.b, p.route ? "#16a34a" : "#c21c1c")
    }

    // Under the pointer: the brush, and the robot's footprint for scale.
    if (cursor && grid) {
      const [sx, sy] = toScreen(cursor[0], cursor[1])
      ctx.strokeStyle = "rgba(28,28,31,0.55)"
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      const bl = p.robot.bumper.lengthM * view.k, bw = p.robot.bumper.widthM * view.k
      ctx.strokeRect(sx - bl / 2, sy - bw / 2, bl, bw)
      ctx.setLineDash([])
      if (tool.kind === "paint" && tool.shape === "brush") {
        ctx.strokeStyle = NAVGRID_COLOR
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(3, p.brushM * view.k), 0, 2 * Math.PI); ctx.stroke()
      }
      ctx.fillStyle = blockedAt(grid, cursor[0], cursor[1]) ? "#c21c1c" : "#1c1c1f"
      ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, 2 * Math.PI); ctx.fill()
    }
  }, [size, view, image, sketch, grid, p.doc, cursor, boxDraft, tool, p.brushM, p.route, p.routeAB, p.reach, p.showKeepOuts, field.key])

  const local = (e: React.MouseEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  const onDown = (e: React.MouseEvent) => {
    const [sx, sy] = local(e)
    if (e.button === 1 || e.button === 2 || !grid) {
      drag.current = { kind: "pan", sx, sy, v: view }
      return
    }
    const w = toWorld(sx, sy)
    if (tool.kind === "route") { p.onRoutePoint(w); return }
    if (tool.shape === "box") {
      drag.current = { kind: "box", a: w }
      setBoxDraft({ a: w, b: w })
      return
    }
    drag.current = { kind: "paint", last: w }
    p.onPaint(stroke(grid, w, w, p.brushM), tool.block, true)
  }

  const onMove = (e: React.MouseEvent) => {
    const [sx, sy] = local(e)
    const w = toWorld(sx, sy)
    setCursor(w)
    const d = drag.current
    if (!d) return
    if (d.kind === "pan") setView({ ...d.v, ox: d.v.ox + sx - d.sx, oy: d.v.oy + sy - d.sy })
    else if (d.kind === "box") setBoxDraft({ a: d.a, b: w })
    else if (d.kind === "paint" && grid && tool.kind === "paint") {
      p.onPaint(stroke(grid, d.last, w, p.brushM), tool.block, false)
      d.last = w
    }
  }

  const onUp = (e: React.MouseEvent) => {
    const d = drag.current
    drag.current = null
    if (d?.kind === "box" && tool.kind === "paint") {
      p.onBox(d.a, toWorld(...local(e)), tool.block)
      setBoxDraft(null)
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    const [sx, sy] = local(e)
    const f = Math.exp(-e.deltaY * 0.0015)
    setView(v => {
      const k = Math.min(Math.max(v.k * f, 10), 600)
      const [wx, wy] = toWorld(sx, sy, v)
      return { k, ox: sx - wx * k, oy: sy + wy * k }
    })
  }

  const cursorStyle = !grid ? "grab" : tool.kind === "route" ? "crosshair" : "none"
  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, display: "block", cursor: cursorStyle }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => { setCursor(null); drag.current = null; setBoxDraft(null) }}
        onWheel={onWheel}
        onContextMenu={e => e.preventDefault()}
      />
      {cursor && (
        <div style={{ position: "absolute", left: 10, bottom: 10, fontSize: 11, background: "rgba(255,255,255,0.9)", border: "1px solid var(--border-main)", padding: "2px 8px", fontVariantNumeric: "tabular-nums" }}>
          {cursor[0].toFixed(2)}, {cursor[1].toFixed(2)} m{grid && blockedAt(grid, cursor[0], cursor[1]) ? " · blocked" : ""}
        </div>
      )}
    </div>
  )
}

function Heading({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 12px", background: "var(--bg-panel-header)", borderTop: "1px solid var(--border-main)", borderBottom: "1px solid var(--border-main)", flexShrink: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-header-eyebrow)" }}>{label}</span>
    </div>
  )
}

function Help({ children }: { children: ReactNode }) {
  return <div style={{ padding: "8px 12px", fontSize: 10.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>{children}</div>
}

function Button({ icon, children, onClick, title }: { icon: string; children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title}
      style={{
        display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "4px 9px", height: 26, cursor: "pointer", marginLeft: 0,
        border: "1px solid var(--btn-classic-border)", borderRadius: 2, background: "var(--btn-classic-bg)", color: "var(--text-primary)",
      }}>
      <i className={`ti ${icon}`} aria-hidden /> {children}
    </button>
  )
}

function IconButton({ icon, title, onClick, disabled }: { icon: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      style={{ border: "none", background: "transparent", cursor: disabled ? "default" : "pointer", padding: 2, color: disabled ? "var(--text-light)" : "var(--icon-tree)", fontSize: 14 }}>
      <i className={`ti ${icon}`} aria-hidden />
    </button>
  )
}

function Sep() {
  return <span style={{ width: 1, height: 20, background: "var(--border-main)", margin: "0 4px" }} />
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13, background: "var(--bg-page)" }}>
      {children}
    </div>
  )
}

/**
 * The field's structures as a 2.5D map: footprints with a height, for what the cameras can and
 * cannot see. Until one is drawn, Ares estimates them from the AprilTags (a group of tags facing
 * several ways is a structure, such as the hub); a drawn list replaces the estimate entirely.
 */
function Structures({ drawn, estimated, onChange }: {
  drawn: Occluder[] | null
  estimated: Occluder[]
  onChange: (occluders: Occluder[] | undefined) => void
}) {
  const list = drawn ?? estimated
  const set = (i: number, patch: Partial<Occluder>) => onChange(list.map((o, j) => (j === i ? { ...o, ...patch } : o)))
  return (
    <>
      <Heading label="Structures (2.5D)" />
      <Help>
        What blocks the cameras' view: each structure is a footprint with a height, so a camera in front of the hub sees the two tags on its
        face and not the ones behind it. {drawn
          ? <>Drawn by hand ({drawn.length}).</>
          : <><b>Estimated from the AprilTags</b> ({estimated.length}): a group of tags facing several ways is a structure, 0.6 m above its highest tag. Edit any value to make it yours.</>}
      </Help>
      {list.map((o, i) => (
        <div key={i} style={{ borderBottom: "1px solid var(--border-light)", paddingBottom: 4 }}>
          <PropertyRow label="Name">
            <input style={propertyInputStyle} value={o.name} onChange={e => set(i, { name: e.target.value })} />
            <Button icon="ti-trash" title="Remove it" onClick={() => onChange(list.filter((_, j) => j !== i))}>{""}</Button>
          </PropertyRow>
          <PropertyRow label="Center x, y (m)">
            <div style={{ display: "flex", gap: 4, width: "100%" }}>
              <QInput dim="length" value={o.x} onChange={v => set(i, { x: v })} />
              <QInput dim="length" value={o.y} onChange={v => set(i, { y: v })} />
            </div>
          </PropertyRow>
          <PropertyRow label="Length, width (m)">
            <div style={{ display: "flex", gap: 4, width: "100%" }}>
              <QInput dim="length" value={o.lengthM} onChange={v => set(i, { lengthM: Math.max(0.01, v) })} />
              <QInput dim="length" value={o.widthM} onChange={v => set(i, { widthM: Math.max(0.01, v) })} />
            </div>
          </PropertyRow>
          <PropertyRow label="Turned (°)">
            <QInput dim="plain" value={o.yawDeg ?? 0} onChange={v => set(i, { yawDeg: v })} />
          </PropertyRow>
          <PropertyRow label="From, to height (m)">
            <div style={{ display: "flex", gap: 4, width: "100%" }} title="From the carpet up. A bar the robot drives under starts above 0.">
              <QInput dim="length" value={o.zMinM ?? 0} onChange={v => set(i, { zMinM: Math.max(0, v) })} />
              <QInput dim="length" value={o.zMaxM} onChange={v => set(i, { zMaxM: Math.max(0.01, v) })} />
            </div>
          </PropertyRow>
        </div>
      ))}
      <div style={{ padding: "8px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <Button icon="ti-plus" title="A new structure in the middle of the field" onClick={() => onChange([...list, { name: `structure ${list.length + 1}`, x: 8.27, y: 4.03, lengthM: 1, widthM: 1, yawDeg: 0, zMinM: 0, zMaxM: 1 }])}>Add</Button>
        {drawn
          ? <Button icon="ti-wand" title="Forget the drawn ones and estimate them from the AprilTags again" onClick={() => onChange(undefined)}>Estimate again</Button>
          : <Button icon="ti-ban" title="Nothing blocks the cameras (an empty map)" onClick={() => onChange([])}>None</Button>}
      </div>
    </>
  )
}
