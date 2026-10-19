// What the robot's cameras see: the field's AprilTags, from a pose.
//
// The same model as ares-core's vision.rs, so what the app draws is what the planner aims for: a
// camera sees a tag in front of it, inside both halves of its field of view, within its range,
// turned toward it (read nearly edge-on, a tag is not detected), and with nothing in between: the
// field's structures are occluders, a 2.5D map (footprints with a height). No image noise;
// poseSigma models what the tags do for the pose estimate.

import type { CameraConfig, RobotConfig } from "../robot/types"
import layout2023 from "../field/tags/2023-chargedup.json"
import layout2024 from "../field/tags/2024-crescendo.json"
import layout2025 from "../field/tags/2025-reefscape-welded.json"
import layout2026 from "../field/tags/2026-rebuilt-welded.json"

/** A tag read edge-on beyond this angle from its face is not detected. */
export const MAX_TAG_ANGLE_DEG = 70

/** An AprilTag: its center and the direction its face looks (unit vector). */
export interface Tag { id: number; x: number; y: number; z: number; nx: number; ny: number; nz: number }

/**
 * A structure that blocks the view: a rectangle (center, size along its own X and Y, turned by
 * yawDeg) from zMinM up to zMaxM. The field's 2.5D map is a list of these.
 */
export interface Occluder { name: string; x: number; y: number; lengthM: number; widthM: number; yawDeg?: number; zMinM?: number; zMaxM: number }

/** What the cameras look at: the tags, and what stands in the way. */
export interface World { tags: Tag[]; occluders: Occluder[] }

/** The last bit of a sight line left out: the tag sits on its own structure's face. */
const SURFACE_M = 0.03

/** Whether the 3D segment from a to b passes through the occluder (its last SURFACE_M excepted). */
export function blocks(o: Occluder, a: [number, number, number], b: [number, number, number]): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  if (len < 1e-9) return false
  const tEnd = 1 - SURFACE_M / len
  if (tEnd <= 0) return false
  const yaw = rad(o.yawDeg), c = Math.cos(yaw), s = Math.sin(yaw)
  const local = (p: [number, number, number]) => [c * (p[0] - o.x) + s * (p[1] - o.y), -s * (p[0] - o.x) + c * (p[1] - o.y)]
  const [ax, ay] = local(a), [bx, by] = local(b)
  const dx = bx - ax, dy = by - ay
  let t0 = 0, t1 = tEnd
  for (const [pp, q] of [[-dx, ax + o.lengthM / 2], [dx, o.lengthM / 2 - ax], [-dy, ay + o.widthM / 2], [dy, o.widthM / 2 - ay]]) {
    if (Math.abs(pp) < 1e-12) {
      if (q < 0) return false
    } else {
      const r = q / pp
      if (pp < 0) t0 = Math.max(t0, r)
      else t1 = Math.min(t1, r)
    }
    if (t0 > t1) return false
  }
  const z0 = a[2] + (b[2] - a[2]) * t0, z1 = a[2] + (b[2] - a[2]) * t1
  return Math.min(z0, z1) <= o.zMaxM && Math.max(z0, z1) >= (o.zMinM ?? 0)
}

/**
 * Structures estimated from the tags, for a field whose map nobody drew: tags within 1.6 m of each
 * other that face at least two ways (the hub has tags on all four faces) are one structure, the
 * box around them, 0.6 m taller than its highest tag. A wall's row of tags faces one way: none.
 */
