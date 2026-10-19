import { useEffect, useRef, useState } from "react"
import type { NavGrid } from "../field/navgrid"
import { drawNavGrid } from "../field/drawNavGrid"
import type { FieldConfig } from "@desktop/utils/field/fieldImages"
import { Detection, detections, fovOnFloor, fovPolygon, Occluder, poseSigma, Tag, VisionMap, World } from "../vision/vision"
import type { RobotConfig } from "../robot/types"
import {
  KeepOut, PathSpec, RotationTarget, Sample, ScopedConstraint, Selection, SlowZone, Tool, Trajectory, ViewOptions, constraintChip, kindOf, rangeOf, sampleAt, stopAt, waitAt,
  facingDeg, sideName, ALLIANCE_COLOR, allianceOf } from "./types"
import { GLYPH, drawChip, drawHeadingTriangle, drawStop, positionColor, drawAprilTag, sinkChips } from "./glyphs"
import type { TopView } from "../robot/topView"
import { fieldSketch } from "./fieldSketch"
import { linkedPose } from "../vars/variables"
import { symmetryOf } from "../ui/field"

interface Props {
  field: FieldConfig
  robot: RobotConfig
  spec: PathSpec | null
  /** Stage 1 on the current waypoints: the guess, live while editing. */
  guess: Trajectory | null
  /** The last generated trajectory. */
  generated: Trajectory | null
  /** The path changed since it was generated: drawn faded. */
  stale: boolean
  keepOut: KeepOut[]
  /** Where the pathfinder may not go, drawn faintly when the view says so. */
  navgrid?: NavGrid
  /** The field's AprilTags and its structures (the 2.5D map). */
  world: World
  /** How many tags the cameras see from each point, when the view shows it (computed by the page). */
  visionMap?: VisionMap | null
  /** The view holds still: no panning, no zooming (Fit still fits). */
  locked?: boolean
  /** When given, the drawing is also painted here in the field's frame (DECAL_PX_PER_M), and
   * `version` goes up: the 3D view lays it on its carpet. */
  decal?: Decal
  selected: Selection
  /** What the pointer is over in the lists: highlighted on the field. */
  hovered: Selection
  tool: Tool
  view: ViewOptions
  /** The speed that colors as "fastest" (the usable speed). */
  topSpeed: number
  playhead: number | null
  fitSignal: number
  /** The robot's STL seen from above, when it has one. */
  topView: TopView | null
  onSelect: (s: Selection) => void
  onMoveWaypoint: (i: number, x: number, y: number, final: boolean) => void
  onRotateWaypoint: (i: number, headingDeg: number, final: boolean) => void
  /** A click on empty field with a placing tool. */
  onFieldClick: (x: number, y: number) => void
  /** A click on a waypoint with the constraint or event tool. */
  onWaypointClick: (i: number) => void
  onMoveKeepOut: (i: number, x: number, y: number, final: boolean) => void
  onResizeKeepOut: (i: number, r: number, final: boolean) => void
  onEditConstraint: (i: number, patch: Partial<ScopedConstraint>, final: boolean) => void
  /** A manual segment's control point dragged; `free` (Alt) breaks the tangent. */
  onMoveControl: (i: number, side: "prev" | "next", x: number, y: number, final: boolean, free: boolean) => void
  /** Waypoints selected together (Shift+click, Shift+drag a box). */
  multi: number[]
  onMulti: (indices: number[]) => void
  onMoveGroup: (indices: number[], dx: number, dy: number, final: boolean) => void
  /** Pose variables, drawn as marks and used as alignment guides. */
  poseMarks: { name: string; x: number; y: number; heading: number }[]
  /** Slow zones on the field. */
  zones: SlowZone[]
  onAddZone: (z: SlowZone) => void
  onEditZone: (i: number, patch: Partial<SlowZone>, final: boolean) => void
  /** Paths that branch off this one, drawn from their fork. */
  branches: { name: string; condition?: string; fork: [number, number]; points: [number, number][] }[]
  onOpenPath: (name: string) => void
  onAddRotation: (segment: number, fraction: number, headingDeg: number) => void
  onEditRotation: (i: number, patch: Partial<RotationTarget>, final: boolean) => void
}

interface View { k: number; ox: number; oy: number }

type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "waypoint"; index: number; dx: number; dy: number }
  | { kind: "heading"; index: number }
  | { kind: "keepout"; index: number; dx: number; dy: number }
  | { kind: "radius"; index: number }
  | { kind: "shape"; index: number; handle: "move" | "radius" | "corner"; dx: number; dy: number }
  | { kind: "event"; index: number }
  | { kind: "control"; index: number; side: "prev" | "next" }
  | { kind: "group"; indices: number[]; ax: number; ay: number }
  | { kind: "box"; ax: number; ay: number }
  | { kind: "ruler"; ax: number; ay: number }
  | { kind: "zoneNew"; ax: number; ay: number }
  | { kind: "zone"; index: number; handle: "move" | "corner" | "radius"; dx: number; dy: number }
  | { kind: "rotation"; index: number }

const HANDLE_R = 8
const HEADING_HANDLE_R = 5.5
export const COLORS = {
  start: "#1f7a1f",
  end: "#a83c3c",
  mid: "#2f6fdb",
  selected: "#d4a514",
  ink: "#1c1c1f",
  guess: "rgba(28, 28, 31, 0.55)",
  keepout: "rgba(194, 28, 28, 0.16)",
  keepoutEdge: "#c21c1c",
  keepin: "#1f7a1f",
  constraint: "#e95420",
  event: "#a1690a",
}

// Cool to warm: the ramp every scalar gradient uses, and the legend shows.
const RAMP: [number, [number, number, number]][] = [
  [0, [47, 111, 219]],
  [0.5, [28, 143, 120]],
  [0.8, [214, 160, 20]],
  [1, [194, 28, 28]],
]

export function rampColor(f: number): string {
  const x = Math.min(1, Math.max(0, f))
  for (let i = 1; i < RAMP.length; i++) {
    const [b, cb] = RAMP[i]
    const [a, ca] = RAMP[i - 1]
    if (x <= b) {
      const t = (x - a) / (b - a)
      const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * t))
      return `rgb(${c[0]},${c[1]},${c[2]})`
    }
  }
  return "rgb(194,28,28)"
}

export const RAMP_CSS = `linear-gradient(90deg, ${RAMP.map(([f]) => `${rampColor(f)} ${f * 100}%`).join(", ")})`

const SPLIT_COLORS = ["#2f6fdb", "#c2410c", "#1f7a1f", "#e95420", "#0e7490", "#a1690a"]

// The field from above, in WPILib's frame (origin at the blue corner, X along
// the field, Y up the screen). It draws the photo, the keep-outs and the
// constraint shapes, the guess and the generated trajectory, the waypoints,
// the events and the playback robot, and turns mouse gestures into edits it
// hands back to the page.
/** The 2D drawing on a canvas in the field's own frame, for the 3D view: no photo under it. */
export interface Decal {
  canvas: HTMLCanvasElement
  version: number
  /** The labels of the drawing, left off the carpet: the 3D view floats them, in field coordinates.
   * `select` is what a click on one selects. */
  labels: DecalLabel[]
}

export interface DecalLabel { x: number; y: number; text: string; color: string; filled: boolean; select?: Selection }

/** The decal's resolution: enough for the chips to read on the 3D carpet. */
export const DECAL_PX_PER_M = 100

