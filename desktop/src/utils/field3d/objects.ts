// Per-object options of the Field 3D: defaults, sanitizing and drag heuristics.
//
// The same idea as `utils/field/fieldObjects.ts` for the 2D visualizer: every
// field beyond the six mandatory ones is OPTIONAL, and instead of spreading
// `?? default` all over the renderer everything goes once through
// `resolveField3dOptions`, which returns the complete version.

import {
  Field3dObjectConfig, Field3dObjectType, Field3dSettings, Field3dArrayFormat,
  Field3dTrajectoryStyle, Field3dCameraMode, Field3dQuality, Field3dOrigin,
  defaultField3dSettings, EVERGREEN_FIELD_KEY,
} from "../../store/appStore"
import { Field3dCoordinateSystem, COORDINATE_SYSTEMS } from "./frames"
import { isPose3dTopic } from "./pose3d"

export interface ResolvedField3dOptions {
  hidden: boolean
  opacity: number
  showLabel: boolean
  trailSeconds: number
  arrayFormat: Field3dArrayFormat
  robotAssetKey: string | null
  useModel: boolean
  anchorId: string | null
  trajectoryStyle: Field3dTrajectoryStyle
  trajectoryWidth: number
  showWaypoints: boolean
  trajectoryHeight: number
  visionCameraIndex: number
  gamePieceIndex: number
  markerSize: number
}

export const FIELD3D_OBJECT_TYPES: Field3dObjectType[] = [
  "robot", "ghost", "component", "trajectory", "vision", "gamePiece", "cone", "axes",
]

export const FIELD3D_OBJECT_LABELS: Record<Field3dObjectType, string> = {
  robot: "Robot",
  ghost: "Ghost",
  component: "Components",
  trajectory: "Trajectory",
  vision: "Vision target",
  gamePiece: "Game piece",
  cone: "Marker",
  axes: "Axes",
}

export const FIELD3D_OBJECT_HELP: Record<Field3dObjectType, string> = {
  robot: "The robot itself: your imported CAD model, or a box with alliance-coloured bumpers if there is no model.",
  ghost: "The same robot drawn translucent — a setpoint, a second pose estimate, or yesterday's run on top of today's.",
  component: "Articulated parts (arm, elevator, intake) driven by a Pose3d[] of robot-relative poses. Attach it to a robot object.",
  trajectory: "Joins every pose of the array into a path floating just above the carpet.",
  vision: "Marks each target and draws the line back to the camera it was seen from.",
  gamePiece: "Places one of the field's game piece models wherever the topic says — a note in flight, what the robot is holding.",
  cone: "A plain cone marker for any point of interest that is not a game piece.",
  axes: "X/Y/Z triad at the pose. The fastest way to find out why an orientation looks wrong.",
}

// The SVGs in public/icons are chosen by MEANING. Several already exist for the
// 2D visualizer and Mechanism 3D; for the ones with no file yet the final name
// is requested and SidebarIcon falls back on its own to the sibling and then to
// the tabler glyph, so the row never ends up with a broken square.
export interface Field3dIcon {
  svg: string
  svgFallback?: string
  fallback: string
}

export const FIELD3D_OBJECT_ICONS: Record<Field3dObjectType, Field3dIcon> = {
  robot: { svg: "robot.svg", fallback: "ti-robot" },
  ghost: { svg: "ghost.svg", svgFallback: "part-shape.svg", fallback: "ti-ghost-2" },
  component: { svg: "part.svg", svgFallback: "joint.svg", fallback: "ti-hierarchy-2" },
  trajectory: { svg: "trajectory.svg", svgFallback: "sweep.svg", fallback: "ti-route" },
  vision: { svg: "vision.svg", svgFallback: "target.svg", fallback: "ti-eye" },
  gamePiece: { svg: "game-piece.svg", svgFallback: "part-mesh.svg", fallback: "ti-ball-basketball" },
  cone: { svg: "marker.svg", svgFallback: "placement.svg", fallback: "ti-map-pin" },
  axes: { svg: "axes.svg", svgFallback: "joint-pose.svg", fallback: "ti-axis-x" },
}

