// The Mechanism 3D's core: how a joint's value is read from NT, how it turns
// into a transform, how the part tree is built and how the whole configuration
// is exported/imported.
//
// Everything in this file is PURE (no three, no React, no DOM) on purpose: it
// is the part that can be silently wrong — a sign, a unit, a field index — and
// that is worth being able to test without mounting a scene.

import {
  Mechanism3dJoint, Mechanism3dJointUnits, Mechanism3dPart, Mechanism3dRoutine,
  Mechanism3dRoutineStep, Mechanism3dSettings, defaultMechanism3dJoint,
  defaultMechanism3dSettings, makeMechanism3dPart,
} from "../../store/appStore"
import { classifyTopic } from "../dashboard/topicClassification"
import { decodeStructBytes, decodeStructArrayBytes, DecodedStructField } from "../dashboard/valueDecoding"
import { getStructDef } from "../../store/structSchemaStore"

const DEG = Math.PI / 180

export type Vec3 = [number, number, number]
/** A quaternion in three.js' order: (x, y, z, w). */
export type Quat = [number, number, number, number]

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1]

export interface JointTransform {
  position: Vec3
  quaternion: Quat
}

export const IDENTITY_TRANSFORM: JointTransform = {
  position: [0, 0, 0],
  quaternion: IDENTITY_QUAT,
}

// --- Unidades ---------------------------------------------------------------

/**
 * Factor to go from the chosen unit to the internal unit (radians for joints
 * that rotate, meters for the ones that slide).
 *
 * If a unit of the other kind was chosen (degrees on a prismatic, for example)
 * it falls back to neutral instead of returning a meaningless factor: the
 * piece stays still and it is visible that the selector needs fixing, instead
 * of flying off to the Moon.
 */
export function unitScale(units: Mechanism3dJointUnits, kind: "angle" | "length"): number {
  if (kind === "angle") {
    switch (units) {
      case "radians": return 1
      case "rotations": return Math.PI * 2
      case "degrees": return DEG
      default: return DEG
    }
  }
  switch (units) {
    case "meters": return 1
    case "millimeters": return 0.001
    case "inches": return 0.0254
    default: return 1
  }
}

export function jointKind(joint: Mechanism3dJoint): "angle" | "length" | null {
  if (joint.type === "revolute" || joint.type === "continuous") return "angle"
  if (joint.type === "prismatic") return "length"
  return null
}

export const ANGULAR_UNITS: Mechanism3dJointUnits[] = ["degrees", "radians", "rotations"]
export const LINEAR_UNITS: Mechanism3dJointUnits[] = ["meters", "millimeters", "inches"]

export function unitLabel(units: Mechanism3dJointUnits): string {
  switch (units) {
    case "degrees": return "°"
    case "radians": return "rad"
    case "rotations": return "rot"
    case "meters": return "m"
    case "millimeters": return "mm"
    case "inches": return "in"
  }
}

// --- Vectores ---------------------------------------------------------------

export function normalizeAxis(axis: Vec3): Vec3 {
  const length = Math.hypot(axis[0], axis[1], axis[2])
  // A null axis would leave the rotation matrix at NaN and make the whole tree
  // branch disappear; it falls back to +Z, which is a new part's default.
  if (!isFinite(length) || length < 1e-9) return [0, 0, 1]
  return [axis[0] / length, axis[1] / length, axis[2] / length]
}

export function axisAngleQuat(axis: Vec3, angle: number): Quat {
  const [x, y, z] = normalizeAxis(axis)
  const half = angle / 2
  const s = Math.sin(half)
  return [x * s, y * s, z * s, Math.cos(half)]
}

// --- Lectura del topic --------------------------------------------------------

/** Topic types that can drive a joint. */
export function isJointTopic(topicType: string): boolean {
  // boolean[] goes before the text arrays filter: classifyTopic puts every
  // non-numeric, non-struct array into `isTextArray`, and a boolean[] is useful
  // for driving a row of solenoids.
  if (topicType === "boolean[]") return true
  const c = classifyTopic(topicType)
  if (c.isField2d || c.isString || c.isTextArray) return false
  return c.isNumber || c.isBoolean || c.isNumericArray || c.isStructSingle || c.isStructArray
}

