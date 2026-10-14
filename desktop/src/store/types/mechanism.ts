import type { Swerve3dProjection } from "./swerve"

// --- Mechanism2d Visualizer ---

// Unlike every other source in the app, a Mechanism2d source does NOT point at
// a topic but at a whole TABLE (dims + backgroundColor + roots + ligaments).
// That is why it stores a "prefix" instead of a topicName/topicType.
export interface MechanismSourceConfig {
  id: string
  prefix: string
  label: string
  visible: boolean
  /** null = keep the color each ligament publishes. */
  colorOverride: string | null
}

export interface MechanismSettings {
  showGrid: boolean
  showOrigin: boolean          // axes at the canvas' (0,0) (bottom-left corner)
  showJoints: boolean          // dots at the ends of each ligament
  useTopicBackground: boolean  // use the published backgroundColor instead of the dark background
  weightScale: number          // multiplier of the width each ligament publishes
}

export const defaultMechanismSettings: MechanismSettings = {
  showGrid: true,
  showOrigin: true,
  showJoints: true,
  useTopicBackground: true,
  weightScale: 1,
}

// --- Mechanism 3D ---
//
// A mechanism is described as a TREE of parts, like a URDF: each part hangs
// from another, has a fixed transform relative to its parent (the joint's
// origin) and a joint that moves it within that frame. That is enough for a
// three-link arm, a two-stage elevator, a wrist, or the "component poses"
// AdvantageKit publishes.
//
// Everything lives in WPILib's frame: +X forward, +Y to the left, +Z up,
// meters and radians (degrees only show up in the UI and in the fields that
// say so explicitly).

/**
 * - `fixed`: does not move; for hanging decorative parts.
 * - `revolute`: rotates about `axis` (with limits).
 * - `continuous`: the same without limits — a wheel, a flywheel.
 * - `prismatic`: slides along `axis` — an elevator, a telescoping stage.
 * - `pose`: the whole pose comes from a published Pose3d/Pose2d/Translation3d.
 */
export type Mechanism3dJointType = "fixed" | "revolute" | "continuous" | "prismatic" | "pose"

/** Units of the value coming from the topic, BEFORE converting to rad/m. */
export type Mechanism3dJointUnits =
  | "degrees" | "radians" | "rotations"
  | "meters" | "millimeters" | "inches"

/** Primitive drawn while the part has no file yet. */
export type Mechanism3dShape = "none" | "box" | "cylinder" | "sphere"

/** Where the model's origin goes, which is the point it rotates about. */
export type Mechanism3dAnchor = "origin" | "center" | "base"

export interface Mechanism3dJoint {
  type: Mechanism3dJointType
  /** Axis of motion in the part's frame; normalized when drawing. */
  axis: [number, number, number]
  /** Topic that drives the joint. null = manual value only. */
  topicName: string | null
  topicType: string
  /** Index to read when the topic is double[] or struct:X[]. null = the whole topic. */
  arrayIndex: number | null
  /** Struct field used as the value (0 = the first). */
  structField: number
  units: Mechanism3dJointUnits
  /** value = (raw, inverted) * scale + offset, in the units above. */
  scale: number
  offset: number
  invert: boolean
  /** Limits in the SAME units as `units`. null = no stop. */
  min: number | null
  max: number | null
  /** Value used when there is no topic, or when the scene is in manual mode. */
  manual: number
}

export interface Mechanism3dPart {
  id: string
  name: string
  /** Part it hangs from. null = anchored to the world. */
  parentId: string | null

  // --- Model ---
  modelPath: string | null
  modelName: string | null
  modelAnchor: Mechanism3dAnchor
  /** Scales the model so its largest side measures `modelFitSize`. */
  modelAutoFit: boolean
  modelFitSize: number
  /** Uniform scale when `modelAutoFit` is off (0.001 = mm -> m). */
  modelScale: number
  /** Adjustment of the model INSIDE the part, to align it with the joint's axis. */
  modelOffset: [number, number, number]
  modelRotation: [number, number, number]   // degrees
  /** Stand-in primitive while there is no file (or if a box is preferred). */
  shape: Mechanism3dShape
  shapeSize: [number, number, number]       // box: X/Y/Z · cylinder: radius/–/height · sphere: radius

  // --- Appearance ---
  color: string | null      // null = keep the file's materials
  opacity: number
  wireframe: boolean
  visible: boolean

