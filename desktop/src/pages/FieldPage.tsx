import React, { useMemo, useRef, useState } from "react"
import {
  TopicAnnounce, FieldObjectConfig, FieldSettings, FieldOrientation,
} from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { useNTSnapshot } from "../utils/nt/useNTSnapshot"
import { extractPoses } from "../utils/field/poseExtraction"
import { extractModuleStates } from "../utils/field/swerveExtraction"
import {
  FIELDS, SCHEMATIC_FIELD_KEY, getField, COORDINATE_SYSTEM_LABELS, CoordinateSystem,
} from "../utils/field/fieldImages"
import { FIELD2D_TYPE, field2dTopicNames, isField2dTable } from "../utils/field/field2d"
import {
  defaultObjectTypeFor, isFieldDroppable, nextObjectLabel, resolveObjectOptions,
} from "../utils/field/fieldObjects"
import { HistoryStore } from "../utils/field/poseHistory"
import { pickModelFile, fileNameOf } from "../utils/field/robotModel"
import { forgetSprites } from "../utils/field/robotSprite"
import { useRobotSprite } from "../hooks/useRobotSprite"
import { useTableTypeStore } from "../store/tableTypeStore"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import FieldCanvas, { RenderedObject } from "../components/dashboard/field/FieldCanvas"
import FieldObjectPanel from "../components/dashboard/field/FieldObjectPanel"
import FieldViewPanel from "../components/dashboard/field/FieldViewPanel"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"
import SidebarIcon from "../components/common/SidebarIcon"

interface Props {
  topics: Map<string, TopicAnnounce>
  objects: FieldObjectConfig[]
  settings: FieldSettings
  onAddObject: (o: Omit<FieldObjectConfig, "id">) => string
  onRemoveObject: (id: string) => void
  onUpdateObject: (id: string, updates: Partial<FieldObjectConfig>) => void
  onUpdateSettings: (updates: Partial<FieldSettings>) => void
}

const OBJECT_COLORS = ["#2f6fdb", "#d63b3b", "#1f9e4a", "#d4a94a", "#8a4fd1", "#0e9aa7"]

const ORIENTATIONS: FieldOrientation[] = [0, 90, 180, 270]
const COORDINATE_SYSTEMS: CoordinateSystem[] = ["wall_blue", "center", "center_rotated"]

