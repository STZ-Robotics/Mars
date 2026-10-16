// The Field 3D's scene: the field, the camera and everything drawn on top.
//
// The world is Z UP, X towards the red alliance and Y to the left seen from
// blue, with the origin at the CENTER of the playing area. It is the field
// model's frame and the same one AdvantageScope uses, so the AprilTag and driver
// station positions each asset's config.json carries go in as is, without
// recomputing anything.
//
// The conversion from the frame the robot publishes in was already done by the
// page (`utils/field3d/frames.ts`): here all poses arrive ready to draw.
//
// The draw loop reads from REFS and not props: the data arrives at ~30 Hz but
// the scene redraws at 60 (the camera moves on its own, with damping), and
// recreating the loop on every sample would throw that work away.

import { useEffect, useRef } from "react"
import {
  BoxGeometry, Color, Group, HemisphereLight, Matrix4, Mesh, MeshBasicMaterial,
  MeshPhongMaterial, Object3D, PCFSoftShadowMap, PerspectiveCamera, PointLight,
  Quaternion, SRGBColorSpace, Scene, SpotLight, Vector3, WebGLRenderer,
} from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { Field3dSettings } from "../../../store/appStore"
import { FieldSize, Pose3D, composePose } from "../../../utils/field3d/frames"
import { FieldAssetConfig, composeRotations } from "../../../utils/field3d/assetConfig"
import { LoadedAsset, disposeSceneTree, instantiateAsset } from "../../../utils/field3d/assetModels"
import {
  DEFAULT_FIELD_SIZE, evergreenDriverStations, makeEvergreenField, makeFieldGrid,
} from "../../../utils/field3d/evergreen"
import { TrailStore } from "../../../utils/field3d/trails"
import { makeAxes, makeTextSprite } from "../three/sceneKit"
import {
  FrameContext, GamePieceEntry, ObjectVisual, RenderedField3dObject, RobotAssetEntry,
  VisualContext, applyPose, createObjectVisual, visualSignature,
} from "./objectVisuals"

interface Props {
  objects: RenderedField3dObject[]
  settings: Field3dSettings
  size: FieldSize
  /** The active field's config; null = the schematic one. */
  fieldConfig: FieldAssetConfig | null
  fieldAsset: LoadedAsset | null
  robotAssets: Map<string, RobotAssetEntry>
  gamePieces: GamePieceEntry[]
  /** Pieces with an active topic: their "factory" copies in the model are hidden. */
  activeGamePieces: Set<number>
  trails: TrailStore
  /** Changes value when the page asks to go back to the default view. */
  resetCameraToken: number
}

/**
 * Goes from WPILib's camera convention (+X forward, +Z up) to three's
 * (-Z forward, +Y up).
 *
 * Without this, a camera declared in the robot's asset would point at the
 * floor and be rotated 90°, which is the classic mistake when porting vision
 * poses.
 */
const CAMERA_FIX = new Quaternion().setFromRotationMatrix(
  new Matrix4().makeBasis(
    new Vector3(0, -1, 0),   // the camera's +X (right) = the robot's -Y
    new Vector3(0, 0, 1),    // the camera's +Y (up)    = the robot's +Z
    new Vector3(-1, 0, 0),   // the camera's +Z (back)  = the robot's -X
  ),
)

/** Meters per inch, to read the tag's size from its variant. */
const INCH = 0.0254

interface SceneCore {
  renderer: WebGLRenderer
  scene: Scene
  camera: PerspectiveCamera
  controls: OrbitControls
  /** Field + decorations; rebuilt when the asset changes. */
  fieldGroup: Group
  /** The list's objects. */
  objectGroup: Group
  visuals: Map<string, ObjectVisual>
  /** Model nodes that represent pieces already in place, by piece index. */
  staged: Map<number, { visible: boolean; nodes: Object3D[] }>
  lastFrame: number
}

