import React, { useMemo, useState } from "react"
import {
  TopicAnnounce, SwerveSourceConfig, SwerveSettings, FieldOrientation,
} from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { useSwerveSources, swerveSourceFromDrop, PositionSet } from "../hooks/useSwerveSources"
import { isSwerveTopic } from "../utils/field/swerveExtraction"
import {
  solveChassis, moduleLocations, computeICR, vectorToModuleState, KinematicsSolution,
  wrapDegrees, angleErrorDegrees,
} from "../utils/field/swerveKinematics"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import SwerveCanvas, { ModuleSet, ChassisSet } from "../components/dashboard/swerve/SwerveCanvas"
import SwerveSourcePanel from "../components/dashboard/swerve/SwerveSourcePanel"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"

interface Props {
  topics: Map<string, TopicAnnounce>
  sources: SwerveSourceConfig[]
  settings: SwerveSettings
  onAddSource: (s: Omit<SwerveSourceConfig, "id">) => void
  onRemoveSource: (id: string) => void
  onUpdateSource: (id: string, updates: Partial<SwerveSourceConfig>) => void
  onUpdateSettings: (updates: Partial<SwerveSettings>) => void
}

const ORIENTATIONS: FieldOrientation[] = [0, 90, 180, 270]
const CORNER_LABELS = ["FL", "FR", "BL", "BR"]

