// Loading of 3D models (.stl / .glb / .gltf) for the Swerve 3D and Mechanism 3D
// views.
//
// The user picks the file with the native dialog, so it arrives as a disk PATH,
// not as a servable URL: three's loaders cannot fetch it on their own. That is
// why the bytes are requested from the backend (`read_binary_file`) and handed
// to the loader already parsed.
//
// The whole scene is built with Z up (X forward, Y to the left), which is
// WPILib's frame. A .glb comes with Y up by glTF convention, so on loading it a
// +90° turn around X is applied to bring it into this frame; CAD .stl files
// usually already come with Z up.

import { Box3, Group, Mesh, MeshStandardMaterial, Object3D, Vector3, Material } from "three"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"

export type ModelFormat = "stl" | "gltf"

/**
 * Where the model's origin is, which is the point it rotates around.
 *
 * - `origin`: the file's origin, untouched. It is right for parts exported
 *   from CAD with the joint's axis at (0,0,0).
 * - `center`: the center of its bounding box.
 * - `base`: centered in XY and resting on z = 0 (a robot on the floor).
 */
export type ModelAnchor = "origin" | "center" | "base"

export interface LoadedModel {
  /** The model already rotated into the Z-up frame, NOT recentered. */
  holder: Group
  format: ModelFormat
  /** Size of the bounding box, in file units. */
  size: Vector3
  /** Center of the bounding box, in file units. */
  center: Vector3
  /** Lowest Z of the bounding box, for the `base` anchor. */
  minZ: number
  /** Number of triangles, to warn if the model is too heavy. */
  triangles: number
}

export const MODEL_EXTENSIONS = ["stl", "glb", "gltf"]

/** A neutral grey for .stl files, which carry no color at all. */
export const DEFAULT_MODEL_COLOR = "#8f9299"

// A model can weigh tens of MB and parsing takes time; without a cache, every
// tab switch would read the disk and build the mesh again.
const cache = new Map<string, Promise<LoadedModel>>()

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".")
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase()
}

export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Opens the native dialog filtered to the formats the views can read. */
export async function pickModelFile(title = "Select a 3D model"): Promise<string | null> {
  const picked = await open({
    multiple: false,
    title,
    filters: [{ name: "3D model (STL / glTF)", extensions: MODEL_EXTENSIONS }],
  })
  return typeof picked === "string" ? picked : null
}

/** Same as `pickModelFile` but allowing several files at once. */
export async function pickModelFiles(title = "Add 3D models"): Promise<string[]> {
  const picked = await open({
    multiple: true,
    title,
    filters: [{ name: "3D model (STL / glTF)", extensions: MODEL_EXTENSIONS }],
  })
  if (Array.isArray(picked)) return picked.filter((p): p is string => typeof p === "string")
  return typeof picked === "string" ? [picked] : []
}

export async function readFileBytes(path: string): Promise<ArrayBuffer> {
  const raw = await invoke<ArrayBuffer | number[]>("read_binary_file", { path })
  // The command returns `ipc::Response`, which arrives as an ArrayBuffer. A
  // fallback to an array of numbers costs nothing and avoids being tied to that detail.
  if (raw instanceof ArrayBuffer) return raw
  if (ArrayBuffer.isView(raw)) return (raw as ArrayBufferView).buffer as ArrayBuffer
  return new Uint8Array(raw as number[]).buffer
}

function parseGltf(buffer: ArrayBuffer): Promise<Object3D> {
  return new Promise((resolve, reject) => {
    // The second argument is the base path for external resources. It is sent
    // empty on purpose: a .gltf pointing at loose .bin/textures cannot be
    // resolved from here, and it is better for it to fail with the loader's
    // message than to load halfway.
    new GLTFLoader().parse(
      buffer, "",
      gltf => resolve(gltf.scene),
      error => reject(new Error(String((error as any)?.message ?? error))),
    )
  })
}

function countTriangles(object: Object3D): number {
  let total = 0
  object.traverse(child => {
    const mesh = child as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const index = mesh.geometry.getIndex()
    const position = mesh.geometry.getAttribute("position")
    if (index) total += index.count / 3
    else if (position) total += position.count / 3
  })
  return Math.round(total)
}

async function buildModel(path: string): Promise<LoadedModel> {
  const extension = extensionOf(path)
  if (!MODEL_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported model format ".${extension}". Use .stl, .glb or .gltf.`)
  }

  const buffer = await readFileBytes(path)

  let object: Object3D
  let format: ModelFormat
  if (extension === "stl") {
    const geometry = new STLLoader().parse(buffer)
    geometry.computeVertexNormals()
    object = new Mesh(geometry, new MeshStandardMaterial({
      color: DEFAULT_MODEL_COLOR, metalness: 0.15, roughness: 0.65,
    }))
    format = "stl"
  } else {
    object = await parseGltf(buffer)
    // glTF defines Y up; the scene works with Z up.
    object.rotation.x = Math.PI / 2
    format = "gltf"
  }

  const holder = new Group()
  holder.name = "model"
  holder.add(object)
  holder.updateMatrixWorld(true)

  // The box is measured AFTER the rotation into the Z-up frame: it is the one
  // auto-fit and the anchors use, and it has to be in the same frame the part
  // will be placed in.
  const box = new Box3().setFromObject(object)
  const center = box.getCenter(new Vector3())
  const size = box.getSize(new Vector3())

  if (!isFinite(size.x) || size.x <= 0) {
    throw new Error("The model has no geometry (empty bounding box).")
  }

  return { holder, format, size, center, minZ: box.min.z, triangles: countTriangles(object) }
}

export function loadModel(path: string): Promise<LoadedModel> {
  const hit = cache.get(path)
  if (hit) return hit

  // If loading fails it is removed from the cache: otherwise fixing the file and
  // picking it again would return the same error forever.
  const pending = buildModel(path).catch(error => {
    cache.delete(path)
    throw error
  })
  cache.set(path, pending)
  return pending
}

/**
 * An independent copy of the cached model, with its own materials: the scene
 * changes their color and opacity, and without cloning them that would
 * overwrite the original the other tabs share.
 *
 * The anchor's offset is applied to the child and not to the returned group,
 * so the caller can freely use the group's `position`/`scale` without the
 * anchor getting scaled on top.
 */
export function instantiateModel(model: LoadedModel, anchor: ModelAnchor = "base"): Group {
  const clone = model.holder.clone(true)
  clone.traverse(child => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(m => m.clone())
      : mesh.material.clone()
  })

  const inner = clone.children[0]
  if (inner) {
    const { center, minZ } = model
    if (anchor === "center") inner.position.set(-center.x, -center.y, -center.z)
    else if (anchor === "base") inner.position.set(-center.x, -center.y, -minZ)
    else inner.position.set(0, 0, 0)
  }

  return clone
}

/** Returns an instance's materials, so they can be mutated as a block. */
export function materialsOf(object: Object3D): Material[] {
  const out: Material[] = []
  object.traverse(child => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    if (Array.isArray(mesh.material)) out.push(...mesh.material)
    else if (mesh.material) out.push(mesh.material)
  })
  return out
}

/** Frees the materials of an instance about to be discarded. */
export function disposeInstance(object: Object3D) {
  object.traverse(child => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    // The geometry is SHARED with the cached model (clone() does not copy it),
    // so only the materials are discarded, which are its own.
    if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose())
    else mesh.material?.dispose()
  })
}
