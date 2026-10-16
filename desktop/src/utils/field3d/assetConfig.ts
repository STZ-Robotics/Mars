// Reading a 3D asset's `config.json`, in AdvantageScope's format.
//
// An asset is a folder with a `config.json` and one or more `model*.glb`.
// There are two kinds and they are told apart by what the config itself
// declares, not by the folder's name:
//
//   Field  ->  carries widthInches/heightInches (the playing area)
//   Robot  ->  does not; carries components/cameras
//
// The format is accepted EXACTLY as AdvantageScope publishes it so the official
// .zip files (github.com/Mechanical-Advantage/AdvantageScopeAssets) install
// without editing anything, and so a team that already builds its assets does
// not have to maintain two versions.
//
// Every missing field falls back to a reasonable default instead of invalidating
// the package: a hand-written config missing `defaultOrigin` is still perfectly
// usable.

import { Field3dCoordinateSystem, FieldSize, Quat, quatMultiply } from "./frames"

/** A turn around a world axis, in degrees. They are applied IN ORDER. */
export interface AxisRotation {
  axis: "x" | "y" | "z"
  degrees: number
}

export type OriginPreference = "auto" | "blue" | "red"

export interface GamePieceConfig {
  name: string
  rotations: AxisRotation[]
  position: [number, number, number]
  /**
   * Names of the field model's nodes that represent THIS piece already placed
   * at its starting spot. They are hidden when the robot publishes the piece's
   * topic: otherwise each piece would show up twice, the real one and the one
   * painted into the field model.
   */
  stagedObjects: string[]
}

export interface AprilTagConfig {
  /** Family and size, e.g. "36h11-6.5in". */
  variant: string
  id: number
  rotations: AxisRotation[]
  position: [number, number, number]
}

export interface FieldAssetConfig {
  kind: "field"
  name: string
  isFTC: boolean
  coordinateSystem: Field3dCoordinateSystem
  /** Turns that take the file's model into the scene's Z-up frame. */
  rotations: AxisRotation[]
  /** Playing area in meters; it comes from widthInches/heightInches. */
  size: FieldSize
  defaultOrigin: OriginPreference
  /** Positions of the driver stations in the model's frame (6 in FRC). */
  driverStations: [number, number][]
  gamePieces: GamePieceConfig[]
  aprilTags: AprilTagConfig[]
}

export interface RobotCameraConfig {
  name: string
  rotations: AxisRotation[]
  /** Position relative to the robot's center, in meters. */
  position: [number, number, number]
  resolution: [number, number]
  /** HORIZONTAL field of view in degrees. */
  fov: number
}

export interface RobotComponentConfig {
  /** The component's pose when its published Pose3d is the identity. */
  zeroedRotations: AxisRotation[]
  zeroedPosition: [number, number, number]
}

export interface RobotAssetConfig {
  kind: "robot"
  name: string
  isFTC: boolean
  rotations: AxisRotation[]
  position: [number, number, number]
  cameras: RobotCameraConfig[]
  components: RobotComponentConfig[]
}

export type AssetConfig = FieldAssetConfig | RobotAssetConfig

const INCH = 0.0254

// --- Lectores tolerantes -----------------------------------------------------

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && isFinite(value) ? value : fallback
}

function vec3(value: unknown, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!Array.isArray(value)) return fallback
  return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])]
}

function parseRotations(value: unknown): AxisRotation[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry: any): AxisRotation | null => {
      const axis = entry?.axis
      if (axis !== "x" && axis !== "y" && axis !== "z") return null
      return { axis, degrees: num(entry?.degrees, 0) }
    })
    .filter((r): r is AxisRotation => r !== null)
}

function parseCoordinateSystem(value: unknown): Field3dCoordinateSystem {
  switch (value) {
    case "wall-alliance": return "wall-alliance"
    case "center-red": return "center-red"
    case "center-rotated": return "center-rotated"
    // With no explicit value WPILib's classic system is assumed, which is what
    // all robot code written before 2027 publishes.
    default: return "wall-blue"
  }
}

function parseOrigin(value: unknown): OriginPreference {
  return value === "blue" || value === "red" ? value : "auto"
}

// --- Parseo ------------------------------------------------------------------

