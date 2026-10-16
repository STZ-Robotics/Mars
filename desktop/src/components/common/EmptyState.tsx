import React from "react"

interface Props {
  icon?: string // sufijo de icono tabler, ej. "ti-heart-rate-monitor"
  message: React.ReactNode
  hint?: React.ReactNode
  dashed?: boolean // dotted border (empty lists/panels); false = centered text only
  padding?: string
}

// "No data yet" state — it covers the cases currently duplicated in
// WatchDogPage, SeriesPanel, TreeDirectory, GraphCanvas, each with its own
// padding/border/message but the same purpose.
export default function EmptyState({ icon, message, hint, dashed = true, padding = "60px 40px" }: Props) {
  return (
    <div
      style={{
        textAlign: "center",
        padding,
        color: "var(--text-muted)",
        fontSize: 13,
        border: dashed ? "1px dashed var(--border-main)" : "none",
        borderRadius: dashed ? 4 : 0,
      }}
    >
      {icon && <i className={`ti ${icon}`} style={{ fontSize: 32, display: "block", marginBottom: 12, opacity: 0.5 }} />}
      {message}
      {hint && (
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6, fontFamily: "monospace" }}>
          {hint}
        </div>
      )}
    </div>
  )
}