export default function Field3dScene(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const coreRef = useRef<SceneCore | null>(null)

  const propsRef = useRef(props)
  propsRef.current = props

  // --- Setup: renderer, camera, lights, loop --------------------------------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" })
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    container.appendChild(renderer.domElement)

    // Without this the model's colors come out dull: three interprets the
    // material's color in linear space and it has to be converted to sRGB when
    // writing the framebuffer.
    renderer.outputColorSpace = SRGBColorSpace
    renderer.shadowMap.type = PCFSoftShadowMap

    const scene = new Scene()
    scene.background = new Color(0x222222)

    const camera = new PerspectiveCamera(50, 1, 0.05, 300)
    // Z up: without this the orbit would turn about the wrong axis and the field
    // would be seen edge-on.
    camera.up.set(0, 0, 1)
    camera.position.set(-10, -10, 7)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.minDistance = 1
    controls.maxDistance = 60
    // A little before the horizon: looking exactly edge-on reduces the field to
    // a line.
    controls.maxPolarAngle = Math.PI / 2 - 0.02
    controls.target.set(0, 0, 0)
    controls.update()

    const fieldGroup = new Group()
    fieldGroup.name = "field"
    const objectGroup = new Group()
    objectGroup.name = "objects"
    scene.add(fieldGroup, objectGroup)

    const core: SceneCore = {
      renderer, scene, camera, controls, fieldGroup, objectGroup,
      visuals: new Map(), staged: new Map(),
      lastFrame: 0,
    }
    coreRef.current = core

    const resize = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      if (width === 0 || height === 0) return
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    let frame = 0
    const animate = (time: number) => {
      frame = requestAnimationFrame(animate)

      // In low-power mode it draws at 30 fps: on a pit laptop off the charger,
      // half the frames is the difference between the app responding and not.
      const budget = propsRef.current.settings.quality === "lowPower" ? 33 : 0
      if (budget > 0 && time - core.lastFrame < budget) return
      core.lastFrame = time

      // `updateFrame` ends up calling `controls.update()` when the camera is
      // orbital. In the fixed views it is NOT called on purpose: OrbitControls
      // recomputes the position from its internal state on every update, even
      // with `enabled` false, and would overwrite the camera the scene just
      // placed.
      updateFrame(core, propsRef.current)
      core.renderer.render(core.scene, core.camera)
    }
    frame = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      core.controls.dispose()
      core.visuals.forEach(visual => visual.dispose())
      core.visuals.clear()
      clearFieldGroup(core)
      core.renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
      coreRef.current = null
    }
  }, [])

  // --- Render quality ------------------------------------------------------
  // Changes lights, shadows and resolution. It is separate from mounting because
  // it is changed live from the panel and recreating the renderer would lose the
  // camera.
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    applyQuality(core, props.settings.quality)
  }, [props.settings.quality])

  // --- Cancha -----------------------------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    buildField(core, props)
    return () => { if (coreRef.current) clearFieldGroup(coreRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.fieldAsset, props.fieldConfig, props.size.length, props.size.width,
    props.settings.showGrid, props.settings.gridCell, props.settings.showFieldAxes,
    props.settings.showAprilTags, props.settings.showAprilTagIds,
    props.settings.showDriverStations, props.settings.quality,
  ])

  // --- Objects ----------------------------------------------------------------
  // They are rebuilt only when something that alters meshes or materials
  // changes; the poses are applied in the loop, which only touches matrices.
  const signature = props.objects.map(visualSignature).join("~")

  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    syncVisuals(core, propsRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, props.robotAssets, props.gamePieces, props.settings.quality,
      props.settings.robotLength, props.settings.robotWidth, props.settings.robotHeight])

  // --- Vista por defecto -------------------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    resetCamera(core, propsRef.current.size)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.resetCameraToken, props.size.length])

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative", touchAction: "none" }}
    />
  )
}

// --- Calidad -------------------------------------------------------------------

