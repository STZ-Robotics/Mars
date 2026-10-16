// The swerve's 3D view. It consumes EXACTLY the same sources as the Swerve 2D
// tab (SwerveModuleState[], ChassisSpeeds, Rotation2d) and draws them over the
// robot's real model.
//
// The robot does not translate: the idea is to see the drivetrain's state, not
// to follow the pose on the field (that is what the 2D Visualizer is for). What
// moves is the floor, opposite to the chassis.

import React, { useEffect, useMemo, useState } from "react"
import {
  TopicAnnounce, SwerveSourceConfig, SwerveSettings, Swerve3dSettings,
  Swerve3dModulePlacement,
} from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { useSwerveSources, swerveSourceFromDrop } from "../hooks/useSwerveSources"
import { isSwerveTopic, ChassisVelocities } from "../utils/field/swerveExtraction"
import {
  solveChassis, moduleLocations, KinematicsSolution, wrapDegrees,
} from "../utils/field/swerveKinematics"
import { LoadedModel, loadModel, pickModelFile, fileNameOf } from "../utils/field/robotModel"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import SwerveSourcePanel from "../components/dashboard/swerve/SwerveSourcePanel"
import Swerve3dScene from "../components/dashboard/swerve/Swerve3dScene"
import Swerve3dConfigPanel, { ModelStatus } from "../components/dashboard/swerve/Swerve3dConfigPanel"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"

interface Props {
  topics: Map<string, TopicAnnounce>
  sources: SwerveSourceConfig[]
  settings: SwerveSettings
  view: Swerve3dSettings
  onAddSource: (s: Omit<SwerveSourceConfig, "id">) => void
  onRemoveSource: (id: string) => void
  onUpdateSource: (id: string, updates: Partial<SwerveSourceConfig>) => void
  onUpdateSettings: (updates: Partial<SwerveSettings>) => void
  onUpdateView: (updates: Partial<Swerve3dSettings>) => void
}

const CORNER_LABELS = ["FL", "FR", "BL", "BR"]

/** A rectangular chassis' four corners, in drawing order. */
function autoPlacements(length: number, width: number, height: number): Swerve3dModulePlacement[] {
  return moduleLocations(length, width).map(location => ({ x: location.x, y: location.y, z: height }))
}

