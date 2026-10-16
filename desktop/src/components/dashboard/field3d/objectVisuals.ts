// The objects drawn ON the 3D field: robots, ghosts, articulated parts,
// trajectories, vision marks, game pieces and markers.
//
// Each type is built once (when the configuration changes) and afterwards only
// UPDATED per frame. Rebuilding the geometry on every sample would be the
// simplest to write and the worst to use: with a couple of trajectories and a
// robot with components, garbage collection alone eats the 16 ms budget.
//
// Everything works in the field model's frame: origin at the center, +X towards
// red, +Y to the left seen from blue, +Z up. The page already converted the
// poses before they get here.

import {
  BoxGeometry, BufferGeometry, CatmullRomCurve3, ConeGeometry, DoubleSide,
  DynamicDrawUsage, EdgesGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial,
  LineSegments, Mesh, MeshPhongMaterial, Object3D, Points, PointsMaterial,
  SphereGeometry, TubeGeometry, Vector3,
} from "three"
import {
  Field3dObjectType, Field3dQuality, Field3dSettings,
} from "../../../store/appStore"
import { Pose3D, composePose, IDENTITY_POSE } from "../../../utils/field3d/frames"
import { ResolvedField3dOptions } from "../../../utils/field3d/objects"
import { GamePieceConfig, RobotAssetConfig, composeRotations } from "../../../utils/field3d/assetConfig"
import { LoadedAsset, disposeSceneTree, instantiateAsset } from "../../../utils/field3d/assetModels"
import { TrailStore } from "../../../utils/field3d/trails"
import { makeAxes, makeTextSprite } from "../three/sceneKit"

/** An object of the list with its poses for this frame, already in the model's frame. */
export interface RenderedField3dObject {
  id: string
  type: Field3dObjectType
  color: string
  label: string
  poses: Pose3D[]
  options: ResolvedField3dOptions
}

export interface RobotAssetEntry {
  config: RobotAssetConfig
  base: LoadedAsset
  /** `model_0.glb`, `model_1.glb`... in `config.components`' order. */
  components: LoadedAsset[]
}

export interface GamePieceEntry {
  config: GamePieceConfig
  asset: LoadedAsset | null
}

export interface VisualContext {
  settings: Field3dSettings
  quality: Field3dQuality
  robotAssets: Map<string, RobotAssetEntry>
  gamePieces: GamePieceEntry[]
}

/** What changes every frame and several object types need. */
export interface FrameContext {
  now: number
  trails: TrailStore
  /** Pose of the `robot` object a component or a vision mark is anchored to. */
  anchorPose: (anchorId: string | null) => Pose3D | null
  /** Camera of the anchored robot's asset, already composed with its pose. */
  anchorCamera: (anchorId: string | null, cameraIndex: number) => Pose3D | null
}

export interface ObjectVisual {
  group: Group
  update(object: RenderedField3dObject, frame: FrameContext): void
  dispose(): void
}

// --- Utilidades compartidas ---------------------------------------------------

/** three stores the quaternion as (x, y, z, w); WPILib publishes it as (w, x, y, z). */
export function applyPose(object: Object3D, pose: Pose3D) {
  object.position.set(pose.x, pose.y, pose.z)
  object.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw)
}

function tint(object: Object3D, color: string | null, opacity: number, quality: Field3dQuality) {
  object.traverse(child => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach(material => {
      const phong = material as MeshPhongMaterial
      if (color !== null) {
        // Imported models carry their color in a VERTEX attribute, and that
        // attribute is MULTIPLIED with `material.color`. Without turning it off,
        // painting a ghost blue would give blue-times-the-original-color, i.e.
        // almost black. Turning it off is what makes the requested color the one
        // you see.
        phong.vertexColors = false
        phong.color?.set(color)
      }
      phong.transparent = opacity < 1
      phong.opacity = opacity
      // Without this, a ghost covers itself: the back faces write depth and the
      // front ones get discarded against them.
      phong.depthWrite = opacity >= 1
      phong.side = DoubleSide
      phong.needsUpdate = true
    })
    mesh.castShadow = quality === "cinematic" && opacity >= 1
    mesh.receiveShadow = false
  })
}

