// Field 3D: the season's field in three dimensions, with the robot, its
// articulated parts, the trajectories and the vision marks on top.
//
// It is the 2D Visualizer's 3D sibling and shares its shape: topics are dragged
// from the Data Directory onto the scene and each one becomes a configurable
// object. What changes is that here a pose has height and full orientation, so
// it serves what 2D cannot — seeing whether the arm reaches, whether the shot
// leaves at the computed angle, or where the camera saw the AprilTag that moved
// the estimated pose from.
//
// The page does three things and delegates the rest: it resolves WHICH poses
// there are this frame, converts them from the frame the robot publishes in to
// the field model's, and hands the result to the scene. The drawing lives in
// `components/dashboard/field3d/`, the assets in `utils/field3d/`.

import React, { useCallback, useMemo, useRef, useState } from "react"
import { TopicAnnounce, Field3dObjectConfig, Field3dSettings, Field3dCameraMode, Field3dQuality, EVERGREEN_FIELD_KEY } from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { useNTSnapshot } from "../utils/nt/useNTSnapshot"
import { useField3dAssets } from "../hooks/useField3dAssets"
import { extractPoses3d } from "../utils/field3d/pose3d"
import { Alliance, Pose3D, frameTransform, toFieldFrame } from "../utils/field3d/frames"
import { DEFAULT_FIELD_SIZE } from "../utils/field3d/evergreen"
import {
  defaultField3dTypeFor, isField3dDroppable, nextField3dLabel, resolveField3dOptions,
} from "../utils/field3d/objects"
import { TrailStore } from "../utils/field3d/trails"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import Field3dScene from "../components/dashboard/field3d/Field3dScene"
import Field3dObjectPanel from "../components/dashboard/field3d/Field3dObjectPanel"
import Field3dViewPanel from "../components/dashboard/field3d/Field3dViewPanel"
import Field3dAssetPanel from "../components/dashboard/field3d/Field3dAssetPanel"
import { RenderedField3dObject } from "../components/dashboard/field3d/objectVisuals"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"
import SidebarIcon from "../components/common/SidebarIcon"

interface Props {
  topics: Map<string, TopicAnnounce>
  objects: Field3dObjectConfig[]
  settings: Field3dSettings
  onAddObject: (o: Omit<Field3dObjectConfig, "id">) => string
  onRemoveObject: (id: string) => void
  onUpdateObject: (id: string, updates: Partial<Field3dObjectConfig>) => void
  onUpdateSettings: (updates: Partial<Field3dSettings>) => void
}

const OBJECT_COLORS = ["#2f6fdb", "#d63b3b", "#1f9e4a", "#d4a94a", "#8a4fd1", "#0e9aa7"]

/** The Driver Station publishes this on its own; nothing has to be done on the robot. */
const FMS_ALLIANCE_TOPIC = "/FMSInfo/IsRedAlliance"

const CAMERA_MODES: { value: Field3dCameraMode; label: string }[] = [
  { value: "orbit", label: "Orbit field" },
  { value: "orbitRobot", label: "Orbit robot" },
  { value: "driverStation", label: "Driver station" },
  { value: "robotCamera", label: "Robot camera" },
]

const QUALITIES: { value: Field3dQuality; label: string }[] = [
  { value: "cinematic", label: "Cinematic" },
  { value: "standard", label: "Standard" },
  { value: "lowPower", label: "Low power" },
]