/** A topic that can drive a `pose` joint. */
export function isPoseTopic(topicType: string): boolean {
  const c = classifyTopic(topicType)
  return c.isStructType && c.structName !== null && POSE_STRUCTS.has(c.structName)
}

const POSE_STRUCTS = new Set([
  "Pose3d", "Transform3d", "Pose2d", "Transform2d",
  "Translation3d", "Translation2d", "Rotation3d", "Rotation2d", "Quaternion",
])

/** The already decoded fields of the struct the joint points at, or null. */
function decodeJointStruct(liveValue: any, joint: Mechanism3dJoint): DecodedStructField[] | null {
  const c = classifyTopic(joint.topicType)
  const def = getStructDef(c.structName)
  if (!def) return null

  const bytes: number[] | undefined = liveValue?.Raw
  if (!bytes || bytes.length === 0) return null

  if (c.isStructArray) {
    const items = decodeStructArrayBytes(bytes, def)
    return items[joint.arrayIndex ?? 0] ?? null
  }
  return decodeStructBytes(bytes, def)
}

/**
 * The raw number the topic publishes, without scaling or converting.
 *
 * CAREFUL with structs: `decodeStructBytes` already returns the fields marked
 * as an angle in DEGREES (it is what the whole Dashboard does), so a
 * Rotation2d arrives in degrees and the units selector has to say "degrees".
 * It is set that way by default.
 */
export function resolveJointScalar(liveValue: any, joint: Mechanism3dJoint): number | null {
  if (!liveValue || !joint.topicName) return null
  const c = classifyTopic(joint.topicType)

  if (c.isStructType) {
    const fields = decodeJointStruct(liveValue, joint)
    const value = fields?.[joint.structField]?.value
    return typeof value === "number" && isFinite(value) ? value : null
  }

  if (c.isNumericArray) {
    const array: number[] | undefined = liveValue.NumberArray
    const value = array?.[joint.arrayIndex ?? 0]
    return typeof value === "number" ? value : null
  }

  if (joint.topicType === "boolean[]") {
    const array: boolean[] | undefined = liveValue.BooleanArray
    const value = array?.[joint.arrayIndex ?? 0]
    // A solenoid is a two-position prismatic joint: 0 or the full travel.
    // Returning 0/1 lets `scale` set that travel.
    return typeof value === "boolean" ? (value ? 1 : 0) : null
  }

  if (c.isBoolean) {
    const value: boolean | undefined = liveValue.Boolean
    return typeof value === "boolean" ? (value ? 1 : 0) : null
  }

  if (c.isNumber) {
    const value: number | undefined = liveValue.Number
    return typeof value === "number" && isFinite(value) ? value : null
  }

  return null
}

function clampToLimits(joint: Mechanism3dJoint, value: number): number {
  let out = value
  if (joint.min !== null && isFinite(joint.min)) out = Math.max(out, joint.min)
  if (joint.max !== null && isFinite(joint.max)) out = Math.min(out, joint.max)
  return out
}

/**
 * The joint's final value IN ITS OWN UNITS (the ones the panel shows). It is
 * the number seen in the inspector and the one the limits apply to; the
 * conversion to rad/m comes after.
 */
export function jointValue(joint: Mechanism3dJoint, liveValue: any, manualOverride: boolean): number {
  if (manualOverride || !joint.topicName) return clampToLimits(joint, joint.manual)

  const raw = resolveJointScalar(liveValue, joint)
  // With no data the manual value is used: otherwise opening the tab without a
  // connection would leave the whole mechanism folded at zero with no explanation.
  if (raw === null) return clampToLimits(joint, joint.manual)

  const signed = joint.invert ? -raw : raw
  return clampToLimits(joint, signed * joint.scale + joint.offset)
}

// --- Poses -------------------------------------------------------------------

/**
 * A full transform published as a struct. It is the equivalent of
 * AdvantageScope's "component poses": the robot publishes a Pose3d[] and each
 * part takes an index.
 *
 * The struct is identified by NAME and not by field count: Pose2d and
 * Translation3d both have three fields and mean different things.
 */