/**
 * Generic chassis: a box with bumpers in the object's color and a wedge at the
 * front. It is what you see until the team imports its CAD, and it has to be
 * enough on its own — most practices are watched like this.
 */
function makeGenericChassis(settings: Field3dSettings, color: string): Group {
  const group = new Group()
  const { robotLength: length, robotWidth: width, robotHeight: height } = settings

  // The bumper is the colored outer ring; the body goes grey and a bit smaller,
  // so the color does not eat the whole silhouette.
  const bumperHeight = Math.min(height * 0.35, 0.13)
  const bumper = new Mesh(
    new BoxGeometry(length, width, bumperHeight),
    new MeshPhongMaterial({ color, shininess: 0 }),
  )
  bumper.position.z = bumperHeight / 2 + 0.05
  group.add(bumper)

  const body = new Mesh(
    new BoxGeometry(length * 0.88, width * 0.88, height),
    new MeshPhongMaterial({ color: 0xababb4, shininess: 12 }),
  )
  body.position.z = height / 2
  group.add(body)

  const outline = new LineSegments(
    new EdgesGeometry(new BoxGeometry(length, width, height)),
    new LineBasicMaterial({ color: 0x1c1c22 }),
  )
  outline.position.z = height / 2
  group.add(outline)

  // A wedge at the front: without it there is no way to know which way the robot
  // faces when the camera sees it from above, which is the most used view.
  const nose = new Mesh(
    new ConeGeometry(width * 0.12, length * 0.2, 4).rotateZ(-Math.PI / 2),
    new MeshPhongMaterial({ color: 0xf2f2f5, shininess: 0 }),
  )
  nose.position.set(length * 0.38, 0, height + 0.03)
  group.add(nose)

  return group
}

/**
 * Intermediate node with the "at zero" placement the asset declares.
 *
 * A robot asset's components and cameras come exported at the origin;
 * `zeroedPosition`/`zeroedRotations` say where they go when the published pose
 * is the identity. Putting it in as a separate node lets the published pose be
 * applied to the PARENT, which is exactly the composition AdvantageScope does.
 */
function makeZeroedSlot(position: [number, number, number], rotations: ReturnType<typeof composeRotations>): Group {
  const slot = new Group()
  slot.position.set(position[0], position[1], position[2])
  slot.quaternion.set(rotations[1], rotations[2], rotations[3], rotations[0])
  return slot
}

// --- Robot y fantasma ---------------------------------------------------------

function createRobot(object: RenderedField3dObject, ctx: VisualContext): ObjectVisual {
  const group = new Group()
  group.name = `robot:${object.id}`

  const entry = object.options.robotAssetKey
    ? ctx.robotAssets.get(object.options.robotAssetKey)
    : undefined

  let instance: Object3D
  let usedModel = false
  if (entry && object.options.useModel) {
    // The asset carries its own orientation and its own offset from the robot's
    // center; the placement node applies them only once.
    const slot = makeZeroedSlot(entry.config.position, composeRotations(entry.config.rotations))
    slot.add(instantiateAsset(entry.base))
    instance = slot
    usedModel = true
  } else {
    instance = makeGenericChassis(ctx.settings, object.color)
  }

  // With an imported model its materials are kept unless it is a ghost: there
  // the object's color is the only way to tell it from the real robot.
  const isGhost = object.type === "ghost"
  tint(instance, usedModel && !isGhost ? null : object.color, object.options.opacity, ctx.quality)

  // The outer group stays at the field's origin and only the inner one moves
  // with the pose. The trail lives in FIELD coordinates: hung from the group that
  // turns with the robot, it would be seen turning with it instead of staying
  // marked on the floor.
  const poseGroup = new Group()
  poseGroup.add(instance)
  group.add(poseGroup)

  if (object.options.showLabel) {
    const label = makeTextSprite(object.label)
    label.position.z = ctx.settings.robotHeight + 0.35
    poseGroup.add(label)
  }

  // The trail uses a fixed-size buffer with a moving `drawRange`: recreating the
  // geometry every frame is what makes a long trail ruin the fps.
  const trail = makeTrailLine(object.options.trailSeconds > 0 ? object.color : null)
  if (trail) group.add(trail.line)

  return {
    group,
    update(next, frame) {
      const pose = next.poses[0]
      group.visible = pose !== undefined && !next.options.hidden
      if (!pose) return
      applyPose(poseGroup, pose)

      if (trail) {
        const store = frame.trails.get(next.id)
        store.push(pose.x, pose.y, pose.z, frame.now)
        updateTrailLine(trail, store.since(next.options.trailSeconds, frame.now))
      }
    },
    dispose() {
      disposeSceneTree(group)
    },
  }
}

