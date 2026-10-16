// The Mechanism 3D's scene.
//
// The mechanism is a tree. Each part builds this chain of groups:
//
//   originGroup   FIXED placement relative to the parent (origin + originRotation)
//     └ pivotOut  +pivot   ─┐ together they make the rotation happen about the
//         └ jointGroup      │  pivot and not the origin: at rest they cancel,
//             └ pivotIn  -pivot  so moving the pivot does NOT move the part.
//                 ├ modelSlot   the STL/GLB or the primitive
//                 └ each child's originGroup…
//
// The joint indicators (the revolute's ring, the prismatic's rail) hang from
// originGroup, not from the joint: they mark where the axis goes through, so
// they have to stay still while the part moves.
//
// The tree is only rebuilt when the structure or the appearance changes; the
// values are applied in the frame loop touching only transforms, which is
// cheap.

import { useEffect, useRef } from "react"
import {
  BoxGeometry, BoxHelper, CircleGeometry, Color, ConeGeometry, CylinderGeometry,
  DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D,
  OrthographicCamera, PerspectiveCamera, Quaternion, Raycaster, Scene, SphereGeometry,
  Sprite, TorusGeometry, Vector2, Vector3, WebGLRenderer,
} from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js"
import { Mechanism3dPart, Mechanism3dRoutine, Mechanism3dSettings } from "../../../store/appStore"
import {
  LoadedModel, instantiateModel, materialsOf, disposeInstance,
} from "../../../utils/field/robotModel"
import {
  buildPartTree, evaluateRoutine, jointTransform, jointTransformFromValue, jointValue,
  normalizeAxis, PartNode, routineDuration, sweepRange, travelRange, unitScale,
} from "../../../utils/mechanism/mechanism3d"
import {
  DEG, addStandardLights, disposeGroup, makeAxes, makeFloorGrid, makeOrbitControls,
  makeTextSprite,
} from "../three/sceneKit"

interface Props {
  parts: Mechanism3dPart[]
  settings: Mechanism3dSettings
  /** Already loaded models, indexed by path. */
  models: Map<string, LoadedModel>
  /** The last value of each topic that drives some joint. */
  values: Record<string, any>
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Called on RELEASING the gizmo, with the fields it changed. */
  onCommit: (id: string, updates: Partial<Mechanism3dPart>) => void
  resetCameraToken: number

  // --- Routine playback ---
  /** The chosen routine, or null if there is none. */
  routine: Mechanism3dRoutine | null
  /** The routine wins over the topics and over the manual value. */
  routineActive: boolean
  /** Advances the clock. Paused, it keeps showing the current pose. */
  routinePlaying: boolean
  routineSpeed: number
  /** Changes value to send the clock back to zero. */
  routineSeekToken: number
  /**
   * Progress, ~10 times per second. It goes as a callback and not as React
   * state on purpose: the clock runs at 60 fps and re-rendering the page at
   * that pace would remount the whole panels on every frame.
   */
  onRoutineTick?: (timeMs: number, fraction: number) => void
}

const FLOOR_HALF = 6
const SELECTION_COLOR = 0x4a5fd9
const PRIMITIVE_COLOR = 0x9aa0ad
const PIVOT_COLOR = 0xd97706

// Purple = rotates, teal = slides. The same code as the tree's badge.
const REVOLUTE_COLOR = 0x7c3aed
const PRISMATIC_COLOR = 0x0e9aa7

const SWEEP_SEGMENTS = 60
const JOINT_RADIUS = 0.09      // m, before multiplying by settings.jointScale

const THEME = {
  light: { clear: 0xe6e6ea, grid: 0x9a9aa2, label: "#1c1c1f", labelBg: "rgba(255,255,255,0.85)" },
  dark: { clear: 0x1b1b20, grid: 0x50505a, label: "#f2f2f5", labelBg: "rgba(20,20,24,0.8)" },
}

/** What the frame loop needs to move in a joint's indicator. */
interface JointVisual {
  kind: "revolute" | "prismatic"
  /** Segments of the sweep arc; the first n are shown. */
  sweep: Group | null
  segments: Mesh[]
  /** The tip that runs along the ring or the rail. */
  head: Object3D | null
  /** The rail's ends, in meters, so nothing is drawn outside it. */
  travel: { min: number; max: number }
}

