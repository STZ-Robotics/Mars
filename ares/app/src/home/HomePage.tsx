// The Home tab: Ares and its version, the pages a team opens most, and under them, filling the
// rest of the window, robots driving several routes at once on a checkered floor (the look of a
// physics simulator's scene). The routes are fixed and timed kinematically (a trapezoid of speed
// along each one, the heading turning between waypoints): a picture of what Ares plans, not the
// planner's output. Nothing here scrolls.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { getVersion } from "@tauri-apps/api/app"
import {
  BoxGeometry, CanvasTexture, CatmullRomCurve3, Color, ConeGeometry, Fog, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  NearestFilter, PerspectiveCamera, PlaneGeometry, RepeatWrapping, Scene, SRGBColorSpace, TubeGeometry, Vector3, WebGLRenderer,
} from "three"
import { addStandardLights } from "@desktop/components/dashboard/three/sceneKit"
import type { RobotConfig } from "../robot/types"
import SwerveIcon from "../ui/SwerveIcon"

export type HomeTarget = "paths" | "robot" | "autos"

interface Props {
  robot: RobotConfig
  onOpen: (page: HomeTarget) => void
  onOpenProject: () => void
}

export default function HomePage({ robot, onOpen, onOpenProject }: Props) {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => { getVersion().then(setVersion).catch(() => setVersion(null)) }, [])
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-page)" }}>
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", padding: "22px 24px 16px", gap: 4 }}>
        <h1 style={{ margin: "4px 0 6px", lineHeight: 0, color: "var(--text-primary)" }}><Wordmark /></h1>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{version ? `Version ${version}` : " "}</div>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12, marginTop: 14 }}>
          <Shortcut icon={<i className="ti ti-route" style={{ fontSize: 24 }} />} label="Paths" hint="Draw and generate trajectories" onClick={() => onOpen("paths")} />
          <Shortcut icon={<SwerveIcon size={24} />} label="Robot configuration" hint="Drivetrain, bumpers, cameras" onClick={() => onOpen("robot")} />
          <Shortcut icon={<i className="ti ti-list-details" style={{ fontSize: 24 }} />} label="Autonomous" hint="Chain paths and commands" onClick={() => onOpen("autos")} />
        </div>
        <button onClick={onOpenProject}
          style={{ marginTop: 4, border: "none", background: "transparent", color: "var(--ares-accent)", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
          <i className="ti ti-folder-open" /> Open a robot project…
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", margin: "0 16px 16px", border: "1px solid var(--border-main)", borderRadius: 6, overflow: "hidden", background: BACKGROUND_CSS }}>
        <Showcase robot={robot} />
      </div>
    </div>
  )
}

/** "ARES" in square, ultra-wide strokes, drawn rather than typed: no font needed, the same everywhere. */
function Wordmark() {
  // Each letter is 110 wide and 40 tall, 30 apart, drawn with straight strokes only.
  const letters = [
    "M0 40 V0 H110 V40 M0 21 H110", // A
    "M0 40 V0 H110 V21 H0 M66 21 L110 40", // R
    "M110 0 H0 V40 H110 M0 21 H84", // E
    "M110 0 H0 V21 H110 V40 H0", // S
  ]
  return (
    <svg role="img" aria-label="Ares" viewBox="-4 -4 538 48" style={{ height: 30, width: "auto", display: "block", overflow: "visible" }}>
      {letters.map((d, i) => (
        <path key={i} d={d} transform={`translate(${i * 140} 0)`} fill="none" stroke="currentColor" strokeWidth={7} strokeLinecap="square" strokeLinejoin="miter" />
      ))}
    </svg>
  )
}

function Shortcut({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--ares-accent)"; e.currentTarget.style.transform = "translateY(-2px)" }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border-main)"; e.currentTarget.style.transform = "none" }}
      style={{
        width: 190, padding: "12px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 5, cursor: "pointer",
        border: "1px solid var(--border-main)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text-primary)",
        transition: "transform 160ms var(--ares-ease), border-color 160ms var(--ares-ease)",
      }}>
      <span style={{ color: "var(--ares-accent)", display: "flex" }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{hint}</span>
    </button>
  )
}

// --- The routes --------------------------------------------------------------------------

/** The floor the routes are laid on, in meters: an FRC field's size. */
const L = 16.5, W = 8.1

/** A waypoint in meters, and a heading in degrees. */
type Point = [number, number, number]
interface Route { color: number; points: Point[] }

