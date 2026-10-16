interface Props {
  angleDeg: number
  needleColor?: string
  valueLabel: string
}

// Compass primitive shared by NumberWidget ("Compass" style on doubles) and
// RotationWidget (Rotation2d in "Compass" mode). They used to be two copies of
// the same SVG with a different needle color.
export default function CompassDial({ angleDeg, needleColor = "var(--mars-red)", valueLabel }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ width: 50, height: 50, borderRadius: "50%", border: "2px solid var(--text-primary)", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 4, height: 4, background: "var(--text-primary)", borderRadius: "50%", zIndex: 2 }} />
        <div style={{ position: "absolute", width: 2, height: 24, background: needleColor, top: 1, transformOrigin: "bottom center", transform: `rotate(${angleDeg}deg)` }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: "bold", fontFamily: "monospace", color: "var(--text-primary)" }}>{valueLabel}</span>
    </div>
  )
}
