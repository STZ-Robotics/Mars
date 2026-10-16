// The robot's numbers, drawn on the robot like a technical drawing: dimension
// lines with arrowheads and extension lines on the floor, callouts on the
// wheels, the center of mass with its drafting symbol, and a spec plate above
// the robot with its weight and limits.
//
// Lines and arrowheads are three.js geometry (they turn with the robot);
// text is HTML through CSS2DRenderer, so it stays crisp and readable from any
// angle.

import {
  BoxGeometry, BufferGeometry, CylinderGeometry, DoubleSide, EdgesGeometry, Float32BufferAttribute,
  Group, Line, LineBasicMaterial, LineDashedMaterial, LineSegments, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, Shape, ShapeGeometry, Vector3,
} from "three"
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js"
import type { Derived, RobotConfig } from "./types"
import "./annotations.css"

const INK = 0x3a3b40
const BUMPER_RED = 0xa83c3c
const FLOOR_Z = 0.003
const ARROW_LENGTH = 0.04
const ARROW_HALF_WIDTH = 0.012
// FRC bumpers sit low; their exact zone does not matter for a guide.
export const BUMPER_HEIGHT = 0.13

const ink = () => new LineBasicMaterial({ color: INK })

function seg(a: Vector3, b: Vector3, material = ink()): LineSegments {
  const g = new BufferGeometry()
  g.setAttribute("position", new Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3))
  return new LineSegments(g, material)
}

/** A filled arrowhead on the floor, its tip at `tip`, pointing along `dir`. */
function arrowhead(tip: Vector3, dir: Vector3): Mesh {
  const s = new Shape()
  s.moveTo(0, 0)
  s.lineTo(-ARROW_LENGTH, ARROW_HALF_WIDTH)
  s.lineTo(-ARROW_LENGTH, -ARROW_HALF_WIDTH)
  s.closePath()
  const m = new Mesh(new ShapeGeometry(s), new MeshBasicMaterial({ color: INK, side: DoubleSide }))
  m.position.copy(tip)
  m.rotation.z = Math.atan2(dir.y, dir.x)
  return m
}

function label(html: string, className: string, center: [number, number] = [0.5, 0.5]): CSS2DObject {
  const outer = document.createElement("div")
  outer.className = "ares-anno"
  outer.innerHTML = `<div class="${className}">${html}</div>`
  const o = new CSS2DObject(outer)
  o.center.set(...center)
  return o
}

const num = (v: string) => `<span class="ares-anno-num">${v}</span>`
const meters = (m: number) => `${num(m.toFixed(3))} m<span class="alt">${num((m / 0.0254).toFixed(2))} in</span>`

/**
 * A dimension between `a` and `b` on the floor, drawn `offset` away along
 * `out` (a unit vector on the floor), with extension lines back to the
 * points.
 */
function dimension(a: Vector3, b: Vector3, out: Vector3, offset: number, caption: string, length: number): Group {
  const g = new Group()
  const gap = 0.025, overshoot = 0.025
  const da = a.clone().addScaledVector(out, offset), db = b.clone().addScaledVector(out, offset)
  g.add(seg(a.clone().addScaledVector(out, gap), a.clone().addScaledVector(out, offset + overshoot)))
  g.add(seg(b.clone().addScaledVector(out, gap), b.clone().addScaledVector(out, offset + overshoot)))
  g.add(seg(da, db))
  const along = db.clone().sub(da).normalize()
  g.add(arrowhead(da, along.clone().negate()), arrowhead(db, along))
  const tag = label(`<span class="label">${caption}</span>${meters(length)}`, "ares-dim")
  tag.position.copy(da).add(db).multiplyScalar(0.5)
  g.add(tag)
  return g
}