/** These are drawn hanging from a `robot` object, not at their own pose. */
export function needsAnchor(type: Field3dObjectType): boolean {
  return type === "component" || type === "vision"
}

export function resolveField3dOptions(
  obj: Field3dObjectConfig,
  settings: Field3dSettings,
): ResolvedField3dOptions {
  const isGhost = obj.type === "ghost"
  return {
    hidden: obj.hidden === true,
    // The ghost is born translucent: it is what sets it apart from the real
    // robot, and having to lower its opacity by hand every time would be absurd.
    opacity: clamp(obj.opacity ?? (isGhost ? 0.45 : 1), 0.05, 1),
    showLabel: obj.showLabel ?? false,
    // The master switch turns off everyone's trails; with it on each object can
    // set its own or inherit the tab's.
    trailSeconds: settings.showTrails ? (obj.trailSeconds ?? settings.trailSeconds) : 0,
    arrayFormat: obj.arrayFormat ?? "auto",
    robotAssetKey: obj.robotAssetKey ?? settings.robotAssetKey,
    useModel: obj.useModel ?? true,
    anchorId: obj.anchorId ?? null,
    trajectoryStyle: obj.trajectoryStyle ?? "tube",
    trajectoryWidth: positive(obj.trajectoryWidth, 0.05),
    showWaypoints: obj.showWaypoints ?? false,
    trajectoryHeight: positive(obj.trajectoryHeight, 0.02),
    // -1 = from the robot's center, which is right as long as the asset does not
    // declare any camera.
    visionCameraIndex: Number.isInteger(obj.visionCameraIndex) ? obj.visionCameraIndex! : -1,
    gamePieceIndex: Math.max(0, Math.trunc(obj.gamePieceIndex ?? 0)),
    markerSize: positive(obj.markerSize, 0.25),
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

/** Everything the page knows how to receive. */
export function isField3dDroppable(topicType: string): boolean {
  return isPose3dTopic(topicType)
}

/**
 * Which object type is best to create when a topic is dropped.
 *
 * The name wins over the shape: a `Targets` carrying three poses is not a
 * trajectory, and neither is a `Components` carrying four.
 */
export function defaultField3dTypeFor(topicName: string, topicType: string): Field3dObjectType {
  const leaf = topicName.split("/").filter(Boolean).pop()?.toLowerCase() ?? ""

  if (leaf.includes("component") || leaf.includes("mechanism") || leaf.includes("arm")) return "component"
  if (leaf.includes("vision") || leaf.includes("tag") || leaf.includes("target")) return "vision"
  if (leaf.includes("note") || leaf.includes("piece") || leaf.includes("ball") || leaf.includes("coral")) return "gamePiece"
  if (leaf.includes("trajectory") || leaf.includes("path")) return "trajectory"
  if (leaf.includes("setpoint") || leaf.includes("desired") || leaf.includes("goal") || leaf.includes("ghost")) return "ghost"
  return topicType.endsWith("[]") ? "trajectory" : "robot"
}

/**
 * A name for a new object, numbering repeats of the same topic.
 *
 * The same topic can be dropped AS MANY TIMES as needed: seeing it at once as
 * a robot and as a trail, or as a game piece and as a marker, should not force
 * publishing it twice from the robot. The same rule as in 2D.
 */
export function nextField3dLabel(
  objects: { topicName: string }[],
  topicName: string,
  base?: string,
): string {
  const leaf = base ?? topicName.split("/").filter(Boolean).pop() ?? topicName
  const dupes = objects.filter(o => o.topicName === topicName).length
  return dupes === 0 ? leaf : `${leaf} (${dupes + 1})`
}

// --- Persistencia -----------------------------------------------------------

// A layout saved by an earlier version does not carry the new fields, and one
// edited by hand can carry garbage. The renderer uses these numbers as geometry:
// a NaN in a trajectory's thickness leaves it invisible without any error in
// sight, so everything comes in through here.

const OBJECT_TYPES = new Set<string>(FIELD3D_OBJECT_TYPES)
const ARRAY_FORMATS = new Set<string>(["auto", "pose2d", "pose3d"])
const TRAJECTORY_STYLES = new Set<string>(["tube", "line", "points"])
const CAMERA_MODES = new Set<string>(["orbit", "orbitRobot", "driverStation", "robotCamera"])
const QUALITIES = new Set<string>(["cinematic", "standard", "lowPower"])
const ORIGINS = new Set<string>(["auto", "blue", "red"])
const SYSTEMS = new Set<string>(COORDINATE_SYSTEMS)

export function normalizeField3dObjects(raw: unknown): Field3dObjectConfig[] {
  if (!Array.isArray(raw)) return []

  return raw
    .filter(o => o && typeof o.id === "string" && typeof o.topicName === "string")
    .map((o: any): Field3dObjectConfig => ({
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
      arrayFormat: ARRAY_FORMATS.has(o.arrayFormat) ? o.arrayFormat : undefined,
      robotAssetKey: typeof o.robotAssetKey === "string" ? o.robotAssetKey : undefined,
      useModel: bool(o.useModel),
      anchorId: typeof o.anchorId === "string" ? o.anchorId : undefined,
      trajectoryStyle: TRAJECTORY_STYLES.has(o.trajectoryStyle) ? o.trajectoryStyle : undefined,
      trajectoryWidth: finite(o.trajectoryWidth),
      showWaypoints: bool(o.showWaypoints),
      trajectoryHeight: finite(o.trajectoryHeight),
      visionCameraIndex: finite(o.visionCameraIndex),
      gamePieceIndex: finite(o.gamePieceIndex),
      markerSize: finite(o.markerSize),
    }))
}

export function normalizeField3dSettings(raw: unknown): Field3dSettings {
  const merged = { ...defaultField3dSettings, ...(raw as Partial<Field3dSettings> | undefined) }
  const source = (raw ?? {}) as Record<string, unknown>

  return {
    ...merged,
    fieldKey: typeof merged.fieldKey === "string" && merged.fieldKey.length > 0
      ? merged.fieldKey : EVERGREEN_FIELD_KEY,
    robotAssetKey: typeof merged.robotAssetKey === "string" ? merged.robotAssetKey : null,
    coordinateSystem: SYSTEMS.has(merged.coordinateSystem as string)
      ? merged.coordinateSystem as Field3dCoordinateSystem : null,
    origin: (ORIGINS.has(merged.origin) ? merged.origin : "auto") as Field3dOrigin,
    alliance: merged.alliance === "red" ? "red" : "blue",
    allianceFromFMS: merged.allianceFromFMS !== false,

    cameraMode: (CAMERA_MODES.has(merged.cameraMode) ? merged.cameraMode : "orbit") as Field3dCameraMode,
    // Six driver stations in FRC; the index is bounded so an FTC layout (four)
    // does not leave the camera looking at nothing.
    driverStationIndex: index(source.driverStationIndex, 1, 5),
    robotCameraIndex: index(source.robotCameraIndex, 0, 15),
    fov: number(source.fov, defaultField3dSettings.fov, 20, 110),

    quality: (QUALITIES.has(merged.quality) ? merged.quality : "standard") as Field3dQuality,
    gridCell: number(source.gridCell, defaultField3dSettings.gridCell, 0.1, 5),
    trailSeconds: number(source.trailSeconds, defaultField3dSettings.trailSeconds, 0, 120),

    robotLength: number(source.robotLength, defaultField3dSettings.robotLength, 0.1, 3),
    robotWidth: number(source.robotWidth, defaultField3dSettings.robotWidth, 0.1, 3),
    robotHeight: number(source.robotHeight, defaultField3dSettings.robotHeight, 0.05, 3),
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

function index(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !isFinite(value)) return fallback
  return Math.min(max, Math.max(0, Math.trunc(value)))
}
