interface Props {
  value: number
  min: number
  max: number
  divisions: number
  inverted: boolean
  orientation: "horizontal" | "vertical"
}

// A yellow linear bar with division labels, a functional replica of Elastic's
// LinearGauge (without the geekyants_flutter_gauges library).
export default function VoltageWidget({ value, min, max, divisions, inverted, orientation }: Props) {
  const clamped = Math.max(min, Math.min(max, value))
  const range = max - min || 1
  let pct = (clamped - min) / range
  if (inverted) pct = 1 - pct

  const divisionCount = Math.max(2, divisions)
  const divisionValues = Array.from({ length: divisionCount }, (_, i) => min + (range / (divisionCount - 1)) * i)

  const isVertical = orientation === "vertical"

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
      <span style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "var(--text-primary)" }}>
        {value.toFixed(2)} V
      </span>

      <div style={{
        display: "flex", flexDirection: isVertical ? "row" : "column", alignItems: "center", gap: 6,
        width: isVertical ? undefined : "88%", height: isVertical ? "80%" : undefined,
      }}>
        <div style={{
          position: "relative", background: "var(--bg-input)", border: "1px solid var(--border-main)", borderRadius: 4,
          width: isVertical ? 14 : "100%", height: isVertical ? "100%" : 14, overflow: "hidden", flexShrink: 0,
        }}>
          <div style={{
            position: "absolute", background: "#e8c94a",
            ...(isVertical
              ? { left: 0, right: 0, bottom: 0, height: `${pct * 100}%` }
              : { top: 0, bottom: 0, left: 0, width: `${pct * 100}%` }),
          }} />
        </div>

        <div style={{
          display: "flex", flexDirection: isVertical ? "column-reverse" : "row", justifyContent: "space-between",
          width: isVertical ? undefined : "100%", height: isVertical ? "100%" : undefined,
        }}>
          {divisionValues.map((dv, i) => (
            <span key={i} style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "monospace" }}>
              {dv.toFixed(dv % 1 === 0 ? 0 : 1)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
