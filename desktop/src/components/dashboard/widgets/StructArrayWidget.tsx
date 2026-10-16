import { decodeStructBytes } from "../../../utils/dashboard/valueDecoding"
import { useStructDef } from "../../../store/structSchemaStore"
import UnsupportedValue from "../../common/UnsupportedValue"
import ArrayHeader from "../../common/ArrayHeader"

// An array of structs (e.g. struct:Pose2d[] for a whole trajectory).
// The bytes come concatenated one after another, each block the struct's fixed size.
export default function StructArrayWidget({ rawVal, structName }: { rawVal: any; structName: string }) {
  const def = useStructDef(structName)
  if (!def || !Array.isArray(rawVal)) {
    return <UnsupportedValue message={`Unsupported struct: ${structName}`} />
  }
  const count = Math.floor(rawVal.length / def.length)
  const items: { label: string; suffix?: string; value: number }[][] = []
  for (let i = 0; i < count; i++) {
    items.push(decodeStructBytes(rawVal.slice(i * def.length, (i + 1) * def.length), def))
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <ArrayHeader count={count} label={structName} />
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 10px" }}>
        {items.map((fields, i) => (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--border-light)" }}>
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "monospace", width: 18, flexShrink: 0 }}>{i}</span>
            {fields.map(f => (
              <span key={f.label} style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-primary)" }}>
                <span style={{ color: "var(--mars-accent)", fontWeight: 700 }}>{f.label}</span> {f.value.toFixed(2)}{f.suffix}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