export function estimateOccluders(tags: Tag[]): Occluder[] {
  const group = tags.map((_, i) => i)
  const root = (i: number): number => { let r = i; while (group[r] !== r) r = group[r]; group[i] = r; return r }
  for (let i = 0; i < tags.length; i++)
    for (let j = i + 1; j < tags.length; j++)
      if (Math.hypot(tags[i].x - tags[j].x, tags[i].y - tags[j].y) < 1.6) group[root(i)] = root(j)
  const clusters = new Map<number, Tag[]>()
  tags.forEach((t, i) => { const r = root(i); clusters.set(r, [...(clusters.get(r) ?? []), t]) })
  return [...clusters.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
    .filter(c => c.length >= 3 && c.some(a => c.some(b => a.nx * b.nx + a.ny * b.ny < 0.5)))
    .map(c => {
      const xs = c.map(t => t.x), ys = c.map(t => t.y), ids = c.map(t => t.id).sort((a, b) => a - b)
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      return {
        name: `structure of tags ${ids[0]}-${ids[ids.length - 1]}`,
        x: (x0 + x1) / 2, y: (y0 + y1) / 2, lengthM: Math.max(0.1, x1 - x0), widthM: Math.max(0.1, y1 - y0),
        yawDeg: 0, zMinM: 0, zMaxM: Math.max(...c.map(t => t.z)) + 0.6,
      }
    })
}

/** The field's 2.5D map: the one drawn in the Field tab, or estimated from the tags if none was. */
export function occludersFor(drawn: Occluder[] | null | undefined, tags: Tag[]): Occluder[] {
  return drawn ?? estimateOccluders(tags)
}

interface WpilibLayout {
  tags: { ID: number; pose: { translation: { x: number; y: number; z: number }; rotation: { quaternion: { W: number; X: number; Y: number; Z: number } } } }[]
}

/** A WPILib AprilTag layout's tags: each face looks along its pose's X axis. */
export function tagsFromLayout(layout: WpilibLayout): Tag[] {
  return layout.tags.map(t => {
    const { W: w, X: x, Y: y, Z: z } = t.pose.rotation.quaternion
    const p = t.pose.translation
    return { id: t.ID, x: p.x, y: p.y, z: p.z, nx: 1 - 2 * (y * y + z * z), ny: 2 * (x * y + w * z), nz: 2 * (x * z - w * y) }
  })
}

const LAYOUTS: Record<string, WpilibLayout> = {
  "2023": layout2023 as WpilibLayout,
  "2024": layout2024 as WpilibLayout,
  "2025": layout2025 as WpilibLayout,
  "2026": layout2026 as WpilibLayout,
}

const cache = new Map<string, Tag[]>()

/** The tags of the field with this key ("2026-rebuilt", ...), by its year; none if unknown. */
export function tagsForField(key: string): Tag[] {
  const year = key.slice(0, 4)
  if (!cache.has(year)) cache.set(year, LAYOUTS[year] ? tagsFromLayout(LAYOUTS[year]) : [])
  return cache.get(year)!
}

type M3 = number[][]

function mul(a: M3, b: M3): M3 {
  return [0, 1, 2].map(i => [0, 1, 2].map(j => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]))
}
const rz = (t: number): M3 => [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]]
const ry = (t: number): M3 => [[Math.cos(t), 0, Math.sin(t)], [0, 1, 0], [-Math.sin(t), 0, Math.cos(t)]]
const rx = (t: number): M3 => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]]
const rad = (d: number | undefined) => ((d ?? 0) * Math.PI) / 180

/** Where a camera is on the field and how it is turned (columns: forward, left, up). */
export interface CameraPose { position: [number, number, number]; rotation: M3 }

export function cameraPose(c: CameraConfig, x: number, y: number, heading: number): CameraPose {
  const ch = Math.cos(heading), sh = Math.sin(heading)
  // WPILib's Rotation3d(roll, pitch, yaw): about X, then Y, then Z, all fixed axes.
  const own = mul(rz(rad(c.yawDeg)), mul(ry(rad(c.pitchDeg)), rx(rad(c.rollDeg))))
  return { position: [x + ch * c.xM - sh * c.yM, y + sh * c.xM + ch * c.yM, c.zM], rotation: mul(rz(heading), own) }
}

export function rangeOf(c: CameraConfig): number {
  return c.maxRangeM ?? 5
}