interface PartVisual {
  id: string
  originGroup: Group
  jointGroup: Group
  pivotMarker: Object3D | null
  joint: JointVisual | null
}

interface SceneCore {
  renderer: WebGLRenderer
  scene: Scene
  camera: PerspectiveCamera | OrthographicCamera
  controls: OrbitControls
  /** The mechanism's root; emptied and rebuilt on every rebuild. */
  root: Group
  floor: Group
  transform: TransformControls | null
  selectionBox: BoxHelper | null
  visuals: Map<string, PartVisual>
  raycaster: Raycaster
  pointer: Vector2
  /** The routine's clock, in ms. */
  routineClock: number
  lastFrame: number
  lastTick: number
}

export default function Mechanism3dScene({
  parts, settings, models, values, selectedId, onSelect, onCommit, resetCameraToken,
  routine, routineActive, routinePlaying, routineSpeed, routineSeekToken, onRoutineTick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const coreRef = useRef<SceneCore | null>(null)

  // The loop runs at 60 fps and the data arrives at ~30 Hz: it reads from refs
  // so it does not have to be recreated on every sample.
  const liveRef = useRef({ parts, settings, values, routine, routineActive, routinePlaying, routineSpeed })
  liveRef.current = { parts, settings, values, routine, routineActive, routinePlaying, routineSpeed }
  const tickRef = useRef(onRoutineTick)
  tickRef.current = onRoutineTick
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  // --- Montaje ---------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    container.appendChild(renderer.domElement)

    const scene = new Scene()
    const camera = new PerspectiveCamera(45, 1, 0.02, 200)
    camera.up.set(0, 0, 1)
    camera.position.set(-1.2, -1.2, 0.9)

    const controls = makeOrbitControls(camera, renderer.domElement, { minDistance: 0.1, maxDistance: 30 })
    controls.target.set(0, 0, 0.3)
    controls.update()

    addStandardLights(scene)

    const floor = new Group()
    scene.add(floor)
    const root = new Group()
    scene.add(root)

    const core: SceneCore = {
      renderer, scene, camera, controls, root, floor,
      transform: null, selectionBox: null,
      visuals: new Map(),
      raycaster: new Raycaster(),
      pointer: new Vector2(),
      routineClock: 0,
      lastFrame: performance.now(),
      lastTick: 0,
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
        const halfWidth = cam.top * (width / height)
        cam.left = -halfWidth
        cam.right = halfWidth
      }
      cam.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    // --- Click selection ---
    // A click is told apart from a camera drag by the distance traveled: without
    // this, orbiting would select a random part on release.
    let downAt: { x: number; y: number } | null = null
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      downAt = { x: event.clientX, y: event.clientY }
    }
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0 || !downAt) return
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y)
      downAt = null
      if (moved > 4) return
      if (core.transform?.dragging) return   // the click belongs to the gizmo

      const rect = core.renderer.domElement.getBoundingClientRect()
      core.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      core.raycaster.setFromCamera(core.pointer, core.camera)
      const hits = core.raycaster.intersectObject(core.root, true)
      const hit = hits.find(h => (h.object as Sprite).isSprite !== true)
      selectRef.current(hit ? findPartId(hit.object) : null)
    }
    renderer.domElement.addEventListener("pointerdown", onPointerDown)
    renderer.domElement.addEventListener("pointerup", onPointerUp)

    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)

      const now = performance.now()
      // The step is capped: coming back to the tab after a while would give a
      // huge dt and the routine would jump several seconds at once.
      const dt = Math.min(now - core.lastFrame, 100)
      core.lastFrame = now

      updateFrame(core, liveRef.current, dt, tickRef.current, now)
      core.selectionBox?.update()
      core.controls.update()
      core.renderer.render(core.scene, core.camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.domElement.removeEventListener("pointerdown", onPointerDown)
      renderer.domElement.removeEventListener("pointerup", onPointerUp)
      core.transform?.detach()
      core.transform?.dispose()
      core.controls.dispose()
      clearTree(core.root)
      disposeGroup(core.floor)
      core.renderer.dispose()
      if (core.renderer.domElement.parentNode === container) {
        container.removeChild(core.renderer.domElement)
      }
      coreRef.current = null
    }
  }, [])

  // --- Floor, background and world axes ------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    const theme = THEME[settings.background]

    core.renderer.setClearColor(theme.clear, 1)
    disposeGroup(core.floor)
    if (settings.showFloor) core.floor.add(makeFloorGrid(FLOOR_HALF, settings.gridCell, theme.grid))
    if (settings.showWorldAxes) core.floor.add(makeAxes(0.35))
  }, [settings.showFloor, settings.gridCell, settings.showWorldAxes, settings.background])

  // --- Part tree --------------------------------------------------------
  // The signature leaves out each joint's manual value: it is the only field
  // edited by dragging, and rebuilding on every frame of the slider would make
  // the whole scene flicker.
  const structureSignature = JSON.stringify(parts.map(p => ({
    ...p,
    joint: { ...p.joint, manual: 0 },
  })))
  const modelsSignature = [...models.keys()].sort().join("|")

  useEffect(() => {
    const core = coreRef.current
    if (!core) return

    detachGizmo(core)
    clearTree(core.root)
    core.visuals.clear()

    const theme = THEME[settings.background]
    buildPartTree(parts).forEach(node => buildNode(node, core.root, core, models, settings, theme))

    return () => {
      detachGizmo(core)
      clearTree(core.root)
      core.visuals.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    structureSignature, modelsSignature,
    settings.showJointAxes, settings.showJointLimits, settings.jointScale,
    settings.showPartLabels, settings.background,
  ])

  // --- Selection: box and pivot marker -----------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return

    if (core.selectionBox) {
      core.scene.remove(core.selectionBox)
      core.selectionBox.geometry.dispose()
      core.selectionBox = null
    }

    // The pivot marker only shows on the selected part: one per part would be a
    // cloud of meaningless orange dots.
    core.visuals.forEach(visual => {
      if (visual.pivotMarker) visual.pivotMarker.visible = visual.id === selectedId
    })

    const visual = selectedId ? core.visuals.get(selectedId) : undefined
    if (visual && settings.showBounds) {
      const box = new BoxHelper(visual.jointGroup, new Color(SELECTION_COLOR))
      // Without this the box disappears when it lies right on the surface.
      box.material.depthTest = false
      box.renderOrder = 5
      core.scene.add(box)
      core.selectionBox = box
    }
  }, [selectedId, settings.showBounds, structureSignature, modelsSignature])

  // --- Gizmo ------------------------------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    detachGizmo(core)

    const part = parts.find(p => p.id === selectedId)
    const visual = selectedId ? core.visuals.get(selectedId) : undefined
    if (settings.gizmo === "off" || !part || !visual || part.locked) return

    // The "pivot" mode drags the orange marker, not the part: while dragging
    // only the marker moves, which is exactly what is being chosen (where the
    // axis will end up).
    const movingPivot = settings.gizmo === "pivot"
    const target = movingPivot ? visual.pivotMarker : visual.originGroup
    if (!target) return
    if (movingPivot) target.visible = true

    const transform = new TransformControls(core.camera, core.renderer.domElement)
    // `pivot` is a mode of ours, not TransformControls': underneath it is a
    // translate, the only difference is which object it attaches to.
    transform.setMode(movingPivot || settings.gizmo === "translate" ? "translate" : "rotate")
    transform.setSpace(movingPivot ? "local" : settings.gizmoSpace)
    transform.setTranslationSnap(settings.gizmoSnap ? 0.01 : null)
    transform.setRotationSnap(settings.gizmoSnap ? 5 * DEG : null)
    transform.attach(target)

    // Orbiting and dragging the gizmo at the same time would fight over the pointer.
    const onDragging = (event: { value: unknown }) => {
      core.controls.enabled = !event.value
      if (event.value) return

      // The commit goes on RELEASE: sending the state on every frame of the
      // drag would trigger a tree rebuild per mouse move.
      if (movingPivot) {
        commitRef.current(part.id, {
          pivot: [round(target.position.x), round(target.position.y), round(target.position.z)],
        })
        return
      }
      commitRef.current(part.id, {
        origin: [round(target.position.x), round(target.position.y), round(target.position.z)],
        originRotation: [
          round(target.rotation.x / DEG, 3),
          round(target.rotation.y / DEG, 3),
          round(target.rotation.z / DEG, 3),
        ],
      })
    }
    transform.addEventListener("dragging-changed", onDragging)

    core.scene.add(transform.getHelper())
    core.transform = transform

    return () => {
      transform.removeEventListener("dragging-changed", onDragging)
      detachGizmo(core)
      core.controls.enabled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedId, settings.gizmo, settings.gizmoSpace, settings.gizmoSnap,
    structureSignature, modelsSignature, settings.projection,
  ])

  // --- Projection --------------------------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    const container = containerRef.current
    if (!core || !container) return
    const wantsOrtho = settings.projection === "orthographic"
    if (wantsOrtho === (core.camera instanceof OrthographicCamera)) return

    const old = core.camera
    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
    const distance = old.position.distanceTo(core.controls.target)

    let camera: PerspectiveCamera | OrthographicCamera
    if (wantsOrtho) {
      const halfHeight = distance * Math.tan(22.5 * DEG)
      camera = new OrthographicCamera(
        -halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 0.02, 200,
      )
    } else {
      camera = new PerspectiveCamera(45, aspect, 0.02, 200)
    }
    camera.up.set(0, 0, 1)
    camera.position.copy(old.position)
    camera.updateProjectionMatrix()

    core.controls.dispose()
    const controls = makeOrbitControls(camera, core.renderer.domElement, { minDistance: 0.1, maxDistance: 30 })
    controls.target.copy(core.controls.target)
    controls.update()

    core.camera = camera
    core.controls = controls
  }, [settings.projection])

  // --- Rutina: volver al principio ----------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    core.routineClock = 0
    onRoutineTick?.(0, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineSeekToken])

  // --- Encuadre por defecto ----------------------------------------------------
  useEffect(() => {
    const core = coreRef.current
    if (!core) return
    core.camera.position.set(-1.1, -1.1, 0.8)
    core.controls.target.set(0, 0, 0.3)
    core.controls.update()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetCameraToken])

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative", touchAction: "none" }}
    />
  )
}