function applyQuality(core: SceneCore, quality: Field3dSettings["quality"]) {
  const { renderer, scene } = core
  const cinematic = quality === "cinematic"

  // In low power it draws BELOW the screen's resolution. It is what really
  // shows: the rest of the savings (less geometric detail, no shadows) the
  // optimizer already applied when loading the model.
  renderer.setPixelRatio(quality === "lowPower" ? 0.75 : Math.min(window.devicePixelRatio || 1, 2))
  renderer.shadowMap.enabled = cinematic

  // The lights are rebuilt whole: they are a few objects and keeping their
  // intensities in sync with one `if` per light is more fragile.
  scene.children
    .filter(child => child.userData.isLight === true)
    .forEach(child => {
      scene.remove(child)
      ;(child as any).dispose?.()
    })

  const add = (light: any) => {
    light.userData.isLight = true
    scene.add(light)
  }

  // The hemisphere light does almost all the work outside cinematic: at
  // intensity 2 the field reads flat and clear, which is exactly what you want
  // for looking at data. Lowering it and compensating with directionals produces
  // those dark scenes with half the model in shadow where nothing can be seen.
  // In cinematic the ambient bounce goes slightly warm with a darker ground: it
  // is what makes the mode read as a lit venue and not as the normal mode with
  // the brightness turned down.
  add(cinematic
    ? new HemisphereLight(0xfff4e8, 0x2b2b33, 0.5)
    : new HemisphereLight(0xffffff, 0x444444, 2))

  if (!cinematic) {
    // A single high light source to give the plane some relief.
    const point = new PointLight(0xffffff, 0.5)
    point.position.set(0, 0, 10)
    add(point)
    return
  }

  // In cinematic the venue's fixtures are imitated: four spotlights from above,
  // which are the ones that cast the shadows. The light is warm white and is NOT
  // tinted blue and red at the ends: that tint is AdvantageScope's visual
  // signature and, worse, it falsifies the color of the robot's materials, which
  // is exactly what you come to this tab to look at.
  // The volume comes from where each spotlight hits and how hard, not from color.
  const SPOTS: [number, number, number, number][] = [
    // x, y, z, intensity. Asymmetric on purpose: the spotlight on one side acts as
    // key and the opposite one as fill, which is what separates the robot's faces.
    // Four identical spotlights flatten the model as much as a single ambient one.
    [3, 7, 10, 200], [-3, -7, 10, 95], [8, -2, 10, 140], [-8, 2, 10, 120],
  ]
  SPOTS.forEach(([x, y, z, intensity]) => {
    const spot = new SpotLight(0xfff3e2, intensity, 0, 50 * (Math.PI / 180), 0.25, 2)
    spot.position.set(x, y, z)
    spot.target.position.set(0, 0, 0)
    spot.castShadow = true
    spot.shadow.mapSize.set(2048, 2048)
    // Without this the carpet fills up with the classic self-shadowing speckle.
    spot.shadow.bias = -0.0001
    add(spot)
    add(spot.target)
  })

  // Two low grazing lights at the ends, in very soft cool white. They play the
  // role the alliance lights used to — lifting the far walls and the robot's
  // outline off the black background as the camera turns — but without painting
  // anything: the contrast comes from the angle and the falloff, not the hue.
  ;[-4.6, 4.6].forEach(x => {
    const rim = new PointLight(0xe6edf7, 22, 13, 2)
    rim.position.set(x, 0, 2.6)
    add(rim)
  })
}

// --- Cancha ---------------------------------------------------------------------

function clearFieldGroup(core: SceneCore) {
  core.fieldGroup.children.slice().forEach(child => {
    core.fieldGroup.remove(child)
    // `disposeSceneTree` respects what is borrowed: an asset instance's geometry
    // is shared by all the copies and the loader's cache, and releasing it would
    // leave the field black the next time the tab is opened.
    disposeSceneTree(child)
  })
  core.staged.clear()
}

