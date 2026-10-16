// Extraction of swerve module states, chassis speeds and rotation from NT4
// values, reusing the Dashboard's struct decoder.

import { decodeStructBytes, decodeStructArrayBytes } from "../dashboard/valueDecoding"
import { getStructDef } from "../../store/structSchemaStore"
import { classifyTopic } from "../dashboard/topicClassification"

export interface ModuleState {
  speed: number   // m/s (for SwerveModulePosition it is 0: that struct carries no speed)
  angle: number   // RADIANS
}

export interface ChassisVelocities {
  vx: number      // m/s
  vy: number      // m/s
  omega: number   // rad/s
}

export interface ModulePosition {
  distance: number  // m accumulated by the wheel
  angle: number     // RADIANES
}

const DEG_TO_RAD = Math.PI / 180

const MODULE_STRUCTS = new Set(["SwerveModuleState", "SwerveModulePosition"])
const ROTATION_STRUCTS = new Set(["Rotation2d", "Pose2d", "Transform2d"])

function isNumericArrayTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  return c.isArrayType && !c.isStructType && ["double", "float", "int"].includes(c.baseType)
}

function isNumericTopic(topicType: string): boolean {
  return classifyTopic(topicType).isNumber
}

// --- Which topics does each source type accept? -------------------------------

export function isModulesTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  if (c.isStructArray && c.structName) return MODULE_STRUCTS.has(c.structName)
  return isNumericArrayTopic(topicType)
}

export function isChassisTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  if (c.isStructSingle && c.structName === "ChassisSpeeds") return true
  return isNumericArrayTopic(topicType)
}

export function isRotationTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  if (c.isStructSingle && c.structName) return ROTATION_STRUCTS.has(c.structName)
  return isNumericTopic(topicType)
}

export function isPositionsTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  return c.isStructArray && c.structName === "SwerveModulePosition"
}

export function isSwerveTopic(topicType: string): boolean {
  return isModulesTopic(topicType) || isChassisTopic(topicType) || isRotationTopic(topicType)
}

// The source type that matches by default when this topic is dropped.
export function defaultSourceTypeFor(topicType: string): "modules" | "positions" | "chassis" | "rotation" {
  const c = classifyTopic(topicType)
  if (c.isStructArray && c.structName === "SwerveModulePosition") return "positions"
  if (c.isStructArray && c.structName && MODULE_STRUCTS.has(c.structName)) return "modules"
  if (c.isStructSingle && c.structName === "ChassisSpeeds") return "chassis"
  if (c.isStructSingle && c.structName && ROTATION_STRUCTS.has(c.structName)) return "rotation"
  if (isNumericTopic(topicType)) return "rotation"
  return "modules"
}

// SwerveModulePosition = [Distance, Angle]: the distance accumulated by the
// wheel, which is where dead-reckoning odometry comes from.
export function extractModulePositions(liveValue: any, topicType: string): ModulePosition[] {
  if (!liveValue) return []
  if (!isPositionsTopic(topicType)) return []

  const def = getStructDef("SwerveModulePosition")
  if (!def) return []
  const bytes: number[] | undefined = liveValue.Raw
  if (!bytes || bytes.length === 0) return []

  return decodeStructArrayBytes(bytes, def).map(fields => ({
    distance: fields[0]?.value ?? 0,
    angle: (fields[1]?.value ?? 0) * DEG_TO_RAD,
  }))
}

// --- Extraction ------------------------------------------------------------

// SwerveModuleState = [Speed, Angle]; SwerveModulePosition = [Distance, Angle].
// In both, decodeStructBytes already returned the angle in degrees.
export function extractModuleStates(liveValue: any, topicType: string): ModuleState[] {
  if (!liveValue) return []
  const c = classifyTopic(topicType)

  if (c.isStructArray && c.structName && MODULE_STRUCTS.has(c.structName)) {
    const def = getStructDef(c.structName)
    if (!def) return []
    const bytes: number[] | undefined = liveValue.Raw
    if (!bytes || bytes.length === 0) return []

    const isPosition = c.structName === "SwerveModulePosition"
    return decodeStructArrayBytes(bytes, def).map(fields => ({
      // In SwerveModulePosition the first field is the distance traveled, not
      // speed: only the module's orientation is drawn.
      speed: isPosition ? 0 : (fields[0]?.value ?? 0),
      angle: (fields[1]?.value ?? 0) * DEG_TO_RAD,
    }))
  }

  if (isNumericArrayTopic(topicType)) {
    const arr: number[] | undefined = liveValue.NumberArray
    if (!arr) return []
    // The format of WPILib's "SwerveDrive" widget: [angle°, speed] pairs.
    const out: ModuleState[] = []
    for (let i = 0; i + 1 < arr.length; i += 2) {
      out.push({ angle: arr[i] * DEG_TO_RAD, speed: arr[i + 1] })
    }
    return out
  }

  return []
}

export function extractChassisVelocities(liveValue: any, topicType: string): ChassisVelocities | null {
  if (!liveValue) return null
  const c = classifyTopic(topicType)

  if (c.isStructSingle && c.structName === "ChassisSpeeds") {
    const def = getStructDef("ChassisSpeeds")
    if (!def) return null
    const bytes: number[] | undefined = liveValue.Raw
    if (!bytes || bytes.length === 0) return null
    const fields = decodeStructBytes(bytes, def)
    return {
      vx: fields[0]?.value ?? 0,
      vy: fields[1]?.value ?? 0,
      omega: (fields[2]?.value ?? 0) * DEG_TO_RAD, // ω came in °/s because of isAngle
    }
  }

  if (isNumericArrayTopic(topicType)) {
    const arr: number[] | undefined = liveValue.NumberArray
    if (!arr || arr.length < 3) return null
    return { vx: arr[0], vy: arr[1], omega: arr[2] }
  }

  return null
}

// Returns the chassis' rotation in RADIANS.
export function extractRotation(
  liveValue: any,
  topicType: string,
  angleUnits: "degrees" | "radians",
): number | null {
  if (!liveValue) return null
  const c = classifyTopic(topicType)

  if (c.isStructSingle && c.structName && ROTATION_STRUCTS.has(c.structName)) {
    const def = getStructDef(c.structName)
    if (!def) return null
    const bytes: number[] | undefined = liveValue.Raw
    if (!bytes || bytes.length === 0) return null
    const fields = decodeStructBytes(bytes, def)
    // Rotation2d: [θ]. Pose2d/Transform2d: [X, Y, θ]. Always the last field.
    const theta = fields[fields.length - 1]?.value ?? 0
    return theta * DEG_TO_RAD
  }

  if (isNumericTopic(topicType)) {
    const raw: number | undefined = liveValue.Number
    if (raw === undefined) return null
    return angleUnits === "degrees" ? raw * DEG_TO_RAD : raw
  }

  return null
}
