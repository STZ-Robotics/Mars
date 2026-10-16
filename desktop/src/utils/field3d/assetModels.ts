// Loading and optimization of a 3D asset's .glb files.
//
// Unlike `utils/field/robotModel.ts` — which loads the loose model the user picks
// for Swerve 3D and applies a fixed turn to it — here the turn is dictated by the
// package's `config.json`, so the model is loaded RAW and the scene orients it
// afterwards.
//
// This module's big job is OPTIMIZATION, and it follows the same path as
// AdvantageScope because its result is the one that looks right:
//
//  1. The material's color is baked into a VERTEX attribute. That allows
//     merging meshes that do NOT share a material, which is what takes the 2026
//     field from almost three thousand meshes to three. Merging by material left
//     28 and, worse, forced keeping the original PBR materials.
//
//  2. Everything is drawn with `MeshPhongMaterial`, not `MeshStandardMaterial`.
//     A PBR material with high `metalness` and NO environment map renders
//     black, which is exactly how the field used to look: the official model
//     declares metals everywhere. Phong does not have that problem and is
//     cheaper on top.
//
//  3. Pieces smaller than a threshold are discarded. It is what really sets the
//     three quality modes apart: on the 2026 field they are thousands of screws
//     and rivets that add nothing at five meters away.
//
// The geometry is split into three groups because they are shaded differently:
// the CARPET receives shadows and does not cast them, the TRANSPARENT stuff
// (glass, polycarbonate) goes at 20 % without writing depth, and the rest casts.

import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh,
  MeshPhongMaterial, Object3D,
} from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { invoke } from "@tauri-apps/api/core"
import { AssetSource, sourceKey } from "./assetStore"

/**
 * How to optimize and shade a model. It comes from the scene's quality mode,
 * so changing mode forces optimizing again (and that is why it goes into the
 * cache key).
 */
export interface OptimizeOptions {
  /** Pieces with a radius smaller than this are discarded, in meters. */
  maxRadius: number
  /** Specular shine. Black = matte, which is how it looks outside cinematic. */
  specular: number
  shininess: number
  /** Marks the meshes to cast and receive shadows. */
  shadows: boolean
}

/** The three presets, with the same thresholds AdvantageScope uses. */
export const OPTIMIZE_PRESETS: Record<"lowPower" | "standard" | "cinematic", OptimizeOptions> = {
  lowPower: { maxRadius: 0.08, specular: 0x000000, shininess: 0, shadows: false },
  standard: { maxRadius: 0.04, specular: 0x000000, shininess: 0, shadows: false },
  cinematic: { maxRadius: 0.02, specular: 0x666666, shininess: 100, shadows: true },
}

export interface LoadedAsset {
  /** The already optimized root, NOT rotated: the scene applies the config's turns. */
  root: Group
  /**
   * Nodes left unmerged because the config names them (the game pieces
   * already in place). The scene turns them on and off by name.
   */
  named: Map<string, Object3D[]>
  /** Triangles left after discarding the small pieces. */
  triangles: number
  /** Meshes drawn per frame. */
  drawCalls: number
  /** How many pieces were discarded for being too small. */
  culled: number
}

async function readBytes(source: AssetSource): Promise<ArrayBuffer> {
  if (source.kind === "url") {
    const response = await fetch(source.url)
    if (!response.ok) throw new Error(`Could not load ${source.url} (HTTP ${response.status}).`)
    return response.arrayBuffer()
  }

  // A file picked on disk cannot be served by URL, so the bytes are requested
  // from the backend and handed to the loader already read.
  const raw = await invoke<ArrayBuffer | number[]>("read_binary_file", { path: source.path })
  if (raw instanceof ArrayBuffer) return raw
  if (ArrayBuffer.isView(raw)) return (raw as ArrayBufferView).buffer as ArrayBuffer
  return new Uint8Array(raw as number[]).buffer
}