// --- Componentes articulados ---------------------------------------------------

/**
 * The robot's moving parts, moved by a `Pose3d[]` relative to the robot.
 *
 * Each pose's index picks the asset's `model_N.glb`: pose 0 moves component 0,
 * and so on. It is AdvantageScope's convention, and the one teams publishing
 * `AdvantageKit` already use.
 */
function createComponents(object: RenderedField3dObject, ctx: VisualContext): ObjectVisual {
  const group = new Group()
  group.name = `components:${object.id}`

  const entry = object.options.robotAssetKey
    ? ctx.robotAssets.get(object.options.robotAssetKey)
    : undefined

  interface Slot { pivot: Group; instance: Object3D }
  const slots: Slot[] = []

  if (entry) {
    entry.components.forEach((component, index) => {
      const config = entry.config.components[index]
      const pivot = new Group()
      const slot = makeZeroedSlot(
        config?.zeroedPosition ?? [0, 0, 0],
        composeRotations(config?.zeroedRotations ?? []),
      )
      const instance = instantiateAsset(component)
      slot.add(instance)
      pivot.add(slot)
      pivot.visible = false
      group.add(pivot)
      slots.push({ pivot, instance })
    })
  }

  const opacity = object.options.opacity
  slots.forEach(slot => tint(slot.instance, null, opacity, ctx.quality))

  return {
    group,
    update(next, frame) {
      const anchor = frame.anchorPose(next.options.anchorId) ?? IDENTITY_POSE
      group.visible = !next.options.hidden && slots.length > 0
      if (!group.visible) return

      slots.forEach((slot, index) => {
        const pose = next.poses[index]
        // A component with no published pose is turned off instead of staying at
        // the last one that arrived: in a trimmed log that leaves the arm raised
        // forever and confuses more than not drawing it.
        slot.pivot.visible = pose !== undefined
        if (pose) applyPose(slot.pivot, composePose(anchor, pose))
      })
    },
    dispose() {
      disposeSceneTree(group)
    },
  }
}

// --- Trayectoria ---------------------------------------------------------------

const TRAJECTORY_SEGMENTS = 6  // sides of the tube; more does not show at this scale