/** Whether the camera, posed as given, detects the tag. */
export function sees(c: CameraConfig, pose: CameraPose, t: Tag): boolean {
  const d = [t.x - pose.position[0], t.y - pose.position[1], t.z - pose.position[2]]
  const dist = Math.hypot(d[0], d[1], d[2])
  if (dist < 1e-6 || dist > rangeOf(c)) return false
  const r = pose.rotation
  const v = [0, 1, 2].map(j => r[0][j] * d[0] + r[1][j] * d[1] + r[2][j] * d[2])
  if (v[0] <= 0) return false
  if (Math.abs(Math.atan2(v[1], v[0])) > rad(c.horizontalFovDeg) / 2) return false
  if (Math.abs(Math.atan2(v[2], v[0])) > rad(c.verticalFovDeg) / 2) return false
  const facing = -(t.nx * d[0] + t.ny * d[1] + t.nz * d[2]) / dist
  return facing >= Math.cos(rad(MAX_TAG_ANGLE_DEG))
}

/** Whether the camera sees the tag with nothing on the field in between. */
export function visible(c: CameraConfig, pose: CameraPose, t: Tag, occluders: Occluder[]): boolean {
  return sees(c, pose, t) && !occluders.some(o => blocks(o, pose.position, [t.x, t.y, t.z]))
}

/** One camera seeing one tag; `hidden`: in its field of view and range, but behind a structure. */
export interface Detection { camera: number; tag: Tag; from: [number, number]; hidden?: boolean }

/** Every detection with the robot at (x, y, heading). With `withHidden`, the occluded ones too. */
export function detections(robot: RobotConfig, world: World, x: number, y: number, heading: number, withHidden = false): Detection[] {
  const out: Detection[] = []
  ;(robot.cameras ?? []).forEach((c, i) => {
    const pose = cameraPose(c, x, y, heading)
    for (const t of world.tags) {
      if (!sees(c, pose, t)) continue
      const hidden = world.occluders.some(o => blocks(o, pose.position, [t.x, t.y, t.z]))
      if (!hidden || withHidden) out.push({ camera: i, tag: t, from: [pose.position[0], pose.position[1]], hidden })
    }
  })
  return out
}

/** The most tags the cameras see from (x, y) turning to the best of `steps` headings. */
export function bestView(robot: RobotConfig, world: World, x: number, y: number, steps = 24): { count: number; heading: number } {
  let best = { count: 0, heading: 0 }
  for (let k = 0; k < steps; k++) {
    const h = (2 * Math.PI * k) / steps
    const n = detections(robot, world, x, y, h).length
    if (n > best.count) best = { count: n, heading: h }
  }
  return best
}

/** The field's vision map: the most tags in view from each cell's center, at the best heading. */
export interface VisionMap { cellM: number; cols: number; rows: number; counts: Uint8Array }

export function visionMap(robot: RobotConfig, world: World, lengthM: number, widthM: number, cellM = 0.3, steps = 24): VisionMap {
  const cols = Math.ceil(lengthM / cellM), rows = Math.ceil(widthM / cellM)
  const counts = new Uint8Array(cols * rows)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) counts[r * cols + c] = Math.min(255, bestView(robot, world, (c + 0.5) * cellM, (r + 0.5) * cellM, steps).count)
  return { cellM, cols, rows, counts }
}

/** The odometry's drift, as a fraction of the distance driven (as ares-core). */
export const ODOMETRY_DRIFT = 0.02

/**
 * How well the robot knows where it is along a path (one sigma, m): the odometry drifts 2% of the
 * distance driven; every sample with tags in view pulls it back as the pose estimator does, with
 * a measurement sigma of 0.04 m x distance^2 / tags (clamped to [0.02, 4] m, worse above 2 m/s).
 */
