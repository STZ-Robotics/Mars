import React, { useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { TopicAnnounce, FunctionSeriesConfig, FunctionSettings } from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { classifyTopic } from "../utils/dashboard/topicClassification"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import GraphCanvas, { PlottedSeries, GraphCanvasHandle } from "../components/dashboard/functions/GraphCanvas"
import SeriesPanel from "../components/dashboard/functions/SeriesPanel"
import PanelHeader from "../components/layout/PanelHeader"
import { useLiveSeriesBuffers } from "../utils/functions/useLiveSeriesBuffers"
import { applyTransform, computeStats, TimeSeriesPoint } from "../utils/functions/mathTransforms"
import { detectUnitSuffix } from "../utils/functions/units"
import { combineSeries, buildErrorBand } from "../utils/functions/seriesAlgebra"
import { buildPhasePlot, PhasePoint } from "../utils/functions/phasePlot"

interface Props {
  topics: Map<string, TopicAnnounce>
  series: FunctionSeriesConfig[]
  settings: FunctionSettings
  onAddSeries: (s: Omit<FunctionSeriesConfig, "id">) => void
  onRemoveSeries: (id: string) => void
  onUpdateSeries: (id: string, updates: Partial<FunctionSeriesConfig>) => void
  onUpdateSettings: (updates: Partial<FunctionSettings>) => void
}

const LINE_COLORS = ["#6262f1", "#d65c5c", "#6c9c6c", "#d4a94a", "#4db8d8", "#c76fd1", "#e08a3c", "#5ecbb0"]
const WINDOW_OPTIONS = [1, 2, 5, 10, 30, 60, 120]

export default function FunctionPage({
  topics, series, settings, onAddSeries, onRemoveSeries, onUpdateSeries, onUpdateSettings,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const graphRef = useRef<GraphCanvasHandle>(null)

  const isLive = useSelectionStore((s) => s.isLive)
  const selectedTime = useSelectionStore((s) => s.selectedTime)

  const buffers = useLiveSeriesBuffers(series, settings.windowSeconds)

  const { plotted, phaseData } = useMemo(() => {
    // Step 1: base points = the topic's raw buffer + its transform + scale.
    const basePoints: Record<string, TimeSeriesPoint[]> = {}
    series.forEach(s => {
      basePoints[s.id] = applyTransform(buffers[s.topicName] ?? [], s.transform, {
        smoothWindow: s.smoothWindow,
        scale: s.scale,
        offset: s.offset,
      })
    })

    // Step 2: algebra between series (A op B), over the already transformed
    // points. If the series it is combined with was deleted, the combine is ignored.
    const finalPoints: Record<string, TimeSeriesPoint[]> = {}
    series.forEach(s => {
      finalPoints[s.id] = s.combine && basePoints[s.combine.withSeriesId]
        ? combineSeries(basePoints[s.id], basePoints[s.combine.withSeriesId], s.combine.operator)
        : basePoints[s.id]
    })

    const plotted: PlottedSeries[] = series.map(s => {
      const points = finalPoints[s.id] ?? []
      const targetPoints = s.errorTargetId ? finalPoints[s.errorTargetId] : undefined
      return {
        id: s.id,
        label: s.label,
        color: s.color,
        axis: s.axis,
        unit: detectUnitSuffix(s.topicName),
        points,
        errorBand: targetPoints ? buildErrorBand(points, targetPoints) : undefined,
        visible: s.visible !== false,
        lineStyle: s.lineStyle ?? "line",
        lineWidth: s.lineWidth ?? 1.6,
      }
    })

    // Step 3 (X-Y mode only): each series is crossed against the series chosen as
    // the X axis. The series acting as X is not drawn against itself.
    let phaseData: { xLabel: string; xUnit: string | null; bySeries: Record<string, PhasePoint[]> } | null = null
    if (settings.xMode === "phase" && settings.xSeriesId && finalPoints[settings.xSeriesId]) {
      const xSeries = series.find(s => s.id === settings.xSeriesId)!
      const xPoints = finalPoints[settings.xSeriesId]
      const bySeries: Record<string, PhasePoint[]> = {}
      series.forEach(s => {
        if (s.id === settings.xSeriesId) return
        bySeries[s.id] = buildPhasePlot(xPoints, finalPoints[s.id] ?? [])
      })
      phaseData = {
        xLabel: xSeries.label,
        xUnit: detectUnitSuffix(xSeries.topicName),
        bySeries,
      }
    }

    return { plotted, phaseData }
  }, [series, buffers, settings.xMode, settings.xSeriesId])

  // In X-Y mode the series acting as the X axis is not drawn as a curve.
  const drawnSeries = settings.xMode === "phase" && settings.xSeriesId
    ? plotted.filter(s => s.id !== settings.xSeriesId)
    : plotted

  const stats = useMemo(
    () => plotted.map(s => ({ id: s.id, label: s.label, color: s.color, unit: s.unit, stats: computeStats(s.points) })),
    [plotted],
  )

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const topicName = e.dataTransfer.getData("topicName")
    const topicType = e.dataTransfer.getData("topicType")
    if (!topicName) return
    if (!classifyTopic(topicType).isNumber) return

    // On purpose, a topic already plotted is NOT discarded: dropping the same
    // position twice is what lets the signal and its derivative be seen together.
    const parts = topicName.split("/").filter(Boolean)
    const base = parts.length > 0 ? parts[parts.length - 1] : topicName
    const dupes = series.filter(s => s.topicName === topicName).length
    const label = dupes === 0 ? base : `${base} (${dupes + 1})`

    const usedColors = new Set(series.map(s => s.color))
    const color = LINE_COLORS.find(c => !usedColors.has(c)) ?? LINE_COLORS[series.length % LINE_COLORS.length]

    onAddSeries({ topicName, label, color, transform: "raw", axis: "left", visible: true })
  }

  const handleDuplicate = (id: string) => {
    const source = series.find(s => s.id === id)
    if (!source) return
    const usedColors = new Set(series.map(s => s.color))
    const color = LINE_COLORS.find(c => !usedColors.has(c)) ?? source.color
    // The copy starts out differentiated: duplicating to leave two identical
    // curves helps nobody, and comparing a signal against its derivative is the
    // typical case.
    const { id: _drop, ...rest } = source
    onAddSeries({
      ...rest,
      label: `${source.label} d/dt`,
      transform: source.transform === "raw" ? "derivative" : "raw",
      color,
      combine: null,
      errorTargetId: null,
    })
  }

  const handleExport = async () => {
    const url = graphRef.current?.toDataURL()
    if (!url) return
    try {
      // The default name comes from the plot's title, sanitized: a "/" or a ":"
      // in the title would make writing fail on Windows.
      const safeTitle = (settings.title || "plot").replace(/[^\w\-. ]+/g, "_").trim() || "plot"
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const path = await save({
        title: "Export plot",
        defaultPath: `${safeTitle}-${stamp}.png`,
        filters: [{ name: "PNG image", extensions: ["png"] }],
      })
      if (!path) return
      await invoke("save_base64_file", { path, base64Data: url })
    } catch (error) {
      alert(`Could not export plot:
${error}`)
    }
  }

  const leftCount = plotted.filter(s => s.axis === "left" && s.visible).length
  const rightCount = plotted.filter(s => s.axis === "right" && s.visible).length

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      <DataDirectoryPanel
        topics={topics}
        hint="Only numeric values can be plotted — the same topic can be dropped more than once"
        dragFilter={(t) => classifyTopic(t.topic_type).isNumber}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title={
            // The title is editable in place: it is what ends up printed on the
            // PNG and in the file's name.
            <input
              value={settings.title}
              onChange={e => onUpdateSettings({ title: e.target.value })}
              spellCheck={false}
              title="Rename plot"
              style={{
                fontSize: 13, fontWeight: 600, color: "var(--text-header-title)",
                background: "transparent", border: "1px solid transparent",
                borderRadius: 2, padding: "1px 4px", outline: "none", width: 190,
              }}
              onFocus={e => { e.currentTarget.style.background = "var(--bg-input)"; e.currentTarget.style.borderColor = "var(--border-main)" }}
              onBlur={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent" }}
            />
          }
          meta={`${plotted.length} series · ${leftCount}L / ${rightCount}R`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Control label="X AXIS">
                <select
                  value={settings.xMode === "time" ? "time" : settings.xSeriesId ?? "time"}
                  onChange={e => {
                    if (e.target.value === "time") onUpdateSettings({ xMode: "time", xSeriesId: null })
                    else onUpdateSettings({ xMode: "phase", xSeriesId: e.target.value })
                  }}
                  style={selectStyle}
                >
                  <option value="time">Time</option>
                  {/* Any series can become the X axis: that is what turns the plot
                      into velocity-vs-acceleration. */}
                  {series.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </Control>

              {settings.xMode === "time" && (
                <Control label="WINDOW">
                  <select
                    value={settings.windowSeconds}
                    onChange={e => onUpdateSettings({ windowSeconds: Number(e.target.value) })}
                    style={selectStyle}
                  >
                    {WINDOW_OPTIONS.map(w => <option key={w} value={w}>{w}s</option>)}
                  </select>
                </Control>
              )}

              <Toggle label="GRID" checked={settings.showGrid} onChange={v => onUpdateSettings({ showGrid: v })} />
              <Toggle label="LEGEND" checked={settings.showLegend} onChange={v => onUpdateSettings({ showLegend: v })} />
              <Toggle label="STATS" checked={settings.showStats} onChange={v => onUpdateSettings({ showStats: v })} />

              <AxisLock
                label="L"
                range={settings.leftRange}
                onChange={r => onUpdateSettings({ leftRange: r })}
              />
              <AxisLock
                label="R"
                range={settings.rightRange}
                onChange={r => onUpdateSettings({ rightRange: r })}
              />

              <button
                onClick={handleExport}
                title="Export plot as PNG"
                style={{
                  display: "flex", alignItems: "center", gap: 5, height: 22, padding: "0 8px",
                  background: "var(--btn-classic-bg)", border: "1px solid var(--btn-classic-border)",
                  color: "var(--text-primary)", cursor: "pointer", fontSize: 10.5,
                }}
              >
                <img src="/icons/export.svg" alt="" aria-hidden width={13} height={13} style={{ display: "block" }} />
                Export
              </button>

              <span
                title={isLive ? "Live" : "Viewing history"}
                style={{
                  width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  background: isLive ? "var(--status-sim)" : "var(--mars-red)",
                }}
              />
            </div>
          }
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!isDragOver) setIsDragOver(true) }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              style={{
                flex: 1, position: "relative", padding: 10, boxSizing: "border-box", minHeight: 0,
                background: isDragOver ? "var(--bg-panel)" : "var(--bg-page)",
                border: isDragOver ? "1px dashed var(--mars-red)" : "1px solid transparent",
              }}
            >
              <GraphCanvas
                ref={graphRef}
                title={settings.title}
                series={drawnSeries}
                windowSeconds={settings.windowSeconds}
                isLive={isLive}
                selectedTime={selectedTime}
                showGrid={settings.showGrid}
                showLegend={settings.showLegend}
                leftRange={settings.leftRange}
                rightRange={settings.rightRange}
                phaseData={phaseData}
              />
            </div>

            {settings.showStats && <StatsStrip rows={stats} />}
          </div>

          <div style={{ width: 268, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)", flexShrink: 0, overflowY: "auto" }}>
            <SeriesPanel
              series={series}
              onUpdate={onUpdateSeries}
              onRemove={onRemoveSeries}
              onDuplicate={handleDuplicate}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Statistics ------------------------------------------------------------

// The table is what turns the plot into a measurement: tuning a PID needs the
// peak and the deviation, not the curve's shape.
function StatsStrip({ rows }: {
  rows: { id: string; label: string; color: string; unit: string | null; stats: ReturnType<typeof computeStats> }[]
}) {
  const withData = rows.filter(r => r.stats !== null)
  if (withData.length === 0) return null

  const fmt = (v: number) => {
    const abs = Math.abs(v)
    if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) return v.toExponential(2).replace("+", "")
    return v.toFixed(3)
  }

  return (
    <div style={{
      borderTop: "1px solid var(--border-main)", background: "var(--bg-panel)",
      padding: "4px 10px", flexShrink: 0, maxHeight: 132, overflowY: "auto",
    }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr style={{ color: "var(--text-muted)", textAlign: "right" }}>
            <th style={{ textAlign: "left", fontWeight: 600, padding: "1px 6px 1px 0" }}>SERIES</th>
            {["MIN", "MAX", "MEAN", "STD", "RMS", "LAST", "N"].map(h => (
              <th key={h} style={{ fontWeight: 600, padding: "1px 0 1px 10px" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {withData.map(r => (
            <tr key={r.id} style={{ color: "var(--text-primary)", textAlign: "right" }}>
              <td style={{ textAlign: "left", padding: "1px 6px 1px 0", whiteSpace: "nowrap" }}>
                <span style={{ display: "inline-block", width: 7, height: 7, background: r.color, marginRight: 5 }} />
                {r.label}{r.unit ? ` (${r.unit})` : ""}
              </td>
              <td style={cell}>{fmt(r.stats!.min)}</td>
              <td style={cell}>{fmt(r.stats!.max)}</td>
              <td style={cell}>{fmt(r.stats!.mean)}</td>
              <td style={cell}>{fmt(r.stats!.stdDev)}</td>
              <td style={cell}>{fmt(r.stats!.rms)}</td>
              <td style={cell}>{fmt(r.stats!.last)}</td>
              <td style={{ ...cell, color: "var(--text-muted)" }}>{r.stats!.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const cell: React.CSSProperties = { padding: "1px 0 1px 10px", whiteSpace: "nowrap" }

// --- Controles del header ---------------------------------------------------

const selectStyle: React.CSSProperties = {
  background: "var(--bg-input)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", padding: "2px 5px",
  borderRadius: 2, fontSize: 10.5, outline: "none", height: 22,
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <span style={{ fontSize: 9.5, color: "var(--text-header-eyebrow)" }}>{label}</span>
      {children}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, color: "var(--text-header-eyebrow)", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

// Pinning the axis keeps the scale from jumping on its own when a peak comes
// in: comparing two runs needs both to use the same ruler.
function AxisLock({ label, range, onChange }: {
  label: string
  range: [number, number] | null
  onChange: (r: [number, number] | null) => void
}) {
  const locked = range !== null
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <button
        onClick={() => onChange(locked ? null : [-1, 1])}
        title={locked ? `Unlock ${label} axis (auto-scale)` : `Lock ${label} axis to a fixed range`}
        style={{
          height: 22, padding: "0 5px", fontSize: 9.5, cursor: "pointer",
          background: locked ? "var(--tree-selection-bg)" : "var(--btn-classic-bg)",
          color: locked ? "var(--tree-selection-fg)" : "var(--text-primary)",
          border: "1px solid var(--btn-classic-border)",
        }}
      >
        <i className={`ti ${locked ? "ti-lock" : "ti-lock-open"}`} style={{ fontSize: 10 }} aria-hidden /> {label}
      </button>
      {locked && (
        <>
          <input
            type="number" step="any" value={range![0]}
            onChange={e => onChange([Number(e.target.value), range![1]])}
            style={{ ...selectStyle, width: 52 }}
          />
          <input
            type="number" step="any" value={range![1]}
            onChange={e => onChange([range![0], Number(e.target.value)])}
            style={{ ...selectStyle, width: 52 }}
          />
        </>
      )}
    </div>
  )
}
