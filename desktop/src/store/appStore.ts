// The app's top-level state: which page is open, the connection, the project,
// and the workspace tabs.
//
// What each tool SAVES in a tab lives in `./types/`, one file per tool. It is
// re-exported from here so every import keeps saying `store/appStore`.

import type { DashboardWidget } from "./types/dashboard"
import type { Field3dObjectConfig, Field3dSettings } from "./types/field3d"
import type { FieldObjectConfig, FieldSettings } from "./types/field2d"
import type {
  EquationConfig, EquationVariable, FunctionSeriesConfig, FunctionSettings,
} from "./types/functions"
import type {
  Mechanism3dPart, Mechanism3dSettings, MechanismSettings, MechanismSourceConfig,
} from "./types/mechanism"
import type { NTSessionEntry, NTSessionSettings } from "./types/ntSession"
import type { Swerve3dSettings, SwerveSettings, SwerveSourceConfig } from "./types/swerve"

export * from "./types/dashboard"
export * from "./types/field2d"
export * from "./types/field3d"
export * from "./types/functions"
export * from "./types/mechanism"
export * from "./types/ntSession"
export * from "./types/swerve"
export * from "./types/wizard"

export type Page = "welcome" | "packages" | "settings" | "variables" | "phone" | "about" | "creator" | "manifest"| "wizard" | "feature" | "watchdog" | "console" | "jitter" | "bandwidth" | "sysid" | "preferences" | "subsystems"
export type ConnectionState = "disconnected" | "sim" | "real"

// --- Multi-instance tools (AdvantageScope tab style) ---
// Unlike the Pages (singletons, fixed navigation), these are created
// explicitly from the Sidebar/MenuBar/WelcomePage, several can exist at once
// and each one keeps its own state (widgets/series).
export type ToolKind = "visualizer" | "field3d" | "swerve" | "swerve3d" | "mechanism" | "mechanism3d" | "ntsession" | "telemetry" | "display" | "functions" | "equations"

export interface WorkspaceTab {
  id: string
  kind: ToolKind
  title: string
  widgets: DashboardWidget[]             // only used if kind === "display"
  functionSeries: FunctionSeriesConfig[] // only used if kind === "functions"
  functionSettings: FunctionSettings     // only used if kind === "functions"
  fieldObjects: FieldObjectConfig[]      // only used if kind === "visualizer"
  fieldSettings: FieldSettings           // only used if kind === "visualizer"
  field3dObjects: Field3dObjectConfig[]  // only used if kind === "field3d"
  field3dSettings: Field3dSettings       // only used if kind === "field3d"
  swerveSources: SwerveSourceConfig[]    // used by kind === "swerve" and "swerve3d"
  swerveSettings: SwerveSettings         // used by kind === "swerve" and "swerve3d"
  swerve3dSettings: Swerve3dSettings     // only used if kind === "swerve3d"
  mechanismSources: MechanismSourceConfig[]  // only used if kind === "mechanism"
  mechanismSettings: MechanismSettings       // only used if kind === "mechanism"
  mechanism3dParts: Mechanism3dPart[]        // only used if kind === "mechanism3d"
  mechanism3dSettings: Mechanism3dSettings   // only used if kind === "mechanism3d"
  ntSessionEntries: NTSessionEntry[]         // only used if kind === "ntsession"
  ntSessionSettings: NTSessionSettings       // only used if kind === "ntsession"
  equationVars: EquationVariable[]       // only used if kind === "equations"
  equations: EquationConfig[]            // only used if kind === "equations"
}

export interface TopicAnnounce {
  id: number
  name: string
  topic_type: string
}

// A .wpilog loaded from disk. It takes the SAME buffer as NT4 in the backend,
// so the two modes are mutually exclusive: either there is a connection, or
// there is a log.
export interface LogSource {
  path: string
  name: string
  topic_count: number
  sample_count: number
  start_us: number | null
  end_us: number | null
}

export interface AppState {
  currentPage: Page
  connection: ConnectionState
  projectName: string | null
  projectPath: string | null
  topics: Map<string, TopicAnnounce>
  openTabs: WorkspaceTab[]
  activeTabId: string | null
  logSource: LogSource | null
}

export const defaultState: AppState = {
  currentPage: "welcome",
  connection: "disconnected",
  projectName: null,
  projectPath: null,
  topics: new Map(),
  openTabs: [],
  activeTabId: null,
  logSource: null,
}
