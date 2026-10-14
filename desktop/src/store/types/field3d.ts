import { Field3dCoordinateSystem as Field3dCoordinateSystemKey } from "../../utils/field3d/frames"

// --- Field 3D (an AdvantageScope-style 3D field) ---

// Rendering, assets and coordinate conversion live in `utils/field3d/`. Only
// what gets SAVED in the layout is here.
//
// robot      = the team's chassis, with its imported model or a box with
//              bumpers in the alliance color
// ghost      = the same robot, translucent: a setpoint, a second pose
//              estimate, or yesterday's run over today's
// component  = articulated parts of the robot (arm, elevator), hung from a
//              `robot` object and moved by a Pose3d[]
// trajectory = path joining the translations of an array of poses
// vision     = vision marks, with the line joining them to the camera
// gamePiece  = a game piece from the field model, placed wherever the topic
//              says (a note in flight, the robot's inventory)
// cone       = generic conical marker, for any point of interest
// axes       = X/Y/Z axes at the pose, for debugging orientations
export type Field3dObjectType =
  | "robot" | "ghost" | "component" | "trajectory"
  | "vision" | "gamePiece" | "cone" | "axes"

/** How to read a `double[]`: 2D triplets or 3D septets. */
export type Field3dArrayFormat = "auto" | "pose2d" | "pose3d"

export type Field3dTrajectoryStyle = "tube" | "line" | "points"

export interface Field3dObjectConfig {
  id: string
  topicName: string
  topicType: string
  label: string
  type: Field3dObjectType
  color: string

  // --- Per-object options --------------------------------------------------
  // All OPTIONAL: a layout saved by an earlier version does not carry them and
  // the renderer applies their default (see `resolveField3dOptions`). That way
  // adding an option never invalidates the layouts people already had.

  hidden?: boolean
  /** 0..1. Default 1 for robot, 0.45 for ghost. */
  opacity?: number
  /** Name + coordinates floating next to the object. */
  showLabel?: boolean
  /** Seconds of trail. 0 = no trail. */
  trailSeconds?: number
  arrayFormat?: Field3dArrayFormat

  // robot / ghost
  /** Robot asset to use. null = the tab's default. */
  robotAssetKey?: string | null
  /** Draws the asset's model; with false it is always the box with bumpers. */
  useModel?: boolean

  // component / vision: which `robot` object they hang from
  anchorId?: string | null

  // trajectory
  trajectoryStyle?: Field3dTrajectoryStyle
  /** Width in METERS (unlike 2D, which measures it in pixels). */
  trajectoryWidth?: number
  showWaypoints?: boolean
  /** Height above the carpet, so it does not fight it in the z-buffer. */
  trajectoryHeight?: number

  // vision
  /** Camera of the robot's asset the line comes from. -1 = robot center. */
  visionCameraIndex?: number

  // gamePiece
  /** Index of the piece inside the field config's `gamePieces`. */
  gamePieceIndex?: number

  // cone / axes
  /** Marker size in meters. */
  markerSize?: number
}

export type Field3dCameraMode = "orbit" | "orbitRobot" | "driverStation" | "robotCamera"

/**
 * How much graphics effort is spent. On a pit laptop running on battery,
 * `cinematic` can halve the fps; `lowPower` limits the refresh rate and the
 * resolution so the app stays responsive.
 */
export type Field3dQuality = "cinematic" | "standard" | "lowPower"

export type Field3dOrigin = "auto" | "blue" | "red"

export interface Field3dSettings {
  /** Key of the field asset, or EVERGREEN_FIELD_KEY for the schematic one. */
  fieldKey: string
  /** Default robot asset for the objects that do not set their own. */
  robotAssetKey: string | null
  /** null = use the one the field's config declares. */
  coordinateSystem: Field3dCoordinateSystemKey | null
  /** Where the origin is when the system is alliance-relative. */
  origin: Field3dOrigin
  /** Manual alliance, when it is not read from FMSInfo. */
  alliance: "blue" | "red"
  /** Reads the alliance from /FMSInfo/IsRedAlliance instead of the selector. */
  allianceFromFMS: boolean

  // --- Camera --------------------------------------------------------------
  cameraMode: Field3dCameraMode
  /** Driver station index (0-2 blue, 3-5 red). */
  driverStationIndex: number
  /** Index of the camera declared in the robot's asset. */
  robotCameraIndex: number
  /** Vertical field of view in degrees, for the free views. */
  fov: number

  // --- Scene ---------------------------------------------------------------
  quality: Field3dQuality
  showGrid: boolean
  gridCell: number
  showFieldAxes: boolean
  /** AprilTags declared in the field's config. */
  showAprilTags: boolean
  showAprilTagIds: boolean
  /** Game pieces the field model already carries in place. */
  showStagedPieces: boolean
  showDriverStations: boolean
  showLabels: boolean
  /** Master switch for trails. */
  showTrails: boolean
  trailSeconds: number

  // --- Generic chassis (when there is no robot asset) -----------------------
  robotLength: number
  robotWidth: number
  robotHeight: number
}

/** Key reserved for the schematic field, the one that needs no download. */
export const EVERGREEN_FIELD_KEY = "evergreen"

export const defaultField3dSettings: Field3dSettings = {
  fieldKey: EVERGREEN_FIELD_KEY,
  robotAssetKey: null,
  coordinateSystem: null,
  origin: "auto",
  alliance: "blue",
  allianceFromFMS: true,

  cameraMode: "orbit",
  driverStationIndex: 1,
  robotCameraIndex: 0,
  fov: 50,

  quality: "standard",
  showGrid: false,
  gridCell: 1,
  showFieldAxes: false,
  showAprilTags: false,
  showAprilTagIds: false,
  // Off by default: the 2026 field carries 456 FUEL in place, and that is 456
  // meshes drawn every frame to show balls that never move. Whoever wants them
  // turns them on in Field 3D > Field > Pre-placed game pieces.
  showStagedPieces: false,
  showDriverStations: false,
  showLabels: false,
  showTrails: true,
  trailSeconds: 3,

  // 33" x 33" with bumpers and ~18" tall: the typical FRC chassis.
  robotLength: 0.85,
  robotWidth: 0.85,
  robotHeight: 0.45,
}
