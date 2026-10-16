import { CSSProperties } from "react"

// Label/input styles shared by the pages' sidebar forms (WatchDog, Telemetry,
// Manifest, etc.) — each page used to redefine its own identical local
// labelStyle/inputStyle. A different scale from dashboard/DashboardCard.styles.ts,
// which is for the (smaller) widget settings forms.
export const labelStyle: CSSProperties = {
  display: "block", fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8, fontWeight: 600,
}

export const inputStyle: CSSProperties = {
  width: "100%", background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-main)", padding: "8px 12px", borderRadius: 3, fontSize: 12, outline: "none", boxSizing: "border-box",
}

// A value/control inside a PropertyRow (RViz-style property tree): compact,
// meant for a 24px row, without the generous padding of the inputStyle above.
export const propertyInputStyle: CSSProperties = {
  width: "100%", background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-main)", borderRadius: 2, padding: "1px 6px", fontSize: 11, outline: "none", boxSizing: "border-box", height: 20,
}