function createTrajectory(object: RenderedField3dObject, ctx: VisualContext): ObjectVisual {
  const group = new Group()
  group.name = `trajectory:${object.id}`

  const material = new MeshPhongMaterial({
    color: object.color, shininess: 10,
    transparent: object.options.opacity < 1, opacity: object.options.opacity,
  })
  const lineMaterial = new LineBasicMaterial({
    color: object.color, transparent: object.options.opacity < 1, opacity: object.options.opacity,
  })
  const pointMaterial = new PointsMaterial({
    color: object.color, size: object.options.trajectoryWidth * 3, sizeAttenuation: true,
  })

  let drawn: Object3D | null = null
  let signature = ""

  const waypoints = new Group()
  group.add(waypoints)
  const waypointGeometry = new SphereGeometry(object.options.trajectoryWidth * 1.6, 10, 8)
  const waypointMaterial = new MeshPhongMaterial({ color: object.color, shininess: 10 })

  const rebuild = (poses: Pose3D[], options: ResolvedField3dOptions) => {
    if (drawn) {
      group.remove(drawn)
      drawn.traverse(node => (node as Mesh).geometry?.dispose())
      drawn = null
    }
    if (poses.length < 2) return

    const points = poses.map(p => new Vector3(p.x, p.y, p.z + options.trajectoryHeight))

    if (options.trajectoryStyle === "points") {
      const geometry = new BufferGeometry().setFromPoints(points)
      drawn = new Points(geometry, pointMaterial)
    } else if (options.trajectoryStyle === "line") {
      const geometry = new BufferGeometry().setFromPoints(points)
      drawn = new Line(geometry, lineMaterial)
    } else {
      // The tube is sampled finer than the waypoints so curves do not look
      // faceted, but with a ceiling: a thousand-point trajectory does not need
      // five thousand segments.
      const curve = new CatmullRomCurve3(points, false, "catmullrom", 0.1)
      const segments = Math.min(Math.max(points.length * 4, 24), 900)
      drawn = new Mesh(
        new TubeGeometry(curve, segments, options.trajectoryWidth / 2, TRAJECTORY_SEGMENTS, false),
        material,
      )
      drawn.castShadow = ctx.quality === "cinematic"
    }
    group.add(drawn)
  }

  const rebuildWaypoints = (poses: Pose3D[], options: ResolvedField3dOptions) => {
    waypoints.clear()
    if (!options.showWaypoints) return
    poses.forEach(pose => {
      const marker = new Mesh(waypointGeometry, waypointMaterial)
      marker.position.set(pose.x, pose.y, pose.z + options.trajectoryHeight)
      waypoints.add(marker)
    })
  }

  return {
    group,
    update(next) {
      group.visible = !next.options.hidden
      if (!group.visible) return

      // A trajectory is published once and does not change; redoing the tube
      // every frame would blow the whole budget. The cheap signature detects the
      // change without walking the array twice.
      let checksum = 0
      for (const pose of next.poses) checksum += pose.x + pose.y * 3 + pose.z * 7
      const nextSignature = [
        next.poses.length, checksum.toFixed(4),
        next.options.trajectoryStyle, next.options.trajectoryWidth,
        next.options.trajectoryHeight, next.options.showWaypoints,
      ].join("|")

      if (nextSignature !== signature) {
        signature = nextSignature
        rebuild(next.poses, next.options)
        rebuildWaypoints(next.poses, next.options)
      }
    },
    dispose() {
      waypointGeometry.dispose()
      waypointMaterial.dispose()
      material.dispose()
      lineMaterial.dispose()
      pointMaterial.dispose()
      disposeSceneTree(group)
    },
  }
}

// --- Vision marks ----------------------------------------------------------

/** Cap on marks drawn at once; above it the buffer is trimmed. */
const MAX_VISION_TARGETS = 64

