import { useState } from "react"
import { Page, ConnectionState, ToolKind } from "../store/appStore"
import { MARS_ENABLED, PROJECT_ITEMS, MODULE_ITEMS, CONFIG_ITEMS } from "@mars"

interface Props {
  navigate: (page: Page) => void
  onOpenProject: () => void
  connection: ConnectionState
  onConnectSim: () => void
  onConnectReal: () => void
  onDisconnect: () => void
  onCreateTab: (kind: ToolKind) => void
  projectName: string | null
}

// A startup screen in the style of a 2000s desktop suite: a dark band on top
// with the logo and three beveled panels with dense lists. No big cards nor a
// full-screen hero — this is a tool's index, not a product's landing page.
export default function WelcomePage({ navigate, onOpenProject, onCreateTab, projectName }: Props) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg-app)", overflow: "hidden" }}>

      <Banner projectName={projectName} />

      <div style={{ flex: 1, display: "flex", justifyContent: "center", overflowY: "auto" }}>
        <div style={{ width: "100%", maxWidth: 680, padding: "18px 24px 40px", display: "flex", flexDirection: "column", gap: 14 }}>

          {/* A project is a MARS project. In the Tools edition the whole panel
              is gone and Settings moves to the tools panel. */}
          {MARS_ENABLED && (
            <BevelPanel title="Project" icon="open-folder.svg">
              <LaunchList
                items={[
                  ...PROJECT_ITEMS.flatMap(i => [
                    { svg: i.svg, title: i.label, desc: i.desc, page: i.page },
                    // "Open project" is an action, not a page: it goes after
                    // "New project", as in the sidebar.
                    ...(i.page === "creator"
                      ? [{ svg: "open-folder.svg", title: "Open project", desc: "Load from disk", action: onOpenProject }]
                      : []),
                  ]),
                  { svg: "settings.svg", title: "Settings", desc: "Workspace paths and defaults", page: "settings" as Page },
                ]}
                navigate={navigate}
              />
            </BevelPanel>
          )}

          <BevelPanel title="Live Data" icon="connect.svg">
            <LaunchList
              items={[
                { svg: "visualizer2d.svg", title: "2D Visualizer", desc: "Robot poses on the field", tabKind: "visualizer" },
                { svg: "field3d.svg", title: "Field 3D", desc: "The season field in 3D, with your robot and its components", tabKind: "field3d" },
                { svg: "swerve.svg", title: "Swerve", desc: "Module states and chassis speeds", tabKind: "swerve" },
                { svg: "swerve3d.svg", title: "Swerve 3D", desc: "Your robot model driven by the module states", tabKind: "swerve3d" },
                { svg: "mechanism.svg", title: "Mechanism", desc: "Mechanism2d roots and ligaments", tabKind: "mechanism" },
                { svg: "mechanism3d.svg", title: "Mechanism 3D", desc: "Articulated STL/GLB parts driven by your topics", tabKind: "mechanism3d" },
                { svg: "nt-session.svg", title: "NT Session", desc: "Publish your own values and copy them as Java", tabKind: "ntsession" },
                { svg: "telemetry.svg", title: "Telemetry", desc: "Live variable inspector", tabKind: "telemetry" },
                { svg: "display.svg", title: "Display", desc: "Custom live dashboard", tabKind: "display" },
                { svg: "function.svg", title: "Function plot", desc: "Plot numeric topics over time", tabKind: "functions" },
                { svg: "equation.svg", title: "Equations", desc: "Live math over your variables", tabKind: "equations" },
              ]}
              navigate={navigate}
              onCreateTab={onCreateTab}
            />
          </BevelPanel>

          <BevelPanel title="Tools" icon="packages.svg">
            <LaunchList
              items={[
                ...MODULE_ITEMS.map(i => ({ svg: i.svg, title: i.label, desc: i.desc, page: i.page })),
                ...CONFIG_ITEMS.map(i => ({ svg: i.svg, title: i.label, desc: i.desc, page: i.page })),
                { svg: "loop-timing.svg", title: "Loop timing", desc: "Jitter and period analysis", page: "jitter" as Page },
                { svg: "network.svg", title: "Network bandwidth", desc: "Which topics eat the 4 Mbps budget", page: "bandwidth" as Page },
                { svg: "sysid.svg", title: "System identification", desc: "Fit kS/kV/kA from recorded runs", page: "sysid" as Page },
                { svg: "console.svg", title: "Command console", desc: "Write values back to the robot", page: "console" as Page },
                { svg: "phone.svg", title: "Phone telemetry", desc: "Cast dashboard to mobile", page: "phone" as Page },
                ...(MARS_ENABLED ? [] : [
                  { svg: "settings.svg", title: "Settings", desc: "Team number, NetworkTables target", page: "settings" as Page },
                ]),
              ]}
              navigate={navigate}
            />
          </BevelPanel>

        </div>
      </div>
    </div>
  )
}

