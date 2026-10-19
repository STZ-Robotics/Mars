// robot.json as the app edits it. Mirrors ares-core's RobotConfig (serde,
// camelCase); the backend validates, so these types only need to be right,
// not to enforce anything.

export type MotorId = "kraken_x60" | "falcon500" | "neo" | "neo550" | "cim"

export interface ModuleConfig { name: string; xM: number; yM: number }

export interface SwerveConfig {
  type: "swerve"
  modules: ModuleConfig[]
  wheelRadiusM: number
  driveGearRatio: number
  driveMotor: MotorId
  driveMotorsPerModule: number
  driveCurrentLimitA: number
  wheelCof: number
  batteryVoltage: number
  /** Fraction of the free speed trajectories may use (~0.8 is a good start). */
  maxSpeedFraction?: number
}

export interface ModelRef {
  path: string
  scale: number
  offsetM: [number, number, number]
  rotationDeg: [number, number, number]
}

/**
 * A FIXED camera that reads AprilTags (bolted to the chassis: it only turns with the robot; one on
 * a turret, an arm or an elevator is not modeled), as WPILib's robot-to-camera Transform3d: from the robot's
 * center on the carpet (X forward, Y left, Z up) to the lens, then roll, pitch and yaw. WPILib's
 * pitch is positive tilting down, so a camera tilted up has a negative pitch.
 */
export interface CameraConfig {
  name: string
  xM: number
  yM: number
  zM: number
  rollDeg?: number
  pitchDeg?: number
  yawDeg?: number
  horizontalFovDeg: number
  verticalFovDeg: number
  /** Farthest a tag is still read reliably (5 m when unset). */
  maxRangeM?: number
  /** The preset it came from, for the picker. */
  model?: string
}

export interface RobotConfig {
  version: number
  name: string
  massKg: number
  moiKgM2: number
  cogHeightM?: number
  bumper: { lengthM: number; widthM: number }
  drivetrain: SwerveConfig
  model?: ModelRef
  cameras?: CameraConfig[]
  /** Formulas behind numeric fields, by dotted path ("drivetrain.wheelRadiusM"). */
  exprs?: Record<string, string>
}

export interface MotorInfo {
  id: MotorId
  stallTorqueNm: number
  stallCurrentA: number
  freeSpeedRpm: number
}

export interface Derived {
  freeSpeedMps: number
  floorSpeedMps: number
  tractionAccelMps2: number
  motorAccelMps2: number
  maxOmegaRadps: number
  maxAlphaRadps2: number
  maxOmegaDps: number
  driveForceN: number
  gripForceN: number
  maxAccelMps2: number
  launchLimitedBy: "motor" | "grip"
  tipAccelMps2: number | null
  moiEstimateKgM2: number
  sprint5mS: number | null
  sprint5mTopSpeedMps: number | null
  driveKvTheory: number
  driveKaTheory: number
}

export interface Check { problems: string[]; derived: Derived | null }

export const MOTOR_LABELS: Record<MotorId, string> = {
  kraken_x60: "Kraken X60",
  falcon500: "Falcon 500",
  neo: "NEO",
  neo550: "NEO 550",
  cim: "CIM",
}

/** Common swerve modules' drive ratios (motor turns per wheel turn). */
export const GEAR_PRESETS: { label: string; ratio: number }[] = [
  { label: "SDS MK4i L1", ratio: 8.14 },
  { label: "SDS MK4i L2", ratio: 6.75 },
  { label: "SDS MK4i L3", ratio: 6.12 },
  { label: "SDS MK4n L1+", ratio: 7.13 },
  { label: "SDS MK4n L2+", ratio: 5.9 },
  { label: "SDS MK4n L3+", ratio: 5.36 },
]

/**
 * Common AprilTag cameras' whole field of view. The Limelights' are the maker's; an OV9281's
 * depends on its lens, so those are the usual ones on its 1280×800 sensor (check yours).
 */
export const CAMERA_PRESETS: { id: string; label: string; horizontalFovDeg: number; verticalFovDeg: number; maxRangeM: number }[] = [
  { id: "limelight4", label: "Limelight 4", horizontalFovDeg: 82, verticalFovDeg: 56.2, maxRangeM: 6 },
  { id: "limelight3g", label: "Limelight 3G", horizontalFovDeg: 82, verticalFovDeg: 56.2, maxRangeM: 6 },
  { id: "limelight3", label: "Limelight 3", horizontalFovDeg: 63.3, verticalFovDeg: 49.7, maxRangeM: 5 },
  { id: "limelight2plus", label: "Limelight 2+", horizontalFovDeg: 59.6, verticalFovDeg: 45.7, maxRangeM: 4.5 },
  { id: "ov9281-70", label: "OV9281 · 70° lens", horizontalFovDeg: 70, verticalFovDeg: 47.2, maxRangeM: 6 },
  { id: "ov9281-100", label: "OV9281 · 100° lens", horizontalFovDeg: 100, verticalFovDeg: 73.4, maxRangeM: 4.5 },
]

/** A new camera: a Limelight 3G on the front, centered, tilted 15° up. */
export function newCamera(existing: CameraConfig[]): CameraConfig {
  let n = existing.length + 1
  while (existing.some(c => c.name === `camera${n}`)) n++
  return { name: `camera${n}`, xM: 0.3, yM: 0, zM: 0.4, rollDeg: 0, pitchDeg: -15, yawDeg: 0, horizontalFovDeg: 82, verticalFovDeg: 56.2, maxRangeM: 6, model: "limelight3g" }
}

/** Four modules at the corners of a wheelbase × trackwidth rectangle. */
export function squareModules(wheelbaseM: number, trackwidthM: number): ModuleConfig[] {
  const x = wheelbaseM / 2, y = trackwidthM / 2
  return [
    { name: "fl", xM: x, yM: y },
    { name: "fr", xM: x, yM: -y },
    { name: "bl", xM: -x, yM: y },
    { name: "br", xM: -x, yM: -y },
  ]
}

/** The wheelbase and trackwidth if the modules are the usual rectangle. */
export function rectangleOf(modules: ModuleConfig[]): { wheelbaseM: number; trackwidthM: number } | null {
  if (modules.length !== 4) return null
  const x = Math.abs(modules[0].xM), y = Math.abs(modules[0].yM)
  const expected = squareModules(2 * x, 2 * y)
  const same = expected.every((e, i) =>
    Math.abs(modules[i].xM - e.xM) < 1e-9 && Math.abs(modules[i].yM - e.yM) < 1e-9)
  return same ? { wheelbaseM: 2 * x, trackwidthM: 2 * y } : null
}

/** A new robot starts as a typical competition swerve, not as zeros. */
export function newRobot(): RobotConfig {
  const inch = 0.0254
  return {
    version: 1,
    name: "New robot",
    massKg: 58,
    moiKgM2: 7,
    bumper: { lengthM: 0.851, widthM: 0.851 },
    drivetrain: {
      type: "swerve",
      modules: squareModules(21.75 * inch, 21.75 * inch),
      wheelRadiusM: 2 * inch,
      driveGearRatio: 6.75,
      driveMotor: "kraken_x60",
      driveMotorsPerModule: 1,
      driveCurrentLimitA: 80,
      wheelCof: 1.0,
      batteryVoltage: 12,
    },
  }
}
