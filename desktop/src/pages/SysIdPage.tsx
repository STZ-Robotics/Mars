import React, { useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { TopicAnnounce, ConnectionState, LogSource } from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { useSysIdStore, isRangeUsable, TestRange } from "../store/sysidStore"
import { classifyTopic } from "../utils/dashboard/topicClassification"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import PanelHeader from "../components/layout/PanelHeader"
import EmptyState from "../components/common/EmptyState"
import {
  ALL_TESTS, TEST_LABELS, MECHANISM_LABELS, MechanismType, SysIdTestType,
  SysIdTestRun, FeedforwardFit, RunDiagnostics,
  buildSamples, fitFeedforward, buildDiagnostics,
} from "../utils/sysid/feedforward"
import SysIdDiagnosticPlot, { DiagnosticLegend } from "../components/dashboard/sysid/SysIdDiagnosticPlot"

interface Props {
  topics: Map<string, TopicAnnounce>
  connection: ConnectionState
  logSource: LogSource | null
}

const MECHANISMS: { key: MechanismType; icon: string }[] = [
  { key: "simple", icon: "function.svg" },
  { key: "elevator", icon: "sysid.svg" },
  { key: "arm", icon: "mechanism.svg" },
]

type SignalSlot = "voltageTopic" | "positionTopic" | "velocityTopic"

const SIGNALS: { key: SignalSlot; label: string; hint: string; required: boolean }[] = [
  { key: "voltageTopic", label: "Applied voltage", hint: "Volts sent to the motor", required: true },
  { key: "velocityTopic", label: "Velocity", hint: "m/s or rad/s", required: true },
  { key: "positionTopic", label: "Position", hint: "Only used by the arm model (cos θ)", required: false },
]

export default function SysIdPage({ topics, connection, logSource }: Props) {
  const config = useSysIdStore(s => s.config)
  const update = useSysIdStore(s => s.update)
  const setRange = useSysIdStore(s => s.setRange)
  const clearRange = useSysIdStore(s => s.clearRange)
  const reset = useSysIdStore(s => s.reset)

  const selectedTime = useSelectionStore(s => s.selectedTime)

  const [fit, setFit] = useState<FeedforwardFit | null>(null)
  const [diagnostics, setDiagnostics] = useState<RunDiagnostics[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const hasSource = connection !== "disconnected" || logSource !== null
  const usableRanges = ALL_TESTS.filter(t => isRangeUsable(config.ranges[t]))
  const needsPosition = config.mechanism === "arm"

  const missing: string[] = []
  if (!config.voltageTopic) missing.push("applied voltage")
  if (!config.velocityTopic) missing.push("velocity")
  if (needsPosition && !config.positionTopic) missing.push("position (required for arm)")
  if (usableRanges.length === 0) missing.push("at least one test range")

  const canAnalyze = missing.length === 0 && !busy

  const handleAnalyze = async () => {
    setBusy(true)
    setError(null)
    setFit(null)
    setDiagnostics([])
    try {
      const names = [config.voltageTopic!, config.velocityTopic!]
      if (config.positionTopic) names.push(config.positionTopic)

      const runs: SysIdTestRun[] = []
      for (const test of usableRanges) {
        const range = config.ranges[test]
        const data: Record<string, [number, any][]> = await invoke("get_values_range", {
          topicNames: names,
          start: range.startUs!,
          end: range.endUs!,
        })

        // To seconds: the whole fit works in seconds, so kV comes out directly
        // in V/(unit/s).
        const toPoints = (name: string | null) =>
          !name ? [] : (data[name] ?? [])
            .filter(([, v]) => typeof v?.Number === "number")
            .map(([ts, v]) => ({ t: ts / 1e6, v: v.Number as number }))

        const samples = buildSamples(
          toPoints(config.voltageTopic),
          toPoints(config.positionTopic),
          toPoints(config.velocityTopic),
        )
        runs.push({ type: test, samples })
      }

      const result = fitFeedforward(config.mechanism, runs)
      if (result === null) {
        setError(
          "Could not fit the model. The most common cause is running only the quasistatic tests: " +
          "without the dynamic ones, kS and kA are mathematically indistinguishable.",
        )
      } else {
        setFit(result)
        // The predictions are computed only once, here: recomputing them on
        // every canvas render would throw CPU at data that does not change.
        setDiagnostics(buildDiagnostics(config.mechanism, result.gains, runs))
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDropSignal = (slot: SignalSlot) => (e: React.DragEvent) => {
    e.preventDefault()
    const topicName = e.dataTransfer.getData("topicName")
    const topicType = e.dataTransfer.getData("topicType")
    if (!topicName || !classifyTopic(topicType).isNumber) return
    update({ [slot]: topicName } as Partial<typeof config>)
    setFit(null)
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>
      <DataDirectoryPanel
        topics={topics}
        hint="Drag the applied voltage, velocity and (for arms) position onto the slots"
        dragFilter={t => classifyTopic(t.topic_type).isNumber}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="System Identification"
          meta={`${usableRanges.length} of 4 test runs · ${MECHANISM_LABELS[config.mechanism].split(" (")[0]}`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ToolButton icon="ti-refresh" label="Reset" onClick={() => { reset(); setFit(null); setDiagnostics([]); setError(null) }} />
              <button
                onClick={handleAnalyze}
                disabled={!canAnalyze}
                title={canAnalyze ? "Fit the feedforward model" : `Still missing: ${missing.join(", ")}`}
                style={{
                  display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 12px",
                  background: canAnalyze ? "var(--tree-selection-bg)" : "var(--btn-classic-bg)",
                  color: canAnalyze ? "var(--tree-selection-fg)" : "var(--btn-classic-text-disabled)",
                  border: "1px solid var(--btn-classic-border)",
                  cursor: canAnalyze ? "pointer" : "default", fontSize: 11, fontWeight: 600,
                }}
              >
                <img src="/icons/sysid.svg" alt="" aria-hidden width={14} height={14} style={{ display: "block" }} />
                {busy ? "Analyzing…" : "Analyze"}
              </button>
            </div>
          }
        />

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px 32px" }}>
          <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>

            {!hasSource && (
              <EmptyState
                icon="ti-database-off"
                message="No data source"
                hint="Open a log or connect to the robot, then run the SysId routine from your robot code"
              />
            )}

            <BevelPanel title="Mechanism" icon="mechanism.svg">
              <div style={{ display: "flex", gap: 6, padding: 8 }}>
                {MECHANISMS.map(m => (
                  <MechanismCard
                    key={m.key}
                    type={m.key}
                    icon={m.icon}
                    selected={config.mechanism === m.key}
                    onSelect={() => { update({ mechanism: m.key }); setFit(null) }}
                  />
                ))}
              </div>
            </BevelPanel>

            <BevelPanel title="Signals" icon="data-directory.svg">
              <div>
                {SIGNALS.map(signal => (
                  <SignalRow
                    key={signal.key}
                    label={signal.label}
                    hint={signal.hint}
                    // The position is mandatory ONLY in the arm model: it is the only
                    // thing that uses cos(θ).
                    required={signal.required || (signal.key === "positionTopic" && needsPosition)}
                    dimmed={signal.key === "positionTopic" && !needsPosition}
                    value={config[signal.key]}
                    onDrop={handleDropSignal(signal.key)}
                    onClear={() => { update({ [signal.key]: null } as Partial<typeof config>); setFit(null) }}
                  />
                ))}
              </div>
            </BevelPanel>

            <BevelPanel
              title="Test runs"
              icon="capture.svg"
              note="Move the timeline cursor to the start of a run, press Set start, move to the end, press Set end."
            >
              <div>
                {ALL_TESTS.map(test => (
                  <TestRangeRow
                    key={test}
                    test={test}
                    range={config.ranges[test]}
                    cursorUs={selectedTime}
                    onSetStart={() => { if (selectedTime !== null) { setRange(test, { startUs: selectedTime }); setFit(null) } }}
                    onSetEnd={() => { if (selectedTime !== null) { setRange(test, { endUs: selectedTime }); setFit(null) } }}
                    onClear={() => { clearRange(test); setFit(null) }}
                  />
                ))}
              </div>
            </BevelPanel>

            {error && (
              <div style={{
                background: "var(--bg-panel)", border: "1px solid var(--status-error)",
                padding: "8px 10px", fontSize: 11, color: "var(--status-error)", lineHeight: 1.45,
              }}>
                {error}
              </div>
            )}

            {fit && <ResultsPanel fit={fit} />}
            {fit && diagnostics.length > 0 && <DiagnosticsPanel diagnostics={diagnostics} />}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Resultados -------------------------------------------------------------

function ResultsPanel({ fit }: { fit: FeedforwardFit }) {
  const [copied, setCopied] = useState(false)
  const g = fit.gains

  // The order of the arguments is NOT the same in WPILib's three classes:
  // SimpleMotorFeedforward(kS, kV, kA) but Elevator/ArmFeedforward(kS, kG, kV, kA).
  const javaSnippet =
    fit.mechanism === "simple"
      ? `new SimpleMotorFeedforward(${g.kS.toFixed(5)}, ${g.kV.toFixed(5)}, ${g.kA.toFixed(5)})`
      : fit.mechanism === "elevator"
        ? `new ElevatorFeedforward(${g.kS.toFixed(5)}, ${g.kG!.toFixed(5)}, ${g.kV.toFixed(5)}, ${g.kA.toFixed(5)})`
        : `new ArmFeedforward(${g.kS.toFixed(5)}, ${g.kG!.toFixed(5)}, ${g.kV.toFixed(5)}, ${g.kA.toFixed(5)})`

  const handleExport = async () => {
    try {
      const path = await save({
        title: "Export gains",
        defaultPath: `sysid-${fit.mechanism}-gains.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
      if (!path) return
      const payload = JSON.stringify({
        mechanism: fit.mechanism,
        gains: fit.gains,
        rSquared: fit.rSquared,
        rmse: fit.rmse,
        sampleCount: fit.sampleCount,
        warnings: fit.warnings,
        java: javaSnippet,
        generated: new Date().toISOString(),
      }, null, 2)
      // btoa does not support characters outside latin1; the detour through
      // encodeURIComponent turns the text into UTF-8 byte by byte before encoding it.
      await invoke("save_base64_file", { path, base64Data: btoa(unescape(encodeURIComponent(payload))) })
    } catch (e) {
      alert(`Could not export gains:\n${e}`)
    }
  }

  const quality = fit.rSquared >= 0.95 ? "var(--status-sim)"
    : fit.rSquared >= 0.85 ? "var(--status-warning)"
    : "var(--status-error)"

  return (
    <BevelPanel title="Feedforward gains" icon="gains.svg">
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <GainCard label="kS" value={g.kS} unit="V" hint="Static friction" />
          {g.kG !== undefined && (
            <GainCard label="kG" value={g.kG} unit="V" hint="Gravity" />
          )}
          <GainCard label="kV" value={g.kV} unit="V·s/unit" hint="Velocity" />
          <GainCard label="kA" value={g.kA} unit="V·s²/unit" hint="Acceleration" />
        </div>

        <div style={{ display: "flex", gap: 16, fontSize: 10.5, color: "var(--text-muted)", flexWrap: "wrap" }}>
          <span>R² <b style={{ color: quality, fontVariantNumeric: "tabular-nums" }}>{fit.rSquared.toFixed(4)}</b></span>
          <span>RMSE <b style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{fit.rmse.toFixed(4)} V</b></span>
          <span>Samples <b style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{fit.sampleCount}</b></span>
        </div>

        {fit.warnings.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
            {fit.warnings.map(w => (
              <li key={w} style={{ fontSize: 10.5, color: "var(--status-warning)", lineHeight: 1.4 }}>{w}</li>
            ))}
          </ul>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <code style={{
            flex: 1, minWidth: 0, fontSize: 10.5, fontFamily: "ui-monospace, monospace",
            background: "var(--bg-input)", border: "1px solid var(--border-main)",
            padding: "5px 8px", overflowX: "auto", whiteSpace: "nowrap",
          }}>
            {javaSnippet}
          </code>
          <ToolButton
            icon={copied ? "ti-check" : "ti-copy"}
            label={copied ? "Copied" : "Copy"}
            onClick={() => {
              navigator.clipboard.writeText(javaSnippet).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }).catch(() => {})
            }}
          />
          <button
            onClick={handleExport}
            title="Export gains as JSON"
            style={{
              display: "flex", alignItems: "center", gap: 5, height: 22, padding: "0 8px",
              background: "var(--btn-classic-bg)", border: "1px solid var(--btn-classic-border)",
              color: "var(--text-primary)", cursor: "pointer", fontSize: 10.5, flexShrink: 0,
            }}
          >
            <img src="/icons/export.svg" alt="" aria-hidden width={13} height={13} style={{ display: "block" }} />
            Export
          </button>
        </div>
      </div>
    </BevelPanel>
  )
}

// The two plots answer different questions: the top one says HOW MUCH the model
// is wrong, the bottom one says WHETHER the error has structure (i.e. whether
// physics is missing from the chosen model).
function DiagnosticsPanel({ diagnostics }: { diagnostics: RunDiagnostics[] }) {
  return (
    <BevelPanel
      title="Fit diagnostics"
      icon="gains.svg"
      note="Left: measured vs predicted — a good fit hugs the dashed 45° line. Right: residual vs velocity — any visible shape means the model is missing something."
    >
      <DiagnosticLegend diagnostics={diagnostics} />
      <div style={{ display: "flex", gap: 8, padding: "0 8px 8px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SysIdDiagnosticPlot diagnostics={diagnostics} mode="fit" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SysIdDiagnosticPlot diagnostics={diagnostics} mode="residual" />
        </div>
      </div>
    </BevelPanel>
  )
}

function GainCard({ label, value, unit, hint }: { label: string; value: number; unit: string; hint: string }) {
  return (
    <div
      title={hint}
      style={{
        flex: "1 1 120px", minWidth: 110,
        background: "var(--bg-input)", border: "1px solid var(--border-main)",
        padding: "6px 9px",
      }}
    >
      <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums", lineHeight: 1.2 }}>
        {value.toFixed(5)}
      </div>
      <div style={{ fontSize: 9, color: "var(--text-muted)" }}>{unit}</div>
    </div>
  )
}

// --- Filas ------------------------------------------------------------------

function MechanismCard({ type, icon, selected, onSelect }: {
  type: MechanismType; icon: string; selected: boolean; onSelect: () => void
}) {
  const [name, detail] = MECHANISM_LABELS[type].split(" (")
  return (
    <div
      onClick={onSelect}
      style={{
        flex: 1, cursor: "pointer", padding: "8px 9px",
        display: "flex", alignItems: "center", gap: 8,
        background: selected ? "var(--tree-selection-bg)" : "var(--bg-input)",
        color: selected ? "var(--tree-selection-fg)" : "var(--text-primary)",
        border: `1px solid ${selected ? "var(--tree-selection-bg)" : "var(--border-main)"}`,
      }}
    >
      <img src={`/icons/${icon}`} alt="" aria-hidden width={20} height={20} style={{ display: "block", flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600 }}>{name}</div>
        <div style={{ fontSize: 9, opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {detail?.replace(")", "")}
        </div>
      </div>
    </div>
  )
}

function SignalRow({ label, hint, required, dimmed, value, onDrop, onClear }: {
  label: string; hint: string; required: boolean; dimmed: boolean
  value: string | null
  onDrop: (e: React.DragEvent) => void
  onClear: () => void
}) {
  const [over, setOver] = useState(false)

  return (
    <div
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { setOver(false); onDrop(e) }}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "5px 9px", minHeight: 30,
        borderBottom: "1px solid var(--border-light)",
        background: over ? "var(--tree-hover-bg)" : "transparent",
        opacity: dimmed ? 0.5 : 1,
      }}
    >
      <div style={{ width: 130, flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: "var(--text-primary)" }}>
          {label}
          {required && <span style={{ color: "var(--status-error)" }}> *</span>}
        </div>
        <div style={{ fontSize: 9, color: "var(--text-muted)" }}>{hint}</div>
      </div>

      <div style={{
        flex: 1, minWidth: 0, height: 22, display: "flex", alignItems: "center", padding: "0 7px",
        background: "var(--bg-input)",
        border: `1px ${value ? "solid" : "dashed"} var(--border-main)`,
        fontSize: 10.5, fontFamily: "ui-monospace, monospace",
        color: value ? "var(--text-primary)" : "var(--text-muted)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }} title={value ?? undefined}>
        {value ?? "drag a numeric topic here"}
      </div>

      {value && <ToolButton icon="ti-x" label="Clear" onClick={onClear} />}
    </div>
  )
}

function TestRangeRow({ test, range, cursorUs, onSetStart, onSetEnd, onClear }: {
  test: SysIdTestType
  range: TestRange
  cursorUs: number | null
  onSetStart: () => void
  onSetEnd: () => void
  onClear: () => void
}) {
  const usable = isRangeUsable(range)
  const durationS = usable ? (range.endUs! - range.startUs!) / 1e6 : null
  const inverted = range.startUs !== null && range.endUs !== null && range.endUs <= range.startUs

  const status = usable ? "var(--status-sim)"
    : inverted ? "var(--status-error)"
    : "var(--text-muted)"

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "5px 9px", minHeight: 30,
      borderBottom: "1px solid var(--border-light)",
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%", background: status, flexShrink: 0,
      }} />
      <div style={{ width: 150, flexShrink: 0, fontSize: 11 }}>{TEST_LABELS[test]}</div>

      <div style={{
        flex: 1, minWidth: 0, fontSize: 10, fontFamily: "ui-monospace, monospace",
        color: inverted ? "var(--status-error)" : "var(--text-muted)",
      }}>
        {inverted
          ? "end is before start"
          : usable
            ? `${durationS!.toFixed(2)}s selected`
            : range.startUs !== null ? "start set — now mark the end"
            : range.endUs !== null ? "end set — now mark the start"
            : "not set"}
      </div>

      {/* The ranges are marked with the timeline's cursor: it is the only way
          to know exactly where each robot run started. */}
      <ToolButton icon="ti-arrow-bar-to-right" label="Set start" disabled={cursorUs === null} onClick={onSetStart} />
      <ToolButton icon="ti-arrow-bar-to-left" label="Set end" disabled={cursorUs === null} onClick={onSetEnd} />
      <ToolButton icon="ti-x" label="Clear" onClick={onClear} />
    </div>
  )
}

// --- Piezas visuales --------------------------------------------------------

function BevelPanel({ title, icon, note, children }: {
  title: string; icon: string; note?: string; children: React.ReactNode
}) {
  return (
    <div style={{
      background: "var(--bg-page)",
      borderTop: "1px solid var(--bevel-light)",
      borderLeft: "1px solid var(--bevel-light)",
      borderRight: "1px solid var(--bevel-dark)",
      borderBottom: "1px solid var(--bevel-dark)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 8px",
        background: "linear-gradient(180deg, #e6e6ea 0%, #d4d4da 100%)",
        borderBottom: "1px solid var(--bevel-dark)", userSelect: "none",
      }}>
        <img src={`/icons/${icon}`} alt="" aria-hidden width={14} height={14} style={{ display: "block" }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>{title}</span>
      </div>
      {note && (
        <div style={{
          fontSize: 9.5, color: "var(--text-muted)", padding: "4px 9px", lineHeight: 1.4,
          background: "var(--bg-panel)", borderBottom: "1px solid var(--border-light)",
        }}>
          {note}
        </div>
      )}
      {children}
    </div>
  )
}

function ToolButton({ icon, label, onClick, disabled = false }: {
  icon: string; label: string; onClick: () => void; disabled?: boolean
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
        height: 20, padding: "0 6px", flexShrink: 0, fontSize: 10,
        background: disabled ? "var(--btn-classic-bg)" : hovered ? "var(--btn-classic-bg-hover)" : "var(--btn-classic-bg)",
        border: "1px solid var(--btn-classic-border)",
        color: disabled ? "var(--btn-classic-text-disabled)" : "var(--text-primary)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <i className={`ti ${icon}`} style={{ fontSize: 11 }} aria-hidden />
    </button>
  )
}