function parseGltf(buffer: ArrayBuffer): Promise<Group> {
  return new Promise((resolve, reject) => {
    // The base path goes empty on purpose: a .gltf pointing at loose .bin or
    // textures cannot be resolved from here, and it is better for it to fail
    // with the loader's message than to load halfway and look wrong with no
    // explanation.
    new GLTFLoader().parse(
      buffer, "",
      gltf => resolve(gltf.scene),
      error => reject(new Error(String((error as any)?.message ?? error))),
    )
  })
}

function countTriangles(geometry: BufferGeometry): number {
  const index = geometry.getIndex()
  if (index) return index.count / 3
  const position = geometry.getAttribute("position")
  return position ? position.count / 3 : 0
}

/** Which group a mesh falls into; each one is shaded differently. */
type Bucket = "normal" | "transparent" | "carpet"

function bucketOf(mesh: Mesh, material: any): Bucket {
  // The carpet is recognized by NAME because geometrically it is one more plane
  // among thousands; it is the asset's exporter that marks it.
  if (mesh.name.toLowerCase().includes("carpet")) return "carpet"
  // A barely translucent material (a decal) is not glass: only what can really
  // be seen through goes to the transparent group.
  if (material?.transparent === true && material.opacity < 0.75) return "transparent"
  return "normal"
}

/**
 * Prepares the geometry for merging: in world coordinates, with only position
 * and normal, and with the material's color baked per vertex.
 *
 * That baking is the key to everything: with the color in the vertices, two
 * meshes with different materials can be merged into one without losing their
 * color, and the whole field fits in three draw calls.
 */
function bakeGeometry(mesh: Mesh, material: any): BufferGeometry | null {
  const source = mesh.geometry
  const position = source?.getAttribute("position")
  const normal = source?.getAttribute("normal")
  // Without normals there is nothing to light it with, and merging it with the
  // ones that have them breaks the whole merge.
  if (!position || !normal) return null

  const baked = new BufferGeometry()
  baked.setAttribute("position", position.clone())
  baked.setAttribute("normal", normal.clone())

  const index = source.getIndex()
  // Every input of a merge has to agree on whether it is indexed or not;
  // `mergeGeometries` returns null as soon as one breaks the rule. It is
  // normalized to INDEXED because the opposite path (`toNonIndexed`) duplicates
  // every shared vertex and multiplies the field's memory.
  //
  // The index is built as a TypedArray and not as a JS array: the 2026 field is
  // millions of indices, and passing them through a plain array costs almost
  // twice the loading time.
  baked.setIndex(index
    ? new BufferAttribute((index.array as any).slice(), 1)
    : new BufferAttribute(new Uint32Array(position.count).map((_, i) => i), 1))

  const color: Color | undefined = material?.color
  if (color) {
    // Normalized Uint8: a field is millions of vertices, and storing the color
    // in floats would cost four times the memory for a flat color.
    const count = position.count
    const colors = new Uint8Array(count * 3)
    const r = Math.round(color.r * 255)
    const g = Math.round(color.g * 255)
    const b = Math.round(color.b * 255)
    for (let i = 0; i < count; i++) {
      colors[i * 3] = r
      colors[i * 3 + 1] = g
      colors[i * 3 + 2] = b
    }
    baked.setAttribute("color", new BufferAttribute(colors, 3, true))
  }

  // `applyMatrix4` already uses the inverse transpose for the normals, so the
  // smoothing the exporter brought survives the transform.
  mesh.updateWorldMatrix(true, false)
  baked.applyMatrix4(mesh.matrixWorld)

  return baked
}

/**
 * Prepares a node to hang from the new root keeping where it was.
 *
 * Taking a node out of its parent strips all its ancestors' transforms, which
 * in a CAD glTF are half the piece's placement: without baking the world
 * matrix into its local transform, the game pieces reappear piled up at the
 * field's center.
 *
 * `source` is where that matrix is taken from; it is separate from `node` so
 * it can be baked onto a COPY, which has no parent and therefore no world
 * matrix of its own either.
 */
function detach(node: Object3D, source: Object3D = node): Object3D {
  source.updateWorldMatrix(true, false)
  node.matrix.copy(source.matrixWorld)
  node.matrix.decompose(node.position, node.quaternion, node.scale)
  return node
}