// --- Utilidades ------------------------------------------------------------------

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function detachGizmo(core: SceneCore) {
  if (!core.transform) return
  core.scene.remove(core.transform.getHelper())
  core.transform.detach()
  core.transform.dispose()
  core.transform = null
}

/** Empties the tree, releasing the instances' materials and the rest of the meshes. */
function clearTree(root: Group) {
  root.children.slice().forEach(child => {
    root.remove(child)
    child.traverse(node => {
      const mesh = node as Mesh
      if (!mesh.isMesh) return
      // Imported meshes share geometry with the cached model, so only what is
      // our own is discarded: their materials and the primitives.
      if (node.userData.imported) disposeInstance(node)
      else {
        mesh.geometry?.dispose()
        const material = (mesh as any).material
        if (Array.isArray(material)) material.forEach((m: any) => m?.dispose())
        else material?.dispose()
      }
    })
  })
}

/** Goes up through the parents until it finds which part the hit mesh belongs to. */
function findPartId(object: Object3D): string | null {
  let current: Object3D | null = object
  while (current) {
    if (typeof current.userData.partId === "string") return current.userData.partId
    current = current.parent
  }
  return null
}

// --- Building the tree --------------------------------------------------------

function buildNode(
  node: PartNode,
  parent: Group,
  core: SceneCore,
  models: Map<string, LoadedModel>,
  settings: Mechanism3dSettings,
  theme: typeof THEME["light"],
) {
  const part = node.part
  const [px, py, pz] = part.pivot

  const originGroup = new Group()
  originGroup.name = `origin:${part.id}`
  originGroup.position.set(part.origin[0], part.origin[1], part.origin[2])
  originGroup.rotation.set(
    part.originRotation[0] * DEG,
    part.originRotation[1] * DEG,
    part.originRotation[2] * DEG,
  )
  parent.add(originGroup)

  // pivotOut/pivotIn cancel out at rest: the pair is what moves the center of
  // rotation without moving the part from where it is.
  const pivotOut = new Group()
  pivotOut.position.set(px, py, pz)
  originGroup.add(pivotOut)

  const jointGroup = new Group()
  jointGroup.name = `joint:${part.id}`
  pivotOut.add(jointGroup)

  const pivotIn = new Group()
  pivotIn.position.set(-px, -py, -pz)
  // The id goes here and not on originGroup: the gizmo moves the origin, and if
  // the raycast returned that same object the helper would be selecting itself.
  pivotIn.userData.partId = part.id
  jointGroup.add(pivotIn)

  const modelSlot = new Group()
  modelSlot.visible = part.visible
  pivotIn.add(modelSlot)
  fillModelSlot(modelSlot, part, models)

  // The indicator marks where the axis goes through, so it goes in the FIXED frame.
  let joint: JointVisual | null = null
  if (settings.showJointAxes) {
    const built = buildJointIndicator(part, settings)
    if (built) {
      built.group.position.set(px, py, pz)
      built.group.userData.partId = part.id
      originGroup.add(built.group)
      joint = built.visual
    }
  }

  const pivotMarker = makePivotMarker(settings.jointScale)
  pivotMarker.position.set(px, py, pz)
  pivotMarker.visible = false
  pivotMarker.userData.partId = part.id
  originGroup.add(pivotMarker)

  if (settings.showPartLabels) {
    const label = makeTextSprite(part.name, {
      height: 0.06, color: theme.label, background: theme.labelBg,
    })
    label.position.set(0, 0, 0.08)
    pivotIn.add(label)
  }

  core.visuals.set(part.id, { id: part.id, originGroup, jointGroup, pivotMarker, joint })

  node.children.forEach(child => buildNode(child, pivotIn, core, models, settings, theme))
}