// The marks cast no shadow (they float in the air and the shadow would confuse
// more than help), so this type does not look at the render quality.
function createVision(object: RenderedField3dObject): ObjectVisual {
  const group = new Group()
  group.name = `vision:${object.id}`

  // A pair of vertices per mark, with the buffer reserved up front: the number
  // of marks changes from frame to frame and recreating the geometry each time is
  // what makes vision the most expensive object in the scene.
  const positions = new Float32BufferAttribute(new Float32Array(MAX_VISION_TARGETS * 6), 3)
  positions.setUsage(DynamicDrawUsage)
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", positions)

  const lines = new LineSegments(geometry, new LineBasicMaterial({
    color: object.color, transparent: true, opacity: Math.min(object.options.opacity, 0.9),
  }))
  group.add(lines)

  const markers = new Group()
  group.add(markers)
  const markerGeometry = new SphereGeometry(object.options.markerSize / 2, 12, 10)
  // The vision marks are slightly emissive: they are points of interest that
  // have to read even when they fall in the shadow of a field structure.
  const markerMaterial = new MeshPhongMaterial({
    color: object.color, emissive: object.color, emissiveIntensity: 0.35, shininess: 20,
  })
  const pool: Mesh[] = []

  return {
    group,
    update(next, frame) {
      group.visible = !next.options.hidden
      if (!group.visible) return

      const from = frame.anchorCamera(next.options.anchorId, next.options.visionCameraIndex)
        ?? frame.anchorPose(next.options.anchorId)
      const targets = next.poses.slice(0, MAX_VISION_TARGETS)

      // Markers are created on demand and not destroyed: the number of marks
      // swings a lot (a camera sees three tags and one on the next frame), and
      // creating and throwing away meshes at that pace shows.
      while (pool.length < targets.length) {
        const marker = new Mesh(markerGeometry, markerMaterial)
        markers.add(marker)
        pool.push(marker)
      }
      pool.forEach((marker, index) => {
        const target = targets[index]
        marker.visible = target !== undefined
        if (target) marker.position.set(target.x, target.y, target.z)
      })

      const array = positions.array as Float32Array
      let written = 0
      if (from) {
        targets.forEach(target => {
          const base = written * 6
          array[base] = from.x
          array[base + 1] = from.y
          array[base + 2] = from.z
          array[base + 3] = target.x
          array[base + 4] = target.y
          array[base + 5] = target.z
          written++
        })
      }
      geometry.setDrawRange(0, written * 2)
      positions.needsUpdate = true
      lines.visible = written > 0
    },
    dispose() {
      markerGeometry.dispose()
      markerMaterial.dispose()
      disposeSceneTree(group)
    },
  }
}

// --- Piezas de juego ------------------------------------------------------------

/** Cap on pieces drawn at once. */
const MAX_GAME_PIECES = 128

function createGamePiece(object: RenderedField3dObject, ctx: VisualContext): ObjectVisual {
  const group = new Group()
  group.name = `gamePiece:${object.id}`

  const entry = ctx.gamePieces[object.options.gamePieceIndex]
  const pool: Object3D[] = []

  // The field's config says how the piece is exported; that rotation and that
  // offset are part of the model, not of the published pose.
  const zeroedRotation = composeRotations(entry?.config.rotations ?? [])
  const zeroedPosition = entry?.config.position ?? [0, 0, 0]

  // Without a model (schematic field, or a piece the asset does not carry) it
  // falls back to a sphere in the object's color: it is better to see WHERE the
  // piece is with the wrong shape than not to see it.
  const fallbackGeometry = new SphereGeometry(object.options.markerSize / 2, 14, 12)
  const fallbackMaterial = new MeshPhongMaterial({
    color: object.color, shininess: 10,
    transparent: object.options.opacity < 1, opacity: object.options.opacity,
  })

  const spawn = (): Object3D => {
    const pivot = new Group()
    if (entry?.asset) {
      const slot = makeZeroedSlot(zeroedPosition, zeroedRotation)
      const instance = instantiateAsset(entry.asset)
      tint(instance, null, object.options.opacity, ctx.quality)
      slot.add(instance)
      pivot.add(slot)
    } else {
      const mesh = new Mesh(fallbackGeometry, fallbackMaterial)
      mesh.castShadow = ctx.quality === "cinematic"
      pivot.add(mesh)
    }
    group.add(pivot)
    return pivot
  }

  return {
    group,
    update(next) {
      group.visible = !next.options.hidden
      if (!group.visible) return

      const poses = next.poses.slice(0, MAX_GAME_PIECES)
      while (pool.length < poses.length) pool.push(spawn())
      pool.forEach((pivot, index) => {
        const pose = poses[index]
        pivot.visible = pose !== undefined
        if (pose) applyPose(pivot, pose)
      })
    },
    dispose() {
      fallbackGeometry.dispose()
      fallbackMaterial.dispose()
      disposeSceneTree(group)
    },
  }
}

// --- Marcadores simples ----------------------------------------------------------

const MAX_MARKERS = 128

