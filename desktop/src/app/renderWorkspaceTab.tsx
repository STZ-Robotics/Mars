// Which page draws each kind of workspace tab, wired to that tab's actions.

import TelemetryPage from "../pages/TelemetryPage"
import DisplayPage from "../pages/DisplayPage"
import FunctionPage from "../pages/FunctionPage"
import FieldPage from "../pages/FieldPage"
import Field3dPage from "../pages/Field3dPage"
import SwervePage from "../pages/SwervePage"
import Swerve3dPage from "../pages/Swerve3dPage"
import MechanismPage from "../pages/MechanismPage"
import Mechanism3dPage from "../pages/Mechanism3dPage"
import NTSessionPage from "../pages/NTSessionPage"
import EquationsPage from "../pages/EquationsPage"
import type { AppState, WorkspaceTab } from "../store/appStore"
import type { WorkspaceTabActions } from "./useWorkspaceTabs"

export function renderWorkspaceTab(tab: WorkspaceTab, state: AppState, a: WorkspaceTabActions) {
  switch (tab.kind) {
    case "telemetry": return <TelemetryPage projectName={state.projectName} projectPath={state.projectPath} topics={state.topics} />
    case "display": return (
      <DisplayPage
        topics={state.topics}
        widgets={tab.widgets}
        onAddWidget={(w) => a.addWidget(tab.id, w)}
        onRemoveWidget={(id) => a.removeWidget(tab.id, id)}
        onUpdateWidget={(id, updates) => a.updateWidget(tab.id, id, updates)}
        onReorderWidgets={(newOrder) => a.reorderWidgets(tab.id, newOrder)}
      />
    )
    // AdvantageScope-style line plots (integral/derivative)
    case "functions": return (
      <FunctionPage
        topics={state.topics}
        series={tab.functionSeries}
        settings={tab.functionSettings}
        onAddSeries={(s) => a.addFunctionSeries(tab.id, s)}
        onRemoveSeries={(id) => a.removeFunctionSeries(tab.id, id)}
        onUpdateSeries={(id, updates) => a.updateFunctionSeries(tab.id, id, updates)}
        onUpdateSettings={(updates) => a.updateFunctionSettings(tab.id, updates)}
      />
    )
    case "visualizer": return (
      <FieldPage
        topics={state.topics}
        objects={tab.fieldObjects}
        settings={tab.fieldSettings}
        onAddObject={(o) => a.addFieldObject(tab.id, o)}
        onRemoveObject={(id) => a.removeFieldObject(tab.id, id)}
        onUpdateObject={(id, updates) => a.updateFieldObject(tab.id, id, updates)}
        onUpdateSettings={(updates) => a.updateFieldSettings(tab.id, updates)}
      />
    )
    case "field3d": return (
      <Field3dPage
        topics={state.topics}
        objects={tab.field3dObjects}
        settings={tab.field3dSettings}
        onAddObject={(o) => a.addField3dObject(tab.id, o)}
        onRemoveObject={(id) => a.removeField3dObject(tab.id, id)}
        onUpdateObject={(id, updates) => a.updateField3dObject(tab.id, id, updates)}
        onUpdateSettings={(updates) => a.updateField3dSettings(tab.id, updates)}
      />
    )
    case "swerve": return (
      <SwervePage
        topics={state.topics}
        sources={tab.swerveSources}
        settings={tab.swerveSettings}
        onAddSource={(s) => a.addSwerveSource(tab.id, s)}
        onRemoveSource={(id) => a.removeSwerveSource(tab.id, id)}
        onUpdateSource={(id, updates) => a.updateSwerveSource(tab.id, id, updates)}
        onUpdateSettings={(updates) => a.updateSwerveSettings(tab.id, updates)}
      />
    )
    // The same tab as "swerve" but in 3D: it shares sources and chassis size,
    // and adds the imported model and where the modules sit.
    case "swerve3d": return (
      <Swerve3dPage
        topics={state.topics}
        sources={tab.swerveSources}
        settings={tab.swerveSettings}
        view={tab.swerve3dSettings}
        onAddSource={(s) => a.addSwerveSource(tab.id, s)}
        onRemoveSource={(id) => a.removeSwerveSource(tab.id, id)}
        onUpdateSource={(id, updates) => a.updateSwerveSource(tab.id, id, updates)}
        onUpdateSettings={(updates) => a.updateSwerveSettings(tab.id, updates)}
        onUpdateView={(updates) => a.updateSwerve3dSettings(tab.id, updates)}
      />
    )
    case "mechanism": return (
      <MechanismPage
        topics={state.topics}
        sources={tab.mechanismSources}
        settings={tab.mechanismSettings}
        onAddSource={(s) => a.addMechanismSource(tab.id, s)}
        onRemoveSource={(id) => a.removeMechanismSource(tab.id, id)}
        onUpdateSource={(id, updates) => a.updateMechanismSource(tab.id, id, updates)}
        onUpdateSettings={(updates) => a.updateMechanismSettings(tab.id, updates)}
      />
    )
    case "mechanism3d": return (
      <Mechanism3dPage
        topics={state.topics}
        parts={tab.mechanism3dParts}
        settings={tab.mechanism3dSettings}
        onSetParts={(parts) => a.setMechanism3dParts(tab.id, parts)}
        onUpdateSettings={(updates) => a.updateMechanism3dSettings(tab.id, updates)}
      />
    )
    // The reverse of the rest: this tab PUBLISHES its own topics instead of
    // reading the robot's, so it needs to know whether there is a connection.
    case "ntsession": return (
      <NTSessionPage
        topics={state.topics}
        connection={state.connection}
        entries={tab.ntSessionEntries}
        settings={tab.ntSessionSettings}
        onSetEntries={(entries) => a.setNTSessionEntries(tab.id, entries)}
        onUpdateSettings={(updates) => a.updateNTSessionSettings(tab.id, updates)}
      />
    )
    case "equations": return (
      <EquationsPage
        topics={state.topics}
        variables={tab.equationVars}
        equations={tab.equations}
        onAddVariable={(v) => a.addEquationVariable(tab.id, v)}
        onRemoveVariable={(id) => a.removeEquationVariable(tab.id, id)}
        onUpdateVariable={(id, updates) => a.updateEquationVariable(tab.id, id, updates)}
        onAddEquation={(e) => a.addEquation(tab.id, e)}
        onRemoveEquation={(id) => a.removeEquation(tab.id, id)}
        onUpdateEquation={(id, updates) => a.updateEquation(tab.id, id, updates)}
      />
    )
  }
}
