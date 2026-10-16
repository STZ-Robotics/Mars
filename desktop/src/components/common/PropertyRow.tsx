import { ReactNode } from "react"

interface Props {
  label: string
  children: ReactNode // the control/value: input, select, text, badge...
  indent?: number
}

// RViz-style property tree row ("Displays"/"Views" panel): two fixed
// columns — name on the left, value/control on the right — separated by a
// vertical hairline, dense 24px rows with a horizontal hairline between each
// one. This replaces the "label above, input below" pattern the sidebars
// used — RViz never stacks like that, everything is label:value on a single
// row.
export default function PropertyRow({ label, children, indent = 0 }: Props) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", minHeight: 24, borderBottom: "1px solid var(--border-light)" }}>
      <div style={{
        width: "42%", flexShrink: 0, display: "flex", alignItems: "center",
        paddingLeft: 8 + indent * 14, paddingRight: 6,
        fontSize: 11, color: "var(--text-primary)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        borderRight: "1px solid var(--border-light)",
      }}>
        {label}
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", minWidth: 0, padding: "2px 6px" }}>
        {children}
      </div>
    </div>
  )
}