/**
 * Switches a subtree's materials to Phong.
 *
 * Named nodes are not merged, so they keep the file's materials. If they were
 * left as `MeshStandardMaterial`, the game pieces would look black (metalness
 * without an environment) right next to a field that does look right.
 */
function toPhong(root: Object3D, options: OptimizeOptions) {
  const convert = (original: any): MeshPhongMaterial => {
    const phong = new MeshPhongMaterial({
      color: original?.color?.clone() ?? new Color(0xcfd2d8),
      side: DoubleSide,
      specular: new Color(options.specular),
      shininess: options.shininess,
      transparent: original?.transparent === true,
      opacity: original?.opacity ?? 1,
    })
    original?.dispose?.()
    return phong
  }

  root.traverse(node => {
    const mesh = node as Mesh
    if (!mesh.isMesh) return
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(convert)
      : convert(mesh.material)
    mesh.castShadow = options.shadows
    mesh.receiveShadow = options.shadows
  })
}

function makeMaterial(bucket: Bucket, options: OptimizeOptions): MeshPhongMaterial {
  return new MeshPhongMaterial({
    vertexColors: true,
    side: DoubleSide,
    specular: new Color(options.specular),
    // The carpet always goes matte: a specular shine on it reads as a puddle
    // and confuses more than it helps.
    shininess: bucket === "carpet" ? 0 : options.shininess,
    // Without `depthWrite: false` the glass panes hide each other and the field
    // shows holes depending on where it is looked at from.
    ...(bucket === "transparent"
      ? { transparent: true, opacity: 0.2, depthWrite: false }
      : {}),
  })
}

function optimize(
  scene: Object3D,
  keepNamed: Set<string>,
  options: OptimizeOptions,
): LoadedAsset {
  scene.updateMatrixWorld(true)

  const buckets: Record<Bucket, BufferGeometry[]> = { normal: [], transparent: [], carpet: [] }
  const named = new Map<string, Object3D[]>()
  const loose: Object3D[] = []
  let triangles = 0
  let culled = 0

  // A named node is taken out WHOLE with its children: a game piece is usually
  // a group of several meshes, and merging half of it would leave it split.
  const claimed = new Set<Object3D>()
  if (keepNamed.size > 0) {
    scene.traverse(node => {
      if (!keepNamed.has(node.name)) return
      // If an ancestor already took this node, it is not taken again.
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (claimed.has(parent)) return
      }
      claimed.add(node)
    })
  }

  const walk = (node: Object3D) => {
    if (claimed.has(node)) {
      const list = named.get(node.name) ?? []
      list.push(node)
      named.set(node.name, list)
      loose.push(detach(node))
      node.traverse(child => {
        const mesh = child as Mesh
        if (mesh.isMesh && mesh.geometry) triangles += countTriangles(mesh.geometry)
      })
      return
    }

    const mesh = node as Mesh
    if (mesh.isMesh && mesh.geometry) {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      const baked = bakeGeometry(mesh, material)
      if (baked) {
        // The bounding sphere's radius decides whether the piece survives.
        // `computeBoundingSphere` is used instead of walking the vertices by hand
        // because it does the same math without creating a Vector3 per vertex,
        // and here millions of them go through.
        baked.computeBoundingSphere()
        const radius = baked.boundingSphere?.radius ?? Infinity
        if (radius < options.maxRadius) {
          baked.dispose()
          culled++
          return
        }
        triangles += countTriangles(baked)
        buckets[bucketOf(mesh, material)].push(baked)
        return
      }
      loose.push(detach(mesh.clone(), mesh))
      return
    }

    node.children.forEach(walk)
  }
  scene.children.forEach(walk)

  const root = new Group()
  root.name = "asset"
  let drawCalls = 0

  ;(Object.keys(buckets) as Bucket[]).forEach(bucket => {
    const geometries = buckets[bucket]
    if (geometries.length === 0) return

    const merged = geometries.length === 1
      ? geometries[0]
      : BufferGeometryUtils.mergeGeometries(geometries, false)
    if (!merged) {
      // The merge can fail if two geometries still disagree on attributes;
      // then they are drawn loose, which is correct even if it costs more.
      geometries.forEach(geometry => {
        root.add(new Mesh(geometry, makeMaterial(bucket, options)))
        drawCalls++
      })
      return
    }
    if (geometries.length > 1) geometries.forEach(g => g.dispose())

    const mesh = new Mesh(merged, makeMaterial(bucket, options))
    mesh.name = bucket
    // The carpet RECEIVES the robot's shadow; the rest casts it. Having the
    // field cast shadows on itself costs a whole pass over millions of
    // triangles to gain the edge of one wall against another.
    mesh.castShadow = options.shadows && bucket !== "carpet"
    mesh.receiveShadow = options.shadows && bucket === "carpet"
    root.add(mesh)
    drawCalls++
  })

  loose.forEach(node => {
    toPhong(node, options)
    root.add(node)
    node.traverse(child => { if ((child as Mesh).isMesh) drawCalls++ })
  })

  return { root, named, triangles: Math.round(triangles), drawCalls, culled }
}

