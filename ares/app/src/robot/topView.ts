// The robot seen from above, for the 2D field: the STL rendered once with an
// orthographic camera looking straight down, placed exactly as robot.json
// places it in the 3D preview, into a transparent image the field draws at
// every pose.

import { AmbientLight, DirectionalLight, OrthographicCamera, Scene, WebGLRenderer } from "three"
import { disposeInstance, instantiateModel, loadModel } from "@desktop/utils/field/robotModel"
import { placeModel } from "./RobotTurntable"
import type { RobotConfig } from "./types"

export interface TopView {
  image: HTMLCanvasElement
  /** Half the side of the square the image covers, in meters, centered on the robot. */
  halfExtentM: number
}

const PIXELS = 512

export async function renderTopView(robot: RobotConfig, modelPath: string): Promise<TopView> {
  const model = robot.model
  if (!model) throw new Error("the robot has no 3D model")
  const loaded = await loadModel(modelPath)
  // Big enough for the bumper and anything that sticks out of it.
  const half = Math.max(robot.bumper.lengthM, robot.bumper.widthM) * 0.75

  const scene = new Scene()
  scene.add(new AmbientLight(0xffffff, 1.1))
  const sun = new DirectionalLight(0xffffff, 1.6)
  sun.position.set(0.6, 0.4, 3)
  scene.add(sun)
  const instance = instantiateModel(loaded, "origin")
  placeModel(instance, model)
  scene.add(instance)

  // Looking down -Z with +Y up the image: +X (forward) is to the right.
  const camera = new OrthographicCamera(-half, half, half, -half, 0.01, 20)
  camera.position.set(0, 0, 10)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)

  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setSize(PIXELS, PIXELS, false)
  renderer.setClearColor(0x000000, 0)
  renderer.render(scene, camera)

  const image = document.createElement("canvas")
  image.width = image.height = PIXELS
  image.getContext("2d")!.drawImage(renderer.domElement, 0, 0)
  renderer.dispose()
  renderer.forceContextLoss()
  disposeInstance(instance)
  return { image, halfExtentM: half }
}
