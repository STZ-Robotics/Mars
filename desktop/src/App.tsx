import { useState } from "react"
import "./styles/global.css"
import MenuBar from "./components/layout/MenuBar"
import Sidebar from "./components/layout/Sidebar"
import StatusBar from "./components/layout/StatusBar"
import TimelineGlobal from "./components/layout/TimelineGlobal"
import WelcomePage from "./pages/WelcomePage"
import SettingsPage from "./pages/SettingsPage"
import PhonePage from "./pages/PhonePage"
import CommandConsolePage from "./pages/CommandConsolePage"
import JitterAnalyzerPage from "./pages/JitterAnalyzerPage"
import BandwidthPage from "./pages/BandwidthPage"
import SysIdPage from "./pages/SysIdPage"
import PreferencesPage from "./pages/PreferencesPage"

// Everything that depends on the MARS framework comes in through here. In the
// Tools edition the `@mars` alias resolves to a stub and none of those pages
// ever reach the bundle (see src/mars/README.md).
import { renderMarsPage } from "@mars"

import { defaultState, AppState, Page } from "./store/appStore"
import { useStructSchemas } from "./hooks/useStructSchemas"
import { useNTTableTypes } from "./hooks/useNTTableTypes"
import { useWorkspaceTabs } from "./app/useWorkspaceTabs"
import { useWorkspacePersistence } from "./app/useWorkspacePersistence"
import { useLogFile } from "./app/useLogFile"
import { useNTConnection } from "./app/useNTConnection"
import { renderWorkspaceTab } from "./app/renderWorkspaceTab"

function App() {
  const [state, setState] = useState<AppState>(defaultState)

  const navigate = (page: Page) => setState(prev => ({ ...prev, currentPage: page, activeTabId: null }))

  // Registers the struct schemas the robot publishes (or the log carries), to
  // understand types that are not in the hand-written table.
  useStructSchemas(state.topics)

  // Reads the sendable tables' ".type", which is what makes it possible to
  // recognize a Field2d (its root is not a topic, so it cannot be inferred from
  // the announce).
  useNTTableTypes(state.topics)

  const tabs = useWorkspaceTabs(setState)
  const layout = useWorkspacePersistence(state, setState)
  const log = useLogFile(setState)
  const nt = useNTConnection(setState)

  const renderPage = () => {
    const activeTab = state.activeTabId ? state.openTabs.find(t => t.id === state.activeTabId) : undefined
    if (activeTab) return renderWorkspaceTab(activeTab, state, tabs)

    // The MARS framework's pages are resolved first and live in their own
    // module: in the Tools edition this always returns null and falls through
    // to the switch, which no longer has those cases. Neither edition notices.
    const marsPage = renderMarsPage(state.currentPage, {
      projectName: state.projectName,
      projectPath: state.projectPath,
      topics: state.topics,
      connection: state.connection,
      logSource: state.logSource,
    })
    if (marsPage) return marsPage

    switch (state.currentPage) {
      case "welcome": return (
      <WelcomePage
          navigate={navigate}
          onOpenProject={nt.handleOpenProject}
          connection={state.connection}
          onConnectSim={nt.handleConnectSim}
          onConnectReal={nt.handleConnectReal}
          onDisconnect={nt.handleDisconnect}
          onCreateTab={tabs.createTab}
          projectName={state.projectName}
        />
      )
      case "settings": return <SettingsPage />
      case "bandwidth": return <BandwidthPage connection={state.connection} logSource={state.logSource} />
      case "sysid": return (
        <SysIdPage topics={state.topics} connection={state.connection} logSource={state.logSource} />
      )
      // The NT Session's persistent sibling: what is written to /Preferences
      // survives a robot restart.
      case "preferences": return (
        <PreferencesPage topics={state.topics} connection={state.connection} />
      )
      case "phone": return <PhonePage />
      case "jitter" : return (<JitterAnalyzerPage connection={state.connection} topics={state.topics}></JitterAnalyzerPage>)
      case "console" : return (<CommandConsolePage connection={state.connection} topics={state.topics}></CommandConsolePage>)
      default: return (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-page)" }}>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Page "{state.currentPage}" — coming soon</p>
        </div>
      )
    }
  }

  return (
    <div className="app-root" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <MenuBar
        navigate={navigate}
        currentPage={state.currentPage}
        onOpenProject={nt.handleOpenProject}
        connection={state.connection}
        onConnectSim={nt.handleConnectSim}
        onConnectReal={nt.handleConnectReal}
        onDisconnect={nt.handleDisconnect}
        onCreateTab={tabs.createTab}
        logSource={state.logSource}
        onOpenLog={log.handleOpenLog}
        onExportLog={log.handleExportLog}
        onCloseLog={log.handleCloseLog}
        onSaveLayoutAs={layout.handleSaveLayoutAs}
        onOpenLayout={layout.handleOpenLayout}
        onResetLayout={layout.handleResetLayout}
        onToggleSidebar={() => layout.setSidebarCollapsed(c => !c)}
        sidebarCollapsed={layout.sidebarCollapsed}
        projectName={state.projectName}
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        <Sidebar
          navigate={navigate}
          currentPage={state.currentPage}
          onOpenProject={nt.handleOpenProject}
          connection={state.connection}
          onConnectSim={nt.handleConnectSim}
          onConnectReal={nt.handleConnectReal}
          onDisconnect={nt.handleDisconnect}
          openTabs={state.openTabs}
          activeTabId={state.activeTabId}
          onCreateTab={tabs.createTab}
          onSelectTab={tabs.setActiveTab}
          onRenameTab={tabs.renameTab}
          onCloseTab={tabs.closeTab}
          collapsed={layout.sidebarCollapsed}
          onToggleCollapsed={() => layout.setSidebarCollapsed(c => !c)}
        />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", position: "relative" }}>
          {renderPage()}
        </div>
      </div>

      {/* Time panel at the very bottom, full width — the same position as
          RViz's "Time" dock (above the status bar). */}
      <TimelineGlobal connection={state.connection} hasLog={state.logSource !== null} />
      <StatusBar connection={state.connection} projectName={state.projectName} logSource={state.logSource} />
    </div>
  )
}

export default App
