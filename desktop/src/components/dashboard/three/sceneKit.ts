// three.js pieces shared by the 3D views (Swerve 3D, Mechanism 3D).
//
// Every scene in the app works with Z UP, X forward and Y to the left, which is
// WPILib's frame: that way the angles and poses the robot publishes go in
// exactly as they come out of NT, with no loose conversions spread around the
// code.

import {
  BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry,
  Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh,
  MeshStandardMaterial, Object3D, OrthographicCamera, PerspectiveCamera,
  Scene, Sprite, SpriteMaterial, AmbientLight, DirectionalLight, HemisphereLight,
} from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"

export const DEG = Math.PI / 180

/** X axis red, Y green, Z blue — the same color code as RViz and WPILib. */
export const AXIS_COLORS = [0xc21c1c, 0x1c8f1c, 0x2f6fdb] as const

// --- Luces -------------------------------------------------------------------

/** Neutral lighting: a high key, an opposite fill and ambient for the shadows. */
export function addStandardLights(scene: Scene) {
  scene.add(new HemisphereLight(0xffffff, 0x9a9aa2, 1.4))
  scene.add(new AmbientLight(0xffffff, 0.35))

  const key = new DirectionalLight(0xffffff, 1.4)
  key.position.set(2.5, 3, 5)
  scene.add(key)

  const fill = new DirectionalLight(0xffffff, 0.5)
  fill.position.set(-3, -2, 2)
  scene.add(fill)
}

// --- Camera ------------------------------------------------------------------

export function makeOrbitControls(
  camera: PerspectiveCamera | OrthographicCamera,
  dom: HTMLElement,
  options: { minDistance?: number; maxDistance?: number } = {},
): OrbitControls {
  const controls = new OrbitControls(camera, dom)
  controls.enableDamping = true
  controls.dampingFactor = 0.12
  controls.minDistance = options.minDistance ?? 0.2
  controls.maxDistance = options.maxDistance ?? 40
  // A little before the horizon: looking exactly edge-on reduces the scene to a
  // line.
  controls.maxPolarAngle = Math.PI / 2 - 0.02
  return controls
}

// --- Supporting geometry -------------------------------------------------------

/**
 * Floor grid on the XY plane. It is worth drawing it much bigger than the
 * framing: the views that move it (the swerve's moving floor) must never show
 * where it ends.
 */
export function makeFloorGrid(halfSize: number, cell: number, color = 0x9a9aa2): LineSegments {
  const points: number[] = []
  for (let i = -halfSize; i <= halfSize + 1e-6; i += cell) {
    points.push(i, -halfSize, 0, i, halfSize, 0)
    points.push(-halfSize, i, 0, halfSize, i, 0)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3))
  return new LineSegments(geometry, new LineBasicMaterial({
    color, transparent: true, opacity: 0.55,
  }))
}

/** X/Y/Z axes from the origin of whatever group it hangs from. */
export function makeAxes(length: number): Group {
  const group = new Group()
  const directions: [number, number, number][] = [
    [length, 0, 0],
    [0, length, 0],
    [0, 0, length],
  ]
  directions.forEach((direction, i) => {
    const geometry = new BufferGeometry()
    geometry.setAttribute("position", new Float32BufferAttribute(
      [0, 0, 0.002, direction[0], direction[1], direction[2] + 0.002], 3,
    ))
    group.add(new LineSegments(geometry, new LineBasicMaterial({ color: AXIS_COLORS[i] })))
  })
  return group
}

/**
 * An arrow along +X, of unit length. It is stretched with `setArrowLength`
 * instead of being rebuilt: scaling only the body leaves the tip undistorted.
 */
export function makeArrow(color: string | number, radius: number): Group {
  const head = radius * 3.2
  const group = new Group()
  const material = new MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55 })

  const shaft = new Mesh(
    new CylinderGeometry(radius, radius, 1, 10).rotateZ(-Math.PI / 2).translate(0.5, 0, 0),
    material,
  )
  shaft.name = "shaft"

  const tip = new Mesh(
    new ConeGeometry(radius * 2.2, head, 14).rotateZ(-Math.PI / 2).translate(head / 2, 0, 0),
    material,
  )
  tip.name = "head"

  group.add(shaft, tip)
  group.userData.headLength = head
  return group
}

/** `length` is the arrow's TOTAL length, tip included. */
export function setArrowLength(arrow: Group, length: number) {
  const head: number = arrow.userData.headLength
  arrow.visible = length > head * 0.6
  if (!arrow.visible) return

  const body = Math.max(length - head, 1e-4)
  arrow.getObjectByName("shaft")!.scale.x = body
  arrow.getObjectByName("head")!.position.x = body
}

export function arrowMaterial(arrow: Group): MeshStandardMaterial {
  return (arrow.getObjectByName("shaft") as Mesh).material as MeshStandardMaterial
}

export function setArrowOpacity(arrow: Group, opacity: number) {
  const material = arrowMaterial(arrow)
  material.transparent = opacity < 1
  material.opacity = opacity
  material.depthWrite = opacity >= 1
}

/**
 * A text label that always faces the camera. `depthTest: false` on purpose: a
 * label hidden by the part it names is useless.
 */
export function makeTextSprite(text: string, options: {
  /** The sprite's height in scene meters. */
  height?: number
  color?: string
  background?: string
} = {}): Sprite {
  const height = options.height ?? 0.1
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")!

  ctx.font = "bold 38px 'Segoe UI', Arial, sans-serif"
  const textWidth = Math.max(ctx.measureText(text).width, 8)
  canvas.width = Math.ceil(textWidth) + 24
  canvas.height = 64

  // Resizing the canvas resets the context, so the font is set again after
  // sizing it.
  ctx.font = "bold 38px 'Segoe UI', Arial, sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillStyle = options.background ?? "rgba(255,255,255,0.85)"
  ctx.fillRect(0, 10, canvas.width, 44)
  ctx.fillStyle = options.color ?? "#1c1c1f"
  ctx.fillText(text, canvas.width / 2, 33)

  const sprite = new Sprite(new SpriteMaterial({
    map: new CanvasTexture(canvas), depthTest: false, transparent: true,
  }))
  sprite.scale.set((canvas.width / canvas.height) * height, height, 1)
  sprite.renderOrder = 10
  return sprite
}

/** Green -> yellow -> red according to what fraction of the maximum is in use. */
export function ratioColor(ratio: number): Color {
  const clamped = Math.min(Math.max(ratio, 0), 1)
  return new Color().setHSL((130 * (1 - clamped)) / 360, 0.72, 0.4)
}

// --- Cleanup -----------------------------------------------------------------

/**
 * Empties a group releasing geometries and materials. It is used every time
 * the configuration changes and things have to be rebuilt: without it,
 * touching a checkbox fifty times leaves fifty orphaned meshes on the GPU.
 */
export function disposeGroup(group: Group) {
  group.children.slice().forEach(child => {
    group.remove(child)
    disposeObject(child)
  })
}

export function disposeObject(object: Object3D) {
  object.traverse((node: Object3D) => {
    const mesh = node as Mesh
    mesh.geometry?.dispose()
    const material = (mesh as any).material
    if (Array.isArray(material)) material.forEach((m: any) => m?.dispose())
    else material?.dispose()
  })
}
