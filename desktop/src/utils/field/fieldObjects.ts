// Per-object options of the 2D Visualizer: defaults, sanitizing and drag
// heuristics.
//
// Every FieldObjectConfig field beyond the original five is OPTIONAL: a layout
// saved before it existed does not carry it. Instead of spreading `?? default`
// all over the renderer, everything goes once through `resolveObjectOptions`,
// which returns the complete version.

import {
  FieldObjectConfig, FieldObjectType, FieldSettings, FieldOrientation,
  ArrowAnchor, TrajectoryStyle, defaultFieldSettings,
} from "../../store/appStore"
import { isPoseTopic } from "./poseExtraction"
import { isModulesTopic } from "./swerveExtraction"

export interface ResolvedObjectOptions {
  hidden: boolean
  opacity: number
  showLabel: boolean
  trailSeconds: number
  /** null = use the object's color. */
  trailColor: string | null
  useModel: boolean
  arrowAnchor: ArrowAnchor
  arrowLength: number
  trajectoryStyle: TrajectoryStyle
  trajectoryWidth: number
  showWaypoints: boolean
  showHeading: boolean
  heatmapRadius: number
  heatmapCell: number
  targetLines: boolean
  targetLabels: boolean
  swerveArrangement: string
  swerveMaxSpeed: number
}

export const FIELD_OBJECT_TYPES: FieldObjectType[] = [
  "robot", "ghost", "trajectory", "arrow", "heatmap", "target", "swerve",
]

export const FIELD_OBJECT_LABELS: Record<FieldObjectType, string> = {
  robot: "Robot",
  ghost: "Ghost",
  trajectory: "Trajectory",
  arrow: "Arrow",
  heatmap: "Heatmap",
  target: "Vision target",
  swerve: "Swerve modules",
}

export const FIELD_OBJECT_HELP: Record<FieldObjectType, string> = {
  robot: "Chassis with coloured bumpers and a heading arrow, or your CAD model seen from above.",
  ghost: "The same chassis drawn translucent — for a setpoint or a second pose estimate on top of the real one.",
  trajectory: "Joins every pose of the array into a path.",
  arrow: "Only the heading arrow, no chassis. Useful for a velocity vector or an aiming direction.",
  heatmap: "Accumulates every pose the object visits and shades the field by how long it spent there.",
  target: "Marks each pose and draws the line that joins it to the robot — vision targets, game pieces, aiming points.",
  swerve: "Draws the four module vectors on the robot. Takes a SwerveModuleState[] topic, not a pose.",
}

/**
 * An object of this type is drawn anchored to the robot and not at its own
 * pose, so it needs a visible `robot` object in the list.
 */
export function needsRobotAnchor(type: FieldObjectType): boolean {
  return type === "swerve" || type === "target"
}

export function resolveObjectOptions(
  obj: FieldObjectConfig,
  settings: FieldSettings,
): ResolvedObjectOptions {
  const defaultTrail = settings.showTrails ? settings.trailSeconds : 0
  return {
    hidden: obj.hidden === true,
    opacity: clamp(obj.opacity ?? 1, 0.05, 1),
    showLabel: obj.showLabel ?? false,
    // The master switch turns off everyone's trails; with it on each object can
    // set its own or inherit the panel's.
    trailSeconds: settings.showTrails ? (obj.trailSeconds ?? defaultTrail) : 0,
    // A trail with its own color lets two poses of the SAME topic (the chassis
    // and its history) be compared without mixing them up.
    trailColor: typeof obj.trailColor === "string" ? obj.trailColor : null,
    useModel: obj.useModel ?? settings.robotRender === "model",
    arrowAnchor: obj.arrowAnchor ?? "center",
    arrowLength: positive(obj.arrowLength, settings.robotSizeMeters),
    trajectoryStyle: obj.trajectoryStyle ?? "solid",
    trajectoryWidth: positive(obj.trajectoryWidth, 2.5),
    showWaypoints: obj.showWaypoints ?? false,
    showHeading: obj.showHeading ?? false,
    heatmapRadius: positive(obj.heatmapRadius, 0.6),
    heatmapCell: positive(obj.heatmapCell, 0.15),
    targetLines: obj.targetLines ?? true,
    targetLabels: obj.targetLabels ?? false,
    swerveArrangement: obj.swerveArrangement ?? "0,1,2,3",
    swerveMaxSpeed: positive(obj.swerveMaxSpeed, 4.5),
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!isFinite(value)) return max
  return Math.min(max, Math.max(min, value))
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && isFinite(value) && value > 0 ? value : fallback
}

