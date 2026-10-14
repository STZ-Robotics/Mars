import type { FieldOrientation } from "./field2d"

// --- Swerve Visualizer ---

// modules   = SwerveModuleState[] or a double[] of [angle, speed] pairs
// positions = SwerveModulePosition[] (accumulated distance per wheel)
// chassis   = ChassisSpeeds (vx, vy, ω) of the whole robot
// rotation  = the chassis' heading (Rotation2d, Pose2d, or a gyro double)
export type SwerveSourceType = "modules" | "positions" | "chassis" | "rotation"

// The order in which the topic's modules map to the drawn corners (FL, FR,
// BL, BR). Same as AdvantageScope's "Arrangement" selector: not every team
// indexes its modules in the same order.
export const SWERVE_ARRANGEMENTS: { key: string; label: string }[] = [
  { key: "0,1,2,3", label: "FL/FR/BL/BR" },
  { key: "1,0,3,2", label: "FR/FL/BR/BL" },
  { key: "0,1,3,2", label: "FL/FR/BR/BL" },
  { key: "0,3,1,2", label: "FL/BL/BR/FR" },
  { key: "3,0,2,1", label: "FR/BR/BL/FL" },
  { key: "1,0,2,3", label: "FR/FL/BL/BR" },
]

// What a set of modules represents: what the robot MEASURES, or what it is
// COMMANDED. With both, the tracking error can be computed.
export type SwerveModuleRole = "measured" | "setpoint"

export interface SwerveSourceConfig {
  id: string
  topicName: string
  topicType: string
  label: string
  type: SwerveSourceType
  color: string
  arrangement: string                    // only for type === "modules"/"positions"
  angleUnits: "degrees" | "radians"      // only for rotations published as a raw double
  role: SwerveModuleRole                 // only for type === "modules"
}

export interface SwerveSettings {
  maxSpeed: number       // m/s, normalizes the vectors' length
  frameLength: number    // m, the chassis' X axis (forward)
  frameWidth: number     // m, the chassis' Y axis (to the left)
  orientation: FieldOrientation
  gradient: boolean       // colors each module by its speed
  showValues: boolean     // numeric labels next to each module
  showPredicted: boolean  // the vector each module should have according to the kinematics
  showICR: boolean        // instantaneous center of rotation
}

export const defaultSwerveSettings: SwerveSettings = {
  maxSpeed: 4.5,
  frameLength: 0.6,
  frameWidth: 0.6,
  orientation: 0,
  gradient: true,
  showValues: true,
  showPredicted: false,
  showICR: false,
}

// --- Swerve 3D Visualizer ---

// The 3D view consumes the SAME sources as the 2D one (swerveSources) and the
// same chassis size and maximum speed (swerveSettings). The only thing of its
// own is how it looks: which model is loaded and where each module is drawn.

/** Where a module is drawn, in the robot's frame (X forward, Y left, Z up). */
export interface Swerve3dModulePlacement {
  x: number
  y: number
  z: number   // height of the wheel's center
}

export type Swerve3dProjection = "perspective" | "orthographic"

export interface Swerve3dSettings {
  // --- Robot model ---
  /** Absolute path of the chosen .stl/.glb/.gltf. null = drawn generic chassis. */
  modelPath: string | null
  /** File name, only to show it in the panel without cutting the path. */
  modelName: string | null
  /** Uniform scale. Ignored while modelAutoFit is on. */
  modelScale: number
  /** Adjusts the scale so the model's length matches frameLength. */
  modelAutoFit: boolean
  /** The model's rotations in degrees, applied before the heading (X, then Y, then Z). */
  modelRotX: number
  modelRotY: number
  modelRotZ: number
  /** Offset from the chassis' center, in meters. */
  modelOffsetX: number
  modelOffsetY: number
  modelOffsetZ: number
  /** Rests the model's base on the floor after scaling and rotating it. */
  modelDropToFloor: boolean
  /** null = keep the file's materials (GLB). STL files carry no color. */
  modelColor: string | null
  modelOpacity: number
  modelWireframe: boolean

  // --- Modules ---
  /** FL, FR, BL, BR positions. Only used if moduleAuto is false. */
  modules: Swerve3dModulePlacement[]
  /** Derives the four corners from frameLength/frameWidth instead of using `modules`. */
  moduleAuto: boolean
  /** Height of the wheel's center when moduleAuto is on. */
  moduleAutoHeight: number
  wheelRadius: number   // m
  wheelWidth: number    // m

  // --- Scene ---
  showModel: boolean
  showFrame: boolean          // wire box the size of the chassis
  showModules: boolean
  showVectors: boolean        // velocity arrow per module
  showSetpoints: boolean      // second set of modules, as a ghost
  showChassisVector: boolean  // ChassisSpeeds arrow from the center
  showOmega: boolean          // angular velocity arc
  showLabels: boolean         // FL/FR/BL/BR floating over each module
  showAxes: boolean           // the robot's axes
  showFloor: boolean
  /** The floor moves opposite to the chassis: the robot stays still and is seen moving. */
  motionFloor: boolean
  /** false = the chassis does not rotate with the gyro (robot-fixed view). */
  followHeading: boolean
  gradient: boolean           // colors the vectors by their fraction of maxSpeed

  // --- Camera ---
  projection: Swerve3dProjection
}

// FL, FR, BL, BR for a 0.6 m square chassis, which is SwerveSettings' default.
export const defaultSwerve3dModules: Swerve3dModulePlacement[] = [
  { x: 0.3, y: 0.3, z: 0.05 },
  { x: 0.3, y: -0.3, z: 0.05 },
  { x: -0.3, y: 0.3, z: 0.05 },
  { x: -0.3, y: -0.3, z: 0.05 },
]

export const defaultSwerve3dSettings: Swerve3dSettings = {
  modelPath: null,
  modelName: null,
  modelScale: 1,
  modelAutoFit: true,
  modelRotX: 0,
  modelRotY: 0,
  modelRotZ: 0,
  modelOffsetX: 0,
  modelOffsetY: 0,
  modelOffsetZ: 0,
  modelDropToFloor: true,
  modelColor: null,
  modelOpacity: 1,
  modelWireframe: false,

  modules: defaultSwerve3dModules,
  moduleAuto: true,
  moduleAutoHeight: 0.05,
  wheelRadius: 0.05,
  wheelWidth: 0.04,

  showModel: true,
  showFrame: true,
  showModules: true,
  showVectors: true,
  showSetpoints: true,
  showChassisVector: true,
  showOmega: true,
  showLabels: true,
  showAxes: false,
  showFloor: true,
  motionFloor: true,
  followHeading: true,
  gradient: true,

  projection: "perspective",
}