export function poseSigma(robot: RobotConfig, world: World, samples: { x: number; y: number; heading: number; vx: number; vy: number }[], startSigma = 0.05): number[] {
  const out: number[] = []
  let sigma = startSigma
  let last: [number, number] | null = null
  for (const q of samples) {
    if (last) sigma += ODOMETRY_DRIFT * Math.hypot(q.x - last[0], q.y - last[1])
    last = [q.x, q.y]
    let d2 = 0, n = 0
    ;(robot.cameras ?? []).forEach(c => {
      const pose = cameraPose(c, q.x, q.y, q.heading)
      for (const t of world.tags) {
        if (!visible(c, pose, t, world.occluders)) continue
        d2 += (t.x - pose.position[0]) ** 2 + (t.y - pose.position[1]) ** 2 + (t.z - pose.position[2]) ** 2
        n++
      }
    })
    if (n > 0) {
      const measured = Math.min(4, Math.max(0.02, (0.04 * (d2 / n)) / n)) * (1 + Math.max(0, Math.hypot(q.vx, q.vy) / 2))
      sigma = 1 / Math.sqrt(1 / (sigma * sigma) + 1 / (measured * measured))
    }
    out.push(sigma)
  }
  return out
}

/** A camera's field of view projected on the carpet: its center and the two edges' directions. */
export function fovOnFloor(c: CameraConfig, x: number, y: number, heading: number): { at: [number, number]; left: number; right: number; range: number } {
  const pose = cameraPose(c, x, y, heading)
  const f = pose.rotation.map(row => row[0])
  const center = Math.atan2(f[1], f[0])
  const half = rad(c.horizontalFovDeg) / 2
  return { at: [pose.position[0], pose.position[1]], left: center + half, right: center - half, range: rangeOf(c) }
}

/** Limelight green: every camera's field of view and sight lines are drawn in it. */
export const LIMELIGHT_GREEN = "#39ff14"

/** The colors the cameras are drawn in, by index: all Limelight green (their labels tell them apart). */
export const CAMERA_COLORS = [LIMELIGHT_GREEN]

/**
 * A camera's field of view on the carpet as it really reaches: rays across the field of view,
 * each stopped by the first structure in the way. A structure cuts a ray when it reaches the
 * camera's height (the hub does, a bump lower than the lens does not). Field coordinates.
 */
export function fovPolygon(c: CameraConfig, x: number, y: number, heading: number, occluders: Occluder[], rays = 72): { at: [number, number]; points: [number, number][] } {
  const f = fovOnFloor(c, x, y, heading)
  const cz = c.zM
  const walls = occluders.filter(o => o.zMaxM >= cz && (o.zMinM ?? 0) <= cz + 0.5)
  const points: [number, number][] = []
  for (let k = 0; k <= rays; k++) {
    const a = f.right + ((f.left - f.right) * k) / rays
    const dx = Math.cos(a), dy = Math.sin(a)
    let reach = f.range
    for (const o of walls) {
      const hit = rayHitsRect(o, f.at[0], f.at[1], dx, dy)
      if (hit !== null && hit < reach) reach = hit
    }
    points.push([f.at[0] + dx * reach, f.at[1] + dy * reach])
  }
  return { at: f.at, points }
}

/** Where a ray from (x, y) along (dx, dy) first enters the occluder's footprint, or null. */
function rayHitsRect(o: Occluder, x: number, y: number, dx: number, dy: number): number | null {
  const yaw = rad(o.yawDeg), c = Math.cos(yaw), s = Math.sin(yaw)
  const ox = c * (x - o.x) + s * (y - o.y), oy = -s * (x - o.x) + c * (y - o.y)
  const vx = c * dx + s * dy, vy = -s * dx + c * dy
  let t0 = 0, t1 = Infinity
  for (const [p, v, h] of [[ox, vx, o.lengthM / 2], [oy, vy, o.widthM / 2]]) {
    if (Math.abs(v) < 1e-12) {
      if (Math.abs(p) > h) return null
    } else {
      let a = (-h - p) / v, b = (h - p) / v
      if (a > b) [a, b] = [b, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, b)
      if (t0 > t1) return null
    }
  }
  return t0
}

/** The planner's notion of "enough tags", for the span chips. */
export function tagCount(robot: RobotConfig, world: World, x: number, y: number, heading: number, camera?: string): number {
  return detections(robot, world, x, y, heading).filter(d => camera === undefined || robot.cameras![d.camera].name === camera).length
}
