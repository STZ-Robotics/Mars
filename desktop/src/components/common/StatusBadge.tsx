interface Props {
  color: string // color del punto, ej. "var(--status-sim)"
  label: string
  dim?: boolean // estado apagado/sin actividad (opacidad reducida)
}

// A color dot + text ("LIVE", "Sim running", active menu dot...).
// The same concept repeated with different code in TimelineGlobal, StatusBar
// and MenuBar.
export default function StatusBadge({ color, label, dim = false }: Props) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, opacity: dim ? 0.6 : 1 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.5, color: "var(--text-header-eyebrow)", fontFamily: "monospace" }}>
        {label}
      </span>
    </span>
  )
}