export function poseTransform(liveValue: any, joint: Mechanism3dJoint): JointTransform | null {
  const c = classifyTopic(joint.topicType)
  if (!c.structName) return null

  const fields = decodeJointStruct(liveValue, joint)
  if (!fields) return null
  const at = (i: number) => fields[i]?.value ?? 0

  switch (c.structName) {
    case "Pose3d":
    case "Transform3d":
      // X, Y, Z, QW, QX, QY, QZ -> three uses (x, y, z, w).
      return { position: [at(0), at(1), at(2)], quaternion: [at(4), at(5), at(6), at(3)] }

    case "Pose2d":
    case "Transform2d":
      // The third field is an angle, so it arrives in DEGREES.
      return { position: [at(0), at(1), 0], quaternion: axisAngleQuat([0, 0, 1], at(2) * DEG) }

    case "Translation3d":
      return { position: [at(0), at(1), at(2)], quaternion: IDENTITY_QUAT }

    case "Translation2d":
      return { position: [at(0), at(1), 0], quaternion: IDENTITY_QUAT }

    case "Rotation3d":
    case "Quaternion":
      // W, X, Y, Z
      return { position: [0, 0, 0], quaternion: [at(1), at(2), at(3), at(0)] }

    case "Rotation2d":
      return { position: [0, 0, 0], quaternion: axisAngleQuat([0, 0, 1], at(0) * DEG) }

    default:
      return null
  }
}

/** The transform the joint applies to its part, relative to its origin. */
export function jointTransform(
  joint: Mechanism3dJoint,
  liveValue: any,
  manualOverride: boolean,
): JointTransform {
  if (joint.type === "fixed") return IDENTITY_TRANSFORM

  if (joint.type === "pose") {
    // A pose has no "manual value": it is six degrees of freedom, not a number.
    // With no data the part stays at its parent's origin.
    if (manualOverride || !joint.topicName) return IDENTITY_TRANSFORM
    return poseTransform(liveValue, joint) ?? IDENTITY_TRANSFORM
  }

  return jointTransformFromValue(joint, jointValue(joint, liveValue, manualOverride))
}

/**
 * A joint's transform from an already resolved value, in the joint's units.
 *
 * It exists separately because the value does not always come from NT: an
 * animation routine produces it on its own, and it has to reach the scene by
 * the same path.
 */
export function jointTransformFromValue(joint: Mechanism3dJoint, value: number): JointTransform {
  if (joint.type === "fixed" || joint.type === "pose") return IDENTITY_TRANSFORM

  if (joint.type === "prismatic") {
    const distance = value * unitScale(joint.units, "length")
    const axis = normalizeAxis(joint.axis)
    return {
      position: [axis[0] * distance, axis[1] * distance, axis[2] * distance],
      quaternion: IDENTITY_QUAT,
    }
  }

  return {
    position: [0, 0, 0],
    quaternion: axisAngleQuat(joint.axis, value * unitScale(joint.units, "angle")),
  }
}

// --- Enlace de topics ----------------------------------------------------------

/** Structs that carry a full transform (or at least a 3D rotation). */
const TRANSFORM_STRUCTS = new Set([
  "Pose3d", "Transform3d", "Pose2d", "Transform2d",
  "Translation3d", "Translation2d", "Rotation3d", "Quaternion",
])

/**
 * A joint with a freshly bound topic, already with the defaults that match
 * THAT data type.
 *
 * Choosing the type automatically only happens when the joint was still
 * `fixed`: if the user already decided it is a prismatic, binding a topic has
 * no reason to change that.
 */
export function bindJointTopic(
  joint: Mechanism3dJoint,
  topicName: string,
  topicType: string,
): Mechanism3dJoint {
  const c = classifyTopic(topicType)
  const isArray = c.isNumericArray || c.isStructArray || topicType === "boolean[]"

  let type = joint.type
  let units = joint.units
  if (joint.type === "fixed") {
    if (c.structName !== null && TRANSFORM_STRUCTS.has(c.structName)) type = "pose"
    else type = "revolute"
  }
  // Rotation2d and the fields marked as an angle come out of the decoder in
  // degrees, so that is the right selector.
  if (type === "revolute" || type === "continuous") {
    if (!ANGULAR_UNITS.includes(units)) units = "degrees"
  } else if (type === "prismatic" && !LINEAR_UNITS.includes(units)) {
    units = "meters"
  }

  return {
    ...joint,
    type,
    units,
    topicName,
    topicType,
    arrayIndex: isArray ? (joint.arrayIndex ?? 0) : null,
  }
}

