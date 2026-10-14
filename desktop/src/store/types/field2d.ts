import { CoordinateSystem, FIELDS, SCHEMATIC_FIELD_KEY } from "../../utils/field/fieldImages"

// --- 2D Visualizer (an AdvantageScope Field2d-style field) ---

// robot      = chassis with colored bumpers + a heading arrow, or the team's 3D
//              model seen from above (see `robotRender`)
// ghost      = the same chassis, translucent (setpoint / alternative estimated pose)
// trajectory = polyline joining the translations of a Pose2d[]
// arrow      = only the heading arrow, no chassis
// heatmap    = heat map of where the object went over time
// target     = vision marks, with the line joining them to the robot
// swerve     = the four modules' vectors, anchored to the robot
export type FieldObjectType =
  | "robot" | "ghost" | "trajectory" | "arrow" | "heatmap" | "target" | "swerve"

/** Where the arrow starts relative to the pose: front, center or back. */
export type ArrowAnchor = "front" | "center" | "back"

export type TrajectoryStyle = "solid" | "dashed" | "points" | "gradient"

export interface FieldObjectConfig {
  id: string
  topicName: string
  topicType: string
  label: string
  type: FieldObjectType
  color: string

  // --- Per-object options --------------------------------------------------
  // All of them are OPTIONAL on purpose: a layout saved by an earlier version
  // does not carry them, and the renderer applies their default (see
  // `resolveObjectOptions` in utils/field/fieldObjects.ts). That way adding a
  // new option never invalidates the layouts people already had.

  /** Stays in the list but is not drawn. */
  hidden?: boolean
  /** 0..1. Default 1. */
  opacity?: number
  /** Name + (x, y, θ) floating next to the object. */
  showLabel?: boolean
  /** Seconds of trail. 0 = no trail. */
  trailSeconds?: number
  /** The trail's own color. null/missing = the object's color. */
  trailColor?: string | null

  // robot / ghost
  /** Draws the 3D model instead of the icon. Default: whatever FieldSettings says. */
  useModel?: boolean

  // arrow
  arrowAnchor?: ArrowAnchor
  /** Arrow length in meters. */
  arrowLength?: number

  // trajectory
  trajectoryStyle?: TrajectoryStyle
  /** Width in screen pixels (does not scale with zoom). */
  trajectoryWidth?: number
  /** A dot at each waypoint of the array. */
  showWaypoints?: boolean
  /** Heading arrows spread along the path. */
  showHeading?: boolean

  // heatmap
  /** Radius of influence of each sample, in meters. */
  heatmapRadius?: number
  /** Side of the grid cell, in meters. Smaller = more detail and more CPU. */
  heatmapCell?: number

  // target
  /** A line from the robot to each mark. */
  targetLines?: boolean
  /** Distance and angle on each line. */
  targetLabels?: boolean

  // swerve
  /** A SWERVE_ARRANGEMENTS key: the order the modules come in. */
  swerveArrangement?: string
  /** m/s that correspond to a vector half a footprint long. */
  swerveMaxSpeed?: number
}

// 0 / 90 / 180 / 270 degrees of field rotation on screen.
export type FieldOrientation = 0 | 90 | 180 | 270

/** A drawn icon, or the team's 3D model rendered from above. */
export type RobotRenderMode = "icon" | "model"

export interface FieldSettings {
  orientation: FieldOrientation
  /** LENGTH of the chassis with bumpers, along the robot's +X (default 0.85 m ≈ 33"). */
  robotSizeMeters: number
  /** WIDTH of the chassis with bumpers, along the robot's +Y. */
  robotWidthMeters: number
  showGrid: boolean
  /** Grid spacing in meters. */
  gridSpacing: number
  /** Key of the field with an image, or SCHEMATIC_FIELD_KEY for the drawing. */
  fieldKey: string
  /** null = use the system the field's JSON declares. */
  coordinateSystem: CoordinateSystem | null

  // --- View ----------------------------------------------------------------
  /** Mirrors the field 180°: the view the red alliance's driver has. */
  allianceFlip: boolean
  /** X/Y axes at the robot's coordinate origin. */
  showAxes: boolean
  /** Readout of the coordinates under the pointer. */
  showCursor: boolean
  /** The objects' labels (those that have them enabled). */
  showLabels: boolean
  /** Master switch for trails. */
  showTrails: boolean
  /** Default trail seconds for the objects that do not set their own. */
  trailSeconds: number

  // --- Robot model ---------------------------------------------------------
  robotRender: RobotRenderMode
  /** Absolute path of the .stl/.glb/.gltf. null = no model loaded. */
  robotModelPath: string | null
  /** File name, to show it without cutting the path. */
  robotModelName: string | null
  /** Scales the model so its footprint matches the chassis length. */
  robotModelAutoFit: boolean
  /** File units -> meters, when auto-fit is off. */
  robotModelScale: number
  /** Rotation in degrees to bring the CAD's front to the robot's +X. */
  robotModelRotation: number
  /** null = keep the file's materials (.stl files carry no color). */
  robotModelColor: string | null
  /** Outline in the object's color on top of the model. */
  showBumpers: boolean
}

export const defaultFieldSettings: FieldSettings = {
  orientation: 0,
  robotSizeMeters: 0.85,
  robotWidthMeters: 0.85,
  showGrid: true,
  gridSpacing: 1,
  // If a field with an image is installed, that one is used: it is what
  // people expect to see when opening the visualizer, not an empty grid.
  fieldKey: FIELDS[0]?.key ?? SCHEMATIC_FIELD_KEY,
  coordinateSystem: null,

  allianceFlip: false,
  showAxes: false,
  showCursor: true,
  showLabels: true,
  showTrails: true,
  trailSeconds: 3,

  robotRender: "icon",
  robotModelPath: null,
  robotModelName: null,
  robotModelAutoFit: true,
  robotModelScale: 0.001,
  robotModelRotation: 0,
  robotModelColor: null,
  showBumpers: true,
}
