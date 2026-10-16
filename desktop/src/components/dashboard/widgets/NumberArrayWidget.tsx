import UnsupportedValue from "../../common/UnsupportedValue"
import ArrayHeader from "../../common/ArrayHeader"

// Shown as a list with relative mini-bars, useful for looking at swerve
// modules, encoders, PID arrays, etc.
export default function NumberArrayWidget({ values }: { values: number[] }) {
  if (!Array.isArray(values) || values.length === 0) {
    return <UnsupportedValue message="Empty array" />
  }
  const max = Math.max(...values.map(v => Math.abs(v)), 0.0001)

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <ArrayHeader count={values.length} />
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
        {values.map((v, i) => {
          const pct = Math.min(1, Math.abs(v) / max)
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "monospace", width: 16, flexShrink: 0 }}>{i}</span>
              <div style={{ flex: 1, height: 8, background: "var(--bg-input)", border: "1px solid var(--border-main)", position: "relative", borderRadius: 2 }}>
                <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 1, background: "var(--border-main)" }} />
                <div style={{
                  position: "absolute", top: 0, bottom: 0,
                  left: v < 0 ? `${50 - pct * 50}%` : "50%",
                  width: `${pct * 50}%`,
                  background: v < 0 ? "var(--status-error)" : "var(--status-sim)",
                }} />
              </div>
              <span style={{ fontSize: 10, fontFamily: "monospace", color: "var(--text-primary)", width: 58, textAlign: "right", flexShrink: 0 }}>{v.toFixed(3)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
