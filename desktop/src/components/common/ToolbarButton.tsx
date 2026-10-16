import { useState } from "react"

interface Props {
  icon: string
  label?: string // visible at size "lg"; always used as the title/tooltip
  variant?: "default" | "green" | "red"
  size?: "lg" | "sm" // lg = icon+label stacked (ToolBar), sm = icon only, compact square (Timeline controls)
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  iconColor?: string // accent per function category (wayfinding), only for variant="default"
}

const VARIANT_TOKENS = {
  default: { bg: "transparent", bgHover: "var(--border-main)", bgActive: "var(--toolbar-active-bg)", border: "var(--mars-accent)", borderHover: "var(--border-dark)", text: "var(--text-primary)", icon: "var(--icon-toolbar)" },
  green: { bg: "var(--variant-green-bg)", bgHover: "var(--variant-green-bg-hover)", bgActive: "var(--variant-green-bg-active)", border: "var(--variant-green-border)", borderHover: "var(--variant-green-border-hover)", text: "var(--status-sim)", icon: "var(--status-sim)" },
  red: { bg: "var(--variant-red-bg)", bgHover: "var(--variant-red-bg-hover)", bgActive: "var(--variant-red-bg-active)", border: "var(--variant-red-border)", borderHover: "var(--variant-red-border-hover)", text: "var(--status-error)", icon: "var(--status-error)" },
}

// Toolbar/control button, with the same color variants that are currently
// duplicated (with different hex literals) in ToolBar.tsx and in
// TimelineGlobal's live/pause buttons.
export default function ToolbarButton({ icon, label, variant = "default", size = "lg", active = false, disabled = false, onClick, iconColor }: Props) {
  const [hovered, setHovered] = useState(false)
  const t = VARIANT_TOKENS[variant]
  const resolvedIconColor = iconColor ?? t.icon

  const bg = active ? t.bgActive : hovered && !disabled ? t.bgHover : t.bg
  const border = active ? t.border : hovered && !disabled ? t.borderHover : "transparent"

  if (size === "sm") {
    return (
      <button
        onClick={onClick}
        title={label}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          border: "none",
          color: resolvedIconColor,
          fontSize: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          borderRadius: 3,
          background: bg,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <i className={`ti ${icon}`} aria-hidden />
      </button>
    )
  }

  // "lg" = compact horizontal icon+label row, RViz/Qt toolbar style (not the big
  // icon-above-label-below ribbon it used to have).
  return (
    <button
      onClick={onClick}
      title={label}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
        height: 30, padding: "0 10px",
        fontSize: 11.5, color: t.text, background: bg, border: `1px solid ${border}`,
        borderRadius: 3, cursor: disabled ? "default" : "pointer", whiteSpace: "nowrap",
      }}
    >
      <i className={`ti ${icon}`} style={{ fontSize: 15, color: resolvedIconColor }} aria-hidden />
      {label && <span>{label}</span>}
    </button>
  )
}