/** The same route from the other end of the floor, facing the other way. */
const mirror = (points: Point[]): Point[] => points.map(([x, y, h]) => [L - x, y, 180 - h])

const LEFT: Point[] = [[1.0, 1.5, 0], [3.6, 1.0, 10], [5.9, 2.4, 60], [5.0, 4.2, 120]]
const MIDDLE: Point[] = [[1.0, 4.05, 0], [3.3, 3.7, 0], [5.6, 4.9, -30], [7.6, 4.05, 0]]
const RIGHT: Point[] = [[1.0, 6.8, 0], [3.3, 7.3, 0], [5.4, 5.8, -60], [3.0, 5.0, -170]]
const CYCLE: Point[] = [[1.3, 2.4, 0], [5.3, 1.1, 0], [10.2, 1.8, 20], [13.9, 3.7, 90], [10.9, 6.5, 180], [5.6, 6.8, 180], [2.3, 5.0, 200]]

const BLUE = 0x2563eb, RED = 0xdc2626, AMBER = 0xf59e0b
const ROUTES: Route[] = [
  { color: BLUE, points: LEFT },
  { color: BLUE, points: MIDDLE },
  { color: BLUE, points: RIGHT },
  { color: RED, points: mirror(LEFT) },
  { color: RED, points: mirror(RIGHT) },
  { color: AMBER, points: CYCLE },
]

const TOP_SPEED = 3.6
const ACCEL = 3.2
const PAUSE_S = 0.9

/** A route laid out: its curve, its length, where each waypoint falls along it, and its timing. */
function layout(route: Route) {
  const pts = route.points.map(([x, y]) => new Vector3(x, y, 0))
  const curve = new CatmullRomCurve3(pts, false, "centripetal")
  const length = curve.getLength()
  // Where each waypoint falls, by the chords between them.
  const chords = pts.map((p, i) => (i === 0 ? 0 : p.distanceTo(pts[i - 1])))
  const total = chords.reduce((a, b) => a + b, 0)
  let acc = 0
  const at = chords.map(c => (acc += c) / total)
  // A trapezoid of speed: up at ACCEL, cruise, down at ACCEL (a triangle when the route is short).
  const vPeak = Math.min(TOP_SPEED, Math.sqrt(ACCEL * length))
  const tRamp = vPeak / ACCEL
  const dRamp = (vPeak * tRamp) / 2
  const tCruise = Math.max(0, (length - 2 * dRamp) / vPeak)
  const duration = 2 * tRamp + tCruise
  const distance = (t: number) => {
    if (t <= tRamp) return (ACCEL * t * t) / 2
    if (t <= tRamp + tCruise) return dRamp + vPeak * (t - tRamp)
    const r = Math.max(0, duration - t)
    return length - (ACCEL * r * r) / 2
  }
  return { curve, length, at, duration, distance, headings: route.points.map(([, , h]) => (h * Math.PI) / 180) }
}

/** The heading at fraction u of the route: turning between the waypoints' headings, the short way. */
function headingAt(at: number[], headings: number[], u: number): number {
  let i = 0
  while (i < at.length - 2 && u > at[i + 1]) i++
  const span = at[i + 1] - at[i]
  const f = span > 0 ? Math.min(1, Math.max(0, (u - at[i]) / span)) : 0
  const s = f * f * (3 - 2 * f)
  let d = headings[i + 1] - headings[i]
  d = Math.atan2(Math.sin(d), Math.cos(d))
  return headings[i] + d * s
}

// --- The scene ------------------------------------------------------------------------------

const BACKGROUND = 0x14202e
const BACKGROUND_CSS = "#14202e"