// A dark band with the logo, the same grey as the menu bar: together they form
// the window's "roof".
function Banner({ projectName }: { projectName: string | null }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "14px 24px", flexShrink: 0,
      background: "linear-gradient(180deg, #3c3d44 0%, #2b2c31 100%)",
      borderBottom: "1px solid #14151a",
      boxShadow: "inset 0 1px 0 #55565e",
    }}>
      <img src="/marslogo.png" alt="MARS" style={{ height: 30, objectFit: "contain" }} draggable={false} />

      <div style={{ width: 1, height: 26, background: "#55565e" }} />

      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: "var(--text-menubar)", letterSpacing: 0.4 }}>
          Modular Architecture for Robot Systems
        </div>
        {/* There are no projects in the Tools edition: announcing that none is
            loaded would be talking about something that does not exist. */}
        {MARS_ENABLED && (
        <div style={{ fontSize: 10, marginTop: 2, fontFamily: "ui-monospace, monospace" }}>
          {projectName ? (
            <span style={{ color: "#f0a860" }}>PROJECT: {projectName.toUpperCase()}</span>
          ) : (
            <span style={{ color: "var(--text-menubar-dim)" }}>NO PROJECT LOADED</span>
          )}
        </div>
        )}
      </div>
    </div>
  )
}

// A raised panel: a gradient title bar and a beveled border, like a classic Qt
// QGroupBox.
function BevelPanel({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--bg-page)",
      borderTop: "1px solid var(--bevel-light)",
      borderLeft: "1px solid var(--bevel-light)",
      borderRight: "1px solid var(--bevel-dark)",
      borderBottom: "1px solid var(--bevel-dark)",
      boxShadow: "1px 1px 0 var(--shadow-soft)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        height: 24, padding: "0 8px",
        background: "linear-gradient(180deg, #e6e6ea 0%, #d4d4da 100%)",
        borderBottom: "1px solid var(--bevel-dark)",
        userSelect: "none",
      }}>
        <img src={`/icons/${icon}`} alt="" aria-hidden width={14} height={14} draggable={false} style={{ display: "block" }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", letterSpacing: 0.2 }}>{title}</span>
      </div>
      {children}
    </div>
  )
}

interface LaunchItem {
  svg: string
  title: string
  desc: string
  page?: Page
  tabKind?: ToolKind
  action?: () => void
}

function LaunchList({ items, navigate, onCreateTab }: {
  items: LaunchItem[]
  navigate: (page: Page) => void
  onCreateTab?: (kind: ToolKind) => void
}) {
  return (
    <div>
      {items.map((item, i) => (
        <LaunchRow
          key={item.title}
          item={item}
          navigate={navigate}
          onCreateTab={onCreateTab}
          // Striping: in dense lists of even rows it is what makes the eye follow
          // the line to the description on the right.
          striped={i % 2 === 1}
        />
      ))}
    </div>
  )
}

function LaunchRow({ item, navigate, onCreateTab, striped }: {
  item: LaunchItem
  navigate: (page: Page) => void
  onCreateTab?: (kind: ToolKind) => void
  striped: boolean
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={() => {
        if (item.action) return item.action()
        if (item.tabKind) return onCreateTab?.(item.tabKind)
        if (item.page) return navigate(item.page)
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "0 9px", height: 24,
        background: hovered ? "var(--tree-selection-bg)" : striped ? "var(--bg-panel)" : "transparent",
        color: hovered ? "var(--tree-selection-fg)" : "var(--text-primary)",
        cursor: "pointer", userSelect: "none",
      }}
    >
      <img src={`/icons/${item.svg}`} alt="" aria-hidden width={15} height={15} draggable={false} style={{ display: "block", flexShrink: 0 }} />
      <span style={{ fontSize: 11.5, flexShrink: 0 }}>{item.title}</span>
      <span style={{
        fontSize: 10, marginLeft: "auto", textAlign: "right",
        color: hovered ? "var(--tree-selection-fg)" : "var(--text-muted)",
        opacity: hovered ? 0.85 : 1,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {item.desc}
      </span>
    </div>
  )
}