// --- Pivote ---------------------------------------------------------------------

/**
 * Where a point of the part ends up after applying the joint, turning around
 * `pivot` instead of around the origin.
 *
 *   world = P + T + R·(p − P)
 *
 * At rest (R identity, T zero) the point does NOT move however the pivot is
 * changed: that is why moving the center of rotation does not rearrange the
 * model, which is exactly what cannot be done by shifting the mesh's offset.
 */
export function applyJointToPoint(point: Vec3, pivot: Vec3, transform: JointTransform): Vec3 {
  const local: Vec3 = [point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]]
  const rotated = rotateByQuat(local, transform.quaternion)
  return [
    pivot[0] + transform.position[0] + rotated[0],
    pivot[1] + transform.position[1] + rotated[1],
    pivot[2] + transform.position[2] + rotated[2],
  ]
}

/** v' = q · v · q* */
export function rotateByQuat(v: Vec3, q: Quat): Vec3 {
  const [x, y, z, w] = q
  // Rodrigues' formula in quaternion form: v + 2w(u×v) + 2u×(u×v).
  const ux = y * v[2] - z * v[1]
  const uy = z * v[0] - x * v[2]
  const uz = x * v[1] - y * v[0]
  return [
    v[0] + 2 * (w * ux + y * uz - z * uy),
    v[1] + 2 * (w * uy + z * ux - x * uz),
    v[2] + 2 * (w * uz + x * uy - y * ux),
  ]
}

/** A prismatic's allowed travel, already in METERS. */
export function travelRange(joint: Mechanism3dJoint, fallback: number): { min: number; max: number } {
  const factor = unitScale(joint.units, "length")
  const min = joint.min !== null && isFinite(joint.min) ? joint.min * factor : -fallback
  const max = joint.max !== null && isFinite(joint.max) ? joint.max * factor : fallback
  // An inverted range (min > max) would leave the rail with a negative length.
  return min <= max ? { min, max } : { min: max, max: min }
}

/** A revolute's allowed travel, already in RADIANS; null = no limits. */
export function sweepRange(joint: Mechanism3dJoint): { min: number; max: number } | null {
  if (joint.min === null || joint.max === null) return null
  if (!isFinite(joint.min) || !isFinite(joint.max)) return null
  const factor = unitScale(joint.units, "angle")
  const min = joint.min * factor
  const max = joint.max * factor
  if (max <= min) return null
  if (max - min >= Math.PI * 2) return null
  return { min, max }
}

// --- Part tree ----------------------------------------------------------

export interface PartNode {
  part: Mechanism3dPart
  children: PartNode[]
  depth: number
}

/**
 * Builds the tree from `parentId`. A part whose parent does not exist, or that
 * forms a cycle, hangs from the root: with a hand-imported file that happens,
 * and it is better to see it misplaced than to have it vanish without warning.
 */