export default function FieldPage({
  topics, objects, settings,
  onAddObject, onRemoveObject, onUpdateObject, onUpdateSettings,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [panel, setPanel] = useState<"objects" | "field">("objects")
  const [measureMode, setMeasureMode] = useState(false)
  const [resetToken, setResetToken] = useState(0)
  const isLive = useSelectionStore(s => s.isLive)
  const tableTypes = useTableTypeStore(s => s.types)

  // The history lives in the PAGE and not in the canvas: the side panel has to
  // be able to count and clear the samples, and the canvas remounts every time
  // the field changes.
  const historyRef = useRef<HistoryStore | null>(null)
  if (historyRef.current === null) historyRef.current = new HistoryStore()
  const history = historyRef.current

  const { sprite, scale: spriteScale, status: spriteStatus, error: spriteError } = useRobotSprite(settings)

  const field = getField(settings.fieldKey)
  // The field's JSON says which frame the robot publishes in; the override
  // exists because a team may be publishing in another one and the pose comes
  // out mirrored. It is quicker to change it here than to edit the JSON.
  const coordinateSystem: CoordinateSystem =
    settings.coordinateSystem ?? field?.coordinateSystem ?? "wall_blue"

  // A single poll for all the drawn topics; useNTSnapshot already decides
  // whether to ask for the live value or the timeline's scrubbed instant's.
  // The Set is not cosmetic: the same topic can be in several objects (the
  // chassis and its heat map), and without it it would be requested once per
  // object.
  const topicNames = useMemo(
    () => Array.from(new Set(objects.map(o => o.topicName))),
    [objects],
  )
  const liveValues = useNTSnapshot(topicNames, 33)

  const rendered: RenderedObject[] = useMemo(() => (
    objects.map(obj => {
      const value = liveValues[obj.topicName]
      return {
        id: obj.id,
        type: obj.type,
        color: obj.color,
        label: obj.label,
        // A swerve object carries no poses: it is drawn anchored to the robot,
        // and what it needs from the topic is the four modules' states.
        poses: obj.type === "swerve" ? [] : extractPoses(value, obj.topicType),
        modules: obj.type === "swerve" ? extractModuleStates(value, obj.topicType) : undefined,
        options: resolveObjectOptions(obj, settings),
      }
    })
  ), [objects, liveValues, settings])

  // The history is filled outside React (the canvas writes it), so the count
  // is redone on every poll: `liveValues` is in the dependencies as a trigger,
  // not because it is used here.
  const sampleCounts = useMemo(() => {
    const out: Record<string, number> = {}
    objects.forEach(obj => { out[obj.id] = history.get(obj.id).length })
    return out
  }, [objects, liveValues, history])

  const totalSamples = Object.values(sampleCounts).reduce((acc, n) => acc + n, 0)
  const poseCount = rendered.reduce((acc, o) => acc + o.poses.length, 0)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    if (!isDragOver) setIsDragOver(true)
  }
  const handleDragLeave = () => setIsDragOver(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const topicName = e.dataTransfer.getData("topicName")
    const topicType = e.dataTransfer.getData("topicType")
    if (!topicName) return

    // A whole Field2d table: it is expanded into one object per topic hanging
    // from it, so each one stays editable separately in the panel.
    if (topicType === FIELD2D_TYPE) {
      addField2dTable(topicName)
      return
    }

    // Double lock: the tree already filters by type, it is revalidated in case
    // the drop came from another source.
    if (!isFieldDroppable(topicType)) return

    // On purpose, a topic already in the list is NOT discarded: dropping the
    // same pose twice is what lets it be seen as a chassis and as a heat map at
    // once. Publishing it twice from the robot only to get that would waste
    // bandwidth. The same rule as in Functions.
    const usedColors = new Set(objects.map(o => o.color))
    const color = OBJECT_COLORS.find(c => !usedColors.has(c)) ?? OBJECT_COLORS[objects.length % OBJECT_COLORS.length]

    onAddObject({
      topicName,
      topicType,
      label: nextObjectLabel(objects, topicName),
      type: defaultObjectTypeFor(topicName, topicType),
      color,
    })
  }

  const addField2dTable = (prefix: string) => {
    const used = new Set(objects.map(o => o.color))
    let colorIndex = 0
    const nextColor = () => {
      const free = OBJECT_COLORS.find(c => !used.has(c))
      const color = free ?? OBJECT_COLORS[colorIndex % OBJECT_COLORS.length]
      used.add(color)
      colorIndex++
      return color
    }

    for (const topicName of field2dTopicNames(topics, prefix)) {
      const topic = topics.get(topicName)
      if (!topic) continue

      const leaf = topicName.slice(prefix.length + 1)
      const isRobot = leaf === "Robot"
      // The Field2d's "Robot" is the robot; for the rest the same name-and-shape
      // heuristic used when dropping a loose topic applies.
      const type = isRobot ? ("robot" as const) : defaultObjectTypeFor(topicName, topic.topic_type)

      const base = isRobot ? prefix.split("/").filter(Boolean).pop() ?? leaf : leaf

      onAddObject({
        topicName,
        topicType: topic.topic_type,
        label: nextObjectLabel(objects, topicName, base),
        type: type === "robot" && !isRobot ? "ghost" : type,
        color: isRobot ? OBJECT_COLORS[0] : nextColor(),
      })
    }
  }

  /**
   * A second view of the SAME topic. It starts as a heat map when a chassis
   * is duplicated, which is the case people duplicate for: seeing where the
   * robot is and where it has been, without publishing the pose twice.
   */
  const handleDuplicate = (id: string) => {
    const source = objects.find(o => o.id === id)
    if (!source) return

    const used = new Set(objects.map(o => o.color))
    const color = OBJECT_COLORS.find(c => !used.has(c)) ?? source.color
    const { id: _drop, ...rest } = source

    const newId = onAddObject({
      ...rest,
      label: nextObjectLabel(objects, source.topicName),
      type: source.type === "robot" || source.type === "ghost" ? "heatmap" : source.type,
      color,
    })
    // The duplicate inherits what was accumulated: otherwise the new heat map
    // would start empty even though the original had been collecting for half a
    // practice.
    history.copy(id, newId)
  }

  const handlePickModel = async () => {
    const path = await pickModelFile("Select the robot model")
    if (path === null) return
    // The previous model's bitmaps are no use anymore and there can be several
    // (one per color and per rotation).
    if (settings.robotModelPath) forgetSprites(settings.robotModelPath)
    onUpdateSettings({
      robotModelPath: path,
      robotModelName: fileNameOf(path),
      robotRender: "model",
    })
  }

  const handleClearModel = () => {
    if (settings.robotModelPath) forgetSprites(settings.robotModelPath)
    onUpdateSettings({ robotModelPath: null, robotModelName: null, robotRender: "icon" })
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      {/* SIDEBAR: DATA DIRECTORY, only topics with geometry or swerve modules */}
      <DataDirectoryPanel
        topics={topics}
        hint="Pose structs · [x, y, θ] double arrays · SwerveModuleState[] · whole Field2d tables"
        dragFilter={(t) => isFieldDroppable(t.topic_type)}
        folderDragType={(fullPath) => (isField2dTable(tableTypes, fullPath) ? FIELD2D_TYPE : null)}
      />

      {/* MAIN: CANCHA + PANELES */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="2D Visualizer"
          meta={`${objects.length} objects · ${poseCount} poses · scroll to zoom, drag to pan, double-click to reset`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <StatusBadge color={isLive ? "var(--status-sim)" : "var(--mars-red)"} label={isLive ? "LIVE" : "VIEWING HISTORY"} />

              <Control label="FIELD">
                <select
                  value={settings.fieldKey}
                  onChange={e => onUpdateSettings({ fieldKey: e.target.value })}
                  style={selectStyle}
                >
                  {FIELDS.map(f => (
                    <option key={f.key} value={f.key}>{f.game} ({f.program})</option>
                  ))}
                  <option value={SCHEMATIC_FIELD_KEY}>Schematic (no image)</option>
                </select>
              </Control>

              <Control label="COORDS">
                <select
                  value={settings.coordinateSystem ?? "auto"}
                  onChange={e => onUpdateSettings({
                    coordinateSystem: e.target.value === "auto" ? null : e.target.value as CoordinateSystem,
                  })}
                  style={selectStyle}
                >
                  <option value="auto">
                    Auto ({COORDINATE_SYSTEM_LABELS[coordinateSystem].split(" (")[0]})
                  </option>
                  {COORDINATE_SYSTEMS.map(s => (
                    <option key={s} value={s}>{COORDINATE_SYSTEM_LABELS[s]}</option>
                  ))}
                </select>
              </Control>

              <Control label="ROTATION">
                <select
                  value={settings.orientation}
                  onChange={e => onUpdateSettings({ orientation: Number(e.target.value) as FieldOrientation })}
                  style={selectStyle}
                >
                  {ORIENTATIONS.map(o => <option key={o} value={o}>{o}°</option>)}
                </select>
              </Control>

              <div style={{ display: "flex", gap: 4 }}>
                <ToggleButton
                  svg="alliance-flip.svg"
                  icon="ti-flip-horizontal"
                  title="Red alliance view (flips the field half a turn)"
                  active={settings.allianceFlip}
                  onClick={() => onUpdateSettings({ allianceFlip: !settings.allianceFlip })}
                />
                <ToggleButton
                  svg="grid.svg"
                  icon="ti-grid-dots"
                  title="Grid"
                  active={settings.showGrid}
                  onClick={() => onUpdateSettings({ showGrid: !settings.showGrid })}
                />
                <ToggleButton
                  svg="measure.svg"
                  icon="ti-ruler-measure"
                  title="Measure: drag on the field to get distance and bearing (Esc clears)"
                  active={measureMode}
                  onClick={() => setMeasureMode(m => !m)}
                />
                <ToggleButton
                  svg="home.svg"
                  icon="ti-focus-centered"
                  title="Reset zoom and pan"
                  active={false}
                  onClick={() => setResetToken(t => t + 1)}
                />
              </div>
            </div>
          }
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              flex: 1, padding: 12, boxSizing: "border-box", overflow: "hidden",
              background: isDragOver ? "var(--bg-panel)" : "var(--bg-page)",
              border: isDragOver ? "1px dashed var(--mars-red)" : "1px solid transparent",
            }}
          >
            <FieldCanvas
              objects={rendered}
              settings={settings}
              field={field}
              coordinateSystem={coordinateSystem}
              sprite={sprite}
              spriteScale={spriteScale}
              measureMode={measureMode}
              resetToken={resetToken}
              history={history}
            />
          </div>

          <div style={{
            width: 288, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)",
            flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
          }}>
            <div style={{ display: "flex", borderBottom: "1px solid var(--border-main)", flexShrink: 0 }}>
              <Tab label={`Objects (${objects.length})`} active={panel === "objects"} onClick={() => setPanel("objects")} />
              <Tab label="Field" active={panel === "field"} onClick={() => setPanel("field")} />
            </div>

            <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {panel === "objects" ? (
                <FieldObjectPanel
                  objects={objects}
                  settings={settings}
                  sampleCounts={sampleCounts}
                  onUpdate={onUpdateObject}
                  onDuplicate={handleDuplicate}
                  onRemove={onRemoveObject}
                  onClearHistory={id => history.clear(id)}
                />
              ) : (
                <FieldViewPanel
                  settings={settings}
                  onUpdate={onUpdateSettings}
                  sprite={sprite}
                  spriteScale={spriteScale}
                  status={spriteStatus}
                  error={spriteError}
                  onPickModel={handlePickModel}
                  onClearModel={handleClearModel}
                  totalSamples={totalSamples}
                  onClearHistory={() => history.clear()}
                />
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
        flex: 1, padding: "7px 8px", cursor: "pointer", fontSize: 10.5, fontWeight: 600,
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
