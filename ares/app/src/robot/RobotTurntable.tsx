import { useEffect, useRef, useState } from "react"
import { Box3, Group, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three"
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js"
import { addStandardLights, makeAxes, makeFloorGrid, makeOrbitControls, DEG } from "@desktop/components/dashboard/three/sceneKit"
import { disposeInstance, instantiateModel, loadModel, LoadedModel } from "@desktop/utils/field/robotModel"
import { buildAnnotations, disposeAnnotations, BUMPER_HEIGHT } from "./annotations"
import type { Derived, ModelRef, RobotConfig } from "./types"

interface Props {
  robot: RobotConfig
  derived: Derived | null
  /** The model file on disk, already resolved; null shows the robot without it. */
  modelPath: string | null
  spinning: boolean
  /** Dimensions, callouts, center of mass and the spec plate. */
  showAnnotations: boolean
  onModelError: (message: string | null) => void
}

// Degrees per second of the idle spin, and how long after the user lets go of
// the view before it resumes.
const SPIN_DPS = 20
const RESUME_AFTER_MS = 2500

// The robot on a turntable, like an item in a game's inventory: it turns on
// its own, can be grabbed and orbited, and starts turning again when left
// alone. Everything is in WPILib's frame (Z up, X forward), the same one
// robot.json uses, so the annotations are exactly where the planner thinks
// the bumper, the wheels and the center of mass are.
export default function RobotTurntable({ robot, derived, modelPath, spinning, showAnnotations, onModelError }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const world = useRef<{ turntable: Group; annotations: Group; modelSlot: Group } | null>(null)
  const spinRef = useRef(spinning)
  spinRef.current = spinning
  const [loaded, setLoaded] = useState<LoadedModel | null>(null)
  // The model's top, so the plate and the callouts clear it.
  const [topZ, setTopZ] = useState(BUMPER_HEIGHT)

  // The scene, once.
  useEffect(() => {
    const el = host.current!
    const renderer = new WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)

    const labels = new CSS2DRenderer()
    Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" })
    el.appendChild(labels.domElement)

    const scene = new Scene()
    addStandardLights(scene)
    scene.add(makeFloorGrid(3, 0.25))
    const axes = makeAxes(0.18)
    scene.add(axes)

    const camera = new PerspectiveCamera(32, 1, 0.02, 100)
    camera.up.set(0, 0, 1)
    camera.position.set(2.3, 1.8, 1.6)
    const controls = makeOrbitControls(camera, renderer.domElement, { minDistance: 0.4, maxDistance: 12 })
    controls.target.set(0, 0, 0.3)

    const turntable = new Group()
    const annotations = new Group()
    const modelSlot = new Group()
    turntable.add(modelSlot, annotations)
    scene.add(turntable)
    world.current = { turntable, annotations, modelSlot }

    let lastTouch = -Infinity
    controls.addEventListener("start", () => { lastTouch = Infinity })
    controls.addEventListener("end", () => { lastTouch = performance.now() })

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      labels.setSize(w, h)
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
      labels.render(scene, camera)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      disposeAnnotations(annotations)
      renderer.dispose()
      el.removeChild(renderer.domElement)
      el.removeChild(labels.domElement)
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
    if (!w || !loaded || !model) { setTopZ(BUMPER_HEIGHT); return }
    const instance = instantiateModel(loaded, "origin")
    placeModel(instance, model)
    w.modelSlot.add(instance)
    instance.updateMatrixWorld(true)
    const box = new Box3().setFromObject(instance)
    // The spin is about Z, so heights read the same in any frame.
    setTopZ(Number.isFinite(box.max.z) ? box.max.z : BUMPER_HEIGHT)
    return () => {
      w.modelSlot.remove(instance)
      disposeInstance(instance)
    }
  }, [loaded, model?.scale, ...(model?.offsetM ?? []), ...(model?.rotationDeg ?? [])])

  // The annotations, rebuilt when anything they show changes.
  useEffect(() => {
    const w = world.current
    if (!w || !showAnnotations) return
    const group = buildAnnotations(robot, derived, { topZ })
    w.annotations.add(group)
    return () => {
      w.annotations.remove(group)
      disposeAnnotations(group)
    }
  }, [showAnnotations, JSON.stringify(robot), JSON.stringify(derived), topZ])

  return <div ref={host} style={{ position: "absolute", inset: 0, overflow: "hidden" }} />
}

export function placeModel(instance: Group, model: ModelRef) {
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
