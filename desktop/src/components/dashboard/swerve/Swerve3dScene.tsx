// The swerve's 3D view: the same diagram as SwerveCanvas, but with volume and
// with the robot's real model on top.
//
// The robot does NOT translate: it stays at the origin and what moves is the
// floor, opposite to the chassis. That way the velocity shows without needing
// odometry or a field, which is exactly what calibrating modules needs.
//
// Everything is built with Z up, X forward and Y to the left (WPILib's frame):
// the module angles and the heading go in exactly as they come out of NT.

import { useEffect, useRef, useState } from "react"
import {
  Box3, BoxGeometry, ConeGeometry, CylinderGeometry, DoubleSide, EdgesGeometry, Group,
  LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  OrthographicCamera, PerspectiveCamera, Scene, TorusGeometry, WebGLRenderer,
} from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { Swerve3dModulePlacement, Swerve3dSettings, SwerveSettings } from "../../../store/appStore"
import { ChassisVelocities, ModuleState } from "../../../utils/field/swerveExtraction"
import {
  LoadedModel, instantiateModel, materialsOf, disposeInstance, DEFAULT_MODEL_COLOR,
} from "../../../utils/field/robotModel"
import {
  DEG, addStandardLights, arrowMaterial, disposeGroup, makeArrow, makeAxes, makeFloorGrid,
  makeOrbitControls, makeTextSprite, ratioColor, setArrowLength, setArrowOpacity,
} from "../three/sceneKit"
import { ModuleSet, ChassisSet } from "./SwerveCanvas"

export interface Swerve3dFrameData {
  moduleSets: ModuleSet[]
  chassisSets: ChassisSet[]
  /** The chassis' heading in radians. */
  rotation: number
  /** Velocity used for the ω arc and to move the floor. */
  velocity: ChassisVelocities | null
}

interface Props {
  data: Swerve3dFrameData
  settings: SwerveSettings
  view: Swerve3dSettings
  /** FL, FR, BL, BR already resolved (automatic or manual). */
  placements: Swerve3dModulePlacement[]
  /** Model already loaded, or null for the generic chassis. */
  model: LoadedModel | null
  /** Changes value when the page asks to go back to the default view. */
  resetCameraToken: number
}

const CORNER_LABELS = ["FL", "FR", "BL", "BR"]

const FLOOR_HALF = 14        // m; the floor is much bigger than what is visible
const FLOOR_CELL = 0.5       // m between grid lines
const OMEGA_SEGMENTS = 48    // segments of the ω arc (the first n are shown)
// --- This view's own pieces -------------------------------------------

// A wire box the declared size of the chassis: it is the reference to compare
// against whether the imported model ended up at scale.
function makeFrameBox(length: number, width: number, height: number): LineSegments {
  const box = new LineSegments(
    new EdgesGeometry(new BoxGeometry(length, width, height)),
    new LineBasicMaterial({ color: 0x3a3a42 }),
  )
  box.position.z = height / 2
  return box
}

// --- Scene structure ------------------------------------------------

interface ArrowVisual {
  setId: string
  /** Rotates by THIS set's deviation from the measured azimuth. */
  pivot: Group
  arrow: Group
  baseColor: string
  ghost: boolean
}

interface ModuleVisual {
  azimuth: Group
  ring: Mesh
  arrows: ArrowVisual[]
}

interface ChassisVisual {
  setId: string
  pivot: Group
  arrow: Group
}

interface Visuals {
  modules: ModuleVisual[]
  chassis: ChassisVisual[]
  omega: { group: Group; segments: Mesh[]; head: Group } | null
}

interface SceneCore {
  renderer: WebGLRenderer
  scene: Scene
  camera: PerspectiveCamera | OrthographicCamera
  controls: OrbitControls
  robotGroup: Group
  modelSlot: Group
  contents: Group
  floorGroup: Group
  floorInner: Group
  visuals: Visuals | null
  offset: { x: number; y: number }
  lastTime: number
}

