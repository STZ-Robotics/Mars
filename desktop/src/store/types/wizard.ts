// --- Subsystem Generator Wizard ---

export type JavaFieldType =
  | "double"
  | "boolean"
  | "int"
  | "String"
  | "Rotation2d"
  | "Translation2d"
  | "Pose2d"

// A field inside <Module>Inputs extends Data<...>
export interface IOInputField {
  id: string
  name: string          // e.g. "position"
  type: JavaFieldType
  hasUnit: boolean       // only applies if the project has UnitProcessor and type === "double"
  unitValue?: string     // e.g. "Degrees"
  unitGroup?: string     // e.g. "Intake"
}

export type Severity = "OK" | "WARNING" | "ERROR"

// A ModuleColorCode.solid(...) inside the subsystem
export interface ColorCodeEntry {
  id: string
  name: string          // IDLE, ON_TARGET...
  severity: Severity
  color: string          // WPI name without the "k", e.g. "DarkGreen"
  description: string    // may include %.2f etc.
}

export interface SubsystemWizardConfig {
  // Step 1 — location
  targetDir: string       // folder chosen with the native dialog
  javaPackage: string      // derived or hand-edited package
  moduleName: string       // "Arm" -> Arm.java / ArmIO.java
  separateFolder: boolean  // true: <targetDir>/arm/Arm.java, false: <targetDir>/Arm.java

  // Step 2 — IO
  inputs: IOInputField[]
  useProjectUnits: boolean  // detected by reading workspace-mars/features/UnitProcessor.json
  outputUnitValue: string    // unit for applyOutput, default "Volts"
  outputUnitGroup: string    // group for applyOutput, default = moduleName

  // Step 3 — diagnostics
  colorCodes: ColorCodeEntry[]
}

export const defaultWizardConfig: SubsystemWizardConfig = {
  targetDir: "",
  javaPackage: "",
  moduleName: "",
  separateFolder: true,
  inputs: [],
  useProjectUnits: false,
  outputUnitValue: "Volts",
  outputUnitGroup: "",
  colorCodes: [],
}