export default function FieldView(props: Props) {
  const { field, robot, spec, guess, generated, stale, keepOut, selected, hovered, tool, view: opts, topSpeed, playhead, fitSignal, topView } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ k: 50, ox: 0, oy: 0 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [sketch, setSketch] = useState<HTMLCanvasElement | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [hoverWp, setHoverWp] = useState<number | null>(null)
  // Overlays of the current gesture: the box being drawn, the ruler, the
  // alignment guides of a drag.
  const [box, setBox] = useState<{ a: [number, number]; b: [number, number] } | null>(null)
  const [ruler, setRuler] = useState<{ a: [number, number]; b: [number, number] } | null>(null)
  const [guides, setGuides] = useState<{ x?: number; y?: number } | null>(null)
  const [zoneDraft, setZoneDraft] = useState<{ a: [number, number]; b: [number, number] } | null>(null)
  const [tip, setTip] = useState<{ sx: number; sy: number; title: string; lines: string[]; hint?: string } | null>(null)
  const drag = useRef<Drag | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const [L, W] = field.sizeMeters

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      setImage(img)
      fieldSketch(img).then(setSketch)
    }
    img.src = field.imageUrl
  }, [field.imageUrl])

  useEffect(() => {
    const el = hostRef.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ready = size.w > 0 && size.h > 0
  useEffect(() => {
    if (!ready) return
    const margin = 40
    const k = Math.min((size.w - 2 * margin) / L, (size.h - 2 * margin) / W)
    setView({ k, ox: (size.w - L * k) / 2, oy: (size.h + W * k) / 2 })
  }, [fitSignal, ready, L, W])

  const toScreen = (x: number, y: number, v = view): [number, number] => [v.ox + x * v.k, v.oy - y * v.k]
  const toWorld = (sx: number, sy: number, v = view): [number, number] => [(sx - v.ox) / v.k, (v.oy - sy) / v.k]

  // Where a waypoint's heading is drawn: its own for a pose, else what the
  // trajectory does there.
  const reference = generated ?? guess
  const headingOf = (i: number): number => {
    const w = spec!.waypoints[i]
    if (kindOf(w) === "pose" && w.headingDeg !== undefined) return w.headingDeg * Math.PI / 180
    return headingNear(reference, w.x, w.y)
  }

  // --- Drawing ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !ready) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paint(ctx, toScreen, view.k, false)

    // The decal: the same drawing in the field's own frame, for the 3D view's carpet.
    const d = props.decal
    if (d) {
      const dk = DECAL_PX_PER_M
      if (d.canvas.width !== Math.round(L * dk)) {
        d.canvas.width = Math.round(L * dk)
        d.canvas.height = Math.round(W * dk)
      }
      const dctx = d.canvas.getContext("2d")!
      dctx.setTransform(1, 0, 0, 1, 0, 0)
      dctx.clearRect(0, 0, d.canvas.width, d.canvas.height)
      d.labels = []
      const h = d.canvas.height
      sinkChips((x, y, text, color, filled) => d.labels.push({ x: x / dk, y: (h - y) / dk, text, color, filled }))
      try {
        paint(dctx, (x: number, y: number): [number, number] => [x * dk, h - y * dk], dk, true)
      } finally {
        sinkChips(null)
      }
      d.version++
    }

    /** On the decal, a label to float over (x, y) in the 3D view instead of painting it. */
    function float(x: number, y: number, text: string, color: string, filled: boolean, select?: Selection) {
      props.decal?.labels.push({ x, y, text, color, filled, select })
    }

    /** Everything the editor shows, at scale `k` (px per meter); `decal` leaves out the photo and
     * what the 3D view draws itself (the tags, the structures, the robot and its cameras). */
    function paint(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, decal: boolean) {
    const plan = opts.fieldStyle === "blueprint"
    if (!decal) drawFieldBackground(ctx, size, toScreen, k, field, image, sketch, opts)

    if (opts.navgrid && props.navgrid) drawNavGrid(ctx, toScreen, k, props.navgrid, false)
    if (opts.visionMap && props.visionMap) drawVisionMap(ctx, toScreen, k, props.visionMap)
    if (opts.occluders && !decal) drawOccluders(ctx, toScreen, k, props.world.occluders)

    // What the cameras see: from the playback robot, else from the selected waypoint's robot.
    const cams = robot.cameras ?? []
    const lookers: [number, number, number][] = []
    if (opts.cameras && cams.length && props.world.tags.length && !decal) {
      const traj = generated ?? guess
      if (traj && playhead !== null) {
        const s = sampleAt(traj, playhead)
        lookers.push([s.x, s.y, s.heading])
      } else if (spec && selected?.kind === "waypoint" && spec.waypoints[selected.index]) {
        const w = spec.waypoints[selected.index]
        const kind = kindOf(w)
        if (kind !== "empty" && kind !== "unknown") lookers.push([w.x, w.y, headingOf(selected.index)])
      }
    }
    // With the hidden ones: in a camera's view and range but behind a structure, drawn apart.
    const seen: Detection[] = lookers.flatMap(([x, y, h]) => detections(robot, props.world, x, y, h, true))
    if (opts.tags && !decal) drawTags(ctx, toScreen, k, props.world.tags, new Map(seen.filter(d => !d.hidden).map(d => [d.tag.id, FOV_GREEN])))

    // Keep-outs shared by every path.
    const reach = Math.hypot(robot.bumper.lengthM, robot.bumper.widthM) / 2
    keepOut.forEach((c, i) => {
      const sel = selected?.kind === "keepout" && selected.index === i
      circle(ctx, toScreen, c.x, c.y, c.radiusM, k, COLORS.keepout, COLORS.keepoutEdge, sel ? 2 : 1.2)
      ctx.setLineDash([4, 4])
      circle(ctx, toScreen, c.x, c.y, c.radiusM + reach * 0.5, k, null, "rgba(194,28,28,0.35)", 1)
      ctx.setLineDash([])
      if (sel) handle(ctx, ...toScreen(c.x + c.radiusM, c.y), 4.5, "#ffffff", COLORS.keepoutEdge)
    })

    // Constraint shapes: faint for all, strong (with handles) for the selected.
    if (spec) {
      spec.scoped.forEach((c, i) => {
        const sel = selected?.kind === "constraint" && selected.index === i
        drawShape(ctx, toScreen, k, c, sel, c.enabled === false)
      })
    }

    // The guess, thin and dashed.
    if (guess && opts.guess) {
      ctx.setLineDash([6, 5])
      // Pathfind segments are not part of the guess: they get their own look.
      const wt = guess.waypointTimes
      const pf = (spec?.waypoints ?? []).map((w, j) => (isPathfind(w, j) && wt && wt[j + 1] !== undefined ? [wt[j], wt[j + 1]] : null)).filter(Boolean) as [number, number][]
      const pts = guess.samples.filter(q => !pf.some(([a, b]) => q.t > a + 1e-9 && q.t < b - 1e-9)).map(s => toScreen(s.x, s.y))
      if (!plan) {
        ctx.setLineDash([])
        polyline(ctx, pts, "rgba(255,255,255,0.85)", 4)
        ctx.setLineDash([6, 5])
      }
      polyline(ctx, pts, plan ? COLORS.guess : "#111114", 1.6)
      ctx.setLineDash([])
    }

    // The generated trajectory, by the chosen gradient, and its mirror.
    if (generated && opts.trajectory) {
      ctx.globalAlpha = stale ? 0.35 : 1
      // On the photo, a white casing under the line so it reads over any color.
      const spans = (generated.pathfind ?? []).map(p => [p.startSample, p.endSample] as [number, number])
      // Where the cameras keep tags in view (green) and where they see none (red), as a halo.
      if (opts.poseSigma && cams.length && props.world.tags.length) drawPoseSigma(ctx, toScreen, k, generated, robot, props.world)
      if (opts.cameras && cams.length && props.world.tags.length) drawCoverage(ctx, toScreen, generated, robot, props.world)
      if (!plan) polyline(ctx, generated.samples.map(q => toScreen(q.x, q.y)), "rgba(255,255,255,0.9)", 7.5)
      drawTrajectory(ctx, toScreen, generated, opts.gradient, topSpeed, 4, spans)
      if (opts.flipped) {
        ctx.globalAlpha = stale ? 0.2 : 0.45
        const mirrored = symmetryOf(field) === "mirrored"
        const flip = (x: number, y: number) => toScreen(L - x, mirrored ? y : W - y)
        drawTrajectory(ctx, flip, generated, opts.gradient, topSpeed, 3, spans)
      }
      ctx.globalAlpha = 1
      if (opts.samples) {
        for (const s of generated.samples) {
          const [x, y] = toScreen(s.x, s.y)
          ctx.beginPath()
          ctx.arc(x, y, 2.2, 0, Math.PI * 2)
          ctx.fillStyle = COLORS.ink
          ctx.fill()
        }
      }
    }

    // The selected (or hovered) constraint's scope, over the path.
    const shownConstraint = hovered?.kind === "constraint" ? hovered : selected?.kind === "constraint" ? selected : null
    if (spec && shownConstraint && reference) {
      const c = spec.scoped[shownConstraint.index]
      if (c) {
        const [a, b] = rangeOf(c, spec.waypoints.length)
        const times = reference.waypointTimes
        if (times && times.length === spec.waypoints.length) {
          const pts = reference.samples.filter(s => s.t >= times[a] - 1e-9 && s.t <= times[b] + 1e-9).map(s => toScreen(s.x, s.y))
          ctx.globalAlpha = 0.35
          polyline(ctx, pts, COLORS.constraint, 12)
          ctx.globalAlpha = 1
        }
      }
    }

    // While placing a constraint: the range picked so far.
    if (spec && tool.kind === "constraint" && tool.from !== null) {
      const to = hoverWp ?? tool.from
      const [a, b] = [Math.min(tool.from, to), Math.max(tool.from, to)]
      ctx.setLineDash([3, 3])
      polyline(ctx, spec.waypoints.slice(a, b + 1).map(w => toScreen(w.x, w.y)), COLORS.constraint, 3)
      ctx.setLineDash([])
    }

    // Segment constraints: a chip at the middle of their range, on the path.
    if (spec && opts.waypoints) {
      const n = spec.waypoints.length
      const times = reference?.waypointTimes
      const perMid = new Map<string, number>()
      spec.scoped.forEach((c, i) => {
        if (c.to === undefined || c.enabled === false) return
        const [a, b] = rangeOf(c, n)
        if (a === b) return
        let x: number, y: number
        if (reference && times && times.length === n) {
          const p = sampleAt(reference, (times[a] + times[b]) / 2)
          x = p.x; y = p.y
        } else {
          x = (spec.waypoints[a].x + spec.waypoints[b].x) / 2
          y = (spec.waypoints[a].y + spec.waypoints[b].y) / 2
        }
        // Several on the same range stack instead of overlapping.
        const key = `${a}-${b}`
        const k = perMid.get(key) ?? 0
        perMid.set(key, k + 1)
        const [sx, sy] = toScreen(x, y)
        const sel = (selected?.kind === "constraint" && selected.index === i) || (hovered?.kind === "constraint" && hovered.index === i)
        if (c.type === "seeTags") {
          // The stretch the cameras keep tags in view: small tags along it, a bigger one by the chip.
          if (reference && times && times.length === n) {
            const [ta, tb] = [times[a], times[b]]
            const marks = Math.max(2, Math.min(8, Math.round((tb - ta) / 0.6)))
            for (let m = 1; m < marks; m++) {
              const p = sampleAt(reference, ta + ((tb - ta) * m) / marks)
              const [mx, my] = toScreen(p.x, p.y)
              drawAprilTag(ctx, mx, my, 9)
            }
          }
          const text = constraintChip(c)
          ctx.font = "600 9.5px 'Segoe UI', Arial, sans-serif"
          const w = ctx.measureText(text).width + 10
          const cy = sy - 18 - k * 18
          if (decal) float(x, y, `▣ ${text}`, COLORS.constraint, sel, { kind: "constraint", index: i })
          else {
            drawChip(ctx, sx + 9, cy, text, COLORS.constraint, sel)
            drawAprilTag(ctx, sx + 9 - w / 2 - 9, cy, 15)
          }
        } else if (decal) {
          float(x, y, constraintChip(c), COLORS.constraint, sel, { kind: "constraint", index: i })
        } else {
          drawChip(ctx, sx, sy - 18 - k * 18, constraintChip(c), COLORS.constraint, sel)
        }
      })
    }

    // Branches: dashed magenta from the fork, with a diamond and the
    // condition the robot code checks there.
    for (const b of props.branches) {
      const pts = b.points.map(([x, y]) => toScreen(x, y))
      if (!plan) polyline(ctx, pts, "rgba(255,255,255,0.85)", 6)
      ctx.setLineDash([8, 5])
      polyline(ctx, pts, BRANCH, 3)
      ctx.setLineDash([])
      const end = pts[pts.length - 1]
      if (end) drawChip(ctx, end[0], end[1] - 16, b.name, BRANCH)
    }
    // The diamonds on top, one per fork (several conditions stack).
    const forks = new Map<string, typeof props.branches>()
    for (const b of props.branches) {
      const k = b.fork.join(",")
      forks.set(k, [...(forks.get(k) ?? []), b])
    }
    for (const group of forks.values()) {
      const [fx, fy] = toScreen(...group[0].fork)
      ctx.save()
      ctx.translate(fx, fy)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = BRANCH
      ctx.fillRect(-8, -8, 16, 16)
      ctx.strokeStyle = "#ffffff"
      ctx.lineWidth = 2
      ctx.strokeRect(-8, -8, 16, 16)
      ctx.restore()
      group.forEach((b, k) => drawChip(ctx, fx + 16, fy + 20 + k * 18, `◆ ${b.condition ?? "?"}`, BRANCH, true))
    }

    // Slow zones: hatched amber, with their caps.
    props.zones.forEach((z, i) => {
      const sel = selected?.kind === "zone" && selected.index === i
      drawZone(ctx, toScreen, k, z, sel)
    })

    // Pose variables: small teal diamonds with their names.
    if (opts.waypoints) {
      for (const m of props.poseMarks) {
        const [px, py] = toScreen(m.x, m.y)
        ctx.save()
        ctx.translate(px, py)
        ctx.rotate(Math.PI / 4)
        ctx.fillStyle = "rgba(14,116,144,0.9)"
        ctx.fillRect(-4.5, -4.5, 9, 9)
        ctx.restore()
        const a = -m.heading * Math.PI / 180
        ctx.strokeStyle = GLYPH.linked
        ctx.lineWidth = 1.5
        line(ctx, [px, py], [px + Math.cos(a) * 14, py + Math.sin(a) * 14])
        ctx.fillStyle = GLYPH.linked
        ctx.font = "600 10px 'Segoe UI', Arial, sans-serif"
        ctx.textAlign = "left"
        ctx.textBaseline = "middle"
        ctx.fillText(m.name, px + 8, py - 9)
      }
    }

    // Pathfind segments: the route is found at run time. With a generated
    // trajectory, Ares' estimate (green, dashed) in its corridor; without
    // one, a straight dashed line. Either way, a question mark.
    if (spec && opts.waypoints) {
      const reachM = Math.hypot(robot.bumper.lengthM, robot.bumper.widthM) / 2
      spec.waypoints.forEach((w, j) => {
        const next = spec.waypoints[j + 1]
        if (!isPathfind(w, j) || !next) return
        const span = generated?.pathfind?.find(p => p.fromWaypoint === j)
        const pts = span && generated
          ? generated.samples.slice(span.startSample, span.endSample + 1).map(q => toScreen(q.x, q.y))
          : [toScreen(w.x, w.y), toScreen(next.x, next.y)]
        ctx.globalAlpha = stale && span ? 0.45 : 1
        if (span && opts.corridor) polyline(ctx, pts, "rgba(22,163,74,0.13)", 2 * reachM * k)
        if (!plan) polyline(ctx, pts, "rgba(255,255,255,0.9)", 6)
        ctx.setLineDash([9, 6])
        polyline(ctx, pts, PATHFIND, 3)
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        const mid = pts[Math.floor(pts.length / 2)]
        const mx = pts.length === 2 ? (pts[0][0] + pts[1][0]) / 2 : mid[0]
        const my = pts.length === 2 ? (pts[0][1] + pts[1][1]) / 2 : mid[1]
        ctx.beginPath()
        ctx.arc(mx, my, 11, 0, Math.PI * 2)
        ctx.fillStyle = PATHFIND
        ctx.fill()
        ctx.strokeStyle = "#ffffff"
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.fillStyle = "#ffffff"
        ctx.font = "800 14px 'Segoe UI', Arial, sans-serif"
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText("?", mx, my + 1)
        drawChip(ctx, mx, my + 22, span ? `pathfind ≈ ${span.estimatedS.toFixed(1)} s` : "pathfind · generate to estimate", PATHFIND, false)
      })
    }

    // Manual segments: the user's Bézier, its control handles and a label.
    if (spec && opts.waypoints) {
      spec.waypoints.forEach((w, j) => {
        const next = spec.waypoints[j + 1]
        if (!w.manualNext || !next || !w.nextControl || !next.prevControl) return
        const p0 = toScreen(w.x, w.y), p1 = toScreen(...w.nextControl), p2 = toScreen(...next.prevControl), p3 = toScreen(next.x, next.y)
        ctx.beginPath()
        ctx.moveTo(...p0)
        ctx.bezierCurveTo(...p1, ...p2, ...p3)
        if (!plan) {
          ctx.strokeStyle = "rgba(255,255,255,0.9)"
          ctx.lineWidth = 5.5
          ctx.stroke()
          ctx.strokeStyle = "rgba(255,255,255,0.9)"
          ctx.lineWidth = 4.5
          line(ctx, p0, p1)
          line(ctx, p3, p2)
        }
        ctx.strokeStyle = COLORS.constraint
        ctx.lineWidth = 2.5
        ctx.stroke()
        ctx.lineWidth = 1.2
        line(ctx, p0, p1)
        line(ctx, p3, p2)
        for (const c of [p1, p2]) {
          ctx.fillStyle = "#ffffff"
          ctx.fillRect(c[0] - 5, c[1] - 5, 10, 10)
          ctx.strokeStyle = COLORS.constraint
          ctx.lineWidth = 2
          ctx.strokeRect(c[0] - 5, c[1] - 5, 10, 10)
        }
        const mx = 0.125 * (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]), my = 0.125 * (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1])
        drawChip(ctx, mx, my + 16, "✎ manual", COLORS.constraint, true)
      })
    }

    // Waypoints, each in its own shape (see glyphs.tsx).
    if (spec && opts.waypoints) {
      const n = spec.waypoints.length
      spec.waypoints.forEach((w, i) => {
        const kind = kindOf(w)
        const isSel = selected?.kind === "waypoint" && selected.index === i
        const isHover = hovered?.kind === "waypoint" && hovered.index === i
        const color = positionColor(i, n, isSel)
        const [cx, cy] = toScreen(w.x, w.y)
        if (isHover || (hoverWp === i && tool.kind !== "select" && tool.kind !== "waypoint")) {
          ctx.beginPath()
          ctx.arc(cx, cy, Math.max(HANDLE_R + 7, robot.bumper.lengthM * k * 0.62), 0, Math.PI * 2)
          ctx.strokeStyle = GLYPH.selected
          ctx.lineWidth = 2.5
          ctx.setLineDash([5, 4])
          ctx.stroke()
          ctx.setLineDash([])
        }
        if (kind === "unknown" || kind === "continue") {
          // Start kinds: green "?" ring for an unknown start (the robot can
          // be anywhere, it pathfinds), a teal link for a continued one.
          const ring = kind === "unknown" ? GLYPH.pathfind : GLYPH.linked
          if (kind === "continue") {
            ctx.globalAlpha = 0.7
            bumper(ctx, toScreen, w.x, w.y, headingOf(i), robot, ring, [], 1.6, 0.08)
            ctx.globalAlpha = 1
          } else {
            ctx.setLineDash([5, 4])
            ctx.beginPath()
            ctx.arc(cx, cy, Math.max(16, robot.bumper.lengthM * k * 0.55), 0, Math.PI * 2)
            ctx.strokeStyle = ring
            ctx.lineWidth = 2
            ctx.stroke()
            ctx.setLineDash([])
          }
          handle(ctx, cx, cy, HANDLE_R + 1, kind === "unknown" ? "#ffffff" : ring, ring)
          ctx.fillStyle = kind === "unknown" ? ring : "#ffffff"
          ctx.font = "800 12px 'Segoe UI', Arial, sans-serif"
          ctx.textAlign = "center"
          ctx.textBaseline = "middle"
          ctx.fillText(kind === "unknown" ? "?" : "↪", cx, cy + 1)
          const note = kind === "unknown" ? "start anywhere" : spec.continuesFrom ? `after ${spec.continuesFrom}` : "where the last path ended"
          drawChip(ctx, cx, cy + Math.max(26, robot.bumper.widthM * k * 0.5 + 14), note, ring)
          return
        }
        if (topView && kind !== "empty") {
          drawRobot(ctx, toScreen, k, w.x, w.y, headingOf(i), robot, topView, null, 0.45, opts.robotColor)
        }
        if (kind === "pose") {
          const heading = headingOf(i)
          bumper(ctx, toScreen, w.x, w.y, heading, robot, color, [], isSel ? 2.4 : 1.6, isSel ? 0.2 : 0.12)
          drawHeadingTriangle(ctx, cx, cy, heading, Math.max(7, robot.bumper.lengthM * k * 0.3), color)
          const [hx, hy] = toScreen(w.x + Math.cos(heading) * robot.bumper.lengthM / 2, w.y + Math.sin(heading) * robot.bumper.lengthM / 2)
          handle(ctx, hx, hy, HEADING_HANDLE_R, "#ffffff", color)
        } else if (kind === "translation") {
          // Where the bumper will be, faint: the heading is the planner's.
          ctx.globalAlpha = 0.6
          bumper(ctx, toScreen, w.x, w.y, headingOf(i), robot, color, [4, 4], 1, 0.04)
          ctx.globalAlpha = 1
          handle(ctx, cx, cy, HANDLE_R, color, "#ffffff")
        } else {
          ctx.setLineDash([3, 2.5])
          handle(ctx, cx, cy, HANDLE_R, "rgba(255,255,255,0.75)", color)
          ctx.setLineDash([])
        }
        // The number, under the glyph (over the puck, in 3D).
        ctx.font = "700 10px 'Segoe UI', Arial, sans-serif"
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        if (decal) {
          float(w.x, w.y, `Waypoint ${i + 1}`, color, isSel, { kind: "waypoint", index: i })
        } else if (kind === "translation") {
          ctx.fillStyle = "#ffffff"
          ctx.fillText(String(i + 1), cx, cy + 0.5)
        } else {
          const ly = cy + (kind === "pose" ? Math.max(14, robot.bumper.widthM * k * 0.5 + 9) : 15)
          ctx.lineWidth = 3
          ctx.strokeStyle = "rgba(255,255,255,0.9)"
          ctx.strokeText(String(i + 1), cx, ly)
          ctx.fillStyle = color
          ctx.fillText(String(i + 1), cx, ly)
        }
        // Linked to a pose variable: its name, in the link color.
        const link = linkedPose(w)
        if (link) drawChip(ctx, cx, cy - Math.max(24, robot.bumper.widthM * k * 0.5 + 12), `⛓ ${link}`, GLYPH.linked, true)
        // Badges: stop, waypoint-scope constraints, split.
        const bx = cx + Math.max(13, robot.bumper.lengthM * k * 0.5 + 4)
        let by = cy - Math.max(13, robot.bumper.widthM * k * 0.5 + 4)
        if (stopAt(spec, i) >= 0) {
          const wait = waitAt(spec, i)
          if (decal) float(w.x, w.y, `⬣ STOP${wait > 0 ? ` · wait ${wait} s` : ""}`, GLYPH.stop, true, { kind: "constraint", index: stopAt(spec, i) })
          else {
            drawStop(ctx, bx, by, 7.5)
            if (wait > 0) drawChip(ctx, bx + 30, by, `wait ${wait} s`, GLYPH.stop)
          }
          by += 18
        }
        spec.scoped.forEach((c, j) => {
          if (c.type === "stopPoint" || c.enabled === false) return
          const [a, b] = rangeOf(c, n)
          if (a !== i || b !== i || c.to !== undefined) return
          const sel = (selected?.kind === "constraint" && selected.index === j) || (hovered?.kind === "constraint" && hovered.index === j)
          ctx.save()
          ctx.font = "600 9.5px 'Segoe UI', Arial, sans-serif"
          const w2 = ctx.measureText(constraintChip(c)).width / 2 + 5
          ctx.restore()
          if (decal) float(w.x, w.y, constraintChip(c), COLORS.constraint, sel, { kind: "constraint", index: j })
          else drawChip(ctx, bx + w2 - 7, by, constraintChip(c), COLORS.constraint, sel)
          by += 18
        })
        if ((w.split || w.section) && i > 0 && i < n - 1) drawChip(ctx, bx + 18, by, `✂ ${w.section ?? "split"}`, GLYPH.ink)
      })
    }

    // Rotation targets: an orange arrow on the path at their fraction (the 3D view draws its own, to turn).
    if (spec && opts.waypoints && !decal) {
      (spec.rotationTargets ?? []).forEach((r, i) => {
        const at = rotationPoint(spec, generated ?? guess, r)
        if (!at) return
        const [px, py] = toScreen(at.x, at.y)
        const sel = selected?.kind === "rotation" && selected.index === i
        const a = -r.headingDeg * Math.PI / 180
        ctx.beginPath()
        ctx.arc(px, py, 8, 0, Math.PI * 2)
        ctx.fillStyle = sel ? GLYPH.selected : "#ffffff"
        ctx.fill()
        ctx.strokeStyle = COLORS.constraint
        ctx.lineWidth = 2
        ctx.stroke()
        const tipX = px + Math.cos(a) * 22, tipY = py + Math.sin(a) * 22
        ctx.lineWidth = 2.5
        line(ctx, [px, py], [tipX, tipY])
        ctx.beginPath()
        ctx.moveTo(tipX + Math.cos(a) * 6, tipY + Math.sin(a) * 6)
        ctx.lineTo(tipX + Math.cos(a + 2.5) * 6, tipY + Math.sin(a + 2.5) * 6)
        ctx.lineTo(tipX + Math.cos(a - 2.5) * 6, tipY + Math.sin(a - 2.5) * 6)
        ctx.closePath()
        ctx.fillStyle = COLORS.constraint
        ctx.fill()
        if (sel) handle(ctx, tipX, tipY, 5, "#ffffff", COLORS.constraint)
      })
    }

    // Event zones: a band along the trajectory for their duration.
    if (spec && generated) {
      (generated.events ?? []).forEach(e => {
        if (e.endT === undefined) return
        const pts = generated.samples.filter(q => q.t >= e.t && q.t <= e.endT!).map(q => toScreen(q.x, q.y))
        ctx.globalAlpha = 0.35
        polyline(ctx, pts, COLORS.event, 10)
        ctx.globalAlpha = 1
      })
    }

    // Waypoints selected together.
    if (spec) {
      for (const i of props.multi) {
        const w = spec.waypoints[i]
        if (!w) continue
        const [cx, cy] = toScreen(w.x, w.y)
        ctx.beginPath()
        ctx.arc(cx, cy, HANDLE_R + 6, 0, Math.PI * 2)
        ctx.strokeStyle = GLYPH.selected
        ctx.lineWidth = 2.5
        ctx.stroke()
      }
    }

    // Events: a pin where they fire.
    if (spec) {
      (spec.events ?? []).forEach((e, i) => {
        const p = eventPoint(spec, generated, e, i)
        if (!p) return
        const [x, y] = toScreen(p.x, p.y)
        const sel = selected?.kind === "event" && selected.index === i
        if (decal) float(p.x, p.y, `⚑ ${e.name}`, COLORS.event, sel, { kind: "event", index: i })
        else pin(ctx, x, y, sel ? COLORS.selected : COLORS.event, e.name)
      })
    }

    // Gesture overlays: selection box, new zone, ruler, guides.
    if (box) {
      const [ax, ay] = toScreen(...box.a), [bx, by] = toScreen(...box.b)
      ctx.fillStyle = "rgba(212,165,20,0.1)"
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay))
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = GLYPH.selected
      ctx.lineWidth = 1.5
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay))
      ctx.setLineDash([])
    }
    if (zoneDraft) {
      const [x0, y0] = [Math.min(zoneDraft.a[0], zoneDraft.b[0]), Math.min(zoneDraft.a[1], zoneDraft.b[1])]
      drawZone(ctx, toScreen, k, { shape: "rectangle", x: x0, y: y0, widthM: Math.abs(zoneDraft.b[0] - zoneDraft.a[0]), heightM: Math.abs(zoneDraft.b[1] - zoneDraft.a[1]), maxVelocityMps: 1.5 }, true)
    }
    if (guides) {
      ctx.strokeStyle = "rgba(14,116,144,0.8)"
      ctx.lineWidth = 1
      ctx.setLineDash([6, 4])
      if (guides.x !== undefined) line(ctx, toScreen(guides.x, 0), toScreen(guides.x, W))
      if (guides.y !== undefined) line(ctx, toScreen(0, guides.y), toScreen(L, guides.y))
      ctx.setLineDash([])
    }
    if (ruler) {
      const a = toScreen(...ruler.a), b = toScreen(...ruler.b)
      const d = Math.hypot(ruler.b[0] - ruler.a[0], ruler.b[1] - ruler.a[1])
      const ang = Math.atan2(ruler.b[1] - ruler.a[1], ruler.b[0] - ruler.a[0]) * 180 / Math.PI
      ctx.strokeStyle = "#ffffff"
      ctx.lineWidth = 5
      line(ctx, a, b)
      ctx.strokeStyle = GLYPH.ink
      ctx.lineWidth = 2
      line(ctx, a, b)
      handle(ctx, ...a, 4, "#ffffff", GLYPH.ink)
      handle(ctx, ...b, 4, "#ffffff", GLYPH.ink)
      drawChip(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 14, `${d.toFixed(3)} m · ${(d / 0.0254).toFixed(1)} in · ${ang.toFixed(1)}°`, GLYPH.ink, true)
    }

    // The playback robot, with each wheel's velocity.
    const traj = generated ?? guess
    if (traj && playhead !== null && !decal) {
      const s = sampleAt(traj, playhead)
      drawRobot(ctx, toScreen, k, s.x, s.y, s.heading, robot, topView, opts.robotColor, 1)
      moduleVectors(ctx, toScreen, s, robot)
    }

    for (const [x, y, h] of lookers) drawCameras(ctx, toScreen, k, robot, x, y, h, seen, props.world.occluders)

    // Whose path it is: a chip by its start, in the alliance's color.
    const side = allianceOf(spec, L)
    const start = spec?.waypoints.find(q => kindOf(q) !== "unknown")
    if (side && start && opts.waypoints) {
      const [sx, sy] = toScreen(start.x, start.y)
      drawChip(ctx, sx, sy + Math.max(34, robot.bumper.widthM * k * 0.5 + 24), side === "blue" ? "◆ BLUE ALLIANCE" : "◆ RED ALLIANCE", ALLIANCE_COLOR[side], true)
    }
    }
  }, [view, size, image, sketch, spec, guess, generated, stale, keepOut, selected, hovered, playhead, robot, field, opts, topSpeed, tool, hoverWp, topView, box, ruler, guides, zoneDraft, props.multi, props.zones, props.poseMarks, props.branches, props.navgrid, props.world, props.visionMap, props.decal])

  // --- Interaction -----------------------------------------------------------
  const waypointAt = (sx: number, sy: number): number | null => {
    const p = propsRef.current
    if (!p.spec) return null
    for (let i = p.spec.waypoints.length - 1; i >= 0; i--) {
      const [cx, cy] = toScreen(p.spec.waypoints[i].x, p.spec.waypoints[i].y)
      if (Math.hypot(sx - cx, sy - cy) <= HANDLE_R + 3) return i
    }
    return null
  }

  const hit = (sx: number, sy: number): Drag | null => {
    const p = propsRef.current
    const [wx, wy] = toWorld(sx, sy)
    const near = (x: number, y: number, r = 8) => { const [hx, hy] = toScreen(x, y); return Math.hypot(sx - hx, sy - hy) <= r }
    // The selected constraint's handles first: they sit on top.
    if (p.spec && p.selected?.kind === "constraint") {
      const i = p.selected.index
      const c = p.spec.scoped[i]
      if (c && "x" in c) {
        if (c.type === "keepInCircle" || c.type === "keepOutCircle") {
          if (near(c.x + c.radiusM, c.y)) return { kind: "shape", index: i, handle: "radius", dx: 0, dy: 0 }
        }
        if (c.type === "keepInRectangle" && near(c.x + c.widthM, c.y + c.heightM)) {
          return { kind: "shape", index: i, handle: "corner", dx: 0, dy: 0 }
        }
        if (near(c.x, c.y, 10)) return { kind: "shape", index: i, handle: "move", dx: c.x - wx, dy: c.y - wy }
      }
    }
    if (p.spec && p.view.waypoints) {
      const ws = p.spec.waypoints
      for (let i = ws.length - 1; i >= 0; i--) {
        const w = ws[i]
        if (w.nextControl && w.manualNext && near(...w.nextControl, 8)) return { kind: "control", index: i, side: "next" }
        if (w.prevControl && ws[i - 1]?.manualNext && near(...w.prevControl, 8)) return { kind: "control", index: i, side: "prev" }
      }
      for (let i = p.spec.waypoints.length - 1; i >= 0; i--) {
        const w = p.spec.waypoints[i]
        if (kindOf(w) !== "pose") continue
        const h = headingOf(i)
        if (near(w.x + Math.cos(h) * robot.bumper.lengthM / 2, w.y + Math.sin(h) * robot.bumper.lengthM / 2, HEADING_HANDLE_R + 3)) {
          return { kind: "heading", index: i }
        }
      }
      const i = waypointAt(sx, sy)
      if (i !== null) {
        const w = p.spec.waypoints[i]
        return { kind: "waypoint", index: i, dx: w.x - wx, dy: w.y - wy }
      }
    }
    if (p.spec) {
      const events = p.spec.events ?? []
      for (let i = events.length - 1; i >= 0; i--) {
        const pt = eventPoint(p.spec, p.generated, events[i], i)
        if (pt && near(pt.x, pt.y, 12)) {
          const [ex, ey] = toScreen(pt.x, pt.y)
          if (sy <= ey + 4 && Math.abs(sx - ex) <= 9) return { kind: "event", index: i }
        }
      }
    }
    if (p.spec) {
      const rts = p.spec.rotationTargets ?? []
      for (let i = rts.length - 1; i >= 0; i--) {
        const at = rotationPoint(p.spec, p.generated ?? p.guess, rts[i])
        if (!at) continue
        const a = rts[i].headingDeg * Math.PI / 180
        // The arrow's tip turns it; anywhere on the marker selects it.
        if (near(at.x, at.y, 10)) return { kind: "rotation", index: i }
        const [px, py] = toScreen(at.x, at.y)
        if (Math.hypot(sx - (px + Math.cos(-a) * 22), sy - (py + Math.sin(-a) * 22)) <= 8) return { kind: "rotation", index: i }
      }
    }
    for (let i = p.zones.length - 1; i >= 0; i--) {
      const z = p.zones[i]
      const sel = p.selected?.kind === "zone" && p.selected.index === i
      if (z.shape === "rectangle") {
        if (sel && near(z.x + z.widthM, z.y + z.heightM)) return { kind: "zone", index: i, handle: "corner", dx: 0, dy: 0 }
        if (wx >= z.x && wx <= z.x + z.widthM && wy >= z.y && wy <= z.y + z.heightM) return { kind: "zone", index: i, handle: "move", dx: z.x - wx, dy: z.y - wy }
      } else {
        if (sel && near(z.x + z.radiusM, z.y)) return { kind: "zone", index: i, handle: "radius", dx: 0, dy: 0 }
        if (Math.hypot(wx - z.x, wy - z.y) <= z.radiusM) return { kind: "zone", index: i, handle: "move", dx: z.x - wx, dy: z.y - wy }
      }
    }
    for (let i = p.keepOut.length - 1; i >= 0; i--) {
      const c = p.keepOut[i]
      if (p.selected?.kind === "keepout" && p.selected.index === i && near(c.x + c.radiusM, c.y)) return { kind: "radius", index: i }
      if (Math.hypot(wx - c.x, wy - c.y) <= c.radiusM) return { kind: "keepout", index: i, dx: c.x - wx, dy: c.y - wy }
    }
    return null
  }

  /** The branch whose fork diamond (or condition label) is under the pointer. */
  const branchAt = (sx: number, sy: number) => {
    const p = propsRef.current
    const counts = new Map<string, number>()
    for (const b of p.branches) {
      const k = b.fork.join(",")
      const row = counts.get(k) ?? 0
      counts.set(k, row + 1)
      const [fx, fy] = toScreen(...b.fork)
      if (row === 0 && Math.hypot(sx - fx, sy - fy) <= 11) return b
      if (sx >= fx + 10 && sx <= fx + 130 && Math.abs(sy - (fy + 20 + row * 18)) <= 8) return b
    }
    return null
  }

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  /** A pan from here, unless the view is locked. */
  const panFrom = (sx: number, sy: number): Drag | null => (propsRef.current.locked ? null : { kind: "pan", sx, sy, view })

  const onPointerDown = (e: React.PointerEvent) => {
    const [sx, sy] = local(e)
    const p = propsRef.current
    canvasRef.current!.setPointerCapture(e.pointerId)
    if (e.button !== 0) {
      drag.current = panFrom(sx, sy)
      return
    }
    // Constraint and event tools only care about waypoints.
    if (p.tool.kind === "constraint" || p.tool.kind === "event") {
      const i = waypointAt(sx, sy)
      if (i !== null) p.onWaypointClick(i)
      else drag.current = panFrom(sx, sy)
      return
    }
    const [wx, wy] = toWorld(sx, sy)
    // Tools that start a gesture anywhere.
    if (p.tool.kind === "ruler") {
      const a = snapPoint(wx, wy, null).p
      drag.current = { kind: "ruler", ax: a[0], ay: a[1] }
      setRuler({ a, b: a })
      return
    }
    if (p.tool.kind === "zone") {
      drag.current = { kind: "zoneNew", ax: wx, ay: wy }
      setZoneDraft({ a: [wx, wy], b: [wx, wy] })
      return
    }
    if (p.tool.kind === "rotation") {
      const r = rotationAt(p.spec, p.generated ?? p.guess, sx, sy, toScreen)
      if (r) p.onAddRotation(r.segment, r.fraction, r.headingDeg)
      return
    }
    const fork = branchAt(sx, sy)
    if (fork) { p.onOpenPath(fork.name); return }
    const h = hit(sx, sy)
    if (h) {
      // Shift+click a waypoint adds it to (or takes it out of) the group.
      if (h.kind === "waypoint" && e.shiftKey) {
        const set = new Set(p.multi.length ? p.multi : p.selected?.kind === "waypoint" ? [p.selected.index] : [])
        if (set.has(h.index)) set.delete(h.index)
        else set.add(h.index)
        p.onMulti([...set].sort((a, b) => a - b))
        return
      }
      if (h.kind === "waypoint" && p.multi.length > 1 && p.multi.includes(h.index)) {
        drag.current = { kind: "group", indices: p.multi, ax: wx, ay: wy }
        return
      }
      drag.current = h
      if (h.kind === "waypoint" || h.kind === "heading" || h.kind === "control") { p.onMulti([]); p.onSelect({ kind: "waypoint", index: h.index }) }
      else if (h.kind === "keepout" || h.kind === "radius") p.onSelect({ kind: "keepout", index: h.index })
      else if (h.kind === "event") p.onSelect({ kind: "event", index: h.index })
      else if (h.kind === "zone") p.onSelect({ kind: "zone", index: h.index })
      else if (h.kind === "rotation") p.onSelect({ kind: "rotation", index: h.index })
      return
    }
    if (p.tool.kind === "waypoint" || p.tool.kind === "keepout") { p.onFieldClick(wx, wy); return }
    // Shift+drag on empty field: select a box of waypoints.
    if (e.shiftKey) {
      drag.current = { kind: "box", ax: wx, ay: wy }
      setBox({ a: [wx, wy], b: [wx, wy] })
      return
    }
    p.onSelect(null)
    p.onMulti([])
    drag.current = panFrom(sx, sy)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const [sx, sy] = local(e)
    const [wx, wy] = toWorld(sx, sy)
    setCursor({ x: wx, y: wy })
    const p = propsRef.current
    if (p.tool.kind === "constraint" || p.tool.kind === "event") setHoverWp(waypointAt(sx, sy))
    else if (hoverWp !== null) setHoverWp(null)
    const d = drag.current
    if (d) { setTip(null); applyDrag(d, sx, sy, wx, wy, false) }
    else setTip(describe(sx, sy))
  }

  // What is under the pointer, in words: what it is, its numbers, what the
  // mouse does to it.
  const describe = (sx: number, sy: number): { sx: number; sy: number; title: string; lines: string[]; hint?: string } | null => {
    const p = propsRef.current
    const at = (title: string, lines: string[], hint?: string) => ({ sx, sy, title, lines, hint })
    const fork = branchAt(sx, sy)
    if (fork) {
      return at(`Branch "${fork.name}"`, [
        `Taken when ${fork.condition ?? "its condition"} is true: a NamedCondition the robot code registers.`,
        "Otherwise the robot keeps going along this path.",
        "It starts here, at the speed the robot has here.",
      ], "Click to open the branch.")
    }
    const h = hit(sx, sy)
    const n = p.spec?.waypoints.length ?? 0
    if (h && p.spec) {
      if (h.kind === "heading") {
        const w = p.spec.waypoints[h.index]
        return at(`Heading of waypoint ${h.index + 1}`, [`${(w.headingDeg ?? 0).toFixed(1)}° (0° faces +X, away from the blue wall)`], "Drag to turn the robot here. Hold Shift to snap to 15°.")
      }
      if (h.kind === "waypoint") return at(...waypointWords(p.spec, h.index, p.generated))
      if (h.kind === "control") {
        const seg = h.side === "next" ? `${h.index + 1} → ${h.index + 2}` : `${h.index} → ${h.index + 1}`
        return at(`Curve handle (manual segment ${seg})`, [
          "Shapes the curve you drew by hand. The optimizer keeps the robot on it and only decides how fast it goes.",
        ], "Drag to bend the curve. The opposite handle turns with it to keep it smooth; hold Alt to break the tangent.")
      }
      if (h.kind === "shape") {
        const c = p.spec.scoped[h.index]
        const what = h.handle === "radius" ? "Drag to change the radius." : h.handle === "corner" ? "Drag to resize." : "Drag to move."
        return at(constraintTitle(c.type), [constraintLine(c, n)], what)
      }
      if (h.kind === "event") {
        const e = (p.spec.events ?? [])[h.index]
        const fired = p.generated?.events?.[h.index]
        return at(`Event marker "${e.name}"`, [
          `${e.offsetS >= 0 ? "+" : ""}${e.offsetS.toFixed(2)} s from waypoint ${resolveIdx(e.target, n) + 1}`,
          fired ? `Fires at ${fired.t.toFixed(3)} s` : "Generate to see when it fires",
        ], "Click to edit. The robot code runs a command at this moment.")
      }
    }
    if (h && (h.kind === "keepout" || h.kind === "radius")) {
      const c = p.keepOut[h.index]
      return at("Keep-out (field)", [`r = ${c.radiusM.toFixed(2)} m at (${c.x.toFixed(2)}, ${c.y.toFixed(2)})`, "Every path keeps its bumper out of it."],
        h.kind === "radius" ? "Drag to change the radius." : "Drag to move; select it to resize from the edge.")
    }
    // Constraint shapes that are not selected.
    const [wx, wy] = toWorld(sx, sy)
    if (p.spec) {
      for (const c of p.spec.scoped) {
        if (!("x" in c)) continue
        const inside =
          c.type === "keepInRectangle" ? wx >= c.x && wx <= c.x + c.widthM && wy >= c.y && wy <= c.y + c.heightM
          : c.type === "pointAt" ? Math.hypot(wx - c.x, wy - c.y) * view.k <= 14
          : Math.abs(Math.hypot(wx - c.x, wy - c.y) - c.radiusM) * view.k <= 6
        if (inside) return at(constraintTitle(c.type), [constraintLine(c, n)], "Select it in the Constraints list to move it.")
      }
    }
    // The trajectory: what the robot does at that point.
    const traj = p.generated ?? p.guess
    if (traj) {
      let best: Sample | null = null, bd = 10
      for (const q of traj.samples) {
        const [qx, qy] = toScreen(q.x, q.y)
        const d = Math.hypot(qx - sx, qy - sy)
        if (d < bd) { bd = d; best = q }
      }
      if (best) {
        const lines = [
          `t = ${best.t.toFixed(3)} s · ${Math.hypot(best.vx, best.vy).toFixed(2)} m/s`,
          `accel ${Math.hypot(best.ax, best.ay).toFixed(2)} m/s² · turning ${(best.omega * 180 / Math.PI).toFixed(0)} °/s`,
          `heading ${(((best.heading * 180 / Math.PI) + 540) % 360 - 180).toFixed(0)}°`,
        ]
        if (best.modules.length) {
          const grip = Math.max(...best.modules.map(m => m.gripUsed))
          const amps = Math.max(...best.modules.map(m => Math.abs(m.currentA)))
          lines.push(`peak wheel grip ${(100 * grip).toFixed(0)}% · ${amps.toFixed(0)} A`)
        }
        const generated = traj === p.generated
        const idx = traj.samples.indexOf(best)
        const span = generated ? p.generated?.pathfind?.find(q => idx >= q.startSample && idx <= q.endSample) : undefined
        if (span) {
          const lim = [span.maxVelocityMps && `≤ ${span.maxVelocityMps} m/s`, span.maxAccelerationMps2 && `≤ ${span.maxAccelerationMps2} m/s²`, span.maxAngularVelocityDps && `≤ ${span.maxAngularVelocityDps} °/s`].filter(Boolean).join(" · ")
          return at(`Pathfind: waypoint ${span.fromWaypoint + 1} → ${span.toWaypoint + 1}`, [
            "The robot finds this route itself at run time, from wherever it actually is.",
            `Ares' estimate: about ${span.estimatedS.toFixed(2)} s around the keep-outs.`,
            lim ? `Limits: ${lim}` : "Limits: what the robot can do",
            ...lines,
          ], "The green band is where it can go: a bumper's reach on each side of the estimate.")
        }
        return at(generated ? (p.stale ? "Trajectory (out of date)" : "Trajectory") : "Guess (not optimized)", lines,
          generated ? undefined : "The spline through the waypoints, timed. Generate (Ctrl+G) to optimize it.")
      }
    }
    return null
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const [sx, sy] = local(e)
    const [wx, wy] = toWorld(sx, sy)
    applyDrag(d, sx, sy, wx, wy, true)
    setGuides(null)
    setBox(null)
    setZoneDraft(null)
  }

  /**
   * Where a dragged point lands: on the grid when snapping is on, and onto
   * another waypoint's or pose's x or y when within a few pixels (with a
   * guide line to show it). `exclude` is the waypoint being dragged.
   */
  const snapPoint = (x: number, y: number, exclude: number | null): { p: [number, number]; guides: { x?: number; y?: number } | null } => {
    const p = propsRef.current
    const g = p.view.snap
    let [sx, sy] = g > 0 ? [Math.round(x / g) * g, Math.round(y / g) * g] : [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]
    if (!p.view.guides) return { p: [sx, sy], guides: null }
    const tol = 7 / view.k
    const targets = [
      ...(p.spec?.waypoints ?? []).filter((_, i) => i !== exclude && !p.multi.includes(i)).map(w => [w.x, w.y]),
      ...p.poseMarks.map(m => [m.x, m.y]),
    ]
    let gx: number | undefined, gy: number | undefined
    let bx = tol, by = tol
    for (const [tx, ty] of targets) {
      if (Math.abs(x - tx) < bx) { bx = Math.abs(x - tx); gx = tx }
      if (Math.abs(y - ty) < by) { by = Math.abs(y - ty); gy = ty }
    }
    if (gx !== undefined) sx = gx
    if (gy !== undefined) sy = gy
    return { p: [sx, sy], guides: gx !== undefined || gy !== undefined ? { x: gx, y: gy } : null }
  }

  const shiftDown = useRef(false)
  const altDown = useRef(false)
  useEffect(() => {
    const on = (e: KeyboardEvent) => { shiftDown.current = e.shiftKey; altDown.current = e.altKey }
    window.addEventListener("keydown", on)
    window.addEventListener("keyup", on)
    return () => { window.removeEventListener("keydown", on); window.removeEventListener("keyup", on) }
  }, [])

  const applyDrag = (d: Drag, sx: number, sy: number, wx: number, wy: number, final: boolean) => {
    const p = propsRef.current
    const snap = (v: number) => Math.round(v * 1000) / 1000
    switch (d.kind) {
      case "pan":
        setView({ ...d.view, ox: d.view.ox + sx - d.sx, oy: d.view.oy + sy - d.sy })
        break
      case "waypoint": {
        const r = snapPoint(wx + d.dx, wy + d.dy, d.index)
        setGuides(final ? null : r.guides)
        p.onMoveWaypoint(d.index, r.p[0], r.p[1], final)
        break
      }
      case "group": {
        // The group moves by the pointer's delta, snapped like one point.
        const r = snapPoint(wx, wy, null)
        const [dx, dy] = p.view.snap > 0 ? [r.p[0] - snapPoint(d.ax, d.ay, null).p[0], r.p[1] - snapPoint(d.ax, d.ay, null).p[1]] : [wx - d.ax, wy - d.ay]
        p.onMoveGroup(d.indices, Math.round(dx * 1000) / 1000, Math.round(dy * 1000) / 1000, final)
        if (!final) drag.current = { ...d, ax: d.ax + dx, ay: d.ay + dy }
        break
      }
      case "box": {
        setBox({ a: [d.ax, d.ay], b: [wx, wy] })
        if (final && p.spec) {
          const [x0, x1] = [Math.min(d.ax, wx), Math.max(d.ax, wx)]
          const [y0, y1] = [Math.min(d.ay, wy), Math.max(d.ay, wy)]
          const inside = p.spec.waypoints.map((w, i) => (w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1 ? i : -1)).filter(i => i >= 0)
          p.onMulti(inside)
        }
        break
      }
      case "ruler":
        setRuler({ a: [d.ax, d.ay], b: snapPoint(wx, wy, null).p })
        break
      case "zoneNew": {
        const b: [number, number] = [snap(wx), snap(wy)]
        setZoneDraft({ a: [d.ax, d.ay], b })
        if (final) {
          const w = Math.abs(b[0] - d.ax), h = Math.abs(b[1] - d.ay)
          // A click (no drag) makes a 1 m circle; a drag, the rectangle drawn.
          p.onAddZone(w < 0.15 && h < 0.15
            ? { shape: "circle", x: snap(d.ax), y: snap(d.ay), radiusM: 1, maxVelocityMps: 1.5 }
            : { shape: "rectangle", x: snap(Math.min(d.ax, b[0])), y: snap(Math.min(d.ay, b[1])), widthM: snap(w), heightM: snap(h), maxVelocityMps: 1.5 })
        }
        break
      }
      case "zone": {
        const z = p.zones[d.index]
        if (d.handle === "move") {
          const r = snapPoint(wx + d.dx, wy + d.dy, null)
          p.onEditZone(d.index, { x: r.p[0], y: r.p[1] }, final)
        } else if (d.handle === "radius" && z.shape === "circle") {
          p.onEditZone(d.index, { radiusM: Math.max(0.1, snap(Math.hypot(wx - z.x, wy - z.y))) } as Partial<SlowZone>, final)
        } else if (z.shape === "rectangle") {
          p.onEditZone(d.index, { widthM: Math.max(0.1, snap(wx - z.x)), heightM: Math.max(0.1, snap(wy - z.y)) } as Partial<SlowZone>, final)
        }
        break
      }
      case "rotation": {
        const r = p.spec?.rotationTargets?.[d.index]
        const at = r && rotationPoint(p.spec!, p.generated ?? p.guess, r)
        if (!at) break
        let deg = Math.atan2(wy - at.y, wx - at.x) * 180 / Math.PI
        if (shiftDown.current) deg = Math.round(deg / 15) * 15
        p.onEditRotation(d.index, { headingDeg: Math.round(deg * 10) / 10 }, final)
        break
      }
      case "heading": {
        const w = p.spec!.waypoints[d.index]
        let deg = Math.atan2(wy - w.y, wx - w.x) * 180 / Math.PI
        // Shift snaps to 15°, the angles a driver thinks in.
        if (shiftDown.current) deg = Math.round(deg / 15) * 15
        p.onRotateWaypoint(d.index, Math.round(deg * 10) / 10, final)
        break
      }
      case "keepout":
        p.onMoveKeepOut(d.index, snap(wx + d.dx), snap(wy + d.dy), final)
        break
      case "radius": {
        const c = p.keepOut[d.index]
        p.onResizeKeepOut(d.index, Math.max(0.05, snap(Math.hypot(wx - c.x, wy - c.y))), final)
        break
      }
      case "shape": {
        const c = p.spec!.scoped[d.index]
        if (!("x" in c)) break
        if (d.handle === "move") p.onEditConstraint(d.index, { x: snap(wx + d.dx), y: snap(wy + d.dy) } as Partial<ScopedConstraint>, final)
        else if (d.handle === "radius") p.onEditConstraint(d.index, { radiusM: Math.max(0.05, snap(Math.hypot(wx - c.x, wy - c.y))) } as Partial<ScopedConstraint>, final)
        else p.onEditConstraint(d.index, { widthM: Math.max(0.1, snap(wx - c.x)), heightM: Math.max(0.1, snap(wy - c.y)) } as Partial<ScopedConstraint>, final)
        break
      }
      case "event":
        break
      case "control": {
        const r = snapPoint(wx, wy, null)
        p.onMoveControl(d.index, d.side, r.p[0], r.p[1], final, altDown.current)
        break
      }
    }
  }

  // Zoom about the cursor. Attached by hand: React's wheel listener is
  // passive and cannot stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (propsRef.current.locked) return
      const [sx, sy] = local(e)
      setView(v => {
        const k = Math.min(600, Math.max(10, v.k * Math.exp(-e.deltaY * 0.0015)))
        const [wx, wy] = [(sx - v.ox) / v.k, (v.oy - sy) / v.k]
        return { k, ox: sx - wx * k, oy: sy + wy * k }
      })
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [])

  // Esc drops the ruler.
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") setRuler(null) }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [])
  useEffect(() => { if (tool.kind !== "ruler") setRuler(null) }, [tool.kind])

  const cursorStyle = tool.kind === "select" ? "default" : tool.kind === "constraint" || tool.kind === "event" ? (hoverWp !== null ? "pointer" : "default") : "crosshair"

  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block", cursor: cursorStyle, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setCursor(null); setHoverWp(null); setTip(null) }}
        onContextMenu={e => e.preventDefault()}
      />
      {tip && (
        <div style={{
          position: "absolute", left: Math.min(tip.sx + 16, size.w - 290), top: Math.min(tip.sy + 16, size.h - 120), width: 270, pointerEvents: "none", zIndex: 8,
          background: "rgba(28,28,31,0.94)", color: "#ececed", padding: "6px 9px", fontSize: 11, lineHeight: 1.5, boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        }}>
          <div style={{ fontWeight: 600, color: "#ffffff", marginBottom: 2 }}>{tip.title}</div>
          {tip.lines.map((l, i) => <div key={i} style={{ fontFamily: /\d/.test(l) ? "Consolas, 'Cascadia Mono', monospace" : undefined, fontSize: 10.5 }}>{l}</div>)}
          {tip.hint && <div style={{ marginTop: 3, color: "#a0a1a8", fontSize: 10.5 }}>{tip.hint}</div>}
        </div>
      )}
      {cursor && (
        <div style={{ position: "absolute", right: 12, bottom: 66, fontSize: 10.5, fontFamily: "Consolas, 'Cascadia Mono', monospace", color: "var(--text-secondary)", background: "rgba(255,255,255,0.85)", padding: "1px 6px", border: "1px solid var(--border-light)" }}>
          x {cursor.x.toFixed(2)} m · y {cursor.y.toFixed(2)} m
        </div>
      )}
    </div>
  )
}

