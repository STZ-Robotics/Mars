import React from "react"

interface Props {
  eyebrow: string
  title: string
  subtitle?: React.ReactNode
}

// A header block repeated, literally, at the top of each page's sidebar
// (WatchDog, Telemetry, Manifest, etc.): an uppercase eyebrow + title +
// optional subtitle. Each page used to reimplement it with its own loose colors
// (rgba(255,255,255,0.55), #fff...); here it lives once.
export default function PageHeader({ eyebrow, title, subtitle }: Props) {
  return (
    <div style={{ padding: "24px 20px", borderBottom: "1px solid var(--border-light)", background: "var(--bg-panel)" }}>
      <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4 }}>
        {eyebrow}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text-header-title)" }}>
        {title}
      </div>
      {subtitle && (
        <div style={{ fontSize: 10, color: "var(--text-header-subtitle)", marginTop: 4, lineHeight: 1.4 }}>
          {subtitle}
        </div>
      )}
    </div>
  )
}
