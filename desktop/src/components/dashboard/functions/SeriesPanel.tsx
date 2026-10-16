import React from "react"
import {
  FunctionSeriesConfig, FunctionAxis, FunctionTransform, FunctionLineStyle, SeriesOperator,
} from "../../../store/appStore"
import { TRANSFORM_LABELS } from "../../../utils/functions/mathTransforms"
import { OPERATOR_LABELS } from "../../../utils/functions/seriesAlgebra"

interface Props {
  series: FunctionSeriesConfig[]
  onUpdate: (id: string, updates: Partial<FunctionSeriesConfig>) => void
  onRemove: (id: string) => void
  onDuplicate: (id: string) => void
}

const TRANSFORMS: FunctionTransform[] = ["raw", "derivative", "derivative2", "integral", "movingAvg"]
const LINE_STYLES: { key: FunctionLineStyle; label: string }[] = [
  { key: "line", label: "Line" },
  { key: "stepped", label: "Stepped" },
  { key: "points", label: "Points" },
]
const OPERATORS: SeriesOperator[] = ["add", "subtract", "multiply", "divide"]

const selectStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-input)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", padding: "2px 4px",
  borderRadius: 2, fontSize: 10.5, outline: "none", height: 20,
}

const labelStyle: React.CSSProperties = {
  fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase",
  letterSpacing: 0.5, marginBottom: 2,
}

export default function SeriesPanel({ series, onUpdate, onRemove, onDuplicate }: Props) {
  if (series.length === 0) {
    return (
      <div style={{ padding: 14, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        No series yet. Drag a numeric topic from the Data Directory onto the plot.
        <br /><br />
        The same topic can be added more than once — one raw, one derivative, one smoothed.
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {series.map(s => {
        const visible = s.visible !== false
        // A series can only be combined/compared against ANOTHER series, never itself.
        const others = series.filter(o => o.id !== s.id)

        return (
          <div key={s.id} style={{
            display: "flex", flexDirection: "column", gap: 5, padding: "8px 10px",
            borderBottom: "1px solid var(--border-light)",
            opacity: visible ? 1 : 0.5,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="color"
                value={s.color}
                onChange={e => onUpdate(s.id, { color: e.target.value })}
                title="Series color"
                style={{ width: 20, height: 20, padding: 0, border: "1px solid var(--border-main)", background: "var(--bg-input)", borderRadius: 2, cursor: "pointer", flexShrink: 0 }}
              />
              <input
                value={s.label}
                onChange={e => onUpdate(s.id, { label: e.target.value })}
                style={{ ...selectStyle, flex: 1, fontWeight: 600 }}
              />
              <IconButton
                icon={visible ? "ti-eye" : "ti-eye-off"}
                title={visible ? "Hide series" : "Show series"}
                onClick={() => onUpdate(s.id, { visible: !visible })}
              />
              {/* Duplicating is what allows having the SAME topic twice:
                  one raw and another derived, without dragging it again. */}
              <IconButton icon="ti-copy" title="Duplicate series" onClick={() => onDuplicate(s.id)} />
              <IconButton icon="ti-x" title="Remove series" onClick={() => onRemove(s.id)} />
            </div>

            <div style={{ fontSize: 9, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.topicName}
            </div>

            <div>
              <div style={labelStyle}>Transform</div>
              <select
                value={s.transform}
                onChange={e => onUpdate(s.id, { transform: e.target.value as FunctionTransform })}
                style={selectStyle}
              >
                {TRANSFORMS.map(t => <option key={t} value={t}>{TRANSFORM_LABELS[t]}</option>)}
              </select>
            </div>

            {s.transform === "movingAvg" && (
              <div>
                <div style={labelStyle}>Window (samples)</div>
                <input
                  type="number" min={2} max={201} step={1}
                  value={s.smoothWindow ?? 5}
                  onChange={e => onUpdate(s.id, { smoothWindow: Math.max(2, Number(e.target.value) || 5) })}
                  style={selectStyle}
                />
              </div>
            )}

            <div style={{ display: "flex", gap: 5 }}>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Axis</div>
                <select
                  value={s.axis}
                  onChange={e => onUpdate(s.id, { axis: e.target.value as FunctionAxis })}
                  style={selectStyle}
                >
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Style</div>
                <select
                  value={s.lineStyle ?? "line"}
                  onChange={e => onUpdate(s.id, { lineStyle: e.target.value as FunctionLineStyle })}
                  style={selectStyle}
                >
                  {LINE_STYLES.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </div>
              <div style={{ width: 54 }}>
                <div style={labelStyle}>Width</div>
                <input
                  type="number" min={0.5} max={8} step={0.5}
                  value={s.lineWidth ?? 1.6}
                  onChange={e => onUpdate(s.id, { lineWidth: Number(e.target.value) || 1.6 })}
                  style={selectStyle}
                />
              </div>
            </div>

            {/* Scale and offset are applied AFTER the transform: they convert
                units (rad→degrees) or subtract a sensor's zero. */}
            <div style={{ display: "flex", gap: 5 }}>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Scale ×</div>
                <input
                  type="number" step="any"
                  value={s.scale ?? 1}
                  onChange={e => onUpdate(s.id, { scale: Number(e.target.value) || 1 })}
                  style={selectStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>Offset +</div>
                <input
                  type="number" step="any"
                  value={s.offset ?? 0}
                  onChange={e => onUpdate(s.id, { offset: Number(e.target.value) || 0 })}
                  style={selectStyle}
                />
              </div>
            </div>

            {others.length > 0 && (
              <>
                <div style={{ display: "flex", gap: 5 }}>
                  <div style={{ width: 52 }}>
                    <div style={labelStyle}>Op</div>
                    <select
                      value={s.combine?.operator ?? ""}
                      onChange={e => onUpdate(s.id, {
                        combine: e.target.value
                          ? { operator: e.target.value as SeriesOperator, withSeriesId: s.combine?.withSeriesId ?? others[0].id }
                          : null,
                      })}
                      style={selectStyle}
                    >
                      <option value="">—</option>
                      {OPERATORS.map(op => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={labelStyle}>With</div>
                    <select
                      value={s.combine?.withSeriesId ?? ""}
                      disabled={!s.combine}
                      onChange={e => onUpdate(s.id, {
                        combine: s.combine ? { ...s.combine, withSeriesId: e.target.value } : null,
                      })}
                      style={{ ...selectStyle, opacity: s.combine ? 1 : 0.5 }}
                    >
                      {others.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <div style={labelStyle}>Error band vs</div>
                  <select
                    value={s.errorTargetId ?? ""}
                    onChange={e => onUpdate(s.id, { errorTargetId: e.target.value || null })}
                    style={selectStyle}
                  >
                    <option value="">— none —</option>
                    {others.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

function IconButton({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        border: "none", background: "transparent", color: "var(--text-muted)",
        cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1, flexShrink: 0,
        width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <i className={`ti ${icon}`} aria-hidden />
    </button>
  )
}