/** The center-of-mass symbol: a circle in quarters, black and white. */
function cogSymbol(size: number): string {
  const r = size / 2 - 1, c = size / 2
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${c}" cy="${c}" r="${r}" fill="#ffffff"/>
    <path d="M${c},${c} L${c},${c - r} A${r},${r} 0 0,0 ${c - r},${c} Z" fill="#1c1c1f"/>
    <path d="M${c},${c} L${c},${c + r} A${r},${r} 0 0,0 ${c + r},${c} Z" fill="#1c1c1f"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#1c1c1f" stroke-width="1.5"/>
  </svg>`
}

function plate(robot: RobotConfig, d: Derived | null): string {
  const lb = robot.massKg / 0.45359237
  const row = (k: string, v: string, why = "", bind = false) =>
    `<div class="row${bind ? " bind" : ""}"><span class="k">${k}</span><span class="v">${num(v)}</span>${why ? `<span class="why">${why}</span>` : ""}</div>`
  const rows = d ? [
    row("Free speed", `${d.freeSpeedMps.toFixed(2)} m/s`, `${(d.freeSpeedMps / 0.3048).toFixed(1)} ft/s`),
    row("Launch", `${d.maxAccelMps2.toFixed(1)} m/s²`, d.launchLimitedBy === "grip" ? "grip" : "motors"),
    row("Spin", `${d.maxOmegaDps.toFixed(0)} °/s`),
    d.tipAccelMps2 !== null
      ? row("Tips at", `${d.tipAccelMps2.toFixed(1)} m/s²`, d.tipAccelMps2 < d.maxAccelMps2 ? "binds" : "", d.tipAccelMps2 < d.maxAccelMps2)
      : "",
    d.sprint5mS !== null ? row("5 m sprint", `${d.sprint5mS.toFixed(2)} s`) : "",
  ].join("") : `<div class="row"><span class="k">Fix the problems to see the limits</span></div>`
  return `<div class="head"><span class="name">${escapeHtml(robot.name)}</span>
      <span class="mass">${num(robot.massKg.toFixed(1))} kg<small>${num(lb.toFixed(1))} lb</small></span></div>
    <div class="rows">${rows}</div>`
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)
}

export interface AnnotationOptions {
  /** The top of the model (or the bumper), for the plate and the callouts. */
  topZ: number
}

/** Everything drawn over the robot. Dispose it with `disposeAnnotations`. */
export function buildAnnotations(robot: RobotConfig, derived: Derived | null, { topZ }: AnnotationOptions): Group {
  const g = new Group()
  const { lengthM: L, widthM: W } = robot.bumper
  const dt = robot.drivetrain
  const r = dt.wheelRadiusM

  // Bumper: an outline in the bumper's red, a faint fill.
  const box = new BoxGeometry(L, W, BUMPER_HEIGHT)
  const fill = new Mesh(box, new MeshStandardMaterial({ color: BUMPER_RED, transparent: true, opacity: 0.07, depthWrite: false }))
  const outline = new LineSegments(new EdgesGeometry(box), new LineBasicMaterial({ color: BUMPER_RED }))
  fill.position.z = outline.position.z = BUMPER_HEIGHT / 2
  g.add(fill, outline)

  // Dimensions nested as on a drawing: the wheel spacing close to the robot,
  // the bumper outside it, on the left (+Y) and rear (-X) sides. The front
  // (+X) carries the FRONT arrow and the right side stays clear.
  const z = FLOOR_Z
  const near = 0.12, far = 0.27
  const xs = dt.modules.map(m => m.xM), ys = dt.modules.map(m => m.yM)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  if (x1 - x0 > 1e-6) {
    g.add(dimension(new Vector3(x1, y1, z), new Vector3(x0, y1, z), new Vector3(0, 1, 0), W / 2 - y1 + near, "Wheelbase", x1 - x0))
  }
  g.add(dimension(new Vector3(L / 2, W / 2, z), new Vector3(-L / 2, W / 2, z), new Vector3(0, 1, 0), far, "Bumper", L))
  if (y1 - y0 > 1e-6) {
    g.add(dimension(new Vector3(x0, y1, z), new Vector3(x0, y0, z), new Vector3(-1, 0, 0), L / 2 + x0 + near, "Trackwidth", y1 - y0))
  }
  g.add(dimension(new Vector3(-L / 2, W / 2, z), new Vector3(-L / 2, -W / 2, z), new Vector3(-1, 0, 0), far, "Bumper", W))

  // Front: an arrow on the floor ahead of the bumper.
  const front = new Group()
  front.add(seg(new Vector3(L / 2 + 0.05, 0, z), new Vector3(L / 2 + 0.14, 0, z)))
  front.add(arrowhead(new Vector3(L / 2 + 0.18, 0, z), new Vector3(1, 0, 0)))
  const frontTag = label("FRONT", "ares-dim", [0, 0.5])
  frontTag.position.set(L / 2 + 0.2, 0, z)
  front.add(frontTag)
  g.add(front)

  // Wheels, each with a callout: name, grip and size.
  for (const m of dt.modules) {
    const wheel = new Mesh(
      new CylinderGeometry(r, r, 0.04, 32),
      new MeshStandardMaterial({ color: 0x2b2c31, metalness: 0.1, roughness: 0.85 }),
    )
    wheel.position.set(m.xM, m.yM, r)
    g.add(wheel)

    // The leader runs out over the bumper's corner, clear of the dimensions,
    // and rises a little so the tag never sits on the floor lines.
    const outward = new Vector3(m.xM, m.yM, 0).normalize()
    const from = new Vector3(m.xM, m.yM, 2 * r + 0.01)
    const corner = Math.hypot(L / 2, W / 2) - Math.hypot(m.xM, m.yM)
    const to = from.clone().addScaledVector(outward, corner + 0.08).setZ(BUMPER_HEIGHT + 0.22)
    g.add(seg(from, to))
    const tag = label(
      `<b>${escapeHtml(m.name.toUpperCase())}</b>μ ${num(dt.wheelCof.toFixed(2))} · ⌀ ${num((2 * r / 0.0254).toFixed(2))} in`,
      "ares-tag", [0.5, 1],
    )
    tag.position.copy(to)
    g.add(tag)
  }

  // Center of mass: the drafting symbol at its height, a dashed drop line to
  // the floor, and the height itself.
  if (robot.cogHeightM && robot.cogHeightM > 0) {
    const h = robot.cogHeightM
    const drop = new Line(
      new BufferGeometry().setFromPoints([new Vector3(0, 0, z), new Vector3(0, 0, h)]),
      new LineDashedMaterial({ color: INK, dashSize: 0.02, gapSize: 0.015 }),
    )
    drop.computeLineDistances()
    g.add(drop)
    const icon = label(cogSymbol(22), "ares-cog")
    icon.position.set(0, 0, h)
    g.add(icon)
    const height = label(`<span class="label">CoG</span>${meters(h)}`, "ares-dim ares-cog-height", [0, 0.5])
    height.position.set(0, 0, h)
    g.add(height)
  }

  // The spec plate, above everything, on a short stem.
  const top = Math.max(topZ, BUMPER_HEIGHT)
  const stem = top + 0.35
  g.add(seg(new Vector3(0, 0, top + 0.02), new Vector3(0, 0, stem)))
  const spec = label(plate(robot, derived), "ares-plate", [0.5, 1])
  spec.position.set(0, 0, stem)
  g.add(spec)

  return g
}

/** Frees the geometry and takes the HTML labels out of the page. */
export function disposeAnnotations(root: Object3D) {
  root.traverse(o => {
    if (o instanceof CSS2DObject) o.element.remove()
    const mesh = o as Mesh
    mesh.geometry?.dispose?.()
    const mat = mesh.material
    if (Array.isArray(mat)) mat.forEach(x => x.dispose())
    else mat?.dispose?.()
  })
}
