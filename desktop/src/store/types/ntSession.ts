// --- NT Session ---
//
// A session is the reverse of everything else in the app: instead of READING
// what the robot publishes, MARS publishes its own topics under a root table
// ("MarsDesktop" by default) and the robot reads them.
//
// The obvious case is tuning gains without recompiling, but the tab is not
// tied to that: it is a general publisher. Any value you want to send the
// robot live — a target pose, an auto mode, a debug switch — lives here. And
// each value knows how to copy itself as Java code, which is the step usually
// done by hand and with typos.

/**
 * The first three groups are published with their native NT type. Geometry
 * travels as a `double[]` with the components in order, which is what any
 * client can read without needing the struct's schema.
 */
export type NTSessionKind =
  | "double" | "int" | "boolean" | "string"
  | "double[]" | "boolean[]" | "string[]"
  | "Rotation2d" | "Translation2d" | "Pose2d"
  | "Translation3d" | "Pose3d" | "ChassisSpeeds"

export interface NTSessionEntry {
  id: string
  /** Path relative to the root table, e.g. "Arm/kP". */
  key: string
  kind: NTSessionKind
  /** Name of the variable in the Java copied to the clipboard. */
  javaName: string

  /**
   * The value's components. The array matching the type is used: a double is
   * `numbers[0]`, a Pose2d is `numbers[0..2]`, a string[] is `strings`.
   * Keeping them separate by type avoids an `any` that would then have to be
   * validated on every read.
   */
  numbers: number[]
  booleans: boolean[]
  strings: string[]

  // --- Slider for single numeric values ---
  min: number
  max: number
  step: number
  useSlider: boolean

  /** Free-form comment; copied as `//` above the declaration. */
  note: string
}

/** What shape the Java copied to the clipboard has. */
export type NTSessionCopyMode = "declaration" | "value" | "getter"

export interface NTSessionSettings {
  /**
   * Publishes the VALUE as soon as it is edited. It never fires on renaming or
   * changing the type: that is only sent with the button.
   */
  autoPublish: boolean
  copyMode: NTSessionCopyMode
}

export const defaultNTSessionSettings: NTSessionSettings = {
  // Off by default: publishing while typing leaves one topic per letter of
  // the name, and those topics survive until the publisher goes away.
  autoPublish: false,
  copyMode: "declaration",
}