export default function Swerve3dScene({
  data, settings, view, placements, model, resetCameraToken,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  // The data arrives at ~30 Hz through props, but the scene redraws at 60 fps
  // (the camera and the floor move on their own). That is why the frame loop reads
  // from refs and not from the props: that way the loop need not be recreated on
  // every sample.
  const dataRef = useRef(data)
  dataRef.current = data
  const configRef = useRef({ settings, view, placements })
  configRef.current = { settings, view, placements }

  const coreRef = useRef<SceneCore | null>(null)

  // The real height the model takes once scaled and rotated. The chassis arrow
  // and the ω arc are drawn ABOVE that: left at the chassis' height they would
  // be buried inside the robot's mesh.
  const [modelTop, setModelTop] = useState(0)

  // --- Setup: renderer, camera, lights, floor, loop --------------------------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0xe6e6ea, 1)
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    container.appendChild(renderer.domElement)

    const scene = new Scene()

    const camera = new PerspectiveCamera(45, 1, 0.05, 200)
    // Z up: without this the orbit would turn about the wrong axis and the robot
    // would be seen lying down.
    camera.up.set(0, 0, 1)
    camera.position.set(-1.8, -1.8, 1.4)

    const controls = makeOrbitControls(camera, renderer.domElement, { minDistance: 0.4, maxDistance: 25 })
    controls.target.set(0, 0, 0.2)
    controls.update()

    addStandardLights(scene)

    const floorGroup = new Group()
    const floorInner = new Group()
    floorInner.add(makeFloorGrid(FLOOR_HALF, FLOOR_CELL))
    floorGroup.add(floorInner)
    scene.add(floorGroup)

    const robotGroup = new Group()
    const modelSlot = new Group()
    const contents = new Group()
    robotGroup.add(modelSlot, contents)
    scene.add(robotGroup)

    const core: SceneCore = {
      renderer, scene, camera, controls, robotGroup, modelSlot, contents,
      floorGroup, floorInner, visuals: null,
      offset: { x: 0, y: 0 }, lastTime: performance.now(),
    }
    coreRef.current = core

    const resize = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      if (width === 0 || height === 0) return
      core.renderer.setSize(width, height, false)
      const cam = core.camera
      if (cam instanceof PerspectiveCamera) {
        cam.aspect = width / height
      } else {
        // In orthographic the framing is set by the height, not the distance.
        const halfWidth = cam.top * (width / height)
        cam.left = -halfWidth
        cam.right = halfWidth
      }
      cam.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      const now = performance.now()
      // The step is capped: coming back to the tab after a while would give a
      // huge dt and the floor would jump meters at once.
      const dt = Math.min((now - core.lastTime) / 1000, 0.1)
      core.lastTime = now

      updateScene(core, dataRef.current, configRef.current, dt)
      core.controls.update()
      core.renderer.render(core.scene, core.camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      core.controls.dispose()
      disposeGroup(core.contents)
      clearModelSlot(core.modelSlot)
      core.renderer.dispose()
      if (core.renderer.domElement.parentNode === container) {
        container.removeChild(core.renderer.domElement)
      }
      coreRef.current = null
    }
  }, [])

  // --- Projection: the camera is recreated because it changes class ----------------
  useEffect(() => {
    const core = coreRef.current
    const container = containerRef.current
    if (!core || !container) return
    const wantsOrtho = view.projection === "orthographic"
    if (wantsOrtho === (core.camera instanceof OrthographicCamera)) return

    const old = core.camera
    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
    const distance = old.position.distanceTo(core.controls.target)

    let camera: PerspectiveCamera | OrthographicCamera
    if (wantsOrtho) {
      // The height is chosen so the orthographic one starts out showing more or
      // less the same as the perspective was showing.
      const halfHeight = distance * Math.tan(22.5 * DEG)
      camera = new OrthographicCamera(
        -halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 0.05, 200,
      )
    } else {
      camera = new PerspectiveCamera(45, aspect, 0.05, 200)
    }
    camera.up.set(0, 0, 1)
    camera.position.copy(old.position)
    camera.updateProjectionMatrix()

    core.controls.dispose()
    const controls = makeOrbitControls(camera, core.renderer.domElement, { minDistance: 0.4, maxDistance: 25 })
    controls.target.copy(core.controls.target)
    controls.update()

    core.camera = camera
    core.controls = controls
  }, [view.projection])

  // --- Vista por defecto -----------------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    const reach = Math.max(settings.frameLength, settings.frameWidth) * 2.6 + 0.5
    core.camera.position.set(-reach * 0.72, -reach * 0.72, reach * 0.55)
    core.controls.target.set(0, 0, 0.15)
    core.controls.update()
    core.offset.x = 0
    core.offset.y = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetCameraToken])

  // --- Modelo del robot ------------------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return

    clearModelSlot(core.modelSlot)
    if (!model || !view.showModel) {
      setModelTop(0)
      return
    }

    const instance = instantiateModel(model, "base")
    const scale = view.modelAutoFit
      ? Math.max(settings.frameLength, settings.frameWidth) / Math.max(model.size.x, model.size.y, 1e-6)
      : view.modelScale
    instance.scale.setScalar(isFinite(scale) && scale > 0 ? scale : 1)

    materialsOf(instance).forEach(material => {
      const standard = material as MeshStandardMaterial
      if (view.modelColor) standard.color?.set(view.modelColor)
      else if (model.format === "stl") standard.color?.set(DEFAULT_MODEL_COLOR)
      standard.wireframe = view.modelWireframe
      standard.transparent = view.modelOpacity < 1
      standard.opacity = view.modelOpacity
      standard.depthWrite = view.modelOpacity >= 1
      standard.side = DoubleSide
      standard.needsUpdate = true
    })

    // The wrapper is what rotates: the model already comes centered in XY and
    // resting at z = 0, so the pivot is at the chassis' center, flush with the floor.
    const wrapper = new Group()
    wrapper.add(instance)
    wrapper.rotation.set(view.modelRotX * DEG, view.modelRotY * DEG, view.modelRotZ * DEG)
    wrapper.position.set(view.modelOffsetX, view.modelOffsetY, view.modelOffsetZ)
    core.modelSlot.add(wrapper)

    // Resting the base on the floor goes AFTER scaling and rotating: which face
    // is the bottom depends on the rotation it was given.
    wrapper.updateMatrixWorld(true)
    const box = new Box3().setFromObject(wrapper)
    if (view.modelDropToFloor && isFinite(box.min.z)) {
      wrapper.position.z += view.modelOffsetZ - box.min.z
      setModelTop(box.max.z - box.min.z + view.modelOffsetZ)
    } else {
      setModelTop(isFinite(box.max.z) ? box.max.z : 0)
    }
  }, [
    model, view.showModel, view.modelScale, view.modelAutoFit, view.modelColor,
    view.modelOpacity, view.modelWireframe, view.modelDropToFloor,
    view.modelRotX, view.modelRotY, view.modelRotZ,
    view.modelOffsetX, view.modelOffsetY, view.modelOffsetZ,
    settings.frameLength, settings.frameWidth,
  ])

  // --- Modules, chassis and ω arc ------------------------------------------
  // They are rebuilt when the configuration or the set of sources changes; the
  // values themselves are applied in the loop, which only touches transforms.
  const setSignature = data.moduleSets.map(s => `${s.id}:${s.color}:${s.role}`).join("|")
  const chassisSignature = data.chassisSets.map(s => `${s.id}:${s.color}`).join("|")
  const placementSignature = placements.map(p => `${p.x},${p.y},${p.z}`).join("|")
  const hasModel = model !== null && view.showModel

  useEffect(() => {
    const core = coreRef.current
    if (!core) return

    disposeGroup(core.contents)
    core.visuals = buildVisuals(core.contents, {
      settings, view, placements,
      moduleSets: dataRef.current.moduleSets,
      chassisSets: dataRef.current.chassisSets,
      hasModel, modelTop,
    })

    return () => {
      disposeGroup(core.contents)
      core.visuals = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    setSignature, chassisSignature, placementSignature, hasModel, modelTop,
    settings.frameLength, settings.frameWidth,
    view.showFrame, view.showModules, view.showVectors, view.showSetpoints,
    view.showChassisVector, view.showOmega, view.showLabels, view.showAxes,
    view.wheelRadius, view.wheelWidth, view.gradient,
  ])

  // --- Piso ------------------------------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    core.floorGroup.visible = view.showFloor
    if (!view.motionFloor) {
      core.offset.x = 0
      core.offset.y = 0
    }
  }, [view.showFloor, view.motionFloor])

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative", touchAction: "none" }}
    />
  )
}