export default function Swerve3dPage({
  topics, sources, settings, view,
  onAddSource, onRemoveSource, onUpdateSource, onUpdateSettings, onUpdateView,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [panel, setPanel] = useState<"sources" | "view">("sources")
  const [resetToken, setResetToken] = useState(0)
  const isLive = useSelectionStore(s => s.isLive)

  const { moduleSets, chassisSets, rotation } = useSwerveSources(sources)

  // --- Modelo ----------------------------------------------------------------
  const [model, setModel] = useState<LoadedModel | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [modelLoading, setModelLoading] = useState(false)

  useEffect(() => {
    const path = view.modelPath
    if (!path) {
      setModel(null)
      setModelError(null)
      return
    }

    let cancelled = false
    setModelLoading(true)
    setModelError(null)
    loadModel(path)
      .then(loaded => { if (!cancelled) setModel(loaded) })
      .catch(error => {
        if (cancelled) return
        setModel(null)
        setModelError(String(error?.message ?? error))
      })
      .finally(() => { if (!cancelled) setModelLoading(false) })

    return () => { cancelled = true }
  }, [view.modelPath])

  const status: ModelStatus = modelLoading ? "loading"
    : modelError ? "error"
    : model ? "ready"
    : "empty"

  const handlePickModel = async () => {
    try {
      const path = await pickModelFile("Select robot model")
      if (!path) return
      onUpdateView({ modelPath: path, modelName: fileNameOf(path) })
    } catch (error) {
      setModelError(String(error))
    }
  }

  // --- Kinematics ------------------------------------------------------------
  // The velocity that moves the floor comes from the measured source if the
  // robot publishes ChassisSpeeds; if not, it is rebuilt from the modules, which
  // is what the 2D tab does for the ICR.
  const measuredSet = moduleSets.find(s => s.role === "measured") ?? moduleSets[0] ?? null

  const solution: KinematicsSolution | null = useMemo(() => {
    if (!measuredSet) return null
    return solveChassis(measuredSet.values, moduleLocations(settings.frameLength, settings.frameWidth))
  }, [measuredSet, settings.frameLength, settings.frameWidth])

  const velocity: ChassisVelocities | null = useMemo(() => {
    if (chassisSets.length > 0) return chassisSets[0].value
    if (solution) return { vx: solution.vx, vy: solution.vy, omega: solution.omega }
    return null
  }, [chassisSets, solution])

  const velocitySource = chassisSets.length > 0 ? chassisSets[0].label : solution ? "solved" : null

  const placements = useMemo(
    () => view.moduleAuto
      ? autoPlacements(settings.frameLength, settings.frameWidth, view.moduleAutoHeight)
      : view.modules,
    [view.moduleAuto, view.modules, view.moduleAutoHeight, settings.frameLength, settings.frameWidth],
  )

  const frameData = useMemo(
    () => ({ moduleSets, chassisSets, rotation, velocity }),
    [moduleSets, chassisSets, rotation, velocity],
  )

  const peakModuleSpeed = moduleSets.reduce(
    (max, set) => Math.max(max, ...set.values.map(v => Math.abs(v.speed))),
    0,
  )

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

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="Swerve 3D"
          meta={`${moduleSets.length} module sets · ${view.modelName ?? "no model"}`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0, overflow: "hidden" }}>
              <StatusBadge color={isLive ? "var(--status-sim)" : "var(--mars-red)"} label={isLive ? "LIVE" : "VIEWING HISTORY"} />

              <NumberControl label="MAX" value={settings.maxSpeed} suffix="m/s"
                onChange={v => onUpdateSettings({ maxSpeed: Math.max(0.1, v) })} />
              <NumberControl label="LENGTH" value={settings.frameLength} suffix="m"
                onChange={v => onUpdateSettings({ frameLength: Math.max(0.1, v) })} />
              <NumberControl label="WIDTH" value={settings.frameWidth} suffix="m"
                onChange={v => onUpdateSettings({ frameWidth: Math.max(0.1, v) })} />

              <Toggle label="FLOOR" checked={view.motionFloor} onChange={v => onUpdateView({ motionFloor: v })} />
              <Toggle label="GYRO" checked={view.followHeading} onChange={v => onUpdateView({ followHeading: v })} />

              <button onClick={() => setResetToken(t => t + 1)} style={headerButtonStyle} title="Back to the default camera">
                <i className="ti ti-focus-centered" aria-hidden /> View
              </button>
            </div>
          }
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!isDragOver) setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            style={{
              flex: 1, minWidth: 0, position: "relative", overflow: "hidden",
              border: isDragOver ? "1px dashed var(--mars-red)" : "1px solid transparent",
            }}
          >
            <Swerve3dScene
              data={frameData}
              settings={settings}
              view={view}
              placements={placements}
              model={model}
              resetCameraToken={resetToken}
            />

            <Hud
              moduleSets={moduleSets}
              rotation={rotation}
              velocity={velocity}
              velocitySource={velocitySource}
              maxSpeed={settings.maxSpeed}
              peakModuleSpeed={peakModuleSpeed}
              rmsResidual={solution?.rmsResidual ?? null}
            />

            <div style={{
              position: "absolute", right: 10, bottom: 8, fontSize: 9.5,
              color: "var(--text-muted)", pointerEvents: "none", userSelect: "none",
            }}>
              drag to orbit · scroll to zoom · right-drag to pan
            </div>
          </div>

          <div style={{ width: 288, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)", flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", borderBottom: "1px solid var(--border-main)", flexShrink: 0 }}>
              <TabButton label="Sources" active={panel === "sources"} onClick={() => setPanel("sources")} />
              <TabButton label="3D view" active={panel === "view"} onClick={() => setPanel("view")} />
            </div>
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {panel === "sources" ? (
                <SwerveSourcePanel sources={sources} onUpdate={onUpdateSource} onRemove={onRemoveSource} />
              ) : (
                <Swerve3dConfigPanel
                  view={view}
                  settings={settings}
                  onUpdate={onUpdateView}
                  model={model}
                  status={status}
                  error={modelError}
                  onPickModel={handlePickModel}
                  onClearModel={() => onUpdateView({ modelPath: null, modelName: null })}
                  onResetModules={() => onUpdateView({
                    modules: autoPlacements(settings.frameLength, settings.frameWidth, view.moduleAutoHeight),
                  })}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Numeric readout over the 3D -------------------------------------------

// The numbers go over the canvas and not in a separate strip: the 3D view
// needs all the height it can get, and they are four rows anyway.
function Hud({
  moduleSets, rotation, velocity, velocitySource, maxSpeed, peakModuleSpeed, rmsResidual,
}: {
  moduleSets: ReturnType<typeof useSwerveSources>["moduleSets"]
  rotation: number
  velocity: ChassisVelocities | null
  velocitySource: string | null
  maxSpeed: number
  peakModuleSpeed: number
  rmsResidual: number | null
}) {
  if (moduleSets.length === 0 && velocity === null) {
    return (
      <div style={{ ...hudStyle, maxWidth: 260, lineHeight: 1.55 }}>
        Drag a <i>SwerveModuleState[]</i>, a <i>ChassisSpeeds</i> or a <i>Rotation2d</i> here
        to drive the model.
      </div>
    )
  }

  const linear = velocity ? Math.hypot(velocity.vx, velocity.vy) : 0
  const saturated = peakModuleSpeed > maxSpeed

  return (
    <div style={hudStyle}>
      <div style={{ display: "flex", gap: 18 }}>
        <div>
          <HudTitle label={velocitySource ? `Chassis · ${velocitySource}` : "Chassis"} />
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              <tr><td style={cellStyle}>heading</td><td style={numCellStyle}>{((rotation * 180) / Math.PI).toFixed(1)}°</td></tr>
              {velocity && <>
                <tr><td style={cellStyle}>vx</td><td style={numCellStyle}>{velocity.vx.toFixed(2)} m/s</td></tr>
                <tr><td style={cellStyle}>vy</td><td style={numCellStyle}>{velocity.vy.toFixed(2)} m/s</td></tr>
                <tr><td style={cellStyle}>|v|</td><td style={numCellStyle}>{linear.toFixed(2)} m/s</td></tr>
                <tr><td style={cellStyle}>ω</td><td style={numCellStyle}>{((velocity.omega * 180) / Math.PI).toFixed(1)} °/s</td></tr>
              </>}
              <tr>
                <td style={cellStyle}>peak</td>
                <td style={{ ...numCellStyle, color: saturated ? "var(--status-error)" : "var(--text-primary)" }}>
                  {peakModuleSpeed.toFixed(2)} m/s
                </td>
              </tr>
              {rmsResidual !== null && (
                <tr>
                  <td style={cellStyle}>rms err</td>
                  <td style={{ ...numCellStyle, color: rmsResidual > 0.15 ? "var(--status-error)" : "var(--text-primary)" }}>
                    {rmsResidual.toFixed(3)} m/s
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {moduleSets.map(set => (
          <div key={set.id}>
            <HudTitle label={set.label} color={set.color} />
            <table style={{ borderCollapse: "collapse" }}>
              <tbody>
                {set.values.map((state, i) => (
                  <tr key={i}>
                    <td style={cellStyle}>{CORNER_LABELS[i] ?? i}</td>
                    <td style={{ ...numCellStyle, color: Math.abs(state.speed) > maxSpeed ? "var(--status-error)" : "var(--text-primary)" }}>
                      {state.speed.toFixed(2)}
                    </td>
                    <td style={numCellStyle}>{wrapDegrees((state.angle * 180) / Math.PI).toFixed(1)}°</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}

function HudTitle({ label, color }: { label: string; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
      <span style={{
        width: 8, height: 8, borderRadius: 1, flexShrink: 0,
        background: color ?? "transparent",
        border: color ? "none" : "1px solid var(--text-muted)",
      }} />
      <span style={{ fontSize: 9.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </span>
    </div>
  )
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: "7px 0", fontSize: 10.5, cursor: "pointer",
        background: active ? "var(--bg-panel)" : "var(--bg-panel-header)",
        color: active ? "var(--text-primary)" : "var(--text-muted)",
        border: "none",
        borderBottom: active ? "2px solid var(--mars-accent)" : "2px solid transparent",
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  )
}

// --- Controles del header ---------------------------------------------------

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
        style={{
          background: "var(--bg-input)", color: "var(--text-primary)",
          border: "1px solid var(--border-main)", padding: "3px 6px",
          borderRadius: 2, fontSize: 11, outline: "none", width: 62,
        }}
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

const hudStyle: React.CSSProperties = {
  position: "absolute", left: 10, top: 10,
  background: "rgba(255, 255, 255, 0.86)",
  border: "1px solid var(--border-main)",
  borderRadius: 3,
  padding: "7px 10px",
  fontSize: 11,
  color: "var(--text-primary)",
  pointerEvents: "none",
  userSelect: "none",
}

const cellStyle: React.CSSProperties = { padding: "1px 8px 1px 0", color: "var(--text-muted)", fontSize: 10.5 }
const numCellStyle: React.CSSProperties = { ...cellStyle, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }

const headerButtonStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5,
  background: "var(--bg-input)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", borderRadius: 2,
  padding: "3px 8px", fontSize: 10.5, cursor: "pointer",
}