export function buildPartTree(parts: Mechanism3dPart[]): PartNode[] {
  const byId = new Map(parts.map(p => [p.id, p]))

  const isRooted = (part: Mechanism3dPart): boolean => {
    const seen = new Set<string>([part.id])
    let current = part.parentId
    while (current !== null) {
      if (seen.has(current)) return false      // ciclo
      const parent = byId.get(current)
      if (!parent) return false                // padre inexistente
      seen.add(current)
      current = parent.parentId
    }
    return true
  }

  const nodes = new Map<string, PartNode>()
  parts.forEach(part => nodes.set(part.id, { part, children: [], depth: 0 }))

  const roots: PartNode[] = []
  parts.forEach(part => {
    const node = nodes.get(part.id)!
    const parent = part.parentId !== null && isRooted(part) ? nodes.get(part.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  })

  const setDepth = (node: PartNode, depth: number) => {
    node.depth = depth
    node.children.forEach(child => setDepth(child, depth + 1))
  }
  roots.forEach(root => setDepth(root, 0))

  return roots
}

/** The tree flattened in drawing order, to list it in the panel. */
export function flattenTree(roots: PartNode[]): PartNode[] {
  const out: PartNode[] = []
  const walk = (node: PartNode) => {
    out.push(node)
    node.children.forEach(walk)
  }
  roots.forEach(walk)
  return out
}

/** Ids of the part and of everything hanging from it (to delete it as a block). */
export function descendantIds(parts: Mechanism3dPart[], id: string): string[] {
  const out = [id]
  let added = true
  while (added) {
    added = false
    parts.forEach(part => {
      if (part.parentId !== null && out.includes(part.parentId) && !out.includes(part.id)) {
        out.push(part.id)
        added = true
      }
    })
  }
  return out
}

/**
 * Can `partId` hang from `candidateId` without forming a cycle? The parent
 * selector uses this so as not to offer options that would break the tree.
 */
export function canReparent(parts: Mechanism3dPart[], partId: string, candidateId: string | null): boolean {
  if (candidateId === null) return true
  if (candidateId === partId) return false
  return !descendantIds(parts, partId).includes(candidateId)
}

// --- Normalization ------------------------------------------------------------

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && isFinite(value) ? value : fallback
}

function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return fallback
  return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])]
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && isFinite(value) ? value : null
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback
}

const JOINT_TYPES = ["fixed", "revolute", "continuous", "prismatic", "pose"] as const
const JOINT_UNITS = ["degrees", "radians", "rotations", "meters", "millimeters", "inches"] as const
const SHAPES = ["none", "box", "cylinder", "sphere"] as const
const ANCHORS = ["origin", "center", "base"] as const
const GIZMOS = ["off", "translate", "rotate", "pivot"] as const

export function normalizeJoint(raw: any): Mechanism3dJoint {
  const base = defaultMechanism3dJoint
  return {
    type: oneOf(raw?.type, JOINT_TYPES, base.type),
    axis: vec3(raw?.axis, base.axis),
    topicName: typeof raw?.topicName === "string" && raw.topicName.length > 0 ? raw.topicName : null,
    topicType: str(raw?.topicType, base.topicType),
    arrayIndex: nullableNum(raw?.arrayIndex) === null ? null : Math.max(0, Math.round(raw.arrayIndex)),
    structField: Math.max(0, Math.round(num(raw?.structField, base.structField))),
    units: oneOf(raw?.units, JOINT_UNITS, base.units),
    scale: num(raw?.scale, base.scale),
    offset: num(raw?.offset, base.offset),
    invert: raw?.invert === true,
    min: nullableNum(raw?.min),
    max: nullableNum(raw?.max),
    manual: num(raw?.manual, base.manual),
  }
}

/**
 * A part without an id cannot be referenced or deleted, so it is discarded.
 * Everything else is filled with the default: a config exported by an earlier
 * version has to keep opening.
 */
export function normalizePart(raw: any): Mechanism3dPart | null {
  if (!raw || typeof raw !== "object") return null
  if (typeof raw.id !== "string" || raw.id.length === 0) return null

  const base = makeMechanism3dPart(raw.id, str(raw.name, "Part"), null)
  return {
    ...base,
    parentId: typeof raw.parentId === "string" && raw.parentId.length > 0 ? raw.parentId : null,
    modelPath: typeof raw.modelPath === "string" && raw.modelPath.length > 0 ? raw.modelPath : null,
    modelName: typeof raw.modelName === "string" && raw.modelName.length > 0 ? raw.modelName : null,
    modelAnchor: oneOf(raw.modelAnchor, ANCHORS, base.modelAnchor),
    modelAutoFit: raw.modelAutoFit === true,
    modelFitSize: Math.max(1e-4, num(raw.modelFitSize, base.modelFitSize)),
    modelScale: num(raw.modelScale, base.modelScale) || base.modelScale,
    modelOffset: vec3(raw.modelOffset, base.modelOffset),
    modelRotation: vec3(raw.modelRotation, base.modelRotation),
    shape: oneOf(raw.shape, SHAPES, base.shape),
    shapeSize: vec3(raw.shapeSize, base.shapeSize),
    color: typeof raw.color === "string" ? raw.color : null,
    opacity: Math.min(1, Math.max(0.02, num(raw.opacity, base.opacity))),
    wireframe: raw.wireframe === true,
    visible: raw.visible !== false,
    origin: vec3(raw.origin, base.origin),
    originRotation: vec3(raw.originRotation, base.originRotation),
    pivot: vec3(raw.pivot, base.pivot),
    locked: raw.locked === true,
    joint: normalizeJoint(raw.joint),
  }
}