export default function Field3dPage({
  topics, objects, settings,
  onAddObject, onRemoveObject, onUpdateObject, onUpdateSettings,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [panel, setPanel] = useState<"objects" | "view" | "assets">("objects")
  const [resetToken, setResetToken] = useState(0)
  const isLive = useSelectionStore(s => s.isLive)

  // The trails live in the PAGE and not in the scene: the panel has to be able
  // to count and clear them, and the scene remounts every time the field
  // changes.
  const trailsRef = useRef<TrailStore | null>(null)
  if (trailsRef.current === null) trailsRef.current = new TrailStore()
  const trails = trailsRef.current

  // Stable on purpose: they go to memoized panels, and a new function on every
  // render would make them redraw just as if they were not.
  const clearAllTrails = useCallback(() => trails.clear(), [trails])
  const clearOneTrail = useCallback((id: string) => trails.clear(id), [trails])

  const assets = useField3dAssets(settings, objects)

  // --- Datos ------------------------------------------------------------------

  // A single poll for everything drawn. The Set is not cosmetic: the same topic
  // can be in several objects (the robot and its trail) and without it it would
  // be requested once per object.
  const topicNames = useMemo(() => {
    const names = new Set(objects.map(o => o.topicName))
    if (settings.allianceFromFMS) names.add(FMS_ALLIANCE_TOPIC)
    return Array.from(names)
  }, [objects, settings.allianceFromFMS])

  const liveValues = useNTSnapshot(topicNames, 33)

  const fmsAlliance = liveValues[FMS_ALLIANCE_TOPIC]?.Boolean
  const allianceFromRobot = settings.allianceFromFMS && typeof fmsAlliance === "boolean"
  const alliance: Alliance = allianceFromRobot
    ? (fmsAlliance ? "red" : "blue")
    : settings.alliance

  // --- The field's frame ------------------------------------------------------

  const size = assets.fieldPack?.config.size ?? DEFAULT_FIELD_SIZE

  // Which origin to use when the system is alliance-relative. "auto" follows the
  // real alliance, which is what 99 % of cases want; pinning it serves to review
  // a log from the other alliance without everything flipping around.
  const originAlliance: Alliance = settings.origin === "auto" ? alliance : settings.origin

  const transform = useMemo(() => frameTransform(
    settings.coordinateSystem ?? assets.fieldPack?.config.coordinateSystem ?? "wall-blue",
    size,
    originAlliance,
  ), [settings.coordinateSystem, assets.fieldPack, size, originAlliance])

  const rendered: RenderedField3dObject[] = useMemo(() => (
    objects.map(obj => {
      const options = resolveField3dOptions(obj, settings)
      const raw = extractPoses3d(liveValues[obj.topicName], obj.topicType, options.arrayFormat)

      // Components are published RELATIVE to the robot, so they do not go
      // through the frame conversion: the scene composes them with the robot's
      // pose, which is converted.
      const poses: Pose3D[] = obj.type === "component"
        ? raw
        : raw.map(pose => toFieldFrame(pose, transform))

      return {
        id: obj.id,
        type: obj.type,
        color: obj.color,
        label: obj.label,
        poses,
        options,
      }
    })
  ), [objects, settings, liveValues, transform])

  // The pieces the field model already carries in place are turned off as soon
  // as the robot publishes that piece type, so it is not seen twice.
  const activeGamePieces = useMemo(() => {
    const active = new Set<number>()
    rendered.forEach(object => {
      if (object.type === "gamePiece" && !object.options.hidden && object.poses.length > 0) {
        active.add(object.options.gamePieceIndex)
      }
    })
    return active
  }, [rendered])

  // The count is redone on every poll: `liveValues` is in the dependencies as
  // a trigger, not because it is used here — the trails are written by the
  // scene, outside React.
  const sampleCounts = useMemo(() => {
    const out: Record<string, number> = {}
    objects.forEach(obj => { out[obj.id] = trails.count(obj.id) })
    return out
  }, [objects, liveValues, trails])

  // Memoized because it goes to a memoized panel: recreating the object on
  // every render would make it redraw anyway, which is exactly what is avoided.
  const modelStats = useMemo(
    () => (assets.fieldModel
      ? {
          triangles: assets.fieldModel.triangles,
          drawCalls: assets.fieldModel.drawCalls,
          culled: assets.fieldModel.culled,
        }
      : null),
    [assets.fieldModel],
  )

  const totalTrailSamples = Object.values(sampleCounts).reduce((acc, n) => acc + n, 0)
  const poseCount = rendered.reduce((acc, o) => acc + o.poses.length, 0)

  // --- Arrastre ----------------------------------------------------------------

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const topicName = e.dataTransfer.getData("topicName")
    const topicType = e.dataTransfer.getData("topicType")
    // Double lock: the tree already filters by type, it is revalidated in case
    // the drop came from another source.
    if (!topicName || !isField3dDroppable(topicType)) return

    const usedColors = new Set(objects.map(o => o.color))
    const color = OBJECT_COLORS.find(c => !usedColors.has(c))
      ?? OBJECT_COLORS[objects.length % OBJECT_COLORS.length]

    onAddObject({
      topicName,
      topicType,
      label: nextField3dLabel(objects, topicName),
      type: defaultField3dTypeFor(topicName, topicType),
      color,
    })
  }

  /**
   * A second view of the SAME topic. A duplicated robot starts as a ghost,
   * which is the case people duplicate for: comparing the measured pose with
   * the estimated one without publishing the same pose twice from the robot.
   */
  const handleDuplicate = (id: string) => {
    const source = objects.find(o => o.id === id)
    if (!source) return

    const used = new Set(objects.map(o => o.color))
    const color = OBJECT_COLORS.find(c => !used.has(c)) ?? source.color
    const { id: _drop, ...rest } = source

    const newId = onAddObject({
      ...rest,
      label: nextField3dLabel(objects, source.topicName),
      type: source.type === "robot" ? "ghost" : source.type,
      color,
    })
    // The duplicate inherits what was accumulated: otherwise the new trail would
    // start empty even though the original had been collecting for half a practice.
    trails.copy(id, newId)
  }

  // --- Estado de carga ----------------------------------------------------------

  const fieldLabel = settings.fieldKey === EVERGREEN_FIELD_KEY
    ? "Schematic"
    : assets.fieldPack?.config.name ?? "Missing asset"

  const meta = [
    `${objects.length} objects`,
    `${poseCount} poses`,
    fieldLabel,
    assets.status === "loading" ? "loading model…" : null,
  ].filter(Boolean).join(" · ")

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>
      <DataDirectoryPanel
        topics={topics}
        hint="Pose3d · Pose2d · Translation3d · arrays of those · [x, y, θ] and [x, y, z, qw…] double arrays"
        dragFilter={(t) => isField3dDroppable(t.topic_type)}
      />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="Field 3D"
          meta={meta}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <StatusBadge
                color={isLive ? "var(--status-sim)" : "var(--mars-red)"}
                label={isLive ? "LIVE" : "VIEWING HISTORY"}
              />
              <StatusBadge
                color={alliance === "red" ? "var(--mars-red)" : "#2f6fdb"}
                label={alliance === "red" ? "RED" : "BLUE"}
              />

              <Control label="FIELD">
                <select
                  value={settings.fieldKey}
                  onChange={e => onUpdateSettings({ fieldKey: e.target.value })}
                  style={selectStyle}
                >
                  <option value={EVERGREEN_FIELD_KEY}>Schematic</option>
                  {assets.fieldPacks.map(p => (
                    <option key={p.key} value={p.key}>{p.config.name}</option>
                  ))}
                </select>
              </Control>

              <Control label="CAMERA">
                <select
                  value={settings.cameraMode}
                  onChange={e => onUpdateSettings({ cameraMode: e.target.value as Field3dCameraMode })}
                  style={selectStyle}
                >
                  {CAMERA_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </Control>

              <Control label="QUALITY">
                <select
                  value={settings.quality}
                  onChange={e => onUpdateSettings({ quality: e.target.value as Field3dQuality })}
                  style={selectStyle}
                >
                  {QUALITIES.map(q => <option key={q.value} value={q.value}>{q.label}</option>)}
                </select>
              </Control>

              <div style={{ display: "flex", gap: 4 }}>
                <ToggleButton
                  svg="grid.svg"
                  icon="ti-grid-dots"
                  title="Grid"
                  active={settings.showGrid}
                  onClick={() => onUpdateSettings({ showGrid: !settings.showGrid })}
                />
                <ToggleButton
                  svg="target.svg"
                  icon="ti-tag"
                  title="AprilTags from the field layout"
                  active={settings.showAprilTags}
                  onClick={() => onUpdateSettings({ showAprilTags: !settings.showAprilTags })}
                />
                <ToggleButton
                  svg="trail.svg"
                  icon="ti-line-dashed"
                  title="Trails"
                  active={settings.showTrails}
                  onClick={() => onUpdateSettings({ showTrails: !settings.showTrails })}
                />
                <ToggleButton
                  svg="home.svg"
                  icon="ti-focus-centered"
                  title="Back to the default camera"
                  active={false}
                  onClick={() => setResetToken(t => t + 1)}
                />
              </div>
            </div>
          }
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = "copy"
              if (!isDragOver) setIsDragOver(true)
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            style={{
              flex: 1, minWidth: 0, position: "relative", overflow: "hidden",
              border: isDragOver ? "1px dashed var(--mars-red)" : "1px solid transparent",
            }}
          >
            <Field3dScene
              objects={rendered}
              settings={settings}
              size={size}
              fieldConfig={assets.fieldPack?.config ?? null}
              fieldAsset={assets.fieldModel}
              robotAssets={assets.robotAssets}
              gamePieces={assets.gamePieces}
              activeGamePieces={activeGamePieces}
              trails={trails}
              resetCameraToken={resetToken}
            />

            {(assets.status === "loading" || assets.error !== null) && (
              <div style={{
                position: "absolute", left: 12, bottom: 12, maxWidth: 340,
                padding: "6px 10px", borderRadius: 3, fontSize: 10.5, lineHeight: 1.5,
                background: "rgba(12,13,17,0.86)", pointerEvents: "none",
                color: assets.error ? "var(--status-error)" : "var(--text-primary)",
                border: `1px solid ${assets.error ? "var(--status-error-border)" : "var(--border-main)"}`,
              }}>
                {assets.error ?? "Loading the field model — the first time takes a moment."}
              </div>
            )}
          </div>

          <div style={{
            width: 300, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)",
            flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
          }}>
            <div style={{ display: "flex", borderBottom: "1px solid var(--border-main)", flexShrink: 0 }}>
              <Tab label={`Objects (${objects.length})`} active={panel === "objects"} onClick={() => setPanel("objects")} />
              <Tab label="Scene" active={panel === "view"} onClick={() => setPanel("view")} />
              <Tab label={`Assets (${assets.packs.length})`} active={panel === "assets"} onClick={() => setPanel("assets")} />
            </div>

            <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {panel === "objects" && (
                <Field3dObjectPanel
                  objects={objects}
                  settings={settings}
                  robotPacks={assets.robotPacks}
                  gamePieceNames={assets.fieldPack?.config.gamePieces.map(p => p.name) ?? []}
                  sampleCounts={sampleCounts}
                  onUpdate={onUpdateObject}
                  onDuplicate={handleDuplicate}
                  onRemove={onRemoveObject}
                  onClearTrail={clearOneTrail}
                />
              )}
              {panel === "view" && (
                <Field3dViewPanel
                  settings={settings}
                  fieldPacks={assets.fieldPacks}
                  robotPacks={assets.robotPacks}
                  fieldPack={assets.fieldPack}
                  alliance={alliance}
                  allianceFromRobot={allianceFromRobot}
                  stats={modelStats}
                  totalTrailSamples={totalTrailSamples}
                  onUpdate={onUpdateSettings}
                  onClearTrails={clearAllTrails}
                />
              )}
              {panel === "assets" && (
                <Field3dAssetPanel packs={assets.packs} onChanged={assets.refresh} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-main)",
  padding: "3px 6px",
  borderRadius: 2,
  fontSize: 11,
  outline: "none",
  maxWidth: 150,
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 10, color: "var(--text-header-eyebrow)" }}>{label}</span>
      {children}
    </div>
  )
}

function ToggleButton({
  svg, icon, title, active, onClick,
}: { svg?: string; icon: string; title: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 24, height: 24, cursor: "pointer", borderRadius: 2, fontSize: 13,
        background: active ? "var(--toolbar-active-bg)" : "var(--bg-input)",
        color: active ? "var(--mars-accent)" : "var(--text-muted)",
        border: `1px solid ${active ? "var(--mars-accent)" : "var(--border-main)"}`,
      }}
    >
      <SidebarIcon
        svg={svg}
        fallback={icon}
        size={14}
        color={active ? "var(--mars-accent)" : "var(--text-muted)"}
      />
    </button>
  )
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: "7px 6px", cursor: "pointer", fontSize: 10, fontWeight: 600,
        letterSpacing: 0.4, textTransform: "uppercase",
        background: active ? "var(--bg-panel)" : "var(--bg-panel-header)",
        color: active ? "var(--text-primary)" : "var(--text-muted)",
        border: "none",
        borderBottom: `2px solid ${active ? "var(--mars-accent)" : "transparent"}`,
      }}
    >
      {label}
    </button>
  )
}