export default function SwervePage({
  topics, sources, settings,
  onAddSource, onRemoveSource, onUpdateSource, onUpdateSettings,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const isLive = useSelectionStore(s => s.isLive)

  const { moduleSets, positionSets, chassisSets, rotation } = useSwerveSources(sources)

  // The kinematics is solved over what is MEASURED (if there is none, over the
  // first set there is): rebuilding the chassis from a setpoint would say
  // nothing about the real robot, it would only repeat what it was commanded.
  const measuredSet = moduleSets.find(s => s.role === "measured") ?? moduleSets[0] ?? null
  const setpointSet = moduleSets.find(s => s.role === "setpoint") ?? null

  const solution: KinematicsSolution | null = useMemo(() => {
    if (!measuredSet) return null
    return solveChassis(measuredSet.values, moduleLocations(settings.frameLength, settings.frameWidth))
  }, [measuredSet, settings.frameLength, settings.frameWidth])

  // Tracking error per module: commanded − measured.
  const trackingErrors = useMemo(() => {
    if (!measuredSet || !setpointSet) return null
    return measuredSet.values.map((measured, i) => {
      const target = setpointSet.values[i]
      if (!target) return null
      return {
        speed: target.speed - measured.speed,
        angle: angleErrorDegrees(measured.angle, target.angle),
      }
    })
  }, [measuredSet, setpointSet])

  const predictedStates = useMemo(
    () => solution?.predicted.map(vectorToModuleState),
    [solution],
  )

  const icr = solution ? computeICR(solution.vx, solution.vy, solution.omega) : null

  // The highest module speed observed right now: if it goes over the configured
  // maximum, the commanded velocities need desaturating.
  const peakModuleSpeed = moduleSets.reduce(
    (max, set) => Math.max(max, ...set.values.map(v => Math.abs(v.speed))),
    0,
  )
  const isSaturated = peakModuleSpeed > settings.maxSpeed

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const source = swerveSourceFromDrop(
      e.dataTransfer.getData("topicName"),
      e.dataTransfer.getData("topicType"),
      sources,
    )
    if (source) onAddSource(source)
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      <DataDirectoryPanel
        topics={topics}
        hint="SwerveModuleState[] · ChassisSpeeds · Rotation2d · gyro doubles"
        dragFilter={(t) => isSwerveTopic(t.topic_type)}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="Swerve"
          meta={`${moduleSets.length} module sets · ${chassisSets.length} chassis sources`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <StatusBadge color={isLive ? "var(--status-sim)" : "var(--mars-red)"} label={isLive ? "LIVE" : "VIEWING HISTORY"} />

              <NumberControl
                label="MAX"
                value={settings.maxSpeed}
                suffix="m/s"
                onChange={v => onUpdateSettings({ maxSpeed: Math.max(0.1, v) })}
              />
              <NumberControl
                label="LENGTH"
                value={settings.frameLength}
                suffix="m"
                onChange={v => onUpdateSettings({ frameLength: Math.max(0.1, v) })}
              />
              <NumberControl
                label="WIDTH"
                value={settings.frameWidth}
                suffix="m"
                onChange={v => onUpdateSettings({ frameWidth: Math.max(0.1, v) })}
              />

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, color: "var(--text-header-eyebrow)" }}>ROT</span>
                <select
                  value={settings.orientation}
                  onChange={e => onUpdateSettings({ orientation: Number(e.target.value) as FieldOrientation })}
                  style={selectStyle}
                >
                  {ORIENTATIONS.map(o => <option key={o} value={o}>{o}°</option>)}
                </select>
              </div>

              <Toggle
                label="GRADIENT"
                checked={settings.gradient}
                onChange={v => onUpdateSettings({ gradient: v })}
              />
              <Toggle
                label="VALUES"
                checked={settings.showValues}
                onChange={v => onUpdateSettings({ showValues: v })}
              />
              <Toggle
                label="IDEAL"
                checked={settings.showPredicted}
                onChange={v => onUpdateSettings({ showPredicted: v })}
              />
              <Toggle
                label="ICR"
                checked={settings.showICR}
                onChange={v => onUpdateSettings({ showICR: v })}
              />
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
              <SwerveCanvas
                moduleSets={moduleSets}
                chassisSets={chassisSets}
                rotation={rotation}
                settings={settings}
                predicted={predictedStates}
                icr={icr}
              />
            </div>

            <ReadoutStrip
              moduleSets={moduleSets}
              positionSets={positionSets}
              chassisSets={chassisSets}
              rotation={rotation}
              peakModuleSpeed={peakModuleSpeed}
              isSaturated={isSaturated}
              maxSpeed={settings.maxSpeed}
              solution={solution}
              icr={icr}
              trackingErrors={trackingErrors}
            />
          </div>

          <div style={{ width: 280, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)", flexShrink: 0, overflowY: "auto" }}>
            <SwerveSourcePanel sources={sources} onUpdate={onUpdateSource} onRemove={onRemoveSource} />
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Numeric readout -------------------------------------------------------

// A table of exact values under the diagram: the drawing shows the motion's
// shape, but calibrating needs the numbers.
function ReadoutStrip({
  moduleSets, positionSets, chassisSets, rotation, peakModuleSpeed, isSaturated, maxSpeed, solution, icr, trackingErrors,
}: {
  moduleSets: ModuleSet[]
  positionSets: PositionSet[]
  chassisSets: ChassisSet[]
  rotation: number
  peakModuleSpeed: number
  isSaturated: boolean
  maxSpeed: number
  solution: KinematicsSolution | null
  icr: { x: number; y: number } | null
  trackingErrors: ({ speed: number; angle: number } | null)[] | null
}) {
  if (moduleSets.length === 0 && positionSets.length === 0 && chassisSets.length === 0) return null

  return (
    <div style={{
      borderTop: "1px solid var(--border-main)", background: "var(--bg-panel)",
      padding: "8px 12px", display: "flex", gap: 24, flexWrap: "wrap", flexShrink: 0,
      fontSize: 11, color: "var(--text-primary)",
    }}>
      {moduleSets.map(set => (
        <div key={set.id}>
          <ReadoutTitle color={set.color} label={set.label} />
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {set.values.map((state, i) => (
                <tr key={i}>
                  <td style={cellStyle}>{CORNER_LABELS[i] ?? i}</td>
                  <td style={{ ...cellStyle, fontVariantNumeric: "tabular-nums", color: Math.abs(state.speed) > maxSpeed ? "var(--status-error)" : "var(--text-primary)" }}>
                    {state.speed.toFixed(2)} m/s
                  </td>
                  <td style={{ ...cellStyle, fontVariantNumeric: "tabular-nums" }}>
                    {wrapDegrees((state.angle * 180) / Math.PI).toFixed(1)}°
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {chassisSets.map(set => {
        const linear = Math.hypot(set.value.vx, set.value.vy)
        return (
          <div key={set.id}>
            <ReadoutTitle color={set.color} label={set.label} />
            <table style={{ borderCollapse: "collapse" }}>
              <tbody>
                <tr><td style={cellStyle}>vx</td><td style={numCellStyle}>{set.value.vx.toFixed(2)} m/s</td></tr>
                <tr><td style={cellStyle}>vy</td><td style={numCellStyle}>{set.value.vy.toFixed(2)} m/s</td></tr>
                <tr><td style={cellStyle}>|v|</td><td style={numCellStyle}>{linear.toFixed(2)} m/s</td></tr>
                <tr><td style={cellStyle}>ω</td><td style={numCellStyle}>{((set.value.omega * 180) / Math.PI).toFixed(1)} °/s</td></tr>
              </tbody>
            </table>
          </div>
        )
      })}

      {positionSets.map(set => {
        // The difference between the wheel that advanced the most and the one that
        // advanced the least reveals slip or a miscalibrated wheel radius on a module.
        const distances = set.values.map(v => v.distance)
        const spread = Math.max(...distances) - Math.min(...distances)
        return (
          <div key={set.id}>
            <ReadoutTitle color={set.color} label={`${set.label} (dist)`} />
            <table style={{ borderCollapse: "collapse" }}>
              <tbody>
                {set.values.map((p, i) => (
                  <tr key={i}>
                    <td style={cellStyle}>{CORNER_LABELS[i] ?? i}</td>
                    <td style={numCellStyle}>{p.distance.toFixed(3)} m</td>
                    <td style={numCellStyle}>{wrapDegrees((p.angle * 180) / Math.PI).toFixed(1)}°</td>
                  </tr>
                ))}
                <tr>
                  <td style={cellStyle}>spread</td>
                  <td style={numCellStyle} colSpan={2}>{spread.toFixed(3)} m</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      })}

      {trackingErrors && (
        <div>
          <ReadoutTitle computed label="Error (setpoint − measured)" />
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {trackingErrors.map((err, i) => (
                <tr key={i}>
                  <td style={cellStyle}>{CORNER_LABELS[i] ?? i}</td>
                  {err === null ? (
                    <td style={numCellStyle} colSpan={2}>—</td>
                  ) : (
                    <>
                      <td style={{ ...numCellStyle, color: Math.abs(err.speed) > 0.25 ? "var(--status-error)" : Math.abs(err.speed) > 0.1 ? "var(--status-warning)" : "var(--text-primary)" }}>
                        {err.speed >= 0 ? "+" : ""}{err.speed.toFixed(2)} m/s
                      </td>
                      <td style={{ ...numCellStyle, color: Math.abs(err.angle) > 5 ? "var(--status-error)" : Math.abs(err.angle) > 2 ? "var(--status-warning)" : "var(--text-primary)" }}>
                        {err.angle >= 0 ? "+" : ""}{err.angle.toFixed(1)}°
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {solution && (
        <div>
          <ReadoutTitle computed label="Kinematics (solved)" />
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              <tr><td style={cellStyle}>vx</td><td style={numCellStyle}>{solution.vx.toFixed(2)} m/s</td></tr>
              <tr><td style={cellStyle}>vy</td><td style={numCellStyle}>{solution.vy.toFixed(2)} m/s</td></tr>
              <tr><td style={cellStyle}>ω</td><td style={numCellStyle}>{((solution.omega * 180) / Math.PI).toFixed(1)} °/s</td></tr>
              <tr>
                <td style={cellStyle}>rms err</td>
                <td style={{ ...numCellStyle, color: solution.rmsResidual > 0.15 ? "var(--status-error)" : "var(--text-primary)" }}>
                  {solution.rmsResidual.toFixed(3)} m/s
                </td>
              </tr>
              {icr && (
                <tr>
                  <td style={cellStyle}>ICR</td>
                  <td style={numCellStyle}>{icr.x.toFixed(2)}, {icr.y.toFixed(2)} m</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {solution && (
        <div>
          <ReadoutTitle computed label="Slip / residual" />
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {solution.residuals.map((r, i) => (
                <tr key={i}>
                  <td style={cellStyle}>{CORNER_LABELS[i] ?? i}</td>
                  <td style={{ ...numCellStyle, color: r > 0.2 ? "var(--status-error)" : r > 0.1 ? "var(--status-warning)" : "var(--text-primary)" }}>
                    {r.toFixed(3)} m/s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <ReadoutTitle color="var(--text-muted)" label="Chassis" />
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr><td style={cellStyle}>heading</td><td style={numCellStyle}>{((rotation * 180) / Math.PI).toFixed(1)}°</td></tr>
            <tr>
              <td style={cellStyle}>peak</td>
              <td style={{ ...numCellStyle, color: isSaturated ? "var(--status-error)" : "var(--text-primary)" }}>
                {peakModuleSpeed.toFixed(2)} m/s
              </td>
            </tr>
            {isSaturated && (
              <tr>
                <td colSpan={2} style={{ ...cellStyle, color: "var(--status-error)", fontWeight: 600 }}>
                  over max — desaturate
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// The filled square shows the color THAT source is drawn with in the diagram.
// The computed sections (which are not drawn as such) carry a square with only
// a border, so as not to suggest looking for them on the canvas.
function ReadoutTitle({ color, label, computed = false }: { color?: string; label: string; computed?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
      <span style={{
        width: 8, height: 8, borderRadius: 1, flexShrink: 0,
        background: computed ? "transparent" : color,
        border: computed ? "1px solid var(--text-muted)" : "none",
      }} />
      <span style={{ fontSize: 9.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </span>
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
        step={0.05}
        min={0.1}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ ...selectStyle, width: 62 }}
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