/** A little orange cross marking the selected part's center of rotation. */
function makePivotMarker(scale: number): Group {
  const size = 0.02 * scale
  const group = new Group()
  const material = new MeshBasicMaterial({ color: PIVOT_COLOR, depthTest: false })

  const ball = new Mesh(new SphereGeometry(size * 0.55, 14, 10), material)
  ball.renderOrder = 8
  group.add(ball)

  // Three short rods: a lone ball is hard to place in depth.
  const arms: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  arms.forEach(dir => {
    const arm = new Mesh(new CylinderGeometry(size * 0.12, size * 0.12, size * 3, 6), material)
    arm.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...dir))
    arm.renderOrder = 8
    group.add(arm)
  })
  return group
}

// --- Indicadores de junta -----------------------------------------------------------

/**
 * Ring (revolute) or rail (prismatic) on the joint's axis, with the traveled
 * portion highlighted. It is what in Onshape shows at a glance which joint is
 * which, which way it moves and how much travel it has left.
 */
function buildJointIndicator(
  part: Mechanism3dPart,
  settings: Mechanism3dSettings,
): { group: Group; visual: JointVisual } | null {
  const { joint } = part
  if (joint.type === "fixed") return null

  const group = new Group()

  // A pose has no axis: the frame it will take from the topic is marked.
  if (joint.type === "pose") {
    group.add(makeAxes(0.1 * settings.jointScale))
    return {
      group,
      visual: { kind: "revolute", sweep: null, segments: [], head: null, travel: { min: 0, max: 0 } },
    }
  }

  // The whole indicator is drawn with the axis on +Z and then oriented: it is
  // much simpler than building each piece on an arbitrary axis.
  const axis = normalizeAxis(joint.axis)
  group.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(axis[0], axis[1], axis[2]))

  const scale = settings.jointScale
  const rotational = joint.type !== "prismatic"
  const color = rotational ? REVOLUTE_COLOR : PRISMATIC_COLOR
  const trackMaterial = new MeshBasicMaterial({ color, transparent: true, opacity: 0.45 })
  const liveMaterial = new MeshBasicMaterial({ color, side: DoubleSide })

  if (rotational) {
    const radius = JOINT_RADIUS * scale
    const tube = radius * 0.035

    // Full ring: the "track" the sweep runs on.
    group.add(new Mesh(new TorusGeometry(radius, tube, 8, 64), trackMaterial))

    // The axis rod, which is what makes it obvious what it rotates about.
    const rod = new Mesh(
      new CylinderGeometry(tube * 0.8, tube * 0.8, radius * 2.6, 10).rotateX(Math.PI / 2),
      trackMaterial,
    )
    group.add(rod)

    // The limits' sector: it shows at once how much travel is left on each side.
    const range = settings.showJointLimits ? sweepRange(joint) : null
    if (range) {
      const sector = new Mesh(
        new CircleGeometry(radius * 0.94, 48, range.min, range.max - range.min),
        new MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: DoubleSide }),
      )
      group.add(sector)
      // Stops: two radial rods at the ends of the travel.
      ;[range.min, range.max].forEach(angle => {
        const stop = new Mesh(new BoxGeometry(radius * 0.9, tube * 1.6, tube * 1.6), trackMaterial)
        stop.position.set(Math.cos(angle) * radius * 0.45, Math.sin(angle) * radius * 0.45, 0)
        stop.rotation.z = angle
        group.add(stop)
      })
    }

    // The zero mark, to know where it is being measured from.
    const zero = new Mesh(new BoxGeometry(radius * 0.34, tube * 2.2, tube * 2.2), liveMaterial)
    zero.position.x = radius * 1.12
    group.add(zero)

    // Sweep: fixed segments of which the first n are shown. Changing
    // `thetaLength` would force redoing the geometry every frame.
    const sweep = new Group()
    const step = (Math.PI * 2) / SWEEP_SEGMENTS
    const segmentGeometry = new TorusGeometry(radius, tube * 2.1, 6, 6, step * 1.06)
    const segments: Mesh[] = []
    for (let i = 0; i < SWEEP_SEGMENTS; i++) {
      const segment = new Mesh(segmentGeometry, liveMaterial)
      segment.rotation.z = i * step
      segment.visible = false
      sweep.add(segment)
      segments.push(segment)
    }

    // A tip tangent to the ring: it marks where the part is right now.
    const head = new Group()
    const cone = new Mesh(new ConeGeometry(tube * 4, tube * 10, 12).rotateZ(-Math.PI / 2), liveMaterial)
    cone.position.x = radius
    cone.rotation.z = Math.PI / 2
    head.add(cone)
    sweep.add(head)
    group.add(sweep)

    return {
      group,
      visual: { kind: "revolute", sweep, segments, head, travel: { min: 0, max: 0 } },
    }
  }

  // --- Prismatic: a rail with stops and a cursor running along it ---
  const travel = travelRange(joint, 0.15 * scale)
  const span = Math.max(travel.max - travel.min, 1e-3)
  const tube = 0.006 * scale

  const rail = new Mesh(
    new CylinderGeometry(tube, tube, span, 10).rotateX(Math.PI / 2),
    trackMaterial,
  )
  rail.position.z = (travel.min + travel.max) / 2
  group.add(rail)

  // Stops at both ends of the travel.
  ;[travel.min, travel.max].forEach((z, i) => {
    const stop = new Mesh(new CylinderGeometry(tube * 3.4, tube * 3.4, tube * 1.4, 16).rotateX(Math.PI / 2), trackMaterial)
    stop.position.z = z
    group.add(stop)

    const arrow = new Mesh(new ConeGeometry(tube * 3, tube * 8, 12).rotateX(Math.PI / 2), trackMaterial)
    arrow.position.z = z + (i === 0 ? -tube * 5 : tube * 5)
    arrow.rotation.x = i === 0 ? Math.PI : 0
    group.add(arrow)
  })

  const head = new Mesh(new TorusGeometry(tube * 3.6, tube * 1.5, 8, 20), liveMaterial)
  group.add(head)

  return { group, visual: { kind: "prismatic", sweep: null, segments: [], head, travel } }
}