/** A simulator's floor: 1 m checks in two blues, a fine line between them. */
function checkerTexture(): CanvasTexture {
  const n = 128
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 2 * n
  const ctx = canvas.getContext("2d")!
  for (const [x, y, c] of [[0, 0, "#2a3f57"], [n, n, "#2a3f57"], [n, 0, "#1d2d40"], [0, n, "#1d2d40"]] as const) {
    ctx.fillStyle = c
    ctx.fillRect(x, y, n, n)
  }
  ctx.strokeStyle = "rgba(160,190,225,0.22)"
  ctx.lineWidth = 2
  ctx.strokeRect(0, 0, 2 * n, 2 * n)
  ctx.beginPath()
  ctx.moveTo(n, 0); ctx.lineTo(n, 2 * n)
  ctx.moveTo(0, n); ctx.lineTo(2 * n, n)
  ctx.stroke()
  const tex = new CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.magFilter = NearestFilter
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

function Showcase({ robot }: { robot: RobotConfig }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current!
    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.outputColorSpace = SRGBColorSpace
    el.appendChild(renderer.domElement)
    const scene = new Scene()
    scene.background = new Color(BACKGROUND)
    scene.fog = new Fog(BACKGROUND, 22, 60)
    addStandardLights(scene)
    const camera = new PerspectiveCamera(40, 1, 0.1, 200)
    camera.up.set(0, 0, 1)
    const disposables: { dispose: () => void }[] = []
    const keep = <T extends { dispose: () => void }>(x: T) => { disposables.push(x); return x }

    // The floor: checks out to the fog, 2 m a repeat (two 1 m checks).
    const FLOOR = 80
    const checker = keep(checkerTexture())
    checker.repeat.set(FLOOR / 2, FLOOR / 2)
    const floor = new Mesh(keep(new PlaneGeometry(FLOOR, FLOOR)), keep(new MeshStandardMaterial({ map: checker, roughness: 0.9 })))
    floor.position.set(L / 2, W / 2, 0)
    scene.add(floor)

    // The robots, each on its route, the route drawn under it.
    const { lengthM: bl, widthM: bw } = robot.bumper
    const runs = ROUTES.map((route, n) => {
      const r = layout(route)
      const tube = keep(new TubeGeometry(new CatmullRomCurve3(route.points.map(([x, y]) => new Vector3(x, y, 0.04)), false, "centripetal"), 200, 0.045, 8, false))
      scene.add(new Mesh(tube, keep(new MeshBasicMaterial({ color: route.color, transparent: true, opacity: 0.9 }))))
      const body = new Group()
      const bumper = new Mesh(keep(new BoxGeometry(bl, bw, 0.13)), keep(new MeshStandardMaterial({ color: route.color, roughness: 0.6 })))
      bumper.position.z = 0.1
      const top = new Mesh(keep(new BoxGeometry(bl * 0.82, bw * 0.82, 0.05)), keep(new MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5 })))
      top.position.z = 0.19
      const front = new Mesh(keep(new ConeGeometry(Math.min(bl, bw) * 0.18, Math.min(bl, bw) * 0.32, 3).rotateZ(-Math.PI / 2)), keep(new MeshBasicMaterial({ color: 0xffffff })))
      front.position.set(bl * 0.22, 0, 0.23)
      body.add(bumper, top, front)
      scene.add(body)
      // Each starts at a different moment, so they are not in step.
      return { ...r, body, offset: n * 1.7 }
    })

    // Out of view (another tab), it does not draw.
    let visible = true
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting })
    io.observe(el)

    const start = performance.now()
    let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      if (!visible) return
      const w = el.clientWidth, h = el.clientHeight
      if (w === 0 || h === 0) return
      if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.round(h * renderer.getPixelRatio())) {
        renderer.setSize(w, h)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      const t = (performance.now() - start) / 1000
      // The camera sways around the routes, slowly, far enough that they all fit whatever the window's shape.
      const a = 0.35 * Math.sin(t * 0.09)
      const R = Math.max(L * 0.95, (L * 0.95) / Math.min(1, camera.aspect / 1.9))
      camera.position.set(L / 2 + R * Math.sin(a) * 0.6, W / 2 - R * Math.cos(a) * 0.5, R * 0.62)
      camera.lookAt(L / 2, W / 2, 0)
      // Each robot: out along its route, a pause, back along it, a pause.
      for (const r of runs) {
        const cycle = 2 * (r.duration + PAUSE_S)
        let c = (t + r.offset) % cycle
        let back = false
        if (c >= r.duration + PAUSE_S) { back = true; c -= r.duration + PAUSE_S }
        const d = r.distance(Math.min(c, r.duration))
        const u = back ? 1 - d / r.length : d / r.length
        const p = r.curve.getPointAt(Math.min(1, Math.max(0, u)))
        r.body.position.set(p.x, p.y, 0)
        r.body.rotation.z = headingAt(r.at, r.headings, u)
      }
      renderer.render(scene, camera)
    }
    render()

    return () => {
      cancelAnimationFrame(frame)
      io.disconnect()
      disposables.forEach(d => d.dispose())
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [robot.bumper.lengthM, robot.bumper.widthM])
  return <div ref={host} style={{ position: "absolute", inset: 0 }} />
}
