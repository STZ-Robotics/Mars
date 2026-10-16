// Extraction of poses (x, y, θ) from NT4 values, for the 2D Visualizer.
//
// It reuses the WPILib binary struct decoder the Dashboard already uses
// (valueDecoding.ts): here we only map the already decoded fields to the
// (x, y, θ) triple the field renderer needs.

import { decodeStructBytes, decodeStructArrayBytes } from "../dashboard/valueDecoding"
import { getStructDef } from "../../store/structSchemaStore"
import { classifyTopic } from "../dashboard/topicClassification"

export interface FieldPose {
  x: number      // meters, the field's long axis
  y: number      // metros, eje corto
  theta: number  // RADIANS (decodeStructBytes returns degrees; it is converted here)

}

// FRC field (2023-2025 seasons): 16.541 m x 8.211 m.
// WPILib's coordinate origin is the bottom-left corner seen from the blue
// alliance, with X towards the red alliance and Y up.
export const FIELD_LENGTH_M = 16.541
export const FIELD_WIDTH_M = 8.211

// Structs a pose can be taken from. Transform2d/3d share their binary layout
// with Pose2d/3d, and the Translations only provide a translation (θ = 0).
const POSE_STRUCTS = new Set([
  "Pose2d", "Transform2d", "Translation2d",
  "Pose3d", "Transform3d", "Translation3d",
])

function isNumericArrayTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  return c.isArrayType && !c.isStructType && ["double", "float", "int"].includes(c.baseType)
}

// A topic is usable on the field if it is a geometry struct (loose or array)
// or a double[] of triples — the classic WPILib Field2d format.
export function isPoseTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  if (c.isStructType && c.structName) return POSE_STRUCTS.has(c.structName)
  return isNumericArrayTopic(topicType)
}

// Yaw (rotation in the field's plane) from a Pose3d's quaternion.
function quaternionYaw(w: number, x: number, y: number, z: number): number {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
}

function structToPose(structName: string, fields: { value: number }[]): FieldPose | null {
  const v = (i: number) => fields[i]?.value ?? 0
  const DEG_TO_RAD = Math.PI / 180

  switch (structName) {
    // decodeStructBytes already took θ to degrees (isAngle), so it is reverted.
    case "Pose2d":
    case "Transform2d":
      return { x: v(0), y: v(1), theta: v(2) * DEG_TO_RAD }
    case "Translation2d":
    case "Translation3d":
      return { x: v(0), y: v(1), theta: 0 }
    // Pose3d/Transform3d: X, Y, Z, QW, QX, QY, QZ
    case "Pose3d":
    case "Transform3d":
      return { x: v(0), y: v(1), theta: quaternionYaw(v(3), v(4), v(5), v(6)) }
    default:
      return null
  }
}

// Returns ALL the poses the value contains: a single one for a loose struct,
// N for a struct:X[] or for a double[] of triples.
export function extractPoses(liveValue: any, topicType: string): FieldPose[] {
  if (!liveValue) return []
  const c = classifyTopic(topicType)

  if (c.isStructType && c.structName) {
    const def = getStructDef(c.structName)
    if (!def) return []
    const bytes: number[] | undefined = liveValue.Raw
    if (!bytes || bytes.length === 0) return []

    const instances = c.isArrayType
      ? decodeStructArrayBytes(bytes, def)
      : [decodeStructBytes(bytes, def)]

    return instances
      .map(fields => structToPose(c.structName!, fields))
      .filter((p): p is FieldPose => p !== null)
  }

  if (isNumericArrayTopic(topicType)) {
    const arr: number[] | undefined = liveValue.NumberArray
    if (!arr) return []
    // WPILib's Field2d publishes [x, y, θ] per object, with θ in DEGREES.
    const out: FieldPose[] = []
    for (let i = 0; i + 2 < arr.length; i += 3) {
      out.push({ x: arr[i], y: arr[i + 1], theta: arr[i + 2] * (Math.PI / 180) })
    }
    return out
  }

  return []
}
