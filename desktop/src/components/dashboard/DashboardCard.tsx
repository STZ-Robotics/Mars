import { useState } from "react"
import { DashboardWidget, TopicAnnounce } from "../../store/appStore"
import { unpackLiveValue } from "../../utils/dashboard/valueDecoding"
import { classifyTopic } from "../../utils/dashboard/topicClassification"
import CardSettingsPanel from "./settings/CardSettingsPanel"
import WidgetRenderer from "./widgets/WidgetRenderer"

interface Props {
  widget: DashboardWidget
  liveValue?: any
  /** Only used by the widgets that read a whole TABLE (Field2d), which have
   *  no `liveValue` of their own because their root is not a topic. */
  topics: Map<string, TopicAnnounce>
  onRemove: () => void
  onUpdate: (updates: Partial<DashboardWidget>) => void
}

// This file is ONLY the card's orchestrator: header (editable label,
// buttons), the toggle between "see value" and "settings", and passing the
// topic's classification down. All of each widget's logic lives in
// ./widgets/*, and all of each settings form's logic lives in
// ./settings/*. Adding a new widget does not require touching this file
// except, perhaps, WidgetRenderer.tsx.
export default function DashboardCard({ widget, liveValue, topics, onRemove, onUpdate }: Props) {
  const [isEditingLabel, setIsEditingLabel] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [editLabel, setEditLabel] = useState(widget.label)

  const handleSaveLabel = () => {
    onUpdate({ label: editLabel })
    setIsEditingLabel(false)
  }

  const handleSaveSettings = (updates: Partial<DashboardWidget>) => {
    onUpdate(updates)
    setIsSettingsOpen(false)
  }

  const rawVal = unpackLiveValue(liveValue)
  const classification = classifyTopic(widget.topicType)

  return (
    <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)", borderRadius: 4, display: "flex", flexDirection: "column", height: "100%", width: "100%", overflow: "hidden", position: "relative" }}>

      {/* HEADER (works as the handle for moving it) */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", borderBottom: "1px solid var(--border-main)", background: "var(--bg-menubar)", cursor: "grab" }}>
        {isEditingLabel ? (
          <input
            autoFocus value={editLabel} onChange={e => setEditLabel(e.target.value)}
            onBlur={handleSaveLabel} onKeyDown={e => e.key === "Enter" && handleSaveLabel()}
            onMouseDown={e => e.stopPropagation()}
            style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-light)", outline: "none", fontSize: 11, padding: "2px 4px", width: "100%", borderRadius: 2 }}
          />
        ) : (
          <span
            onDoubleClick={(e) => { e.stopPropagation(); setIsEditingLabel(true) }}
            onMouseDown={e => e.stopPropagation()}
            style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "text", flex: 1, letterSpacing: 0.3 }}
          >
            {widget.label}
          </span>
        )}

        <div style={{ display: "flex", gap: 4, marginLeft: 8 }} onMouseDown={e => e.stopPropagation()}>
          <button onClick={() => setIsSettingsOpen(!isSettingsOpen)} style={{ background: isSettingsOpen ? "var(--bg-input)" : "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", borderRadius: 3, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <i className="ti ti-settings" style={{ fontSize: 12 }} />
          </button>
          <button onClick={onRemove} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", borderRadius: 3, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <i className="ti ti-x" style={{ fontSize: 12 }} />
          </button>
        </div>
      </div>

      {isSettingsOpen ? (
        <CardSettingsPanel widget={widget} classification={classification} onSave={handleSaveSettings} />
      ) : (
        <div style={{ flex: 1, padding: (classification.isNumericArray || classification.isTextArray || classification.isStructArray || classification.isField2d) ? 0 : 12, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
          <WidgetRenderer widget={widget} rawVal={rawVal} classification={classification} topics={topics} />
        </div>
      )}
    </div>
  )
}