// --- Arrastre ---------------------------------------------------------------

/** Everything the page knows how to receive: geometry or module states. */
export function isFieldDroppable(topicType: string): boolean {
  return isPoseTopic(topicType) || isModulesTopic(topicType)
}

/**
 * Which object type is best to create when a topic is dropped.
 *
 * An array of poses is almost always a trajectory and a loose pose the robot;
 * the name wins over that, because a `Targets` carrying three poses is not a
 * path.
 */
export function defaultObjectTypeFor(topicName: string, topicType: string): FieldObjectType {
  const leaf = topicName.split("/").filter(Boolean).pop()?.toLowerCase() ?? ""

  if (!isPoseTopic(topicType) && isModulesTopic(topicType)) return "swerve"
  if (leaf.includes("target") || leaf.includes("vision") || leaf.includes("tag")) return "target"
  if (leaf.includes("trajectory") || leaf.includes("path")) return "trajectory"
  if (leaf.includes("setpoint") || leaf.includes("desired") || leaf.includes("goal")) return "ghost"
  return topicType.endsWith("[]") ? "trajectory" : "robot"
}

// --- Persistencia -----------------------------------------------------------

// A layout saved by an earlier version does not carry the new fields, and one
// edited by hand can carry garbage. The renderer draws these numbers straight as
// geometry: a NaN in the chassis length leaves the field blank without any
// visible error, so everything comes in through here.

const OBJECT_TYPES = new Set<string>(FIELD_OBJECT_TYPES)

export function normalizeFieldObjects(raw: unknown): FieldObjectConfig[] {
  if (!Array.isArray(raw)) return []

  return raw
    .filter(o => o && typeof o.id === "string" && typeof o.topicName === "string")
    .map((o: any): FieldObjectConfig => ({
      id: o.id,
      topicName: o.topicName,
      topicType: typeof o.topicType === "string" ? o.topicType : "",
      label: typeof o.label === "string" && o.label.length > 0 ? o.label : o.topicName,
      // An unknown type (from a newer version, or made up by hand) falls back
      // to the robot instead of leaving the object undrawn.
      type: OBJECT_TYPES.has(o.type) ? o.type : "robot",
      color: typeof o.color === "string" ? o.color : "#2f6fdb",

      hidden: o.hidden === true ? true : undefined,
      opacity: finite(o.opacity),
      showLabel: bool(o.showLabel),
      trailSeconds: finite(o.trailSeconds),
      trailColor: typeof o.trailColor === "string" ? o.trailColor : undefined,
      useModel: bool(o.useModel),
      arrowAnchor: o.arrowAnchor === "front" || o.arrowAnchor === "back" || o.arrowAnchor === "center"
        ? o.arrowAnchor : undefined,
      arrowLength: finite(o.arrowLength),
      trajectoryStyle: ["solid", "dashed", "points", "gradient"].includes(o.trajectoryStyle)
        ? o.trajectoryStyle : undefined,
      trajectoryWidth: finite(o.trajectoryWidth),
      showWaypoints: bool(o.showWaypoints),
      showHeading: bool(o.showHeading),
      heatmapRadius: finite(o.heatmapRadius),
      heatmapCell: finite(o.heatmapCell),
      targetLines: bool(o.targetLines),
      targetLabels: bool(o.targetLabels),
      swerveArrangement: typeof o.swerveArrangement === "string" ? o.swerveArrangement : undefined,
      swerveMaxSpeed: finite(o.swerveMaxSpeed),
    }))
}