// --- Construction ------------------------------------------------------------

function clearModelSlot(slot: Group) {
  slot.children.slice().forEach(child => {
    slot.remove(child)
    disposeInstance(child)
  })
}

function buildVisuals(
  root: Group,
  args: {
    settings: SwerveSettings
    view: Swerve3dSettings
    placements: Swerve3dModulePlacement[]
    moduleSets: ModuleSet[]
    chassisSets: ChassisSet[]
    hasModel: boolean
    /** Height of the model's highest point, so nothing is drawn inside it. */
    modelTop: number
  },
): Visuals {
  const { settings, view, placements, moduleSets, chassisSets, hasModel, modelTop } = args
  const frameHeight = Math.max(view.wheelRadius * 2 + 0.06, 0.12)
  // Height at which the chassis arrow and the ω arc float.
  const topHeight = Math.max(frameHeight, modelTop) + 0.07

  if (view.showFrame) {
    root.add(makeFrameBox(settings.frameLength, settings.frameWidth, frameHeight))
  }

  // With no imported model a generic chassis is drawn: the view has to be
  // useful as soon as the tab opens, not only after choosing a file.
  if (!hasModel) {
    const body = new Mesh(
      new BoxGeometry(settings.frameLength * 0.94, settings.frameWidth * 0.94, frameHeight * 0.8),
      new MeshStandardMaterial({
        color: 0xb9bcc4, metalness: 0.1, roughness: 0.7, transparent: true, opacity: 0.55,
      }),
    )
    body.position.z = frameHeight / 2
    root.add(body)

    // A wedge at the front, to know which way the robot faces without relying
    // on the axes.
    const nose = new Mesh(
      new ConeGeometry(settings.frameWidth * 0.13, settings.frameLength * 0.22, 4).rotateZ(-Math.PI / 2),
      new MeshStandardMaterial({ color: 0xa83c3c, roughness: 0.6 }),
    )
    nose.position.set(settings.frameLength * 0.36, 0, frameHeight + 0.02)
    root.add(nose)
  }

  if (view.showAxes) root.add(makeAxes(Math.max(settings.frameLength, settings.frameWidth) * 0.8))

  const wheelGeometry = new CylinderGeometry(view.wheelRadius, view.wheelRadius, view.wheelWidth, 22)
  const ringGeometry = new TorusGeometry(view.wheelRadius * 1.6, view.wheelRadius * 0.1, 8, 30)

  const modules: ModuleVisual[] = []
  if (view.showModules) {
    placements.forEach((placement, index) => {
      const group = new Group()
      group.position.set(placement.x, placement.y, placement.z)

      const azimuth = new Group()
      group.add(azimuth)

      // The wheel is a cylinder with its axis on Y: that way it rolls towards +X
      // and rotating the `azimuth` group about Z points it at the module's azimuth.
      azimuth.add(new Mesh(wheelGeometry, new MeshStandardMaterial({
        color: 0x2f3038, metalness: 0.2, roughness: 0.75,
      })))

      // A ring on the floor around the module: it turns red when that module
      // goes over the maximum speed, just like the 2D canvas' circle.
      const ring = new Mesh(ringGeometry, new MeshBasicMaterial({ color: 0x6a6a72 }))
      ring.position.z = -placement.z + 0.004
      group.add(ring)

      const arrows: ArrowVisual[] = []
      if (view.showVectors) {
        moduleSets.forEach(set => {
          const ghost = set.role === "setpoint"
          if (ghost && !view.showSetpoints) return
          const pivot = new Group()
          const arrow = makeArrow(set.color, view.wheelRadius * (ghost ? 0.16 : 0.24))
          if (ghost) setArrowOpacity(arrow, 0.5)
          pivot.add(arrow)
          azimuth.add(pivot)
          arrows.push({ setId: set.id, pivot, arrow, baseColor: set.color, ghost })
        })
      }

      if (view.showLabels) {
        const label = makeTextSprite(CORNER_LABELS[index] ?? `M${index}`)
        label.position.set(0, 0, view.wheelRadius + 0.12)
        group.add(label)
      }

      root.add(group)
      modules.push({ azimuth, ring, arrows })
    })
  }

  const chassis: ChassisVisual[] = []
  if (view.showChassisVector) {
    chassisSets.forEach(set => {
      const pivot = new Group()
      pivot.position.z = topHeight
      const arrow = makeArrow(set.color, 0.016)
      pivot.add(arrow)
      root.add(pivot)
      chassis.push({ setId: set.id, pivot, arrow })
    })
  }

  let omega: Visuals["omega"] = null
  if (view.showOmega) {
    // The arc is built from fixed segments and the first n are shown: changing
    // `thetaLength` would force redoing the geometry every frame.
    const radius = Math.max(settings.frameLength, settings.frameWidth) * 0.75
    const step = (Math.PI * 2) / OMEGA_SEGMENTS
    const segmentGeometry = new TorusGeometry(radius, 0.008, 6, 6, step * 1.05)
    const material = new MeshBasicMaterial({ color: 0x7c3aed, side: DoubleSide })

    const group = new Group()
    group.position.z = topHeight + 0.04
    const segments: Mesh[] = []
    for (let i = 0; i < OMEGA_SEGMENTS; i++) {
      const segment = new Mesh(segmentGeometry, material)
      segment.rotation.z = i * step
      segment.visible = false
      group.add(segment)
      segments.push(segment)
    }

    // The tip goes tangent to the arc, which is the direction of rotation.
    const head = new Group()
    const cone = new Mesh(new ConeGeometry(0.024, 0.065, 12).rotateZ(-Math.PI / 2), material)
    cone.position.x = radius
    cone.rotation.z = Math.PI / 2
    head.add(cone)
    group.add(head)

    root.add(group)
    omega = { group, segments, head }
  }

  return { modules, chassis, omega }
}

