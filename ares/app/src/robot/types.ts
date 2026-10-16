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
  /** Fraction of the free speed trajectories may use (Choreo: ~0.8). */
  maxSpeedFraction?: number
}

export interface ModelRef {
  path: string
  scale: number
  offsetM: [number, number, number]
  rotationDeg: [number, number, number]
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