  // --- Placement relative to the parent (the joint's origin) ---
  origin: [number, number, number]
  originRotation: [number, number, number]  // degrees, XYZ order
  /**
   * Center of rotation, in the PART's frame. [0,0,0] = the part rotates about
   * its origin.
   *
   * It is different from `modelOffset`: shifting the model moves it away from
   * the axis and leaves it orbiting in a circle; shifting the pivot moves the
   * AXIS inside the model without the model moving from where it is. It is
   * what is needed when the STL comes with its origin at a corner and the real
   * axis is at the bore.
   */
  pivot: [number, number, number]
  /** Keeps the gizmo from moving it; useful for the mechanism's base. */
  locked: boolean

  joint: Mechanism3dJoint
}

// --- Animation routines ---
//
// A routine moves joints on its own, with no robot connected: for showing the
// mechanism at a stand, for checking that a motion does not collide with
// itself, and for recording a clip without having to move sliders by hand.
//
// The steps run IN PARALLEL on a common timeline, each with its own start.
// That allows both a sequence (with staggered starts) and simultaneous motions
// (the arm goes up while the wrist turns), which purely sequential steps could
// not do.

export type Mechanism3dEasing = "linear" | "smooth"

export interface Mechanism3dRoutineStep {
  id: string
  /** Part it moves. If that part no longer exists, the step is ignored. */
  partId: string
  /** Values in the SAME units as the part's joint. */
  from: number
  to: number
  /** When it starts, from the beginning of the routine. */
  startMs: number
  durationMs: number
  easing: Mechanism3dEasing
  /** Goes back to the starting value when done: the classic "side to side". */
  pingPong: boolean
}

export interface Mechanism3dRoutine {
  id: string
  name: string
  loop: boolean
  steps: Mechanism3dRoutineStep[]
}

export type Mechanism3dGizmo = "off" | "translate" | "rotate" | "pivot"

export interface Mechanism3dSettings {
  /** The mechanism's name; travels in the exported JSON. */
  name: string
  showFloor: boolean
  gridCell: number          // m between grid lines
  showWorldAxes: boolean
  showJointAxes: boolean    // joint indicator (ring or rail) on each axis
  /** Size of those indicators; the default suits FRC arms. */
  jointScale: number
  /** Translucent sector with the allowed travel between min and max. */
  showJointLimits: boolean
  showPartLabels: boolean
  showBounds: boolean       // box around the selected part
  /** Ignores the topics and uses each joint's manual values. */
  manualOverride: boolean
  gizmo: Mechanism3dGizmo
  gizmoSpace: "world" | "local"
  gizmoSnap: boolean
  projection: Swerve3dProjection
  background: "light" | "dark"

  /** Saved routines; they travel in the exported JSON along with the parts. */
  routines: Mechanism3dRoutine[]
  /** Routine chosen in the playback bar. */
  activeRoutineId: string | null
}

export const defaultMechanism3dJoint: Mechanism3dJoint = {
  type: "fixed",
  axis: [0, 0, 1],
  topicName: null,
  topicType: "",
  arrayIndex: null,
  structField: 0,
  units: "degrees",
  scale: 1,
  offset: 0,
  invert: false,
  min: null,
  max: null,
  manual: 0,
}

export const defaultMechanism3dSettings: Mechanism3dSettings = {
  name: "Mechanism",
  showFloor: true,
  gridCell: 0.25,
  showWorldAxes: true,
  showJointAxes: true,
  jointScale: 1,
  showJointLimits: true,
  showPartLabels: false,
  showBounds: true,
  manualOverride: false,
  gizmo: "off",
  gizmoSpace: "local",
  gizmoSnap: false,
  projection: "perspective",
  background: "light",
  routines: [],
  activeRoutineId: null,
}

/** A new part, already placed at its parent's origin and not articulated. */
export function makeMechanism3dPart(id: string, name: string, parentId: string | null): Mechanism3dPart {
  return {
    id, name, parentId,
    modelPath: null,
    modelName: null,
    modelAnchor: "origin",
    modelAutoFit: false,
    modelFitSize: 0.5,
    modelScale: 1,
    modelOffset: [0, 0, 0],
    modelRotation: [0, 0, 0],
    // A small, visible box: a new part with nothing to draw would be
    // impossible to find in the scene.
    shape: "box",
    shapeSize: [0.1, 0.1, 0.1],
    color: null,
    opacity: 1,
    wireframe: false,
    visible: true,
    origin: [0, 0, 0],
    originRotation: [0, 0, 0],
    pivot: [0, 0, 0],
    locked: false,
    joint: { ...defaultMechanism3dJoint, axis: [0, 0, 1] },
  }
}