// --- Per-frame update -------------------------------------------------

function updateScene(
  core: SceneCore,
  data: Swerve3dFrameData,
  config: { settings: SwerveSettings; view: Swerve3dSettings; placements: Swerve3dModulePlacement[] },
  dt: number,
) {
  const { settings, view } = config
  const heading = data.rotation

  // The robot turns with the gyro; with followHeading off it stays still and
  // what turns is the floor, which is the chassis-fixed view.
  core.robotGroup.rotation.z = view.followHeading ? heading : 0
  core.floorGroup.rotation.z = view.followHeading ? 0 : -heading

  if (view.motionFloor && data.velocity) {
    // The velocity comes in the robot's frame: to move the floor it has to be
    // taken to the field's frame.
    const cos = Math.cos(heading)
    const sin = Math.sin(heading)
    core.offset.x += (data.velocity.vx * cos - data.velocity.vy * sin) * dt
    core.offset.y += (data.velocity.vx * sin + data.velocity.vy * cos) * dt
    // It wraps per cell: the floor is finite and without this it would end up
    // leaving the frame after a few meters.
    core.offset.x %= FLOOR_CELL
    core.offset.y %= FLOOR_CELL
  }
  core.floorInner.position.set(-core.offset.x, -core.offset.y, 0)

  const visuals = core.visuals
  if (!visuals) return

  const maxSpeed = settings.maxSpeed > 0 ? settings.maxSpeed : 1
  // Length of the full-scale vector, in scene meters.
  const fullVector = Math.max(settings.frameLength, settings.frameWidth) * 0.85
  // The wheel's azimuth is set by the measured set; if there are only
  // commanded ones, the first one there is.
  const primary = data.moduleSets.find(s => s.role !== "setpoint") ?? data.moduleSets[0]

  visuals.modules.forEach((visual, index) => {
    const primaryState: ModuleState | undefined = primary?.values[index]
    if (primaryState) visual.azimuth.rotation.z = primaryState.angle

    const overSpeed = data.moduleSets.some(set => {
      const state = set.values[index]
      return state !== undefined && Math.abs(state.speed) > maxSpeed
    })
    ;(visual.ring.material as MeshBasicMaterial).color.set(overSpeed ? 0xc21c1c : 0x6a6a72)

    visual.arrows.forEach(entry => {
      const set = data.moduleSets.find(s => s.id === entry.setId)
      const state = set?.values[index]
      if (!state) {
        entry.arrow.visible = false
        return
      }

      // Each set has its own angle: that is why the arrow hangs from a pivot of
      // its own and not directly from the measured azimuth.
      const delta = primaryState ? state.angle - primaryState.angle : 0
      entry.pivot.rotation.z = state.speed < 0 ? delta + Math.PI : delta

      // It is allowed past 100% so saturation shows at a glance.
      const ratio = Math.abs(state.speed) / maxSpeed
      setArrowLength(entry.arrow, view.wheelRadius + Math.min(ratio, 1.35) * fullVector)
      const material = arrowMaterial(entry.arrow)
      if (view.gradient && !entry.ghost) material.color.copy(ratioColor(ratio))
      else material.color.set(entry.baseColor)
    })
  })

  visuals.chassis.forEach(entry => {
    const set = data.chassisSets.find(s => s.id === entry.setId)
    if (!set) {
      entry.arrow.visible = false
      return
    }
    entry.pivot.rotation.z = Math.atan2(set.value.vy, set.value.vx)
    setArrowLength(entry.arrow, Math.min(Math.hypot(set.value.vx, set.value.vy) / maxSpeed, 1.35) * fullVector)
  })

  if (visuals.omega) {
    const omega = data.velocity?.omega ?? 0
    const magnitude = Math.min(Math.abs(omega), Math.PI * 2)
    const count = Math.round((magnitude / (Math.PI * 2)) * OMEGA_SEGMENTS)
    visuals.omega.segments.forEach((segment, i) => { segment.visible = i < count })
    visuals.omega.head.visible = count > 0
    visuals.omega.head.rotation.z = (count / OMEGA_SEGMENTS) * Math.PI * 2
    // With a negative ω the whole arc is mirrored, which is the same as drawing
    // it clockwise.
    visuals.omega.group.scale.y = omega < 0 ? -1 : 1
  }
}
