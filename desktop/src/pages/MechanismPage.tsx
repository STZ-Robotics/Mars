import React, { useMemo, useState } from "react"
import { TopicAnnounce, MechanismSourceConfig, MechanismSettings } from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { useNTSnapshot } from "../utils/nt/useNTSnapshot"
import {
  findMechanismTables, isMechanismTable, mechanismTopicNames,
  buildMechanismState, mergeMechanismStates, MechanismState,
} from "../utils/field/mechanismExtraction"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import MechanismCanvas from "../components/dashboard/mechanism/MechanismCanvas"
import MechanismSourcePanel from "../components/dashboard/mechanism/MechanismSourcePanel"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"
import EmptyState from "../components/common/EmptyState"

interface Props {
  topics: Map<string, TopicAnnounce>
  sources: MechanismSourceConfig[]
  settings: MechanismSettings
  onAddSource: (s: Omit<MechanismSourceConfig, "id">) => void
  onRemoveSource: (id: string) => void
  onUpdateSource: (id: string, updates: Partial<MechanismSourceConfig>) => void
  onUpdateSettings: (updates: Partial<MechanismSettings>) => void
}

const RAD_TO_DEG = 180 / Math.PI

export default function MechanismPage({
  topics, sources, settings,
  onAddSource, onRemoveSource, onUpdateSource, onUpdateSettings,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const isLive = useSelectionStore(s => s.isLive)

  // The prefixes that are a Mechanism2d table TODAY; recomputed when new
  // announces arrive, so a table that shows up late is still offered.
  const mechanismTables = useMemo(() => new Set(findMechanismTables(topics)), [topics])

  // A Mechanism2d is drawn from dozens of loose topics: they all have to be
  // requested, not only the "prefix" the user dragged.
  const topicNames = useMemo(
    () => sources.flatMap(s => mechanismTopicNames(topics, s.prefix)),
    [sources, topics],
  )
  const values = useNTSnapshot(topicNames, 33)

  const perSource = useMemo(() => {
    return sources.map(source => {
      const names = mechanismTopicNames(topics, source.prefix)
      const raw = buildMechanismState(values, names, source.prefix)
      if (raw === null) return { source, state: null as MechanismState | null }

      // The override is applied here and not in the canvas: that way the numeric
      // readout and the drawing always talk about the same state.
      const state: MechanismState = source.colorOverride
        ? { ...raw, lines: raw.lines.map(l => ({ ...l, color: source.colorOverride! })) }
        : raw

      return { source, state }
    })
  }, [sources, topics, values])

  const visibleStates = perSource
    .filter(entry => entry.source.visible && entry.state !== null)
    .map(entry => entry.state!)

  const merged = mergeMechanismStates(visibleStates)

  const ligamentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    perSource.forEach(({ source, state }) => {
      if (state !== null) counts[source.id] = state.lines.length
    })
    return counts
  }, [perSource])

  const totalLigaments = visibleStates.reduce((sum, s) => sum + s.lines.length, 0)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const prefix = e.dataTransfer.getData("topicName")
    if (!prefix) return
    if (!isMechanismTable(topics, prefix)) return
    if (sources.some(s => s.prefix === prefix)) return

    const parts = prefix.split("/").filter(Boolean)
    const label = parts.length > 0 ? parts[parts.length - 1] : prefix

    onAddSource({ prefix, label, visible: true, colorOverride: null })
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      <DataDirectoryPanel
        topics={topics}
        hint={mechanismTables.size === 0
          ? "No Mechanism2d tables published — SmartDashboard.putData(\"Mech\", mechanism2d)"
          : "Drag a whole Mechanism2d table onto the canvas"}
        // Only the TABLES are draggable here: the loose topics inside (angle,
        // length, color…) mean nothing on their own.
        dragFilter={() => false}
        folderDragType={(fullPath: string) => (mechanismTables.has(fullPath) ? "Mechanism2d" : null)}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="Mechanism"
          meta={`${visibleStates.length} of ${sources.length} shown · ${totalLigaments} ligaments`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <StatusBadge color={isLive ? "var(--status-sim)" : "var(--mars-red)"} label={isLive ? "LIVE" : "VIEWING HISTORY"} />

              <NumberControl
                label="WEIGHT"
                value={settings.weightScale}
                suffix="×"
                onChange={v => onUpdateSettings({ weightScale: Math.min(10, Math.max(0.1, v)) })}
              />

              <Toggle label="BACKGROUND" checked={settings.useTopicBackground} onChange={v => onUpdateSettings({ useTopicBackground: v })} />
              <Toggle label="GRID" checked={settings.showGrid} onChange={v => onUpdateSettings({ showGrid: v })} />
              <Toggle label="ORIGIN" checked={settings.showOrigin} onChange={v => onUpdateSettings({ showOrigin: v })} />
              <Toggle label="JOINTS" checked={settings.showJoints} onChange={v => onUpdateSettings({ showJoints: v })} />
            </div>
          }
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!isDragOver) setIsDragOver(true) }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              style={{
                flex: 1, padding: 12, boxSizing: "border-box", overflow: "hidden",
                background: isDragOver ? "var(--bg-panel)" : "var(--bg-page)",
                border: isDragOver ? "1px dashed var(--mars-red)" : "1px solid transparent",
              }}
            >
              {merged === null ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <EmptyState
                    icon="ti-hierarchy-2"
                    message={sources.length === 0 ? "Drop a Mechanism2d table here" : "No live values for the selected mechanisms yet"}
                    hint={sources.length === 0 ? undefined : sources.map(s => s.prefix).join("  ·  ")}
                  />
                </div>
              ) : (
                <MechanismCanvas state={merged} settings={settings} />
              )}
            </div>

            <ReadoutStrip entries={perSource} />
          </div>

          <div style={{ width: 280, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)", flexShrink: 0, overflowY: "auto" }}>
            <MechanismSourcePanel
              sources={sources}
              ligamentCounts={ligamentCounts}
              onUpdate={onUpdateSource}
              onRemove={onRemoveSource}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Numeric readout -------------------------------------------------------

// The drawing shows the mechanism's pose; calibrating stops and lengths needs
// each ligament's exact numbers. The listed angle is the ABSOLUTE one, already
// resolved (the published one is relative to the parent ligament).
function ReadoutStrip({ entries }: { entries: { source: MechanismSourceConfig; state: MechanismState | null }[] }) {
  const withState = entries.filter(e => e.state !== null && e.source.visible)
  if (withState.length === 0) return null

  return (
    <div style={{
      borderTop: "1px solid var(--border-main)", background: "var(--bg-panel)",
      padding: "8px 12px", display: "flex", gap: 24, flexWrap: "wrap", flexShrink: 0,
      maxHeight: 180, overflowY: "auto",
      fontSize: 11, color: "var(--text-primary)",
    }}>
      {withState.map(({ source, state }) => (
        <div key={source.id}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 1, flexShrink: 0, background: source.colorOverride ?? state!.backgroundColor, border: "1px solid var(--border-main)" }} />
            <span style={{ fontSize: 9.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              {source.label} · {state!.dimensions[0].toFixed(2)} × {state!.dimensions[1].toFixed(2)} · {state!.rootCount} root{state!.rootCount === 1 ? "" : "s"}
            </span>
          </div>
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {state!.lines.map(line => (
                <tr key={line.path}>
                  <td style={cellStyle} title={line.path}>{line.path.split("/").filter(Boolean).slice(-1)[0]}</td>
                  <td style={numCellStyle}>{line.length.toFixed(3)}</td>
                  <td style={numCellStyle}>{(line.angle * RAD_TO_DEG).toFixed(1)}°</td>
                  <td style={numCellStyle}>
                    ({line.end[0].toFixed(2)}, {line.end[1].toFixed(2)})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

const cellStyle: React.CSSProperties = { padding: "1px 8px 1px 0", color: "var(--text-muted)", fontSize: 10.5 }
const numCellStyle: React.CSSProperties = { ...cellStyle, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }

// --- Controles del header ---------------------------------------------------

const selectStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-main)",
  padding: "3px 6px",
  borderRadius: 2,
  fontSize: 11,
  outline: "none",
}

function NumberControl({
  label, value, suffix, onChange,
}: { label: string; value: number; suffix: string; onChange: (v: number) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <span style={{ fontSize: 10, color: "var(--text-header-eyebrow)" }}>{label}</span>
      <input
        type="number"
        step={0.25}
        min={0.1}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ ...selectStyle, width: 58 }}
      />
      <span style={{ fontSize: 9.5, color: "var(--text-muted)" }}>{suffix}</span>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-header-eyebrow)", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