// --- Each part's model -----------------------------------------------------------

function fillModelSlot(slot: Group, part: Mechanism3dPart, models: Map<string, LoadedModel>) {
  const wrapper = new Group()
  wrapper.position.set(part.modelOffset[0], part.modelOffset[1], part.modelOffset[2])
  wrapper.rotation.set(
    part.modelRotation[0] * DEG,
    part.modelRotation[1] * DEG,
    part.modelRotation[2] * DEG,
  )
  slot.add(wrapper)

  const model = part.modelPath ? models.get(part.modelPath) : undefined
  if (model) {
    const instance = instantiateModel(model, part.modelAnchor)
    const largest = Math.max(model.size.x, model.size.y, model.size.z, 1e-6)
    const scale = part.modelAutoFit ? part.modelFitSize / largest : part.modelScale
    instance.scale.setScalar(isFinite(scale) && scale > 0 ? scale : 1)
    instance.traverse(node => { node.userData.imported = true })
    applyAppearance(instance, part, null)
    wrapper.add(instance)
    return
  }

  if (part.shape === "none") return
  const mesh = new Mesh(primitiveGeometry(part), new MeshStandardMaterial({
    color: PRIMITIVE_COLOR, metalness: 0.1, roughness: 0.7,
  }))
  applyAppearance(mesh, part, PRIMITIVE_COLOR)
  wrapper.add(mesh)
}

