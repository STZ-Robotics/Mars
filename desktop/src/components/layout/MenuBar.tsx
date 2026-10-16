import { useState } from "react"
import { Page, ConnectionState, ToolKind, LogSource } from "../../store/appStore"
import { MARS_ENABLED, PROJECT_ITEMS, MODULE_ITEMS, CONFIG_ITEMS } from "@mars"

interface Props {
  navigate: (page: Page) => void
  currentPage: Page
  onOpenProject: () => void
  connection: ConnectionState
  onConnectSim: () => void
  onConnectReal: () => void
  onDisconnect: () => void
  onCreateTab: (kind: ToolKind) => void
  logSource: LogSource | null
  onOpenLog: () => void
  onExportLog: () => void
  onCloseLog: () => void
  onSaveLayoutAs: () => void
  onOpenLayout: () => void
  onResetLayout: () => void
  onToggleSidebar: () => void
  sidebarCollapsed: boolean
  projectName: string | null
}

interface MenuEntry {
  label: string
  action: () => void
  separator?: boolean
  disabled?: boolean
  dot?: "sim" | "real" | null // status dot on the left (optional)
}

interface MenuItem {
  label: string
  items: MenuEntry[]
}

const BAR_HEIGHT = 30

// The dark menu bar: besides the menus it carries the logo and the connection
// dot, because it absorbed the title strip that used to be on top (a whole 32px
// row spent on a single fixed line of text).
export default function MenuBar({
  navigate, onOpenProject, connection, onConnectSim, onConnectReal, onDisconnect, onCreateTab,
  logSource, onOpenLog, onExportLog, onCloseLog, onSaveLayoutAs, onOpenLayout, onResetLayout,
  onToggleSidebar, sidebarCollapsed, projectName,
}: Props) {
  const [open, setOpen] = useState<string | null>(null)

  const toggle = (label: string) => setOpen(prev => prev === label ? null : label)
  const close = () => setOpen(null)

  const isConnected = connection !== "disconnected"

  // A list from @mars becomes menu entries followed by a separator; an empty
  // one contributes nothing, not even the separator.
  const marsMenuItems = (items: readonly { label: string; page: Page }[]): MenuEntry[] =>
    items.length === 0 ? [] : [
      ...items.map(item => ({ label: item.label, action: () => { navigate(item.page); close() } })),
      { label: "separator", action: () => {}, separator: true },
    ]

  const menus: MenuItem[] = [
    {
      label: "File",
      items: [
        // A project is a MARS project: in the Tools edition these two entries
        // and their separator do not exist.
        ...(MARS_ENABLED ? [
          { label: "New project", action: () => { navigate("creator"); close() } },
          { label: "Open project", action: () => { onOpenProject(); close() } },
          { label: "separator", action: () => {}, separator: true },
        ] : []),
        { label: "Open log…", action: () => { onOpenLog(); close() } },
        { label: "Export log…", action: () => { onExportLog(); close() } },
        // This entry used to exist only when a log was open, so it appeared and
        // disappeared and shifted everything below. Now it is always there and
        // gets disabled, which is how a real menu behaves.
        {
          label: logSource ? `Close log (${logSource.name})` : "Close log",
          action: () => { onCloseLog(); close() },
          disabled: logSource === null,
        },
        { label: "separator", action: () => {}, separator: true },
        { label: "Save layout as…", action: () => { onSaveLayoutAs(); close() } },
        { label: "Open layout…", action: () => { onOpenLayout(); close() } },
        { label: "Reset layout", action: () => { onResetLayout(); close() } },
        { label: "separator", action: () => {}, separator: true },
        { label: "Settings", action: () => { navigate("settings"); close() } },
      ],
    },
    {
      // "Simulation" was lying: the real robot is also connected from here.
      label: "Connection",
      items: [
        {
          label: connection === "sim" ? "Disconnect simulation" : "Connect to sim",
          action: () => { connection === "sim" ? onDisconnect() : onConnectSim(); close() },
          dot: "sim",
        },
        {
          label: connection === "real" ? "Disconnect real robot" : "Connect to real robot",
          action: () => { connection === "real" ? onDisconnect() : onConnectReal(); close() },
          dot: "real",
        },
        { label: "separator", action: () => {}, separator: true },
        // The same action as above, but as an entry of its own it does not force
        // you to remember which of the two you had connected with.
        { label: "Disconnect", action: () => { onDisconnect(); close() }, disabled: !isConnected },
        { label: "separator", action: () => {}, separator: true },
        { label: "Connection settings…", action: () => { navigate("settings"); close() } },
      ],
    },
    {
      label: "View",
      items: [
        { label: "2D Visualizer (new tab)", action: () => { onCreateTab("visualizer"); close() } },
        { label: "Field 3D (new tab)", action: () => { onCreateTab("field3d"); close() } },
        { label: "Swerve (new tab)", action: () => { onCreateTab("swerve"); close() } },
        { label: "Swerve 3D (new tab)", action: () => { onCreateTab("swerve3d"); close() } },
        { label: "Mechanism2d (new tab)", action: () => { onCreateTab("mechanism"); close() } },
        { label: "Mechanism 3D (new tab)", action: () => { onCreateTab("mechanism3d"); close() } },
        { label: "NT Session (new tab)", action: () => { onCreateTab("ntsession"); close() } },
        { label: "Telemetry view (new tab)", action: () => { onCreateTab("telemetry"); close() } },
        { label: "Display dashboard (new tab)", action: () => { onCreateTab("display"); close() } },
        { label: "Function plot (new tab)", action: () => { onCreateTab("functions"); close() } },
        { label: "Equations (new tab)", action: () => { onCreateTab("equations"); close() } },
        { label: "separator", action: () => {}, separator: true },
        {
          label: sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
          action: () => { onToggleSidebar(); close() },
        },
      ],
    },
    {
      label: "Tools",
      items: [
        // The entries that depend on the framework come from @mars, which in the
        // Tools edition exports empty lists: there are no loose conditionals
        // here that somebody could forget to update.
        ...marsMenuItems([...PROJECT_ITEMS, ...MODULE_ITEMS]),
        ...marsMenuItems(CONFIG_ITEMS),
        // These pages existed but were in no menu: they could only be reached
        // from the sidebar.
        { label: "Loop timing", action: () => { navigate("jitter"); close() } },
        { label: "Network bandwidth", action: () => { navigate("bandwidth"); close() } },
        { label: "System identification", action: () => { navigate("sysid"); close() } },
        { label: "Command console", action: () => { navigate("console"); close() } },
        { label: "separator", action: () => {}, separator: true },
        { label: "Launch phone telemetry", action: () => { navigate("phone"); close() } },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Documentation", action: () => { window.open("https://github.com/STZ-Robotics", "_blank"); close() } },
        { label: "About MARS", action: () => { navigate("about"); close() } },
      ],
    },
  ]

  const statusColor = connection === "sim" ? "var(--status-sim)"
    : connection === "real" ? "var(--status-error)"
    : logSource ? "var(--mars-accent)"
    : "var(--text-menubar-dim)"

  return (
    <div
      style={{
        background: "var(--bg-menubar-dark)",
        borderBottom: "1px solid #14151a",
        height: BAR_HEIGHT, display: "flex", alignItems: "center",
        flexShrink: 0, position: "relative", zIndex: 100, userSelect: "none",
      }}
      onMouseLeave={close}
    >
      {/* "marslogo" is the LIGHT logo: it is the one that goes on a dark
          background (the one called "black" is for a light background). */}
      <div style={{ display: "flex", alignItems: "center", padding: "0 11px 0 10px", flexShrink: 0 }}>
        <img src="/marslogo.png" alt="MARS" style={{ height: 17, objectFit: "contain" }} draggable={false} />
      </div>

      <div style={{ width: 1, height: 16, background: "#4a4b53", marginRight: 4, flexShrink: 0 }} />

      {menus.map(menu => (
        <div key={menu.label} style={{ position: "relative", height: "100%" }}>
          <div
            onClick={() => toggle(menu.label)}
            // With a menu already open, hovering switches menus without clicking
            // again — the classic behavior of a menu bar.
            onMouseEnter={() => open ? setOpen(menu.label) : undefined}
            onMouseOver={e => {
              if (open !== menu.label) e.currentTarget.style.background = "var(--bg-menubar-dark-hover)"
            }}
            onMouseOut={e => {
              if (open !== menu.label) e.currentTarget.style.background = "transparent"
            }}
            style={{
              padding: "0 11px", height: "100%",
              display: "flex", alignItems: "center",
              fontSize: 11.5, cursor: "pointer",
              color: "var(--text-menubar)",
              background: open === menu.label ? "var(--bg-menubar-dark-active)" : "transparent",
            }}
          >
            {menu.label}
          </div>

          {open === menu.label && (
            <div style={{
              position: "absolute", top: BAR_HEIGHT, left: 0,
              background: "var(--bg-panel)",
              // Classic bevel: light top-left, dark bottom-right.
              borderTop: "1px solid var(--bevel-light)",
              borderLeft: "1px solid var(--bevel-light)",
              borderRight: "1px solid var(--bevel-dark)",
              borderBottom: "1px solid var(--bevel-dark)",
              minWidth: 218, zIndex: 200,
              boxShadow: "2px 2px 0 var(--shadow-soft)",
              padding: "2px 0",
            }}>
              {menu.items.map((item, i) =>
                item.separator ? (
                  <div key={i} style={{ borderTop: "1px solid var(--bevel-dark)", borderBottom: "1px solid var(--bevel-light)", margin: "3px 2px" }} />
                ) : (
                  <MenuItemRow
                    key={i}
                    item={item}
                    dotOn={item.dot !== undefined && connection === item.dot}
                  />
                )
              )}
            </div>
          )}
        </div>
      ))}

      {/* The window's drag zone: it takes all the leftover space so the app
          can be moved by grabbing the bar, without stealing clicks from the
          menus (which stay on the left). */}
      <div data-tauri-drag-region style={{ flex: 1, height: "100%" }} />

      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 12px", flexShrink: 0 }}>
        {projectName && (
          <span style={{ fontSize: 10.5, color: "var(--text-menubar-dim)", letterSpacing: 0.3, fontFamily: "ui-monospace, monospace" }}>
            {projectName}
          </span>
        )}
        <span
          title={
            logSource ? `Log: ${logSource.name}`
              : connection === "disconnected" ? "Not connected"
              : `Connected (${connection})`
          }
          style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: statusColor,
            boxShadow: isConnected ? `0 0 5px ${statusColor}` : "none",
          }}
        />
      </div>
    </div>
  )
}

function MenuItemRow({ item, dotOn }: { item: MenuEntry, dotOn: boolean }) {
  const [hovered, setHovered] = useState(false)
  const active = hovered && !item.disabled

  return (
    <div
      onClick={item.disabled ? undefined : item.action}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "0 14px", fontSize: 11.5, height: 22,
        display: "flex", alignItems: "center", gap: 8,
        color: item.disabled ? "var(--btn-classic-text-disabled)"
          : active ? "var(--tree-selection-fg)" : "var(--text-primary)",
        background: active ? "var(--tree-selection-bg)" : "transparent",
        cursor: item.disabled ? "default" : "pointer",
      }}
    >
      {item.dot && (
        <span style={{
          width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
          background: dotOn ? (item.dot === "sim" ? "var(--status-sim)" : "var(--status-error)") : "var(--text-muted)",
        }} />
      )}
      <span>{item.label}</span>
    </div>
  )
}
