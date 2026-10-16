import { invoke } from "@tauri-apps/api/core"
import {
  WorkspaceTab, ToolKind, DashboardWidget, FunctionSeriesConfig,
  SwerveSourceConfig, defaultSwerveSettings, SwerveSettings,
  Swerve3dSettings, defaultSwerve3dSettings, defaultSwerve3dModules, Swerve3dModulePlacement,
  FunctionSettings, defaultFunctionSettings,
  MechanismSourceConfig, defaultMechanismSettings, MechanismSettings,
  NTSessionSettings, defaultNTSessionSettings,
  EquationVariable, EquationConfig,
} from "./appStore"
import { normalizeFieldObjects, normalizeFieldSettings } from "../utils/field/fieldObjects"
import { normalizeField3dObjects, normalizeField3dSettings } from "../utils/field3d/objects"
import {
  normalizeParts as normalizeMechanism3dParts,
  normalizeSettings as normalizeMechanism3dSettings,
} from "../utils/mechanism/mechanism3d"
import { normalizeEntries as normalizeNTSessionEntries } from "../utils/nt/ntSession"
import { TimelineMarker } from "./markerStore"
import { SysIdConfig, normalizeSysIdConfig } from "./sysidStore"

// Bump it ONLY if an old layout can no longer be migrated with normalizeTab.
// As long as the new fields have a default, there is no need to touch it.
const LAYOUT_VERSION = 1

const KNOWN_KINDS: ToolKind[] = [
  "visualizer", "field3d", "swerve", "swerve3d", "mechanism", "mechanism3d", "ntsession", "telemetry", "display", "functions", "equations",
]

export interface WorkspaceLayout {
  version: number
  openTabs: WorkspaceTab[]
  activeTabId: string | null
  /** An icon-only rail instead of the full tree. */
  sidebarCollapsed: boolean
  markers: TimelineMarker[]
  sysid: SysIdConfig
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

// A layout saved by an earlier version does not have the fields added later
// (mechanismSources is the most recent case). Filling them in here is what
// keeps adding a new tool from invalidating the layouts people already had
// saved.
function normalizeTab(raw: any): WorkspaceTab | null {
  if (!raw || typeof raw !== "object") return null
  if (!KNOWN_KINDS.includes(raw.kind)) return null
  if (typeof raw.id !== "string" || raw.id.length === 0) return null

  return {
    id: raw.id,
    kind: raw.kind as ToolKind,
    title: typeof raw.title === "string" ? raw.title : raw.kind,
    widgets: asArray<DashboardWidget>(raw.widgets),
    functionSeries: asArray<FunctionSeriesConfig>(raw.functionSeries),
    functionSettings: { ...defaultFunctionSettings, ...(raw.functionSettings as FunctionSettings) },
    // The field's objects and settings are drawn straight as geometry: a chassis
    // length of NaN or a made-up object type leave the visualizer blank without
    // any visible error.
    fieldObjects: normalizeFieldObjects(raw.fieldObjects),
    fieldSettings: normalizeFieldSettings(raw.fieldSettings),
    field3dObjects: normalizeField3dObjects(raw.field3dObjects),
    field3dSettings: normalizeField3dSettings(raw.field3dSettings),
    swerveSources: asArray<SwerveSourceConfig>(raw.swerveSources),
    swerveSettings: { ...defaultSwerveSettings, ...(raw.swerveSettings as SwerveSettings) },
    swerve3dSettings: normalizeSwerve3d(raw.swerve3dSettings),
    mechanismSources: asArray<MechanismSourceConfig>(raw.mechanismSources),
    mechanismSettings: { ...defaultMechanismSettings, ...(raw.mechanismSettings as MechanismSettings) },
    // The Mechanism 3D's part tree is drawn straight as geometry: a NaN or a
    // made-up enum there leaves the scene empty without any visible error, so it
    // is sanitized with the same normalizer the import uses.
    mechanism3dParts: normalizeMechanism3dParts(raw.mechanism3dParts),
    mechanism3dSettings: normalizeMechanism3dSettings(raw.mechanism3dSettings),
    ntSessionEntries: normalizeNTSessionEntries(raw.ntSessionEntries),
    ntSessionSettings: {
      ...defaultNTSessionSettings,
      ...(raw.ntSessionSettings as NTSessionSettings),
    },
    equationVars: asArray<EquationVariable>(raw.equationVars),
    equations: asArray<EquationConfig>(raw.equations),
  }
}

// The four module positions are the only thing in the layout drawn straight as
// geometry: a NaN slipping in there (from editing the field by hand and leaving
// it empty) leaves the meshes with an invalid matrix and the whole scene
// disappears without a visible error.
function normalizeSwerve3d(raw: any): Swerve3dSettings {
  const merged = { ...defaultSwerve3dSettings, ...(raw as Swerve3dSettings) }
  const modules = asArray<any>(raw?.modules)
    .slice(0, 4)
    .map((m, i): Swerve3dModulePlacement => ({
      x: finite(m?.x, defaultSwerve3dModules[i].x),
      y: finite(m?.y, defaultSwerve3dModules[i].y),
      z: finite(m?.z, defaultSwerve3dModules[i].z),
    }))

  return {
    ...merged,
    modules: modules.length === 4 ? modules : defaultSwerve3dModules,
  }
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && isFinite(value) ? value : fallback
}

export function normalizeLayout(raw: any): WorkspaceLayout | null {
  if (!raw || typeof raw !== "object") return null
  const openTabs = asArray<any>(raw.openTabs)
    .map(normalizeTab)
    .filter((t): t is WorkspaceTab => t !== null)

  // An activeTabId pointing at a tab that no longer exists would leave the app
  // showing an empty screen with no way back.
  const activeTabId = openTabs.some(t => t.id === raw.activeTabId) ? raw.activeTabId : null

  return {
    version: LAYOUT_VERSION,
    openTabs,
    activeTabId,
    sidebarCollapsed: raw.sidebarCollapsed === true,
    markers: normalizeMarkers(raw.markers),
    sysid: normalizeSysIdConfig(raw.sysid),
  }
}

// A mark with an invalid time would draw a flag at NaN pixels and break jumping
// between marks.
function normalizeMarkers(raw: unknown): TimelineMarker[] {
  return asArray<any>(raw)
    .filter(m => m && typeof m.id === "string" && typeof m.timeUs === "number" && isFinite(m.timeUs))
    .map(m => ({
      id: m.id,
      timeUs: Math.round(m.timeUs),
      label: typeof m.label === "string" && m.label.length > 0 ? m.label : "Marker",
      color: typeof m.color === "string" ? m.color : "#d63b3b",
    }))
    .sort((a, b) => a.timeUs - b.timeUs)
}

/** Empty `path` = the autosave slot in MARS's config folder. */
export async function saveLayout(layout: Omit<WorkspaceLayout, "version">, path?: string): Promise<string> {
  return invoke<string>("save_workspace", {
    layout: { version: LAYOUT_VERSION, ...layout },
    path: path ?? null,
  })
}

export async function loadLayout(path?: string): Promise<WorkspaceLayout | null> {
  const raw = await invoke<any | null>("load_workspace", { path: path ?? null })
  return raw === null ? null : normalizeLayout(raw)
}
