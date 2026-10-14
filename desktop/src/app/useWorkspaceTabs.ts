// The workspace tabs (Telemetry, Display, Functions, Visualizer...) and every
// tool's edits to what its tab saves.
//
// Tabs are never created on their own: the only way here is an explicit click
// on the Sidebar's "+", the View menu, or the Welcome page's "Live Data"
// panel.

import type { Dispatch, SetStateAction } from "react"
import { TOOL_KIND_META } from "../components/layout/Sidebar"
import {
  AppState, DashboardWidget, EquationConfig, EquationVariable,
  Field3dObjectConfig, Field3dSettings, FieldObjectConfig, FieldSettings,
  FunctionSeriesConfig, FunctionSettings, Mechanism3dPart, Mechanism3dSettings,
  MechanismSettings, MechanismSourceConfig, NTSessionEntry, NTSessionSettings,
  Swerve3dSettings, SwerveSettings, SwerveSourceConfig, ToolKind, WorkspaceTab,
  defaultField3dSettings, defaultFieldSettings, defaultFunctionSettings,
  defaultMechanism3dSettings, defaultMechanismSettings, defaultNTSessionSettings,
  defaultSwerve3dSettings, defaultSwerveSettings,
} from "../store/appStore"

// A counter for unique ids even when several are generated in the same tick.
let idCounter = 0
const nextObjectId = () => `${Date.now()}-${idCounter++}`