export function normalizeParts(raw: unknown): Mechanism3dPart[] {
  if (!Array.isArray(raw)) return []
  const parts = raw.map(normalizePart).filter((p): p is Mechanism3dPart => p !== null)

  // Two parts with the same id would break the tree and the selection; the
  // first one wins, which is the one that was already there.
  const seen = new Set<string>()
  return parts.filter(part => {
    if (seen.has(part.id)) return false
    seen.add(part.id)
    return true
  })
}

export function normalizeSettings(raw: any): Mechanism3dSettings {
  const base = defaultMechanism3dSettings
  return {
    ...base,
    ...(raw && typeof raw === "object" ? raw : {}),
    name: str(raw?.name, base.name),
    gridCell: Math.max(0.02, num(raw?.gridCell, base.gridCell)),
    jointScale: Math.min(8, Math.max(0.1, num(raw?.jointScale, base.jointScale))),
    gizmo: oneOf(raw?.gizmo, GIZMOS, base.gizmo),
    gizmoSpace: oneOf(raw?.gizmoSpace, ["world", "local"] as const, base.gizmoSpace),
    projection: oneOf(raw?.projection, ["perspective", "orthographic"] as const, base.projection),
    background: oneOf(raw?.background, ["light", "dark"] as const, base.background),
    routines: normalizeRoutines(raw?.routines),
    activeRoutineId: typeof raw?.activeRoutineId === "string" ? raw.activeRoutineId : null,
  }
}

// --- Animation routines ---------------------------------------------------------

/** How long the whole routine lasts, in ms. 0 = it has nothing to animate. */
export function routineDuration(routine: Mechanism3dRoutine): number {
  return routine.steps.reduce((longest, step) => {
    const total = step.startMs + step.durationMs * (step.pingPong ? 2 : 1)
    return Math.max(longest, total)
  }, 0)
}

function ease(t: number, easing: Mechanism3dRoutineStep["easing"]): number {
  // smoothstep: it starts and stops smoothly, which is what keeps a repeated
  // movement from looking robotic in a showcase.
  return easing === "smooth" ? t * t * (3 - 2 * t) : t
}

/**
 * Each part's value at instant `timeMs`, in its joint's units.
 *
 * Before a step starts the part stays at its initial value, and after it ends
 * at the final one (or back at the initial one if it goes back and forth):
 * that way the mechanism never jumps to a pose without a transition. If two
 * steps point at the same part, the last one in the list wins.
 */
export function evaluateRoutine(routine: Mechanism3dRoutine, timeMs: number): Record<string, number> {
  const out: Record<string, number> = {}

  routine.steps.forEach(step => {
    const duration = Math.max(step.durationMs, 1)
    const total = duration * (step.pingPong ? 2 : 1)
    const local = timeMs - step.startMs

    let progress: number
    if (local <= 0) progress = 0
    else if (local >= total) progress = step.pingPong ? 0 : 1
    else {
      const raw = local / duration
      progress = step.pingPong && raw > 1 ? 2 - raw : raw
    }

    out[step.partId] = step.from + (step.to - step.from) * ease(progress, step.easing)
  })

  return out
}

export function normalizeRoutineStep(raw: any): Mechanism3dRoutineStep | null {
  if (!raw || typeof raw !== "object") return null
  if (typeof raw.id !== "string" || raw.id.length === 0) return null
  if (typeof raw.partId !== "string" || raw.partId.length === 0) return null

  return {
    id: raw.id,
    partId: raw.partId,
    from: num(raw.from, 0),
    to: num(raw.to, 0),
    startMs: Math.max(0, num(raw.startMs, 0)),
    // A duration of 0 would divide by zero when interpolating.
    durationMs: Math.max(1, num(raw.durationMs, 1000)),
    easing: oneOf(raw.easing, ["linear", "smooth"] as const, "smooth"),
    pingPong: raw.pingPong !== false,
  }
}