function buildField(core: SceneCore, props: Props) {
  clearFieldGroup(core)
  const { fieldAsset, fieldConfig, settings, size } = props

  if (fieldAsset && fieldConfig) {
    // The model is loaded raw; the rotations that bring it to the Z-up frame are
    // declared by its config (normally a +90° about X, which is what separates
    // glTF's Y-up convention from WPILib's Z-up).
    const rotation = composeRotations(fieldConfig.rotations)
    const holder = new Group()
    holder.quaternion.set(rotation[1], rotation[2], rotation[3], rotation[0])
    holder.add(instantiateAsset(fieldAsset))
    // The shadow flags were already set by the optimizer when loading the model,
    // which is what knows which mesh is the carpet and which one a pane of glass.
    core.fieldGroup.add(holder)

    // The pieces the model carries already in place are indexed by piece so they
    // can be turned off when the robot publishes its topic.
    // The nodes are looked up on the freshly attached COPY and not on the cached
    // original: turning off the original would affect any other Field 3D tab open
    // on the same field.
    fieldConfig.gamePieces.forEach((piece, index) => {
      const wanted = new Set(piece.stagedObjects)
      const nodes: Object3D[] = []
      holder.traverse(child => { if (wanted.has(child.name)) nodes.push(child) })
      core.staged.set(index, { visible: true, nodes })
    })
  } else {
    core.fieldGroup.add(makeEvergreenField(size))
  }

  if (settings.showGrid) core.fieldGroup.add(makeFieldGrid(size, settings.gridCell))

  if (settings.showFieldAxes) {
    // The axes go at the ROBOT's coordinate origin (the blue corner in the
    // classic system), not at the center: it is where you expect to see (0,0)
    // when comparing with the numbers the code prints.
    const axes = makeAxes(1.2)
    axes.position.set(-size.length / 2, -size.width / 2, 0.01)
    core.fieldGroup.add(axes)
  }

  if (settings.showAprilTags && fieldConfig) {
    core.fieldGroup.add(makeAprilTags(fieldConfig, settings.showAprilTagIds))
  }

  if (settings.showDriverStations) {
    const stations = fieldConfig?.driverStations.length
      ? fieldConfig.driverStations
      : evergreenDriverStations(size)
    core.fieldGroup.add(makeDriverStationMarkers(stations))
  }
}

/** The tag's physical size, read from its variant ("36h11-6.5in" -> 0.165 m). */
function tagSize(variant: string): number {
  const match = /(\d+(?:\.\d+)?)in/.exec(variant)
  return match ? Number(match[1]) * INCH : 6.5 * INCH
}

function makeAprilTags(config: FieldAssetConfig, withIds: boolean): Group {
  const group = new Group()
  group.name = "apriltags"

  // One material shared by every tag: there are 32 on the 2026 field and each
  // with its own material would be 32 shader programs for nothing.
  const faceMaterial = new MeshBasicMaterial({ color: 0x101014 })
  const borderMaterial = new MeshBasicMaterial({ color: 0xf5f5f8 })

  // A field uses a single tag size, so the geometry is shared per side instead
  // of creating 64 identical boxes.
  const geometries = new Map<number, { face: BoxGeometry; border: BoxGeometry }>()
  const geometryFor = (side: number) => {
    let hit = geometries.get(side)
    if (!hit) {
      // The tag faces +X in WPILib's frame, so the plate is thin in X and
      // square in Y/Z.
      hit = {
        face: new BoxGeometry(0.008, side, side),
        border: new BoxGeometry(0.006, side * 1.25, side * 1.25),
      }
      geometries.set(side, hit)
    }
    return hit
  }

  config.aprilTags.forEach(tag => {
    const side = tagSize(tag.variant)
    const pivot = new Group()
    pivot.position.set(tag.position[0], tag.position[1], tag.position[2])
    const rotation = composeRotations(tag.rotations)
    pivot.quaternion.set(rotation[1], rotation[2], rotation[3], rotation[0])

    const shared = geometryFor(side)
    pivot.add(new Mesh(shared.border, borderMaterial), new Mesh(shared.face, faceMaterial))

    if (withIds) {
      const label = makeTextSprite(String(tag.id), { height: side * 0.7 })
      label.position.set(0.02, 0, 0)
      pivot.add(label)
    }

    group.add(pivot)
  })

  return group
}