/**
 * Turns a `config.json`'s text into a typed asset.
 *
 * Returns `null` instead of throwing when the JSON cannot be read or does not
 * even declare a name: the assets panel lists folders anyone could have left,
 * and a single broken one must not bring the whole list down.
 */
export function parseAssetConfig(text: string): AssetConfig | null {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object") return null

  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : null
  if (name === null) return null

  const isFTC = raw.isFTC === true
  const rotations = parseRotations(raw.rotations)

  // It is a field if it declares the playing area. A robot asset does not carry
  // it, and it is the only structural difference between the two formats.
  const hasSize = typeof raw.widthInches === "number" && typeof raw.heightInches === "number"

  if (hasSize) {
    return {
      kind: "field",
      name,
      isFTC,
      coordinateSystem: parseCoordinateSystem(raw.coordinateSystem),
      rotations,
      size: {
        length: num(raw.widthInches, 0) * INCH,
        width: num(raw.heightInches, 0) * INCH,
      },
      defaultOrigin: parseOrigin(raw.defaultOrigin),
      driverStations: Array.isArray(raw.driverStations)
        ? raw.driverStations
            .filter((d: any) => Array.isArray(d) && d.length >= 2)
            .map((d: any): [number, number] => [num(d[0], 0), num(d[1], 0)])
        : [],
      gamePieces: Array.isArray(raw.gamePieces)
        ? raw.gamePieces.map((piece: any, index: number): GamePieceConfig => ({
            name: typeof piece?.name === "string" ? piece.name : `Piece ${index + 1}`,
            rotations: parseRotations(piece?.rotations),
            position: vec3(piece?.position),
            stagedObjects: Array.isArray(piece?.stagedObjects)
              ? piece.stagedObjects.filter((s: any) => typeof s === "string")
              : [],
          }))
        : [],
      aprilTags: Array.isArray(raw.aprilTags)
        ? raw.aprilTags
            .filter((tag: any) => typeof tag?.id === "number")
            .map((tag: any): AprilTagConfig => ({
              variant: typeof tag.variant === "string" ? tag.variant : "36h11-6.5in",
              id: tag.id,
              rotations: parseRotations(tag.rotations),
              position: vec3(tag.position),
            }))
        : [],
    }
  }

  return {
    kind: "robot",
    name,
    isFTC,
    rotations,
    position: vec3(raw.position),
    cameras: Array.isArray(raw.cameras)
      ? raw.cameras.map((camera: any, index: number): RobotCameraConfig => ({
          name: typeof camera?.name === "string" ? camera.name : `Camera ${index + 1}`,
          rotations: parseRotations(camera?.rotations),
          position: vec3(camera?.position),
          resolution: [num(camera?.resolution?.[0], 960), num(camera?.resolution?.[1], 720)],
          fov: num(camera?.fov, 70),
        }))
      : [],
    components: Array.isArray(raw.components)
      ? raw.components.map((component: any): RobotComponentConfig => ({
          zeroedRotations: parseRotations(component?.zeroedRotations),
          zeroedPosition: vec3(component?.zeroedPosition),
        }))
      : [],
  }
}

// --- Rotaciones --------------------------------------------------------------

const DEG = Math.PI / 180

/**
 * Composes a list of per-axis turns into a single quaternion.
 *
 * The turns are around the WORLD axes and are applied in the order they come,
 * which is what AdvantageScope documents: that is why each one premultiplies
 * the accumulated one instead of postmultiplying.
 *
 * The typical case is `[{axis:"x", degrees:90}]`, which takes a glTF (Y up by
 * the format's convention) into WPILib's Z-up frame the scene uses.
 */
export function composeRotations(rotations: AxisRotation[]): Quat {
  let result: Quat = [1, 0, 0, 0]
  for (const rotation of rotations) {
    const half = (rotation.degrees * DEG) / 2
    const sin = Math.sin(half)
    const cos = Math.cos(half)
    const step: Quat =
      rotation.axis === "x" ? [cos, sin, 0, 0]
      : rotation.axis === "y" ? [cos, 0, sin, 0]
      : [cos, 0, 0, sin]
    result = quatMultiply(step, result)
  }
  return result
}

/** A package's readable size, for the assets panel. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