function primitiveGeometry(part: Mechanism3dPart) {
  const [a, b, c] = part.shapeSize.map(v => Math.max(Math.abs(v), 1e-4))
  switch (part.shape) {
    case "cylinder":
      // three's cylinder has its axis on Y; here everything is thought with Z up.
      return new CylinderGeometry(a, a, c, 24).rotateX(Math.PI / 2)
    case "sphere":
      return new SphereGeometry(a, 24, 16)
    default:
      return new BoxGeometry(a, b, c)
  }
}

function applyAppearance(object: Object3D, part: Mechanism3dPart, fallbackColor: number | null) {
  materialsOf(object).forEach(material => {
    const standard = material as MeshStandardMaterial
    if (part.color) standard.color?.set(part.color)
    else if (fallbackColor !== null) standard.color?.set(fallbackColor)
    standard.wireframe = part.wireframe
    standard.transparent = part.opacity < 1
    standard.opacity = part.opacity
    standard.depthWrite = part.opacity >= 1
    standard.needsUpdate = true
  })
}

// --- Per-frame update ----------------------------------------------------------

const tmpQuat = new Quaternion()

interface LiveState {
  parts: Mechanism3dPart[]
  settings: Mechanism3dSettings
  values: Record<string, any>
  routine: Mechanism3dRoutine | null
  routineActive: boolean
  routinePlaying: boolean
  routineSpeed: number
}

