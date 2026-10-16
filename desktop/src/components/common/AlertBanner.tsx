import { ReactNode } from "react"

interface Props {
  icon?: string // sufijo de icono tabler, ej. "ti-alert-triangle"
  children: ReactNode
  variant?: "error" | "success" | "neutral"
}

const VARIANT_TOKENS = {
  error: { bg: "var(--status-error-bg)", border: "var(--status-error-border)", color: "var(--status-error)" },
  success: { bg: "var(--status-success-bg)", border: "var(--status-success)", color: "var(--status-success)" },
  neutral: { bg: "var(--bg-input)", border: "var(--border-main)", color: "var(--status-sim)" },
}

// Icon + message banner repeated (with different color literals) in
// CommandConsolePage, PackagePage and other pages for inline notices/errors.
export default function AlertBanner({ icon = "ti-alert-triangle", children, variant = "error" }: Props) {
  const t = VARIANT_TOKENS[variant]
  return (
    <div style={{
      background: t.bg, border: `1px solid ${t.border}`,
      borderRadius: 4, padding: "10px 12px", display: "flex", gap: 8, alignItems: "flex-start",
      fontSize: 12, color: t.color,
    }}>
      {icon && <i className={`ti ${icon}`} style={{ fontSize: 14, marginTop: 1, flexShrink: 0 }} />}
      <span>{children}</span>
    </div>
  )
}
