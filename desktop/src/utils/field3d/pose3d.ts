// Extraction of 3D poses from NT4 values.
//
// It reuses the WPILib binary struct decoder the Dashboard already uses
// (valueDecoding.ts) and lifts it to the translation + quaternion pair the
// scene needs. A Pose2d is lifted to 3D with z = 0 and a pure turn around +Z,
// which is exactly what `Pose3d(Pose2d)` does in WPILib.
//
// The generic decoder returns the fields marked `isAngle` already converted to
// DEGREES (the Dashboard widgets show them that way), which is why there are
// conversions back to radians here: the scene's internal angles are always
// radians.

import { decodeStructBytes, decodeStructArrayBytes } from "../dashboard/valueDecoding"
import { getStructDef } from "../../store/structSchemaStore"
import { classifyTopic } from "../dashboard/topicClassification"
import { Pose3D, quatFromYaw, normalizeQuat } from "./frames"

const DEG_TO_RAD = Math.PI / 180

/**
 * How to interpret a `double[]`.
 *
 * The legacy `Field2d` format packs [x, y, θ°] triples and AdvantageScope's
 * packs [x, y, z, qw, qx, qy, qz] septets. An array of 21 numbers fits both,
 * so when the heuristic is not enough the object can pin it by hand.
 */
export type ArrayFormat = "auto" | "pose2d" | "pose3d"

/** Structs a pose can be taken from. */
const POSE_STRUCTS = new Set([
  "Pose3d", "Transform3d", "Translation3d",
  "Pose2d", "Transform2d", "Translation2d",
])

function isNumericArrayTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  return c.isArrayType && !c.isStructType && ["double", "float", "int"].includes(c.baseType)
}

/** A topic is usable on the 3D field if it carries geometry, loose or in an array. */
export function isPose3dTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  if (c.isStructType && c.structName) return POSE_STRUCTS.has(c.structName)
  return isNumericArrayTopic(topicType)
}

/** The most poses a topic carries: 1 if it is a loose struct. */
export function isSinglePoseTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  return !c.isArrayType
}

function structToPose(structName: string, fields: { value: number }[]): Pose3D | null {
  const v = (i: number) => fields[i]?.value ?? 0

  switch (structName) {
    // X, Y, Z, QW, QX, QY, QZ — the quaternion comes raw from the struct.
    case "Pose3d":
    case "Transform3d": {
      const q = normalizeQuat([v(3), v(4), v(5), v(6)])
      return { x: v(0), y: v(1), z: v(2), qw: q[0], qx: q[1], qy: q[2], qz: q[3] }
    }
    case "Translation3d":
      return { x: v(0), y: v(1), z: v(2), qw: 1, qx: 0, qy: 0, qz: 0 }
    case "Pose2d":
    case "Transform2d": {
      const q = quatFromYaw(v(2) * DEG_TO_RAD)
      return { x: v(0), y: v(1), z: 0, qw: q[0], qx: q[1], qy: q[2], qz: q[3] }
    }
    case "Translation2d":
      return { x: v(0), y: v(1), z: 0, qw: 1, qx: 0, qy: 0, qz: 0 }
    default:
      return null
  }
}

/**
 * Decides whether a `double[]` comes in triples or in septets.
 *
 * Multiples of 7 that are NOT multiples of 3 can only be Pose3d and vice
 * versa. On a tie (0, 21, 42...) Pose2d wins, which is the old format and the
 * only one WPILib's `Field2d` publishes without the team doing anything
 * special: whoever publishes septets is usually using structs anyway.
 */
function guessArrayFormat(length: number): "pose2d" | "pose3d" {
  if (length % 7 === 0 && length % 3 !== 0) return "pose3d"
  return "pose2d"
}

function decodeNumberArray(arr: number[], format: ArrayFormat): Pose3D[] {
  const resolved = format === "auto" ? guessArrayFormat(arr.length) : format
  const out: Pose3D[] = []

  if (resolved === "pose3d") {
    for (let i = 0; i + 6 < arr.length; i += 7) {
      const q = normalizeQuat([arr[i + 3], arr[i + 4], arr[i + 5], arr[i + 6]])
      out.push({
        x: arr[i], y: arr[i + 1], z: arr[i + 2],
        qw: q[0], qx: q[1], qy: q[2], qz: q[3],
      })
    }
    return out
  }

  // Field2d publishes [x, y, θ] per object, with θ in DEGREES.
  for (let i = 0; i + 2 < arr.length; i += 3) {
    const q = quatFromYaw(arr[i + 2] * DEG_TO_RAD)
    out.push({ x: arr[i], y: arr[i + 1], z: 0, qw: q[0], qx: q[1], qy: q[2], qz: q[3] })
  }
  return out
}

/**
 * ALL the poses the value contains: one for a loose struct, N for a
 * `struct:X[]` or for a `double[]`.
 */
export function extractPoses3d(
  liveValue: any,
  topicType: string,
  format: ArrayFormat = "auto",
): Pose3D[] {
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
      .filter((p): p is Pose3D => p !== null && isFinite(p.x) && isFinite(p.y) && isFinite(p.z))
  }

  if (isNumericArrayTopic(topicType)) {
    const arr: number[] | undefined = liveValue.NumberArray
    if (!arr) return []
    return decodeNumberArray(arr, format).filter(p => isFinite(p.x) && isFinite(p.y) && isFinite(p.z))
  }

  return []
}

/** The value's first pose, or null. It is what the "robot" object consumes. */
export function extractPose3d(
  liveValue: any,
  topicType: string,
  format: ArrayFormat = "auto",
): Pose3D | null {
  return extractPoses3d(liveValue, topicType, format)[0] ?? null
}