// A field model is 18 MB and optimizing it takes time; without a cache,
// switching tabs would read the disk and redo the merge every time.
const cache = new Map<string, Promise<LoadedAsset>>()

/**
 * Loads (and caches) one of the package's models.
 *
 * `keepNamed` are the nodes the merge must not touch. The cache includes that
 * set and the optimization options in the key: the same file requested with
 * another quality mode is a different result.
 */
export function loadAssetModel(
  source: AssetSource,
  keepNamed: string[] = [],
  options: OptimizeOptions = OPTIMIZE_PRESETS.standard,
): Promise<LoadedAsset> {
  const key = [
    sourceKey(source),
    options.maxRadius, options.specular, options.shininess, options.shadows,
    keepNamed.slice().sort().join(","),
  ].join("#")

  const hit = cache.get(key)
  if (hit) return hit

  const pending = readBytes(source)
    .then(parseGltf)
    .then(scene => optimize(scene, new Set(keepNamed), options))
    // If it fails it is removed from the cache: otherwise fixing the file and
    // requesting it again would return the same error forever.
    .catch(error => {
      cache.delete(key)
      throw error
    })

  cache.set(key, pending)
  return pending
}

/**
 * An independent copy with its own materials.
 *
 * The scene changes their color and opacity (the ghost, the alliance
 * highlight) and without cloning them that would overwrite the original the
 * other instances share. The GEOMETRY is shared: it is the heavy part and
 * nobody mutates it.
 */
export function instantiateAsset(asset: LoadedAsset): Group {
  const clone = asset.root.clone(true)
  clone.traverse(child => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(m => m.clone())
      : mesh.material.clone()
  })
  // The mark travels with the instance so whoever discards it does not have to
  // remember its geometry is borrowed. Forgetting it a single time leaves the
  // field (or the robot) black for ALL the other copies and for the next time
  // the tab opens, because what gets freed is what is in the cache.
  clone.userData.sharedGeometry = true
  return clone
}

/** Frees the materials of an instance being discarded (not the geometry). */
export function disposeAssetInstance(object: Object3D) {
  object.traverse(child => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose())
    else mesh.material?.dispose()
  })
}

/**
 * Frees a whole tree respecting what is borrowed: asset instances only release
 * their materials, everything else releases its geometry too.
 *
 * It is the only correct way to discard an object from the scene, because
 * almost all of them mix the two — a robot is an asset instance plus its
 * label's and its trail's own meshes.
 */
export function disposeSceneTree(object: Object3D) {
  const walk = (node: Object3D) => {
    if (node.userData.sharedGeometry === true) {
      disposeAssetInstance(node)
      return
    }
    const mesh = node as Mesh
    if (mesh.isMesh) {
      mesh.geometry?.dispose()
      const material = mesh.material as any
      if (Array.isArray(material)) material.forEach((m: any) => m?.dispose())
      else material?.dispose()
    }
    node.children.slice().forEach(walk)
  }
  walk(object)
}
