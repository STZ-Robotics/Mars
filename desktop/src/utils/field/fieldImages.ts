// Registry of fields with an image, in the JSON format Elastic and
// AdvantageScope use.
//
// A field JSON describes WHERE the playing area is inside the image:
//
//   {
//     "game": "Rebuilt",
//     "field_image": "assets/fields/frc/2026-field.png",
//     "coordinate_system": "wall_blue",
//     "field_corners": { "top_left": [524, 94], "bottom_right": [3378, 1490] },
//     "field_size": [16.535, 8.069]
//   }
//
// The corners are image PIXELS and field_size is METERS, so that is where the
// px/m scale comes from. Without it a pose cannot be drawn over the photo: the
// image carries walls and driver stations outside the playing area, and its
// edge does not match the field's (0,0).

// Adding a field only takes dropping the .json and the .png in
// public/fields/ — the glob picks them up at build time without touching code.
const FIELD_JSON_MODULES = import.meta.glob("../../../public/fields/*.json", { eager: true }) as Record<
  string,
  { default: any }
>

// The three systems Elastic defines. Each field's JSON says which one it uses,
// but it can be overridden from the UI: if the robot publishes in another frame
// the pose shows up mirrored or turned, and changing the selector is quicker
// than editing the JSON.
export type CoordinateSystem = "wall_blue" | "center" | "center_rotated"

export const COORDINATE_SYSTEM_LABELS: Record<CoordinateSystem, string> = {
  wall_blue: "Wall / Blue corner (WPILib ≤2026)",
  center: "Center (WPILib 2027+)",
  center_rotated: "Center rotated (FTC)",
}

export interface FieldConfig {
  /** The file's name without extension; it is what gets saved in the settings. */
  key: string
  game: string
  program: string
  sourceUrl: string | null
  /** A servable URL for the image (the files in public/ are served at the root). */
  imageUrl: string
  coordinateSystem: CoordinateSystem
  /** Corners of the playing area, in image pixels. */
  topLeft: [number, number]
  bottomRight: [number, number]
  /** Length and width of the playing area, in meters. */
  sizeMeters: [number, number]
}

// Elastic writes the keys with underscores and AdvantageScope/WPILib with
// hyphens. Both are accepted so a JSON downloaded from either one works without
// editing it.
function pick(source: any, ...keys: string[]): any {
  for (const key of keys) {
    if (source && source[key] !== undefined) return source[key]
  }
  return undefined
}

function parseCoordinateSystem(value: unknown): CoordinateSystem {
  if (value === "wall_blue" || value === "wall-blue") return "wall_blue"
  if (value === "center_rotated" || value === "center-rotated") return "center_rotated"
  if (value === "center") return "center"
  // With no explicit value WPILib's classic system is assumed, which is what all
  // robot code written before 2027 publishes.
  return "wall_blue"
}

function parseField(path: string, raw: any): FieldConfig | null {
  const key = path.split("/").pop()!.replace(/\.json$/, "")

  const corners = pick(raw, "field_corners", "field-corners")
  const topLeft = pick(corners, "top_left", "top-left")
  const bottomRight = pick(corners, "bottom_right", "bottom-right")
  const size = pick(raw, "field_size", "field-size")
  const image = pick(raw, "field_image", "field-image")

  if (!Array.isArray(topLeft) || !Array.isArray(bottomRight) || !Array.isArray(size) || typeof image !== "string") {
    return null
  }
  if (size[0] <= 0 || size[1] <= 0) return null

  // The JSON carries Elastic's internal path ("assets/fields/frc/2026-field.png");
  // here only the file's name matters, which lives next to the .json.
  const imageFile = image.split("/").pop()!

  return {
    key,
    game: pick(raw, "game") ?? key,
    program: pick(raw, "program") ?? "FRC",
    sourceUrl: pick(raw, "source_url", "source-url") ?? null,
    imageUrl: `/fields/${imageFile}`,
    coordinateSystem: parseCoordinateSystem(pick(raw, "coordinate_system", "coordinate-system")),
    topLeft: [topLeft[0], topLeft[1]],
    bottomRight: [bottomRight[0], bottomRight[1]],
    sizeMeters: [size[0], size[1]],
  }
}

export const FIELDS: FieldConfig[] = Object.entries(FIELD_JSON_MODULES)
  .map(([path, mod]) => parseField(path, mod.default))
  .filter((f): f is FieldConfig => f !== null)
  // Newest game first (its year leads the file name), and of one year the
  // plain field before its variants ("2026-rebuilt" before "...-no-fuel"):
  // the first is the default, so it stays the current game's.
  .sort((a, b) => b.key.slice(0, 4).localeCompare(a.key.slice(0, 4)) || a.key.length - b.key.length || a.key.localeCompare(b.key))

/** A key reserved for the schematic drawing (without an image) that already existed. */
export const SCHEMATIC_FIELD_KEY = "schematic"

export function getField(key: string): FieldConfig | null {
  return FIELDS.find(f => f.key === key) ?? null
}

// --- Coordinate conversion ---------------------------------------------

// Everything is taken to a common INTERNAL frame: origin at the center of the
// playing area, +X towards the image's right and +Y up. The renderer only
// understands that frame; each coordinate system is a different input.
export interface InternalPose {
  x: number
  y: number
  theta: number // radianes
}

export function toInternal(
  system: CoordinateSystem,
  x: number,
  y: number,
  theta: number,
  sizeMeters: [number, number],
): InternalPose {
  switch (system) {
    // Origin at the blue alliance's corner, +X towards red. In the image blue
    // is on the RIGHT, so the robot's +X goes towards the left of the screen:
    // hence the subtraction and the half turn.
    case "wall_blue":
      return {
        x: sizeMeters[0] / 2 - x,
        y: sizeMeters[1] / 2 - y,
        theta: theta + Math.PI,
      }

    // FTC: origin at the center, +X towards the bottom of the image and +Y to the right.
    case "center_rotated":
      return { x: y, y: -x, theta: theta - Math.PI / 2 }

    // WPILib 2027+: it is already the internal frame.
    case "center":
      return { x, y, theta }
  }
}

/**
 * The inverse of `toInternal`: from the internal frame back to the one the
 * robot publishes in. Used by the coordinate readout under the pointer, which
 * has to show the same numbers you would see in the robot code.
 */
export function fromInternal(
  system: CoordinateSystem,
  x: number,
  y: number,
  theta: number,
  sizeMeters: [number, number],
): InternalPose {
  switch (system) {
    case "wall_blue":
      return {
        x: sizeMeters[0] / 2 - x,
        y: sizeMeters[1] / 2 - y,
        theta: theta - Math.PI,
      }
    case "center_rotated":
      return { x: -y, y: x, theta: theta + Math.PI / 2 }
    case "center":
      return { x, y, theta }
  }
}

/**
 * A half turn around the field's center.
 *
 * It is what the alliance button does: the red alliance's driver sees the
 * field from the other end, and comparing their view with the blue pilot's by
 * turning your head is not viable in the middle of a match.
 */
export function flipInternal(pose: InternalPose): InternalPose {
  return { x: -pose.x, y: -pose.y, theta: pose.theta + Math.PI }
}