export function useWorkspaceTabs(setState: Dispatch<SetStateAction<AppState>>) {
  /** Applies `updater` to one tab and leaves the rest alone. */
  const updateTab = (tabId: string, updater: (tab: WorkspaceTab) => Partial<WorkspaceTab>) => {
    setState(prev => ({
      ...prev,
      openTabs: prev.openTabs.map(t => t.id === tabId ? { ...t, ...updater(t) } : t)
    }))
  }

  // --- The tabs themselves ---------------------------------------------------

  const createTab = (kind: ToolKind) => {
    const id = Date.now().toString()
    setState(prev => {
      const count = prev.openTabs.filter(t => t.kind === kind).length + 1
      const title = count === 1 ? TOOL_KIND_META[kind].label : `${TOOL_KIND_META[kind].label} ${count}`
      const newTab: WorkspaceTab = {
        id, kind, title,
        widgets: [], functionSeries: [], functionSettings: defaultFunctionSettings,
        fieldObjects: [], fieldSettings: defaultFieldSettings,
        field3dObjects: [], field3dSettings: defaultField3dSettings,
        swerveSources: [], swerveSettings: defaultSwerveSettings,
        swerve3dSettings: defaultSwerve3dSettings,
        mechanismSources: [], mechanismSettings: defaultMechanismSettings,
        mechanism3dParts: [], mechanism3dSettings: defaultMechanism3dSettings,
        ntSessionEntries: [], ntSessionSettings: defaultNTSessionSettings,
        equationVars: [], equations: [],
      }
      return { ...prev, openTabs: [...prev.openTabs, newTab], activeTabId: id }
    })
  }

  const closeTab = (id: string) => {
    setState(prev => ({
      ...prev,
      openTabs: prev.openTabs.filter(t => t.id !== id),
      activeTabId: prev.activeTabId === id ? null : prev.activeTabId,
    }))
  }

  const renameTab = (id: string, title: string) => updateTab(id, () => ({ title }))

  const setActiveTab = (id: string) => setState(prev => ({ ...prev, activeTabId: id }))

  // --- Widgets (per "display" tab) -------------------------------------------

  const addWidget = (tabId: string, widget: Omit<DashboardWidget, "id">) => {
    const newWidget = { ...widget, id: Date.now().toString() }
    updateTab(tabId, t => ({ widgets: [...t.widgets, newWidget] }))
  }

  const removeWidget = (tabId: string, id: string) =>
    updateTab(tabId, t => ({ widgets: t.widgets.filter(w => w.id !== id) }))

  const updateWidget = (tabId: string, id: string, updates: Partial<DashboardWidget>) =>
    updateTab(tabId, t => ({ widgets: t.widgets.map(w => w.id === id ? { ...w, ...updates } : w) }))

  const reorderWidgets = (tabId: string, newOrder: DashboardWidget[]) =>
    updateTab(tabId, () => ({ widgets: newOrder }))

  // --- Function page series (per "functions" tab) ----------------------------

  const addFunctionSeries = (tabId: string, series: Omit<FunctionSeriesConfig, "id">) => {
    // nextObjectId and not Date.now(): duplicating a series creates two in the
    // same millisecond and they would share the id React uses as a key.
    const newSeries = { ...series, id: nextObjectId() }
    updateTab(tabId, t => ({ functionSeries: [...t.functionSeries, newSeries] }))
  }

  const removeFunctionSeries = (tabId: string, id: string) =>
    updateTab(tabId, t => ({ functionSeries: t.functionSeries.filter(s => s.id !== id) }))

  const updateFunctionSettings = (tabId: string, updates: Partial<FunctionSettings>) =>
    updateTab(tabId, t => ({ functionSettings: { ...t.functionSettings, ...updates } }))

  const updateFunctionSeries = (tabId: string, id: string, updates: Partial<FunctionSeriesConfig>) =>
    updateTab(tabId, t => ({ functionSeries: t.functionSeries.map(s => s.id === id ? { ...s, ...updates } : s) }))

  // --- 2D Visualizer (per "visualizer" tab) ----------------------------------

  const addFieldObject = (tabId: string, object: Omit<FieldObjectConfig, "id">): string => {
    // nextObjectId and not Date.now(): dropping a whole Field2d table adds
    // several objects within the SAME millisecond and they would all get the
    // same id, which React uses as a key.
    const newObject = { ...object, id: nextObjectId() }
    updateTab(tabId, t => ({ fieldObjects: [...t.fieldObjects, newObject] }))
    // The id is returned because the 2D Visualizer needs it to hand the new
    // object the trail history of the one it was just duplicated from.
    return newObject.id
  }

  const removeFieldObject = (tabId: string, id: string) =>
    updateTab(tabId, t => ({ fieldObjects: t.fieldObjects.filter(o => o.id !== id) }))

  const updateFieldObject = (tabId: string, id: string, updates: Partial<FieldObjectConfig>) =>
    updateTab(tabId, t => ({ fieldObjects: t.fieldObjects.map(o => o.id === id ? { ...o, ...updates } : o) }))

  const updateFieldSettings = (tabId: string, updates: Partial<FieldSettings>) =>
    updateTab(tabId, t => ({ fieldSettings: { ...t.fieldSettings, ...updates } }))

  // --- Field 3D (per "field3d" tab) ------------------------------------------
  // Deliberately separate from the 2D one: they share the idea of "a list of
  // objects on a field", but not the types or the options, and unifying them
  // would force every new field of one to make sense for the other.

  const addField3dObject = (tabId: string, object: Omit<Field3dObjectConfig, "id">): string => {
    const newObject = { ...object, id: nextObjectId() }
    updateTab(tabId, t => ({ field3dObjects: [...t.field3dObjects, newObject] }))
    // The id is returned because the page needs it to hand the new object the
    // trail history of the one it was just duplicated from.
    return newObject.id
  }

  const removeField3dObject = (tabId: string, id: string) =>
    updateTab(tabId, t => ({
      field3dObjects: t.field3dObjects
        .filter(o => o.id !== id)
        // A component anchored to the robot that was just deleted would point
        // at nothing; it is released so it falls back to the first available
        // robot instead of silently no longer being drawn.
        .map(o => o.anchorId === id ? { ...o, anchorId: null } : o),
    }))

  const updateField3dObject = (tabId: string, id: string, updates: Partial<Field3dObjectConfig>) =>
    updateTab(tabId, t => ({ field3dObjects: t.field3dObjects.map(o => o.id === id ? { ...o, ...updates } : o) }))

  const updateField3dSettings = (tabId: string, updates: Partial<Field3dSettings>) =>
    updateTab(tabId, t => ({ field3dSettings: { ...t.field3dSettings, ...updates } }))

  // --- Swerve Visualizer (per "swerve" and "swerve3d" tab) -------------------

  const addSwerveSource = (tabId: string, source: Omit<SwerveSourceConfig, "id">) => {
    const newSource = { ...source, id: Date.now().toString() }
    updateTab(tabId, t => ({ swerveSources: [...t.swerveSources, newSource] }))
  }

  const removeSwerveSource = (tabId: string, id: string) =>
    updateTab(tabId, t => ({ swerveSources: t.swerveSources.filter(s => s.id !== id) }))

  const updateSwerveSource = (tabId: string, id: string, updates: Partial<SwerveSourceConfig>) =>
    updateTab(tabId, t => ({ swerveSources: t.swerveSources.map(s => s.id === id ? { ...s, ...updates } : s) }))

  const updateSwerveSettings = (tabId: string, updates: Partial<SwerveSettings>) =>
    updateTab(tabId, t => ({ swerveSettings: { ...t.swerveSettings, ...updates } }))

  const updateSwerve3dSettings = (tabId: string, updates: Partial<Swerve3dSettings>) =>
    updateTab(tabId, t => ({ swerve3dSettings: { ...t.swerve3dSettings, ...updates } }))

  // --- Mechanism2d (per "mechanism" tab) -------------------------------------
  // A source here is a whole NT TABLE (prefix), not a single topic.

  const addMechanismSource = (tabId: string, source: Omit<MechanismSourceConfig, "id">) => {
    const newSource = { ...source, id: Date.now().toString() }
    updateTab(tabId, t => ({ mechanismSources: [...t.mechanismSources, newSource] }))
  }

  const removeMechanismSource = (tabId: string, id: string) =>
    updateTab(tabId, t => ({ mechanismSources: t.mechanismSources.filter(s => s.id !== id) }))

  const updateMechanismSource = (tabId: string, id: string, updates: Partial<MechanismSourceConfig>) =>
    updateTab(tabId, t => ({ mechanismSources: t.mechanismSources.map(s => s.id === id ? { ...s, ...updates } : s) }))

  const updateMechanismSettings = (tabId: string, updates: Partial<MechanismSettings>) =>
    updateTab(tabId, t => ({ mechanismSettings: { ...t.mechanismSettings, ...updates } }))

  // --- Mechanism 3D (per "mechanism3d" tab) ----------------------------------
  // The parts travel as a WHOLE array and not one at a time: adding, deleting,
  // duplicating and reparenting touch several rows at once, and the page
  // already has the whole tree to compute the result.

  const setMechanism3dParts = (tabId: string, parts: Mechanism3dPart[]) =>
    updateTab(tabId, () => ({ mechanism3dParts: parts }))

  const updateMechanism3dSettings = (tabId: string, updates: Partial<Mechanism3dSettings>) =>
    updateTab(tabId, t => ({ mechanism3dSettings: { ...t.mechanism3dSettings, ...updates } }))

  // --- NT Session (per "ntsession" tab) --------------------------------------

  const setNTSessionEntries = (tabId: string, entries: NTSessionEntry[]) =>
    updateTab(tabId, () => ({ ntSessionEntries: entries }))

  const updateNTSessionSettings = (tabId: string, updates: Partial<NTSessionSettings>) =>
    updateTab(tabId, t => ({ ntSessionSettings: { ...t.ntSessionSettings, ...updates } }))

  // --- Equations (per "equations" tab) ---------------------------------------

  const addEquationVariable = (tabId: string, variable: Omit<EquationVariable, "id">) =>
    updateTab(tabId, t => ({ equationVars: [...t.equationVars, { ...variable, id: Date.now().toString() }] }))

  const removeEquationVariable = (tabId: string, id: string) =>
    updateTab(tabId, t => ({ equationVars: t.equationVars.filter(v => v.id !== id) }))

  const updateEquationVariable = (tabId: string, id: string, updates: Partial<EquationVariable>) =>
    updateTab(tabId, t => ({ equationVars: t.equationVars.map(v => v.id === id ? { ...v, ...updates } : v) }))

  const addEquation = (tabId: string, equation: Omit<EquationConfig, "id">) =>
    updateTab(tabId, t => ({ equations: [...t.equations, { ...equation, id: Date.now().toString() }] }))

  const removeEquation = (tabId: string, id: string) =>
    updateTab(tabId, t => ({ equations: t.equations.filter(e => e.id !== id) }))

  const updateEquation = (tabId: string, id: string, updates: Partial<EquationConfig>) =>
    updateTab(tabId, t => ({ equations: t.equations.map(e => e.id === id ? { ...e, ...updates } : e) }))

  return {
    createTab, closeTab, renameTab, setActiveTab,
    addWidget, removeWidget, updateWidget, reorderWidgets,
    addFunctionSeries, removeFunctionSeries, updateFunctionSettings, updateFunctionSeries,
    addFieldObject, removeFieldObject, updateFieldObject, updateFieldSettings,
    addField3dObject, removeField3dObject, updateField3dObject, updateField3dSettings,
    addSwerveSource, removeSwerveSource, updateSwerveSource, updateSwerveSettings, updateSwerve3dSettings,
    addMechanismSource, removeMechanismSource, updateMechanismSource, updateMechanismSettings,
    setMechanism3dParts, updateMechanism3dSettings,
    setNTSessionEntries, updateNTSessionSettings,
    addEquationVariable, removeEquationVariable, updateEquationVariable,
    addEquation, removeEquation, updateEquation,
  }
}

export type WorkspaceTabActions = ReturnType<typeof useWorkspaceTabs>
