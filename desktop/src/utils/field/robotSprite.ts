// A top-down view of a 3D model, turned into an image the field's 2D canvas can
// stamp at the robot's pose.
//
// The alternative was mounting a whole three scene inside the 2D visualizer,
// but a robot seen from above is ALWAYS the same image: only where it is stamped
// and how much it is turned change. So it is rendered ONCE with an orthographic
// camera looking down, the bitmap is kept, and from then on each frame is a
// `drawImage` — which is what allows drawing six robots at 30 fps without
// breaking a sweat.
//
// The frame is the same as every 3D view in the app (Z up, X forward, Y to the
// left), so in the resulting image +X goes right and +Y up: stamping it with
// the pose's rotation already leaves it pointing the right way.

import {
  AmbientLight, Box3, Color, DirectionalLight, Group, HemisphereLight, Mesh,
  MeshStandardMaterial, OrthographicCamera, Scene, Vector3, WebGLRenderer,
} from "three"
import { instantiateModel, loadModel, materialsOf } from "./robotModel"

const DEG = Math.PI / 180

/** Cap on the bitmap's longer side. More than this is not noticeable on screen. */
const MAX_SPRITE_PX = 1024
const MIN_SPRITE_PX = 96

export interface RobotSprite {
  canvas: HTMLCanvasElement
  /** The footprint the image covers, in FILE UNITS (not meters). */
  spanX: number
  spanY: number
  /** The model's triangles, to warn if it is too heavy. */
  triangles: number
}

export interface SpriteRequest {
  path: string
  /** The bitmap's longer side in pixels. It is quantized so zooming does not re-render. */
  sizePx: number
  /** A flat color, or null to respect the file's materials. */
  color: string | null
  /** Turn in degrees that takes the CAD's front to +X. */
  rotationDeg: number
}

// A single WebGL context for the whole app: browsers limit how many can be
// alive, and this one is used in short bursts.
let renderer: WebGLRenderer | null = null
let rendererBroken = false

const cache = new Map<string, Promise<RobotSprite>>()

function keyOf(req: SpriteRequest): string {
  return `${req.path}|${req.sizePx}|${req.color ?? "file"}|${req.rotationDeg}`
}

/**
 * Quantizes the requested size to powers of two. Without this, every pixel of
 * zoom would trigger a new render of the whole model.
 */
export function quantizeSpriteSize(pixels: number): number {
  const clamped = Math.min(MAX_SPRITE_PX, Math.max(MIN_SPRITE_PX, pixels))
  return Math.pow(2, Math.ceil(Math.log2(clamped)))
}

export function getRobotSprite(req: SpriteRequest): Promise<RobotSprite> {
  const key = keyOf(req)
  const hit = cache.get(key)
  if (hit) return hit

  const pending = render(req).catch(error => {
    cache.delete(key)
    throw error
  })
  cache.set(key, pending)
  return pending
}

/** Drops a model's bitmaps (when it is changed or released). */
export function forgetSprites(path?: string): void {
  if (path === undefined) {
    cache.clear()
    return
  }
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(`${path}|`)) cache.delete(key)
  }
}

function getRenderer(): WebGLRenderer {
  if (renderer) return renderer
  if (rendererBroken) throw new Error("WebGL is not available in this window.")
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true })
    renderer.setClearAlpha(0)
    return renderer
  } catch (error) {
    rendererBroken = true
    throw new Error(`Could not start WebGL to render the model: ${String(error)}`)
  }
}

async function render(req: SpriteRequest): Promise<RobotSprite> {
  const model = await loadModel(req.path)

  const scene = new Scene()
  const group: Group = instantiateModel(model, "center")
  group.rotation.z = req.rotationDeg * DEG
  scene.add(group)
  group.updateMatrixWorld(true)

  if (req.color !== null) {
    const flat = new Color(req.color)
    materialsOf(group).forEach(material => {
      const standard = material as MeshStandardMaterial
      if (standard.color) standard.color.copy(flat)
    })
  }
  // Without this, a GLB with single-sided faces looks holed from above.
  group.traverse(child => {
    const mesh = child as Mesh
    if (mesh.isMesh) mesh.frustumCulled = false
  })

  // The box is measured AFTER the turn: it is the real footprint the robot will
  // take on the field, and it is what auto-fit has to match to the chassis.
  const box = new Box3().setFromObject(group)
  const size = box.getSize(new Vector3())
  const center = box.getCenter(new Vector3())
  if (!isFinite(size.x) || size.x <= 0 || size.y <= 0) {
    throw new Error("The model has no footprint when seen from above.")
  }

  addLights(scene, size)

  const aspect = size.x / size.y
  const width = Math.max(8, Math.round(aspect >= 1 ? req.sizePx : req.sizePx * aspect))
  const height = Math.max(8, Math.round(aspect >= 1 ? req.sizePx / aspect : req.sizePx))

  // Orthographic and not perspective: a top-down view with perspective opens
  // the robot's walls outward and the image stops matching the footprint being
  // drawn on the field.
  const camera = new OrthographicCamera(-size.x / 2, size.x / 2, size.y / 2, -size.y / 2, 0.01, size.z * 4 + 10)
  camera.position.set(center.x, center.y, box.max.z + size.z + 1)
  camera.up.set(0, 1, 0)
  camera.lookAt(center.x, center.y, box.min.z)

  const gl = getRenderer()
  gl.setPixelRatio(1)
  gl.setSize(width, height, false)
  gl.render(scene, camera)

  // The renderer's canvas is reused for the next model, so the bitmap is
  // copied to one of its own before returning it.
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Could not copy the rendered model.")
  ctx.drawImage(gl.domElement, 0, 0, width, height)

  scene.clear()

  return { canvas, spanX: size.x, spanY: size.y, triangles: model.triangles }
}

// Top-down view: a light only from above leaves the robot's roof flat and
// without relief, so the key light is moved forward and to one side.
function addLights(scene: Scene, size: Vector3): void {
  const reach = Math.max(size.x, size.y, size.z) * 3 + 1

  scene.add(new HemisphereLight(0xffffff, 0x8a8a92, 1.1))
  scene.add(new AmbientLight(0xffffff, 0.45))

  const key = new DirectionalLight(0xffffff, 1.5)
  key.position.set(reach * 0.5, reach * 0.7, reach)
  scene.add(key)

  const fill = new DirectionalLight(0xffffff, 0.45)
  fill.position.set(-reach * 0.6, -reach * 0.4, reach * 0.8)
  scene.add(fill)
}