type ToScreen = (x: number, y: number) => [number, number]

function line(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number]) {
  ctx.beginPath()
  ctx.moveTo(...a)
  ctx.lineTo(...b)
  ctx.stroke()
}

function polyline(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string, width: number) {
  if (pts.length < 2) return
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.stroke()
  ctx.lineCap = "butt"
}

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = stroke
  ctx.stroke()
}

function circle(ctx: CanvasRenderingContext2D, toScreen: ToScreen, x: number, y: number, r: number, k: number, fill: string | null, stroke: string, width: number) {
  const [cx, cy] = toScreen(x, y)
  ctx.beginPath()
  ctx.arc(cx, cy, r * k, 0, Math.PI * 2)
  if (fill) { ctx.fillStyle = fill; ctx.fill() }
  ctx.strokeStyle = stroke
  ctx.lineWidth = width
  ctx.stroke()
}

function drawShape(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, c: ScopedConstraint, sel: boolean, disabled: boolean) {
  const alpha = disabled ? 0.25 : sel ? 1 : 0.45
  ctx.globalAlpha = alpha
  switch (c.type) {
    case "keepInCircle":
      ctx.setLineDash([6, 4])
      circle(ctx, toScreen, c.x, c.y, c.radiusM, k, "rgba(31,122,31,0.06)", COLORS.keepin, sel ? 2 : 1.3)
      ctx.setLineDash([])
      if (sel) { handle(ctx, ...toScreen(c.x, c.y), 5, "#ffffff", COLORS.keepin); handle(ctx, ...toScreen(c.x + c.radiusM, c.y), 4.5, "#ffffff", COLORS.keepin) }
      break
    case "keepOutCircle":
      circle(ctx, toScreen, c.x, c.y, c.radiusM, k, COLORS.keepout, COLORS.constraint, sel ? 2 : 1.3)
      if (sel) { handle(ctx, ...toScreen(c.x, c.y), 5, "#ffffff", COLORS.constraint); handle(ctx, ...toScreen(c.x + c.radiusM, c.y), 4.5, "#ffffff", COLORS.constraint) }
      break
    case "keepInRectangle": {
      const [x0, y0] = toScreen(c.x, c.y + c.heightM)
      ctx.setLineDash([6, 4])
      ctx.fillStyle = "rgba(31,122,31,0.06)"
      ctx.fillRect(x0, y0, c.widthM * k, c.heightM * k)
      ctx.strokeStyle = COLORS.keepin
      ctx.lineWidth = sel ? 2 : 1.3
      ctx.strokeRect(x0, y0, c.widthM * k, c.heightM * k)
      ctx.setLineDash([])
      if (sel) { handle(ctx, ...toScreen(c.x, c.y), 5, "#ffffff", COLORS.keepin); handle(ctx, ...toScreen(c.x + c.widthM, c.y + c.heightM), 4.5, "#ffffff", COLORS.keepin) }
      break
    }
    case "pointAt": {
      const [x, y] = toScreen(c.x, c.y)
      ctx.strokeStyle = COLORS.constraint
      ctx.lineWidth = sel ? 2 : 1.3
      ctx.beginPath()
      ctx.arc(x, y, 9, 0, Math.PI * 2)
      ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y)
      ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14)
      ctx.stroke()
      if (sel) handle(ctx, x, y, 4, "#ffffff", COLORS.constraint)
      break
    }
    default:
      break
  }
  ctx.globalAlpha = 1
}

