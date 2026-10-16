import React from "react"
import { MechanismSourceConfig } from "../../../store/appStore"

interface Props {
  sources: MechanismSourceConfig[]
  /** Ligaments found live for each source, to warn when nothing arrives. */
  ligamentCounts: Record<string, number>
  onUpdate: (id: string, updates: Partial<MechanismSourceConfig>) => void
  onRemove: (id: string) => void
}

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9.5,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 2,
}

export default function MechanismSourcePanel({ sources, ligamentCounts, onUpdate, onRemove }: Props) {
  if (sources.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        No mechanisms yet. Drag a <i>Mechanism2d</i> table from the Data Directory onto the canvas.
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {sources.map(source => {
        const count = ligamentCounts[source.id]

        return (
          <div key={source.id} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderBottom: "1px solid var(--border-light)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={source.visible}
                onChange={e => onUpdate(source.id, { visible: e.target.checked })}
                title="Show on canvas"
              />
              <span
                style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={source.prefix}
              >
                {source.label}
              </span>
              <button
                onClick={() => onRemove(source.id)}
                title="Remove mechanism"
                style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}
              >
                <i className="ti ti-x" aria-hidden />
              </button>
            </div>

            <div style={{ fontSize: 9.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {source.prefix}
            </div>

            <div>
              <div style={fieldLabelStyle}>Label</div>
              <input
                value={source.label}
                onChange={e => onUpdate(source.id, { label: e.target.value })}
                style={{
                  width: "100%", boxSizing: "border-box",
                  background: "var(--bg-input)", color: "var(--text-primary)",
                  border: "1px solid var(--border-main)", padding: "3px 6px",
                  borderRadius: 2, fontSize: 10.5, outline: "none",
                }}
              />
            </div>

            {/* Each ligament's color is decided by the robot code; the
                override only serves to tell apart two overlapping mechanisms
                when both were published with the same color. */}
            <div>
              <div style={fieldLabelStyle}>Color</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--text-primary)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={source.colorOverride !== null}
                    onChange={e => onUpdate(source.id, { colorOverride: e.target.checked ? "#2f6fdb" : null })}
                  />
                  Override
                </label>
                <input
                  type="color"
                  value={source.colorOverride ?? "#2f6fdb"}
                  disabled={source.colorOverride === null}
                  onChange={e => onUpdate(source.id, { colorOverride: e.target.value })}
                  title="Override every ligament color"
                  style={{
                    width: 22, height: 22, padding: 0, border: "1px solid var(--border-main)",
                    background: "var(--bg-input)", borderRadius: 2,
                    cursor: source.colorOverride === null ? "default" : "pointer",
                    opacity: source.colorOverride === null ? 0.4 : 1,
                  }}
                />
              </div>
            </div>

            <div style={{ fontSize: 10, color: count ? "var(--text-muted)" : "var(--status-warning)" }}>
              {count === undefined
                ? "waiting for live value…"
                : `${count} ligament${count === 1 ? "" : "s"}`}
            </div>
          </div>
        )
      })}
    </div>
  )
}
