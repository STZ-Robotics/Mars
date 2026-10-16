import React from "react"

interface Props {
  /** Accepts a node so a page can make it editable in place. */
  title: React.ReactNode
  meta?: React.ReactNode
  action?: React.ReactNode
}

// A 48px bar over each page's main panel (title + counter/status + optional
// action on the right). The same pattern as PageHeader but for the content
// area instead of the sidebar.
export default function PanelHeader({ title, meta, action }: Props) {
  return (
    <div style={{ height: 48, background: "var(--bg-menubar)", borderBottom: "1px solid var(--border-main)", display: "flex", alignItems: "center", padding: "0 24px", gap: 16, flexShrink: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-header-title)" }}>{title}</span>
      {meta && <span style={{ fontSize: 11, color: "var(--text-header-eyebrow)" }}>{meta}</span>}
      {action && <span style={{ marginLeft: "auto" }}>{action}</span>}
    </div>
  )
}