export const PATHFIND = "#16a34a"
export const BRANCH = "#db2777"

function drawTrajectory(ctx: CanvasRenderingContext2D, toScreen: ToScreen, t: Trajectory, gradient: ViewOptions["gradient"], topSpeed: number, width: number, skip: [number, number][] = []) {
  const s = t.samples
  if (s.length < 2) return
  const accMax = Math.max(1e-6, ...s.map(q => Math.hypot(q.ax, q.ay)))
  const wMax = Math.max(1e-6, ...s.map(q => Math.abs(q.omega)))
  const dts = s.slice(1).map((q, i) => q.t - s[i].t)
  const [dtMin, dtMax] = [Math.min(...dts), Math.max(...dts)]
  const splits = t.splits ?? []
  const colorAt = (i: number): string => {
    const q = s[i]
    switch (gradient) {
      case "none": return "#2f6fdb"
      case "velocity": return rampColor(Math.hypot(q.vx, q.vy) / topSpeed)
      case "progress": return rampColor(q.t / Math.max(t.durationS, 1e-6))
      case "acceleration": return rampColor(Math.hypot(q.ax, q.ay) / accMax)
      case "interval": return rampColor(dtMax - dtMin < 1e-9 ? 0.5 : 1 - (dts[Math.min(i, dts.length - 1)] - dtMin) / (dtMax - dtMin))
      case "angular": return rampColor(Math.abs(q.omega) / wMax)
      case "splits": return SPLIT_COLORS[splits.filter(k => k <= i).length % SPLIT_COLORS.length]
    }
  }
  ctx.lineWidth = width
  ctx.lineCap = "round"
  for (let i = 1; i < s.length; i++) {
    if (skip.some(([a, b]) => i > a && i <= b)) continue
    const [x0, y0] = toScreen(s[i - 1].x, s[i - 1].y)
    const [x1, y1] = toScreen(s[i].x, s[i].y)
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.strokeStyle = colorAt(i)
    ctx.stroke()
  }
  ctx.lineCap = "butt"
}