export function normalizeFieldSettings(raw: unknown): FieldSettings {
  const merged = { ...defaultFieldSettings, ...(raw as Partial<FieldSettings> | undefined) }
  const source = (raw ?? {}) as Record<string, unknown>

  const length = number(source.robotSizeMeters, defaultFieldSettings.robotSizeMeters, 0.05, 3)

  return {
    ...merged,
    orientation: ([0, 90, 180, 270].includes(merged.orientation) ? merged.orientation : 0) as FieldOrientation,
    robotSizeMeters: length,
    // Earlier layouts only had one side: the chassis was square, so the width
    // inherits the length and nobody sees a change when updating.
    robotWidthMeters: number(source.robotWidthMeters, length, 0.05, 3),
    gridSpacing: number(source.gridSpacing, defaultFieldSettings.gridSpacing, 0.1, 5),
    trailSeconds: number(source.trailSeconds, defaultFieldSettings.trailSeconds, 0, 120),
    robotRender: merged.robotRender === "model" ? "model" : "icon",
    robotModelPath: typeof merged.robotModelPath === "string" ? merged.robotModelPath : null,
    robotModelName: typeof merged.robotModelName === "string" ? merged.robotModelName : null,
    robotModelScale: number(source.robotModelScale, defaultFieldSettings.robotModelScale, 1e-6, 1000),
    robotModelRotation: number(source.robotModelRotation, 0, -360, 360),
    robotModelColor: typeof merged.robotModelColor === "string" ? merged.robotModelColor : null,
    coordinateSystem: merged.coordinateSystem ?? null,
  }
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && isFinite(value) ? value : undefined
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

// --- Iconos -----------------------------------------------------------------

// The SVGs in public/icons are in color, so they are chosen by MEANING and not
// by tint. Several already exist for Mechanism 3D and Swerve, which have panels
// shaped like this one; for the ones with no file yet the final name is
// requested and SidebarIcon falls back on its own to the sibling and then to the
// tabler glyph, so the row never ends up with a broken square.
export interface FieldIcon {
  svg: string
  svgFallback?: string
  fallback: string
}

export const FIELD_OBJECT_ICONS: Record<FieldObjectType, FieldIcon> = {
  robot: { svg: "robot.svg", svgFallback: "part.svg", fallback: "ti-robot" },
  ghost: { svg: "ghost.svg", svgFallback: "part-shape.svg", fallback: "ti-ghost-2" },
  trajectory: { svg: "trajectory.svg", svgFallback: "sweep.svg", fallback: "ti-route" },
  arrow: { svg: "arrow.svg", svgFallback: "joint-prismatic.svg", fallback: "ti-arrow-narrow-right" },
  heatmap: { svg: "heatmap.svg", fallback: "ti-flame" },
  target: { svg: "target.svg", svgFallback: "joint-pose.svg", fallback: "ti-target" },
  // This one does exist: it is the same as the swerve visualizer's.
  swerve: { svg: "swerve.svg", fallback: "ti-steering-wheel" },
}

// --- Etiquetas --------------------------------------------------------------

/**
 * A name for a new object, numbering repeats of the same topic.
 *
 * The same topic can be dropped AS MANY TIMES as needed: publishing the same
 * Pose2d twice from the robot just to see it as a chassis and as a heat map
 * would spend bandwidth on something that is solved here. It is the same rule
 * the Functions page already uses for its series.
 */
export function nextObjectLabel(
  objects: { topicName: string }[],
  topicName: string,
  base?: string,
): string {
  const leaf = base ?? topicName.split("/").filter(Boolean).pop() ?? topicName
  const dupes = objects.filter(o => o.topicName === topicName).length
  return dupes === 0 ? leaf : `${leaf} (${dupes + 1})`
}