function makeDriverStationMarkers(stations: [number, number][]): Group {
  const group = new Group()
  group.name = "driver-stations"

  stations.forEach((station, index) => {
    // The first three are blue and the next three red, which is the order
    // AdvantageScope's config lists them in.
    const color = index < stations.length / 2 ? 0x2f6fdb : 0xd63b3b
    const marker = new Mesh(
      new BoxGeometry(0.35, 0.9, 0.05),
      new MeshPhongMaterial({ color, shininess: 0, transparent: true, opacity: 0.8 }),
    )
    marker.position.set(station[0], station[1], 0.03)
    group.add(marker)

    const label = makeTextSprite(`DS${index + 1}`, { height: 0.28 })
    label.position.set(station[0], station[1], 0.5)
    group.add(label)
  })

  return group
}

// --- Objetos ---------------------------------------------------------------------

function syncVisuals(core: SceneCore, props: Props) {
  const ctx: VisualContext = {
    settings: props.settings,
    quality: props.settings.quality,
    robotAssets: props.robotAssets,
    gamePieces: props.gamePieces,
  }

  const alive = new Set(props.objects.map(o => o.id))
  core.visuals.forEach((visual, id) => {
    if (alive.has(id)) return
    core.objectGroup.remove(visual.group)
    visual.dispose()
    core.visuals.delete(id)
  })

  // Everything is rebuilt at once: the signature that fires this effect already
  // gathered the changes of ALL the objects, and telling which one changed would
  // mean storing each one's signature to gain a few milliseconds nobody sees.
  props.objects.forEach(object => {
    const existing = core.visuals.get(object.id)
    if (existing) {
      core.objectGroup.remove(existing.group)
      existing.dispose()
    }
    const visual = createObjectVisual(object, ctx)
    core.objectGroup.add(visual.group)
    core.visuals.set(object.id, visual)
  })

  props.trails.prune(alive)
}

// --- Frame -----------------------------------------------------------------------

function updateFrame(core: SceneCore, props: Props) {
  const now = Date.now()

  // The `robot` objects' poses are resolved first: components and vision marks
  // hang from them, and in the same frame they have to see THIS frame's pose,
  // not the previous one's.
  const robotPoses = new Map<string, Pose3D>()
  props.objects.forEach(object => {
    if (object.type !== "robot" && object.type !== "ghost") return
    const pose = object.poses[0]
    if (pose) robotPoses.set(object.id, pose)
  })

  // The "main robot" is the first one of type `robot` that has a pose. It is
  // what the robot-following camera and the objects with no explicit anchor aim at.
  const primaryId = props.objects.find(o => o.type === "robot" && robotPoses.has(o.id))?.id ?? null
  const primaryPose = primaryId === null ? null : robotPoses.get(primaryId) ?? null

  const anchorPose = (anchorId: string | null): Pose3D | null => {
    if (anchorId !== null) return robotPoses.get(anchorId) ?? null
    // With no explicit anchor the first robot in the list is used: it is what
    // someone means when they drop a components topic and touch nothing else.
    return primaryPose
  }

  // Which asset an anchored object uses: its own if it set one, otherwise the
  // tab's default. The robot's camera and its field of view have to resolve it
  // the same way, or the framing would come from one asset and the lens from
  // another.
  const assetKeyOf = (anchorId: string | null): string | null => {
    const object = props.objects.find(o => o.id === (anchorId ?? primaryId))
    return object?.options.robotAssetKey ?? props.settings.robotAssetKey
  }

  const anchorCamera = (anchorId: string | null, cameraIndex: number): Pose3D | null => {
    const pose = anchorPose(anchorId)
    if (pose === null || cameraIndex < 0) return pose
    const key = assetKeyOf(anchorId)
    const camera = key ? props.robotAssets.get(key)?.config.cameras[cameraIndex] : undefined
    if (!camera) return pose
    const rotation = composeRotations(camera.rotations)
    return composePose(pose, {
      x: camera.position[0], y: camera.position[1], z: camera.position[2],
      qw: rotation[0], qx: rotation[1], qy: rotation[2], qz: rotation[3],
    })
  }

  const frame: FrameContext = { now, trails: props.trails, anchorPose, anchorCamera }

  props.objects.forEach(object => {
    core.visuals.get(object.id)?.update(object, frame)
  })

  // The pieces the model carries in place are turned off as soon as the robot
  // publishes that piece type: otherwise each one would be seen twice, the real
  // one and the one painted on the field.
  core.staged.forEach((entry, index) => {
    const visible = props.settings.showStagedPieces && !props.activeGamePieces.has(index)
    if (entry.visible === visible) return
    entry.visible = visible
    entry.nodes.forEach(node => { node.visible = visible })
  })

  updateCamera(core, props, primaryPose, anchorCamera, assetKeyOf(null))
}