function bumper(
  ctx: CanvasRenderingContext2D, toScreen: ToScreen, x: number, y: number, heading: number,
  robot: RobotConfig, color: string, dash: number[], width: number, fillAlpha: number,
) {
  const hl = robot.bumper.lengthM / 2, hw = robot.bumper.widthM / 2
  const c = Math.cos(heading), s = Math.sin(heading)
  const corners = [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([bx, by]) => toScreen(x + c * bx - s * by, y + s * bx + c * by))
  ctx.beginPath()
  corners.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)))
  ctx.closePath()
  ctx.globalAlpha = fillAlpha
  ctx.fillStyle = color
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.setLineDash(dash)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
  ctx.setLineDash([])
  // The front face, thicker: which way the robot faces at a glance.
  ctx.beginPath()
  ctx.moveTo(...corners[0])
  ctx.lineTo(...corners[1])
  ctx.lineWidth = width + 2
  ctx.stroke()
}

/**
 * The robot at a pose: its STL from above when there is one, otherwise a
 * drawing (bumper, wheels, an arrow to the front) in colors that stand out
 * on a dark field. `outline` adds a bumper outline in that color.
 */
function drawRobot(
  ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, x: number, y: number, heading: number,
  robot: RobotConfig, top: TopView | null, outline: string | null, alpha: number, tint: string = outline ?? "#22d3ee",
) {
  const [sx, sy] = toScreen(x, y)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(sx, sy)
  ctx.rotate(-heading)
  const hl = robot.bumper.lengthM / 2 * k, hw = robot.bumper.widthM / 2 * k
  if (top) {
    // A light halo around the model's silhouette, so it reads on any field.
    const e = top.halfExtentM * k
    ctx.shadowColor = "rgba(255,255,255,0.85)"
    ctx.shadowBlur = 6
    ctx.drawImage(top.image, -e, -e, 2 * e, 2 * e)
    ctx.shadowBlur = 0
  } else {
    // Bumper, frame, wheels, front arrow. Canvas Y is down: robot +Y is -y.
    ctx.globalAlpha = alpha * 0.45
    ctx.fillStyle = tint
    ctx.fillRect(-hl, -hw, 2 * hl, 2 * hw)
    ctx.globalAlpha = alpha
    ctx.fillStyle = "rgba(240,240,242,0.9)"
    const inset = Math.min(hl, hw) * 0.18
    ctx.fillRect(-hl + inset, -hw + inset, 2 * (hl - inset), 2 * (hw - inset))
    const r = robot.drivetrain.wheelRadiusM * k
    ctx.fillStyle = "#2b2c31"
    for (const m of robot.drivetrain.modules) {
      ctx.fillRect(m.xM * k - r, -m.yM * k - r * 0.45, 2 * r, 0.9 * r)
    }
    ctx.beginPath()
    ctx.moveTo(hl * 0.75, 0)
    ctx.lineTo(hl * 0.15, -hw * 0.35)
    ctx.lineTo(hl * 0.15, hw * 0.35)
    ctx.closePath()
    ctx.fillStyle = tint
    ctx.fill()
  }
  if (outline) {
    ctx.globalAlpha = 1
    ctx.strokeStyle = "#ffffff"
    ctx.lineWidth = 4
    ctx.strokeRect(-hl, -hw, 2 * hl, 2 * hw)
    ctx.strokeStyle = outline
    ctx.lineWidth = 2
    ctx.strokeRect(-hl, -hw, 2 * hl, 2 * hw)
    // The front face, thicker.
    ctx.beginPath()
    ctx.moveTo(hl, -hw)
    ctx.lineTo(hl, hw)
    ctx.lineWidth = 4
    ctx.stroke()
  }
  ctx.restore()
}