function updateFrame(
  core: SceneCore,
  live: LiveState,
  dt: number,
  onTick: ((timeMs: number, fraction: number) => void) | undefined,
  now: number,
) {
  // The routine, if active, wins over the topics and over the manual value.
  let routineValues: Record<string, number> | null = null
  if (live.routine && live.routineActive) {
    const duration = routineDuration(live.routine)

    if (live.routinePlaying && duration > 0) {
      core.routineClock += dt * live.routineSpeed
      if (core.routineClock > duration) {
        core.routineClock = live.routine.loop ? core.routineClock % duration : duration
      }
    }
    routineValues = evaluateRoutine(live.routine, core.routineClock)

    // Progress goes out at ~10 Hz: it is enough for a bar and avoids
    // re-rendering the page sixty times per second.
    if (onTick && now - core.lastTick > 100) {
      core.lastTick = now
      onTick(core.routineClock, duration > 0 ? core.routineClock / duration : 0)
    }
  } else if (core.routineClock !== 0 && !live.routineActive) {
    core.routineClock = 0
  }

  live.parts.forEach(part => {
    const visual = core.visuals.get(part.id)
    if (!visual) return

    const routineValue = routineValues?.[part.id]
    const liveValue = part.joint.topicName ? live.values[part.joint.topicName] : undefined
    const transform = routineValue !== undefined
      ? jointTransformFromValue(part.joint, routineValue)
      : jointTransform(part.joint, liveValue, live.settings.manualOverride)

    visual.jointGroup.position.set(transform.position[0], transform.position[1], transform.position[2])
    tmpQuat.set(transform.quaternion[0], transform.quaternion[1], transform.quaternion[2], transform.quaternion[3])
    visual.jointGroup.quaternion.copy(tmpQuat)

    if (!visual.joint || part.joint.type === "pose" || part.joint.type === "fixed") return
    const value = routineValue !== undefined
      ? routineValue
      : jointValue(part.joint, liveValue, live.settings.manualOverride)

    if (visual.joint.kind === "revolute" && visual.joint.sweep) {
      const angle = value * unitScale(part.joint.units, "angle")
      const magnitude = Math.min(Math.abs(angle), Math.PI * 2)
      const count = Math.round((magnitude / (Math.PI * 2)) * SWEEP_SEGMENTS)
      visual.joint.segments.forEach((segment, i) => { segment.visible = i < count })
      // With a negative angle the whole sweep is mirrored, which is the same as
      // drawing it clockwise.
      visual.joint.sweep.scale.y = angle < 0 ? -1 : 1
      if (visual.joint.head) {
        visual.joint.head.visible = count > 0
        visual.joint.head.rotation.z = (count / SWEEP_SEGMENTS) * Math.PI * 2
      }
      return
    }

    if (visual.joint.head) {
      const distance = value * unitScale(part.joint.units, "length")
      const { min, max } = visual.joint.travel
      visual.joint.head.position.z = Math.min(Math.max(distance, min), max)
    }
  })
}
