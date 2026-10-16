import { useEffect, useRef, useState } from "react"
import {
  Box3, BoxGeometry, CylinderGeometry, EdgesGeometry, Group, LineBasicMaterial, LineSegments,
  Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, SphereGeometry, Vector3, WebGLRenderer,
} from "three"
import { addStandardLights, makeAxes, makeFloorGrid, makeOrbitControls, DEG } from "@desktop/components/dashboard/three/sceneKit"
import { disposeInstance, instantiateModel, loadModel, LoadedModel } from "@desktop/utils/field/robotModel"
import type { ModelRef, RobotConfig } from "./types"

interface Props {
  robot: RobotConfig
  /** The model file on disk, already resolved; null shows the robot without it. */
  modelPath: string | null
  spinning: boolean
  /** Bumper, wheels and the center of mass drawn with the model. */
  showGuides: boolean
  onModelError: (message: string | null) => void
}

// Degrees per second of the idle spin, and how long after the user lets go of
// the view before it resumes.
const SPIN_DPS = 24
const RESUME_AFTER_MS = 2500
// FRC bumpers sit low; their exact zone does not matter for a guide.
const BUMPER_HEIGHT = 0.13

// The robot on a turntable, like an item in a game's inventory: it turns on
// its own, can be grabbed and orbited, and starts turning again when left
// alone. Everything is in WPILib's frame (Z up, X forward), the same one
// robot.json uses, so the guides are exactly where the planner thinks the
// bumper and the wheels are.
export default function RobotTurntable({ robot, modelPath, spinning, showGuides, onModelError }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const world = useRef<{
    scene: Scene
    turntable: Group
    guides: Group
    modelSlot: Group
    camera: PerspectiveCamera
  } | null>(null)
  const spinRef = useRef(spinning)
  spinRef.current = spinning
  const [loaded, setLoaded] = useState<LoadedModel | null>(null)

  // The scene, once.
  useEffect(() => {
    const el = host.current!
    const renderer = new WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)

    const scene = new Scene()
    addStandardLights(scene)
    scene.add(makeFloorGrid(3, 0.25))

    const camera = new PerspectiveCamera(35, 1, 0.02, 100)
    camera.up.set(0, 0, 1)
    camera.position.set(1.9, 1.5, 1.25)
    const controls = makeOrbitControls(camera, renderer.domElement, { minDistance: 0.4, maxDistance: 12 })
    controls.target.set(0, 0, 0.2)

    const turntable = new Group()
    const guides = new Group()
    const modelSlot = new Group()
    turntable.add(guides, modelSlot)
    scene.add(turntable)
    world.current = { scene, turntable, guides, modelSlot, camera }

    let lastTouch = -Infinity
    controls.addEventListener("start", () => { lastTouch = Infinity })
    controls.addEventListener("end", () => { lastTouch = performance.now() })

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()

    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      if (spinRef.current && now - lastTouch > RESUME_AFTER_MS) turntable.rotation.z += SPIN_DPS * DEG * dt
      controls.update()
      renderer.render(scene, camera)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
      world.current = null
    }
  }, [])

  // The file: loaded once per path (the loader caches).
  useEffect(() => {
    setLoaded(null)
    if (!modelPath) { onModelError(null); return }
    let alive = true
    loadModel(modelPath)
      .then(m => { if (alive) { setLoaded(m); onModelError(null) } })
      .catch((e: unknown) => { if (alive) onModelError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [modelPath])

  // The model, placed as robot.json says.
  const model = robot.model
  useEffect(() => {
    const w = world.current
    if (!w || !loaded || !model) return
    const instance = instantiateModel(loaded, "origin")
    placeModel(instance, model)
    w.modelSlot.add(instance)
    return () => {
      w.modelSlot.remove(instance)
      disposeInstance(instance)
    }
  }, [loaded, model?.scale, ...(model?.offsetM ?? []), ...(model?.rotationDeg ?? [])])

  // Bumper, wheels and center of mass.
  useEffect(() => {
    const w = world.current
    if (!w) return
    w.guides.clear()
    if (!showGuides) return
    w.guides.add(buildGuides(robot))
    return () => { w.guides.traverse(disposeMesh); w.guides.clear() }
  }, [showGuides, JSON.stringify(robot.bumper), JSON.stringify(robot.drivetrain.modules), robot.drivetrain.wheelRadiusM, robot.cogHeightM])

  return <div ref={host} style={{ position: "absolute", inset: 0 }} />
}

function placeModel(instance: Group, model: ModelRef) {
  const [r, p, y] = model.rotationDeg
  instance.rotation.set(r * DEG, p * DEG, y * DEG, "ZYX")
  instance.scale.setScalar(model.scale)
  instance.position.set(...model.offsetM)
}

/**
 * The offset that sits the model on the floor, centered on the robot, after
 * its scale and rotation: what "Auto place" writes into robot.json.
 */
export async function autoPlaceOffset(modelPath: string, model: ModelRef): Promise<[number, number, number]> {
  const loaded = await loadModel(modelPath)
  const instance = instantiateModel(loaded, "origin")
  placeModel(instance, { ...model, offsetM: [0, 0, 0] })
  instance.updateMatrixWorld(true)
  const box = new Box3().setFromObject(instance)
  disposeInstance(instance)
  const c = box.getCenter(new Vector3())
  const round = (v: number) => Number(v.toFixed(4))
  return [round(-c.x), round(-c.y), round(-box.min.z)]
}

function buildGuides(robot: RobotConfig): Group {
  const g = new Group()
  const { lengthM, widthM } = robot.bumper
  const bumper = new Mesh(
    new BoxGeometry(lengthM, widthM, BUMPER_HEIGHT),
    new MeshStandardMaterial({ color: 0xa83c3c, transparent: true, opacity: 0.12, depthWrite: false }),
  )
  bumper.position.z = BUMPER_HEIGHT / 2
  const outline = new LineSegments(
    new EdgesGeometry(bumper.geometry),
    new LineBasicMaterial({ color: 0xa83c3c }),
  )
  outline.position.copy(bumper.position)
  g.add(bumper, outline)

  // Front marker: the bumper's +X face, so "forward" is never ambiguous.
  const front = new Mesh(
    new BoxGeometry(0.02, widthM * 0.6, 0.02),
    new MeshStandardMaterial({ color: 0x2f6fdb }),
  )
  front.position.set(lengthM / 2 + 0.015, 0, BUMPER_HEIGHT + 0.01)
  g.add(front)

  const r = robot.drivetrain.wheelRadiusM
  for (const m of robot.drivetrain.modules) {
    const wheel = new Mesh(
      new CylinderGeometry(r, r, 0.04, 28),
      new MeshStandardMaterial({ color: 0x2b2c31, metalness: 0.1, roughness: 0.8 }),
    )
    // CylinderGeometry's axis is Y: rolling forward means its axle is Y.
    wheel.position.set(m.xM, m.yM, r)
    g.add(wheel)
  }

  if (robot.cogHeightM && robot.cogHeightM > 0) {
    const cog = new Mesh(new SphereGeometry(0.03, 20, 14), new MeshStandardMaterial({ color: 0xa1690a }))
    cog.position.z = robot.cogHeightM
    g.add(cog)
  }

  const axes = makeAxes(0.25)
  axes.position.z = 0.002
  g.add(axes)
  return g
}

function disposeMesh(o: unknown) {
  const mesh = o as Mesh
  if (!mesh.isMesh && !(mesh as unknown as LineSegments).isLineSegments) return
  mesh.geometry?.dispose()
  const mat = mesh.material
  if (Array.isArray(mat)) mat.forEach(m => m.dispose())
  else mat?.dispose()
}