function pin(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string) {
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - 6, y - 12)
  ctx.arc(x, y - 15, 6.5, Math.PI * 0.8, Math.PI * 0.2)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = "#ffffff"
  ctx.lineWidth = 1.2
  ctx.stroke()
  ctx.font = "600 10px 'Segoe UI', Arial, sans-serif"
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  const w = ctx.measureText(label).width
  ctx.fillStyle = "rgba(255,255,255,0.92)"
  ctx.fillRect(x + 9, y - 22, w + 8, 14)
  ctx.fillStyle = COLORS.ink
  ctx.fillText(label, x + 13, y - 15)
}

function moduleVectors(ctx: CanvasRenderingContext2D, toScreen: ToScreen, s: Sample, robot: RobotConfig) {
  const c = Math.cos(s.heading), sn = Math.sin(s.heading)
  const scale = 0.12 // meters of arrow per m/s
  robot.drivetrain.modules.forEach(m => {
    const rx = c * m.xM - sn * m.yM, ry = sn * m.xM + c * m.yM
    const vx = s.vx - s.omega * ry, vy = s.vy + s.omega * rx
    const [x0, y0] = toScreen(s.x + rx, s.y + ry)
    const [x1, y1] = toScreen(s.x + rx + vx * scale, s.y + ry + vy * scale)
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.strokeStyle = "#2f6fdb"
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x0, y0, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = "#1c1c1f"
    ctx.fill()
  })
}

/** Where an event fires: on the generated trajectory when there is one,
 *  otherwise at its waypoint. */
export function eventPoint(spec: PathSpec, generated: Trajectory | null, e: NonNullable<PathSpec["events"]>[number], i: number): { x: number; y: number } | null {
  const fired = generated?.events?.[i]
  if (generated && fired && fired.name === e.name) {
    const s = sampleAt(generated, fired.t)
    return { x: s.x, y: s.y }
  }
  const n = spec.waypoints.length
  const idx = e.target === "first" ? 0 : e.target === "last" ? n - 1 : Math.min(e.target.index, n - 1)
  const w = spec.waypoints[idx]
  return w ? { x: w.x, y: w.y } : null
}

/** The trajectory's heading where it passes closest to (x, y). */
function headingNear(traj: Trajectory | null, x: number, y: number): number {
  if (!traj) return 0
  let best = traj.samples[0], d = Infinity
  for (const s of traj.samples) {
    const e = (s.x - x) ** 2 + (s.y - y) ** 2
    if (e < d) { d = e; best = s }
  }
  return best.heading
}

// --- Words for the tooltips -------------------------------------------------------