// --- Camera -----------------------------------------------------------------------

function resetCamera(core: SceneCore, size: FieldSize) {
  // Three quarters from the blue corner: it is the framing in which the whole
  // field is seen and depth is still understood.
  const reach = Math.max(size.length, DEFAULT_FIELD_SIZE.length)
  core.camera.position.set(-reach * 0.62, -reach * 0.5, reach * 0.42)
  core.controls.target.set(0, 0, 0)
  core.controls.update()
}

function updateCamera(
  core: SceneCore,
  props: Props,
  robotPose: Pose3D | null,
  anchorCamera: (anchorId: string | null, cameraIndex: number) => Pose3D | null,
  /** The main robot's asset, which the lens comes from in the camera view. */
  robotAssetKey: string | null,
) {
  const { settings, size } = props
  const camera = core.camera

  const fov = settings.cameraMode === "robotCamera"
    ? robotCameraFov(props, robotAssetKey)
    : settings.fov
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov
    camera.updateProjectionMatrix()
  }

  switch (settings.cameraMode) {
    case "orbit":
      core.controls.enabled = true
      core.controls.update()
      return

    case "orbitRobot": {
      // The orbit follows the robot but does NOT turn with it: the camera stays
      // where the user left it and the robot moves underneath. Turning with the
      // heading is dizzying and makes it impossible to read where it is going.
      core.controls.enabled = true
      if (robotPose) {
        const dx = robotPose.x - core.controls.target.x
        const dy = robotPose.y - core.controls.target.y
        const dz = robotPose.z - core.controls.target.z
        core.controls.target.set(robotPose.x, robotPose.y, robotPose.z)
        camera.position.x += dx
        camera.position.y += dy
        camera.position.z += dz
      }
      core.controls.update()
      return
    }

    case "driverStation": {
      core.controls.enabled = false
      const stations = props.fieldConfig?.driverStations.length
        ? props.fieldConfig.driverStations
        : evergreenDriverStations(size)
      const station = stations[Math.min(settings.driverStationIndex, stations.length - 1)]
      if (!station) return
      // A meter behind the wall and at eye height: it is what the driver sees,
      // which is the point of this view.
      const outward = Math.sign(station[0]) || 1
      camera.position.set(station[0] + outward * 1.1, station[1], 1.6)
      camera.lookAt(0, 0, 0.6)
      return
    }

    case "robotCamera": {
      core.controls.enabled = false
      const pose = anchorCamera(null, settings.robotCameraIndex)
      if (!pose) return
      applyPose(camera, pose)
      // three's camera looks towards -Z; the robot's, towards +X.
      camera.quaternion.multiply(CAMERA_FIX)
      return
    }
  }
}

/**
 * VERTICAL FOV of the chosen robot camera.
 *
 * The config declares the HORIZONTAL one, which is how camera makers publish
 * it; three wants the vertical one, and the conversion depends on the sensor's
 * real aspect, not the window's.
 */
function robotCameraFov(props: Props, robotAssetKey: string | null): number {
  const camera = robotAssetKey
    ? props.robotAssets.get(robotAssetKey)?.config.cameras[props.settings.robotCameraIndex]
    : undefined
  if (!camera) return props.settings.fov

  const aspect = camera.resolution[0] / Math.max(camera.resolution[1], 1)
  const horizontal = (camera.fov * Math.PI) / 180
  const vertical = 2 * Math.atan(Math.tan(horizontal / 2) / Math.max(aspect, 1e-3))
  return Math.min(Math.max((vertical * 180) / Math.PI, 5), 160)
}
