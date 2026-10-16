import { ReactNode } from "react"

interface Props {
  title: string
  children: ReactNode
  icon?: string // tabler icon suffix, optional
}

// RViz/Qt-style dockable panel (QDockWidget): a solid title bar + content
// below, all inside a thin border — the same visual language as RViz's
// "Displays"/"Views"/"Time" panels. It replaces the previous GroupBox (title
// embedded in the border, MATLAB uipanel style): the same role of "grouping
// fields under a title", a different look.
export default function Panel({ title, children, icon }: Props) {
  return (
    <div style={{ border: "1px solid var(--border-main)", overflow: "hidden", background: "var(--bg-page)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
        background: "var(--bg-panel-header)", borderBottom: "1px solid var(--border-main)",
      }}>
        {icon && <i className={`ti ${icon}`} style={{ fontSize: 12, color: "var(--text-muted)" }} aria-hidden />}
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3, color: "var(--text-primary)" }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  )
}