const KIND_WORDS: Record<string, string> = {
  pose: "Pose: the robot passes here facing the set heading.",
  translation: "Translation: the robot passes here; the optimizer picks the heading.",
  empty: "Empty: not a place the robot must reach; it only shapes the starting guess (around an obstacle, say).",
  unknown: "Unknown start: the robot can be anywhere when the path begins; it pathfinds to the next waypoint. This position is only the likely start, for the estimate.",
  continue: "Continue: the path begins where the previous one ended, at its speed. Linked to a path, it takes that path's end pose.",
}

function resolveIdx(t: PathSpec["scoped"][number]["from"], n: number): number {
  return t === "first" ? 0 : t === "last" ? n - 1 : Math.min(t.index, n - 1)
}

function waypointWords(spec: PathSpec, i: number, generated: Trajectory | null): [string, string[], string] {
  const w = spec.waypoints[i]
  const n = spec.waypoints.length
  const kind = kindOf(w)
  const lines = [KIND_WORDS[kind], `(${w.x.toFixed(2)}, ${w.y.toFixed(2)}) m${kind === "pose" ? ` · ${(w.headingDeg ?? 0).toFixed(1)}°` : ""}`]
  const stop = stopAt(spec, i) >= 0
  const wait = waitAt(spec, i)
  lines.push(stop ? (wait > 0 ? `Stops and waits ${wait} s.` : "Stops here.") : "Passes through without stopping.")
  for (const c of spec.scoped) {
    if (c.type === "stopPoint" || c.enabled === false) continue
    const [a, b] = rangeOf(c, n)
    if (a <= i && i <= b) lines.push(`${constraintTitle(c.type)}: ${constraintChip(c)}${a === b ? "" : ` (waypoints ${a + 1}–${b + 1})`}`)
  }
  if (w.split) lines.push("The trajectory splits here.")
  if (w.intervals !== undefined) lines.push(`${w.intervals} samples to the next waypoint.`)
  const t = generated?.waypointTimes?.[i]
  if (t !== undefined) lines.push(`Reached at ${t.toFixed(3)} s.`)
  const role = i === 0 ? "start" : i === n - 1 ? "end" : `${i + 1} of ${n}`
  return [`Waypoint ${i + 1} (${role})`, lines, kind === "pose" ? "Drag to move, drag the white dot to turn, click to edit." : "Drag to move, click to edit."]
}

function constraintTitle(type: ScopedConstraint["type"]): string {
  return ({
    stopPoint: "Stop point", maxVelocity: "Max velocity", maxAcceleration: "Max acceleration", maxAngularVelocity: "Max angular velocity",
    pointAt: "Point at", keepInCircle: "Keep in circle", keepInRectangle: "Keep in rectangle", keepInLane: "Keep in lane", keepOutCircle: "Keep out circle", seeTags: "See AprilTags",
  } as const)[type]
}

function constraintLine(c: ScopedConstraint, n: number): string {
  const [a, b] = rangeOf(c, n)
  const scope = a === b ? `at waypoint ${a + 1}` : `from waypoint ${a + 1} to ${b + 1}`
  switch (c.type) {
    case "pointAt": return `The ${sideName(facingDeg(c)).toLowerCase()}${[0, 90, 180, -90].includes(facingDeg(c)) ? "" : " side"} faces (${c.x.toFixed(2)}, ${c.y.toFixed(2)}) within ${c.toleranceDeg}°, ${scope}.`
    case "keepInCircle": return `The bumper stays inside r = ${c.radiusM} m, ${scope}.`
    case "keepInRectangle": return `The bumper stays inside ${c.widthM} × ${c.heightM} m, ${scope}.`
    case "keepOutCircle": return `The bumper stays out of r = ${c.radiusM} m, ${scope}.`
    case "seeTags": return `${c.camera ? `Camera ${c.camera}` : "The cameras"} keep${c.camera ? "s" : ""} ${c.minTags && c.minTags > 1 ? `${c.minTags} AprilTags` : "an AprilTag"} in view, ${scope}.`
    default: return `${constraintChip(c)}, ${scope}.`
  }
}

// --- The plan view -------------------------------------------------------------

export const BLUEPRINT = {
  background: "#ffffff",
  grid: "rgba(0,0,0,0.07)",
  edge: "#111114",
  label: "#55565c",
  blue: "#1642a0",
  red: "#a81818",
}

/**
 * Over the field's sketch: the playing area outlined in black, an optional
 * meter grid, meter ticks along two sides, the axes from the origin and the
 * field's dimensions.
 */
function drawPlanOverlay(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, L: number, W: number, grid: boolean) {
  const [x0, y0] = toScreen(0, W)
  const [x1, y1] = toScreen(L, 0)
  if (grid) {
    ctx.strokeStyle = BLUEPRINT.grid
    ctx.lineWidth = 1
    for (let x = 0; x <= L + 1e-9; x += 1) line(ctx, toScreen(x, 0), toScreen(x, W))
    for (let y = 0; y <= W + 1e-9; y += 1) line(ctx, toScreen(0, y), toScreen(L, y))
  }
  ctx.strokeStyle = BLUEPRINT.edge
  ctx.lineWidth = 3
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)

  ctx.fillStyle = BLUEPRINT.label
  ctx.font = "9.5px Consolas, 'Cascadia Mono', monospace"
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  for (let x = 0; x <= L + 1e-9; x += 1) {
    const [sx, sy] = toScreen(x, 0)
    ctx.fillRect(sx - 0.5, sy, 1, 5)
    ctx.fillText(String(x), sx, sy + 7)
  }
  ctx.textAlign = "right"
  ctx.textBaseline = "middle"
  for (let y = 0; y <= W + 1e-9; y += 1) {
    const [sx, sy] = toScreen(0, y)
    ctx.fillRect(sx - 5, sy - 0.5, 5, 1)
    ctx.fillText(String(y), sx - 8, sy)
  }

  // Axes from the origin (WPILib: X along the field, Y to the left of the
  // blue driver station).
  const [ox, oy] = toScreen(0, 0)
  const axis = Math.min(1.2 * k, 70)
  arrow(ctx, ox, oy, ox + axis, oy, BLUEPRINT.red, "X")
  arrow(ctx, ox, oy, ox, oy - axis, BLUEPRINT.blue, "Y")

  dimensionLine(ctx, x0, y0 - 22, x1, y0 - 22, `${L.toFixed(3)} m`)
  dimensionLine(ctx, x1 + 26, y0, x1 + 26, y1, `${W.toFixed(3)} m`)
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, label: string) {
  const a = Math.atan2(y1 - y0, x1 - x0)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 2
  line(ctx, [x0, y0], [x1, y1])
  ctx.beginPath()
  ctx.moveTo(x1 + Math.cos(a) * 8, y1 + Math.sin(a) * 8)
  ctx.lineTo(x1 + Math.cos(a + 2.6) * 7, y1 + Math.sin(a + 2.6) * 7)
  ctx.lineTo(x1 + Math.cos(a - 2.6) * 7, y1 + Math.sin(a - 2.6) * 7)
  ctx.closePath()
  ctx.fill()
  ctx.font = "700 10px 'Segoe UI', Arial, sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(label, x1 + Math.cos(a) * 18, y1 + Math.sin(a) * 18)
}

function dimensionLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, text: string) {
  ctx.strokeStyle = BLUEPRINT.label
  ctx.fillStyle = BLUEPRINT.label
  ctx.lineWidth = 1
  line(ctx, [x0, y0], [x1, y1])
  const a = Math.atan2(y1 - y0, x1 - x0)
  for (const [px, py, dir] of [[x0, y0, a + Math.PI], [x1, y1, a]] as [number, number, number][]) {
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.lineTo(px - Math.cos(dir) * 7 + Math.cos(dir + Math.PI / 2) * 3, py - Math.sin(dir) * 7 + Math.sin(dir + Math.PI / 2) * 3)
    ctx.lineTo(px - Math.cos(dir) * 7 - Math.cos(dir + Math.PI / 2) * 3, py - Math.sin(dir) * 7 - Math.sin(dir + Math.PI / 2) * 3)
    ctx.closePath()
    ctx.fill()
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
  ctx.save()
  ctx.translate(mx, my)
  if (Math.abs(a) > Math.PI / 4) ctx.rotate(-Math.PI / 2)
  ctx.font = "10px Consolas, 'Cascadia Mono', monospace"
  const w = ctx.measureText(text).width + 8
  ctx.fillStyle = BLUEPRINT.background
  ctx.fillRect(-w / 2, -7, w, 14)
  ctx.fillStyle = BLUEPRINT.label
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

// --- Zones and rotation targets ------------------------------------------------

export const ZONE = "#ca8a04"

function drawZone(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, z: SlowZone, sel: boolean) {
  ctx.save()
  ctx.beginPath()
  if (z.shape === "rectangle") {
    const [x0, y0] = toScreen(z.x, z.y + z.heightM)
    ctx.rect(x0, y0, z.widthM * k, z.heightM * k)
  } else {
    const [cx, cy] = toScreen(z.x, z.y)
    ctx.arc(cx, cy, z.radiusM * k, 0, Math.PI * 2)
  }
  ctx.fillStyle = "rgba(234,179,8,0.12)"
  ctx.fill()
  // Diagonal hatching, the drawing convention for "caution here".
  ctx.clip()
  ctx.strokeStyle = "rgba(202,138,4,0.35)"
  ctx.lineWidth = 1
  const [ax, ay] = z.shape === "rectangle" ? toScreen(z.x, z.y + z.heightM) : toScreen(z.x - z.radiusM, z.y + z.radiusM)
  const span = (z.shape === "rectangle" ? z.widthM + z.heightM : 4 * z.radiusM) * k
  for (let d = 0; d < span; d += 10) line(ctx, [ax + d, ay], [ax, ay + d])
  ctx.restore()
  ctx.beginPath()
  if (z.shape === "rectangle") {
    const [x0, y0] = toScreen(z.x, z.y + z.heightM)
    ctx.rect(x0, y0, z.widthM * k, z.heightM * k)
  } else {
    const [cx, cy] = toScreen(z.x, z.y)
    ctx.arc(cx, cy, z.radiusM * k, 0, Math.PI * 2)
  }
  ctx.setLineDash(sel ? [] : [6, 4])
  ctx.strokeStyle = ZONE
  ctx.lineWidth = sel ? 2.2 : 1.4
  ctx.stroke()
  ctx.setLineDash([])
  const [lx, ly] = z.shape === "rectangle" ? toScreen(z.x + z.widthM / 2, z.y + z.heightM / 2) : toScreen(z.x, z.y)
  const caps = [z.maxVelocityMps !== undefined && `≤ ${z.maxVelocityMps} m/s`, z.maxAccelerationMps2 !== undefined && `≤ ${z.maxAccelerationMps2} m/s²`].filter(Boolean).join(" · ")
  drawChip(ctx, lx, ly, `${z.name ? z.name + ": " : ""}${caps || "slow zone"}`, ZONE, sel)
  if (sel) {
    const [hx, hy] = z.shape === "rectangle" ? toScreen(z.x + z.widthM, z.y + z.heightM) : toScreen(z.x + z.radiusM, z.y)
    handle(ctx, hx, hy, 4.5, "#ffffff", ZONE)
  }
}

/** Where a rotation target sits: its fraction of the segment's time on the trajectory. */
export function rotationPoint(spec: PathSpec, traj: Trajectory | null, r: RotationTarget): { x: number; y: number } | null {
  const wt = traj?.waypointTimes
  if (traj && wt && wt.length === spec.waypoints.length && r.segment + 1 < wt.length) {
    const s = sampleAt(traj, wt[r.segment] + r.fraction * (wt[r.segment + 1] - wt[r.segment]))
    return { x: s.x, y: s.y }
  }
  const a = spec.waypoints[r.segment], b = spec.waypoints[r.segment + 1]
  return a && b ? { x: a.x + (b.x - a.x) * r.fraction, y: a.y + (b.y - a.y) * r.fraction } : null
}

/** A rotation target from a click near the path: the segment and fraction there, at the current heading. */
export function rotationAt(spec: PathSpec | null, traj: Trajectory | null, sx: number, sy: number, toScreen: ToScreen): { segment: number; fraction: number; headingDeg: number } | null {
  const wt = traj?.waypointTimes
  if (!spec || !traj || !wt || wt.length !== spec.waypoints.length) return null
  let best: Sample | null = null, bd = 14
  for (const q of traj.samples) {
    const [qx, qy] = toScreen(q.x, q.y)
    const d = Math.hypot(qx - sx, qy - sy)
    if (d < bd) { bd = d; best = q }
  }
  if (!best) return null
  const segment = Math.max(0, Math.min(wt.length - 2, wt.findIndex((t, i) => i + 1 < wt.length && best!.t >= t && best!.t <= wt[i + 1])))
  const span = wt[segment + 1] - wt[segment]
  const fraction = span > 0 ? Math.min(1, Math.max(0, (best.t - wt[segment]) / span)) : 0.5
  return { segment, fraction: Math.round(fraction * 1000) / 1000, headingDeg: Math.round((((best.heading * 180 / Math.PI) + 540) % 360 - 180) * 10) / 10 }
}

/** A segment found at run time: marked so, or leaving an unknown start. */
function isPathfind(w: PathSpec["waypoints"][number], j: number): boolean {
  return !!w.pathfindNext || (j === 0 && kindOf(w) === "unknown")
}

/**
 * The field under everything: the background, the photo or its sketch
 * (mirrored so blue is at x = 0 when asked), and the plan view's outline,
 * ticks, axes and dimensions. Shared by the path editor and the autos view.
 */
export function drawFieldBackground(
  ctx: CanvasRenderingContext2D, size: { w: number; h: number }, toScreen: ToScreen, k: number,
  field: FieldConfig, image: HTMLImageElement | null, sketch: HTMLCanvasElement | null, opts: ViewOptions,
) {
  const plan = opts.fieldStyle === "blueprint"
  const [L, W] = field.sizeMeters
  const view = { k }
    ctx.fillStyle = plan ? BLUEPRINT.background : "#e4e4e7"
    ctx.fillRect(0, 0, size.w, size.h)

    // The photo (or its sketch), placed by its calibration: field (0, 0) is
    // the playing area's bottom-left corner in pixels.
    if (image && opts.field) {
      const kImg = (field.bottomRight[0] - field.topLeft[0]) / L
      const [ix, iy] = toScreen(-field.topLeft[0] / kImg, field.bottomRight[1] / kImg)
      const [iw, ih] = [image.width * view.k / kImg, image.height * view.k / kImg]
      // Blue at x = 0: the picture is mirrored (or turned) about the field's
      // center when the image has red there.
      const [fcx, fcy] = toScreen(L / 2, W / 2)
      ctx.save()
      const flip = pictureFlip(field, opts.fieldFlip)
      if (flip === "mirror") { ctx.translate(2 * fcx, 0); ctx.scale(-1, 1) }
      else if (flip === "rotate") { ctx.translate(2 * fcx, 2 * fcy); ctx.scale(-1, -1) }
      if (plan) {
        if (sketch) ctx.drawImage(sketch, ix, iy, iw, ih)
      } else {
        ctx.globalAlpha = 0.9
        ctx.drawImage(image, ix, iy, iw, ih)
        ctx.globalAlpha = 1
      }
      ctx.restore()
    }
    if (plan) drawPlanOverlay(ctx, toScreen, view.k, L, W, opts.grid)
    if (opts.grid && !plan) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)"
      ctx.lineWidth = 1
      for (let x = 0; x <= L; x += 1) line(ctx, toScreen(x, 0), toScreen(x, W))
      for (let y = 0; y <= W; y += 1) line(ctx, toScreen(0, y), toScreen(L, y))
    }
    if (!plan) {
      const [x0, y0] = toScreen(0, W)
      ctx.strokeStyle = "rgba(28,28,31,0.6)"
      ctx.lineWidth = 1
      ctx.strokeRect(x0, y0, L * view.k, W * view.k)
    }

}

