import UnsupportedValue from "../../common/UnsupportedValue"
import ArrayHeader from "../../common/ArrayHeader"

// Index -> value list for the arrays that are not numeric (boolean[],
// string[]). They have no magnitude to plot as a bar, so they are shown as
// text; booleans carry color so they can be read at a glance.
export default function ValueListWidget({ values }: { values: unknown[] }) {
  if (!Array.isArray(values) || values.length === 0) {
    return <UnsupportedValue message="Empty array" />
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <ArrayHeader count={values.length} />
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
        {values.map((v, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "monospace", width: 16, flexShrink: 0 }}>{i}</span>
            <span style={{
              fontSize: 10.5, fontFamily: "monospace", flex: 1, minWidth: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: typeof v === "boolean"
                ? (v ? "var(--status-sim)" : "var(--text-muted)")
                : "var(--text-primary)",
            }}>
              {typeof v === "boolean" ? (v ? "true" : "false") : String(v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