function createMarker(object: RenderedField3dObject, ctx: VisualContext): ObjectVisual {
  const group = new Group()
  group.name = `${object.type}:${object.id}`

  const size = object.options.markerSize
  const isAxes = object.type === "axes"

  const geometry = isAxes ? null : new ConeGeometry(size / 2, size * 1.6, 16)
  const material = isAxes ? null : new MeshPhongMaterial({
    color: object.color, shininess: 10,
    transparent: object.options.opacity < 1, opacity: object.options.opacity,
  })

  const pool: Object3D[] = []

  const spawn = (): Object3D => {
    const pivot = new Group()
    if (isAxes) {
      pivot.add(makeAxes(size * 2))
    } else {
      // The cone is drawn pointing UP and raised half its height: that way the
      // tip marks the point and the body is not buried in the carpet.
      const mesh = new Mesh(geometry!, material!)
      mesh.rotation.x = Math.PI / 2
      mesh.position.z = size * 0.8
      mesh.castShadow = ctx.quality === "cinematic"
      pivot.add(mesh)
    }
    group.add(pivot)
    return pivot
  }

  return {
    group,
    update(next) {
      group.visible = !next.options.hidden
      if (!group.visible) return

      const poses = next.poses.slice(0, MAX_MARKERS)
      while (pool.length < poses.length) pool.push(spawn())
      pool.forEach((pivot, index) => {
        const pose = poses[index]
        pivot.visible = pose !== undefined
        if (pose) applyPose(pivot, pose)
      })
    },
    dispose() {
      geometry?.dispose()
      material?.dispose()
      disposeSceneTree(group)
    },
  }
}

// --- Estelas ---------------------------------------------------------------------

/** A trail's point ceiling; above it the most recent ones are shown. */
const MAX_TRAIL_POINTS = 4000

interface TrailLine {
  line: Line
  positions: Float32BufferAttribute
  geometry: BufferGeometry
}

function makeTrailLine(color: string | null): TrailLine | null {
  if (color === null) return null

  const positions = new Float32BufferAttribute(new Float32Array(MAX_TRAIL_POINTS * 3), 3)
  positions.setUsage(DynamicDrawUsage)
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", positions)
  geometry.setDrawRange(0, 0)

  const line = new Line(geometry, new LineBasicMaterial({
    color, transparent: true, opacity: 0.75, depthWrite: false,
  }))
  line.renderOrder = 3
  return { line, positions, geometry }
}

function updateTrailLine(trail: TrailLine, samples: { x: number; y: number; z: number }[]) {
  const array = trail.positions.array as Float32Array
  const start = Math.max(0, samples.length - MAX_TRAIL_POINTS)
  const count = samples.length - start

  for (let i = 0; i < count; i++) {
    const sample = samples[start + i]
    array[i * 3] = sample.x
    array[i * 3 + 1] = sample.y
    // A hair above the carpet: at the same height the line disappears in
    // patches from z-fighting against the floor.
    array[i * 3 + 2] = sample.z + 0.02
  }

  trail.geometry.setDrawRange(0, count)
  trail.positions.needsUpdate = true
  trail.line.visible = count > 1
}

// --- Factory ----------------------------------------------------------------------

export function createObjectVisual(
  object: RenderedField3dObject,
  ctx: VisualContext,
): ObjectVisual {
  switch (object.type) {
    case "robot":
    case "ghost":
      return createRobot(object, ctx)
    case "component":
      return createComponents(object, ctx)
    case "trajectory":
      return createTrajectory(object, ctx)
    case "vision":
      return createVision(object)
    case "gamePiece":
      return createGamePiece(object, ctx)
    case "cone":
    case "axes":
      return createMarker(object, ctx)
  }
}

/**
 * Signature with everything that forces REBUILDING the object (and not just
 * moving it).
 *
 * Changing the color or the type changes meshes and materials; changing the
 * pose does not. Separating the two is what lets the scene touch only
 * matrices in 99 % of frames.
 */
export function visualSignature(object: RenderedField3dObject): string {
  const o = object.options
  return [
    object.id, object.type, object.color, object.label,
    o.opacity, o.showLabel, o.robotAssetKey ?? "", o.useModel,
    o.trajectoryStyle, o.trajectoryWidth, o.markerSize, o.gamePieceIndex,
    o.trailSeconds > 0,
  ].join("|")
}