// --- Cameras and AprilTags -----------------------------------------------------

const TAG_SIZE_M = 0.165

/** The field's tags, as the small squares they are, with a tick toward where each one faces. */
export function drawTags(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, tags: Tag[], lit: Map<number, string>) {
  for (const t of tags) {
    const face = Math.atan2(t.ny, t.nx)
    const [cx, cy] = toScreen(t.x, t.y)
    const half = Math.max(3, (TAG_SIZE_M / 2) * k)
    const color = lit.get(t.id)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(-face)
    ctx.fillStyle = color ?? "#ffffff"
    ctx.strokeStyle = color ? color : "#111114"
    ctx.lineWidth = color ? 2 : 1.2
    ctx.fillRect(-half * 0.35, -half, half * 0.7, 2 * half)
    ctx.strokeRect(-half * 0.35, -half, half * 0.7, 2 * half)
    ctx.beginPath()
    ctx.moveTo(half * 0.35, 0)
    ctx.lineTo(half * 0.35 + Math.max(5, 0.18 * k), 0)
    ctx.stroke()
    ctx.restore()
    ctx.font = "700 9px 'Segoe UI', Arial, sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    const lx = cx + Math.cos(face) * (half + 9), ly = cy - Math.sin(face) * (half + 9)
    ctx.lineWidth = 3
    ctx.strokeStyle = "rgba(255,255,255,0.9)"
    ctx.strokeText(String(t.id), lx, ly)
    ctx.fillStyle = color ?? "#111114"
    ctx.fillText(String(t.id), lx, ly)
  }
}

/** The cameras' green in 2D: plain, no glow (the 3D view keeps the Limelight's). */
const FOV_GREEN = "#16a34a"

/** Each camera's field of view on the carpet, and a line to every tag it detects. */
function drawCameras(ctx: CanvasRenderingContext2D, toScreen: ToScreen, _k: number, robot: RobotConfig, x: number, y: number, heading: number, seen: Detection[], occluders: Occluder[]) {
  ;(robot.cameras ?? []).forEach((c, i) => {
    const color = FOV_GREEN
    const f = fovOnFloor(c, x, y, heading)
    const [ax, ay] = toScreen(f.at[0], f.at[1])
    // The field of view as it really reaches: cut short by every structure in the way.
    const poly = fovPolygon(c, x, y, heading, occluders)
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    for (const [px, py] of poly.points) ctx.lineTo(...toScreen(px, py))
    ctx.closePath()
    ctx.fillStyle = "rgba(22,163,74,0.14)"
    ctx.fill()
    ctx.strokeStyle = FOV_GREEN
    ctx.lineWidth = 1.6
    ctx.stroke()
    for (const d of seen.filter(q => q.camera === i && Math.hypot(q.from[0] - f.at[0], q.from[1] - f.at[1]) < 1e-6)) {
      const [tx, ty] = toScreen(d.tag.x, d.tag.y)
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(tx, ty)
      // Behind a structure: in view and range, not detected. Grey and dashed, so it reads as "no".
      ctx.save()
      ctx.strokeStyle = d.hidden ? "rgba(90,90,100,0.55)" : color
      ctx.lineWidth = d.hidden ? 1.2 : 2.4
      ctx.setLineDash(d.hidden ? [3, 4] : [])
      ctx.stroke()
      ctx.restore()
    }
    ctx.beginPath()
    ctx.arc(ax, ay, 4.5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = "#ffffff"
    ctx.lineWidth = 1.5
    ctx.stroke()
    const mine = seen.filter(q => q.camera === i && Math.hypot(q.from[0] - f.at[0], q.from[1] - f.at[1]) < 1e-6)
    const seenHere = mine.filter(q => !q.hidden).length, hiddenHere = mine.length - seenHere
    drawChip(ctx, ax, ay - 14, `${c.name}: ${seenHere ? `${seenHere} tag${seenHere > 1 ? "s" : ""}` : "no tags"}${hiddenHere ? ` · ${hiddenHere} hidden` : ""}`, "#15803d", true)
  })
}

/** A halo under the trajectory: green where the cameras see a tag, red where they see none. */
function drawCoverage(ctx: CanvasRenderingContext2D, toScreen: ToScreen, t: Trajectory, robot: RobotConfig, world: World) {
  const s = t.samples
  const ok = s.map(q => detections(robot, world, q.x, q.y, q.heading).length > 0)
  ctx.lineCap = "round"
  ctx.lineWidth = 13
  for (let i = 1; i < s.length; i++) {
    ctx.strokeStyle = ok[i - 1] && ok[i] ? "rgba(34,197,94,0.38)" : "rgba(239,68,68,0.38)"
    ctx.beginPath()
    ctx.moveTo(...toScreen(s[i - 1].x, s[i - 1].y))
    ctx.lineTo(...toScreen(s[i].x, s[i].y))
    ctx.stroke()
  }
  ctx.lineCap = "butt"
}

/**
 * The field's structures, as a map with depth: each footprint shaded darker the taller it is,
 * with its height, so it reads which ones hide a tag from a camera at a given height.
 */
export function drawOccluders(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, occluders: Occluder[]) {
  for (const o of occluders) {
    const yaw = ((o.yawDeg ?? 0) * Math.PI) / 180
    const c = Math.cos(yaw), s = Math.sin(yaw)
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => {
      const lx = (u * o.lengthM) / 2, ly = (v * o.widthM) / 2
      return toScreen(o.x + c * lx - s * ly, o.y + s * lx + c * ly)
    })
    // Up to 2.5 m reads from light to dark.
    const depth = Math.min(1, Math.max(0, o.zMaxM / 2.5))
    ctx.beginPath()
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.closePath()
    ctx.fillStyle = `rgba(30,41,59,${0.18 + 0.45 * depth})`
    ctx.fill()
    ctx.strokeStyle = "rgba(15,23,42,0.85)"
    ctx.lineWidth = 1.4
    ctx.stroke()
    // Hatching: a structure, not a zone.
    ctx.save()
    ctx.clip()
    ctx.strokeStyle = "rgba(255,255,255,0.18)"
    ctx.lineWidth = 1
    const [cx, cy] = toScreen(o.x, o.y)
    const r = Math.hypot(o.lengthM, o.widthM) * k
    for (let d = -r; d < r; d += 7) {
      ctx.beginPath()
      ctx.moveTo(cx + d - r, cy - r)
      ctx.lineTo(cx + d + r, cy + r)
      ctx.stroke()
    }
    ctx.restore()
    const [lx, ly] = toScreen(o.x, o.y)
    drawChip(ctx, lx, ly, `${(o.zMinM ?? 0) > 0 ? `${(o.zMinM ?? 0).toFixed(2)}–` : "▲ "}${o.zMaxM.toFixed(2)} m`, "#0f172a", true)
  }
}

/** The vision map: each cell colored by how many tags the cameras can see from it. */
export function drawVisionMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, m: VisionMap) {
  const colors = ["rgba(239,68,68,0.30)", "rgba(250,204,21,0.30)", "rgba(132,204,22,0.32)", "rgba(34,197,94,0.36)", "rgba(21,128,61,0.42)"]
  const size = m.cellM * k + 0.5
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      const n = m.counts[r * m.cols + c]
      const [x, y] = toScreen(c * m.cellM, (r + 1) * m.cellM)
      ctx.fillStyle = colors[Math.min(n, colors.length - 1)]
      ctx.fillRect(x, y, size, size)
    }
  }
}

/**
 * Around the trajectory, two sigma of where the robot thinks it is: thin where the cameras keep
 * the pose honest, wide where the odometry has been drifting on its own. Starts from a pose known
 * to 5 cm, as after a vision-seeded start.
 */
function drawPoseSigma(ctx: CanvasRenderingContext2D, toScreen: ToScreen, k: number, t: Trajectory, robot: RobotConfig, world: World) {
  const s = t.samples
  const sigma = poseSigma(robot, world, s, 0.05)
  ctx.fillStyle = "rgba(99,102,241,0.13)"
  ctx.strokeStyle = "rgba(99,102,241,0.35)"
  ctx.lineWidth = 1
  // Circles of 2 sigma along the way: their union is the band.
  for (let i = 0; i < s.length; i += Math.max(1, Math.floor(s.length / 120))) {
    const [x, y] = toScreen(s[i].x, s[i].y)
    ctx.beginPath()
    ctx.arc(x, y, Math.max(2, 2 * sigma[i] * k), 0, Math.PI * 2)
    ctx.fill()
  }
  const last = s.length - 1
  const [ex, ey] = toScreen(s[last].x, s[last].y)
  ctx.beginPath()
  ctx.arc(ex, ey, Math.max(2, 2 * sigma[last] * k), 0, Math.PI * 2)
  ctx.stroke()
  drawChip(ctx, ex, ey + Math.max(14, 2 * sigma[last] * k + 10), `pose ±${(200 * sigma[last]).toFixed(0)} cm (2σ)`, "#4f46e5", false)
}

/**
 * How the field picture is turned so blue sits at x = 0. "auto" follows the game's symmetry: the
 * pictures have red on the left, and a field that is the same turned 180 degrees (2026) is turned;
 * one that is the same in a mirror (2023, 2024) is mirrored. Mirroring a rotational field puts its
 * asymmetric parts (2026's depot and outpost) on the wrong side, checked against the official 3D
 * model aligned by its AprilTags: the blue depot is at (0.34, 5.96), top left.
 */
export function pictureFlip(field: FieldConfig, flip: ViewOptions["fieldFlip"]): "none" | "mirror" | "rotate" {
  if (flip !== "auto") return flip
  return symmetryOf(field) === "mirrored" ? "mirror" : "rotate"
}