export function normalizeRoutines(raw: unknown): Mechanism3dRoutine[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()

  return raw
    .map((entry: any): Mechanism3dRoutine | null => {
      if (!entry || typeof entry !== "object") return null
      if (typeof entry.id !== "string" || entry.id.length === 0) return null
      if (seen.has(entry.id)) return null
      seen.add(entry.id)

      return {
        id: entry.id,
        name: str(entry.name, "Routine"),
        loop: entry.loop !== false,
        steps: Array.isArray(entry.steps)
          ? entry.steps.map(normalizeRoutineStep).filter((x: any): x is Mechanism3dRoutineStep => x !== null)
          : [],
      }
    })
    .filter((r): r is Mechanism3dRoutine => r !== null)
}

/**
 * A "back and forth" step for a joint, which is the showcase asked for 90% of
 * the time. It takes the limits if they are set; if not, a reasonable travel
 * according to what the joint does.
 */
export function sweepStep(part: Mechanism3dPart, id: string): Mechanism3dRoutineStep | null {
  const kind = jointKind(part.joint)
  if (kind === null) return null

  const fallback = kind === "length"
    ? 0.3
    : part.joint.units === "radians" ? Math.PI / 4 : part.joint.units === "rotations" ? 0.25 : 45

  return {
    id,
    partId: part.id,
    from: part.joint.min ?? -fallback,
    to: part.joint.max ?? fallback,
    startMs: 0,
    durationMs: 1500,
    easing: "smooth",
    pingPong: true,
  }
}

// --- Exportable configuration --------------------------------------------------

export const MECHANISM3D_FORMAT = "mars-mechanism3d"
export const MECHANISM3D_VERSION = 1

export interface Mechanism3dConfigFile {
  format: string
  version: number
  name: string
  settings: Mechanism3dSettings
  parts: Mechanism3dPart[]
}

export function serializeMechanism3d(parts: Mechanism3dPart[], settings: Mechanism3dSettings): string {
  const file: Mechanism3dConfigFile = {
    format: MECHANISM3D_FORMAT,
    version: MECHANISM3D_VERSION,
    name: settings.name,
    settings,
    parts,
  }
  return JSON.stringify(file, null, 2)
}

/**
 * Reads an exported config. Throws with a readable message instead of
 * returning null: the user just picked a file by hand and needs to know WHY it
 * is no good.
 */
export function parseMechanism3d(text: string): { parts: Mechanism3dPart[]; settings: Mechanism3dSettings } {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`Not valid JSON: ${(error as Error).message}`)
  }

  if (!raw || typeof raw !== "object") throw new Error("The file does not contain an object.")
  if (raw.format !== MECHANISM3D_FORMAT) {
    throw new Error(`Not a mechanism config (expected "format": "${MECHANISM3D_FORMAT}").`)
  }
  if (typeof raw.version === "number" && raw.version > MECHANISM3D_VERSION) {
    throw new Error(`This file was written by a newer version (v${raw.version}); this build reads up to v${MECHANISM3D_VERSION}.`)
  }

  const parts = normalizeParts(raw.parts)
  if (parts.length === 0) throw new Error("The config has no usable parts.")

  const settings = normalizeSettings({ ...raw.settings, name: raw.name ?? raw.settings?.name })
  return { parts, settings }
}

/** A copy of a part with a new id, ready to insert next to the original. */
export function duplicatePart(part: Mechanism3dPart, id: string): Mechanism3dPart {
  return {
    ...part,
    id,
    name: `${part.name} copy`,
    origin: [...part.origin] as Vec3,
    originRotation: [...part.originRotation] as Vec3,
    pivot: [...part.pivot] as Vec3,
    modelOffset: [...part.modelOffset] as Vec3,
    modelRotation: [...part.modelRotation] as Vec3,
    shapeSize: [...part.shapeSize] as Vec3,
    joint: { ...part.joint, axis: [...part.joint.axis] as Vec3 },
  }
}
