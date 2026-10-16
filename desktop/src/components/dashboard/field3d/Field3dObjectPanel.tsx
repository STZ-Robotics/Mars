// The Field 3D's object list, with each type's own options.
//
// The same shape as the 2D visualizer's panel: one row per object with its
// color, its visibility switch and, below, only the controls that type
// understands. Always showing every field would turn the panel into a
// thirty-box form where twenty-five do nothing.

import {
  Field3dObjectConfig, Field3dObjectType, Field3dSettings, Field3dArrayFormat,
  Field3dTrajectoryStyle,
} from "../../../store/appStore"
import {
  FIELD3D_OBJECT_HELP, FIELD3D_OBJECT_ICONS, FIELD3D_OBJECT_LABELS, FIELD3D_OBJECT_TYPES,
  needsAnchor, resolveField3dOptions,
} from "../../../utils/field3d/objects"
import { RobotPack } from "../../../utils/field3d/assetStore"
import {
  Check, Hint, IconToggle, Num, PanelIcon, Row, Select, Slider,
} from "../three/PanelFields"

interface Props {
  objects: Field3dObjectConfig[]
  settings: Field3dSettings
  robotPacks: RobotPack[]
  /** Names of the active field's game pieces, for the selector. */
  gamePieceNames: string[]
  /** Trail samples accumulated per object. */
  sampleCounts: Record<string, number>
  onUpdate: (id: string, updates: Partial<Field3dObjectConfig>) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  onClearTrail: (id: string) => void
}

const ARRAY_FORMAT_OPTIONS: { value: Field3dArrayFormat; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "pose2d", label: "[x, y, θ°] triplets" },
  { value: "pose3d", label: "[x, y, z, qw, qx, qy, qz]" },
]

const TRAJECTORY_STYLES: { value: Field3dTrajectoryStyle; label: string }[] = [
  { value: "tube", label: "Tube" },
  { value: "line", label: "Line" },
  { value: "points", label: "Points" },
]

export default function Field3dObjectPanel({
  objects, settings, robotPacks, gamePieceNames, sampleCounts,
  onUpdate, onDuplicate, onRemove, onClearTrail,
}: Props) {
  if (objects.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
        No objects yet. Drag a <i>Pose3d</i>, <i>Pose2d</i>, a <i>Translation3d[]</i> or any
        array of those from the Data Directory onto the field.
        <br /><br />
        A <i>Pose3d[]</i> of robot-relative poses becomes the articulated components of your
        robot model; a <i>Pose2d</i> becomes the robot itself, lifted to the carpet.
        <br /><br />
        The same topic can be added as many times as you like: drop it twice to see one copy
        as the robot and the other as its trail.
      </div>
    )
  }

  // The anchored types have no pose of their own. If there is no robot in the
  // list they are not drawn, and saying it here saves the time spent believing
  // the topic is published wrong.
  const robots = objects.filter(o => o.type === "robot" || o.type === "ghost")
  const anchorOptions = [
    { value: "", label: robots.length > 0 ? `Auto (${robots[0].label})` : "Auto (no robot)" },
    ...robots.map(r => ({ value: r.id, label: r.label })),
  ]

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {objects.map(obj => {
        const opts = resolveField3dOptions(obj, settings)
        const icon = FIELD3D_OBJECT_ICONS[obj.type]
        const samples = sampleCounts[obj.id] ?? 0
        const robotPack = opts.robotAssetKey
          ? robotPacks.find(p => p.key === opts.robotAssetKey)
          : undefined

        return (
          <div
            key={obj.id}
            style={{
              display: "flex", flexDirection: "column", gap: 7,
              padding: "10px 12px",
              borderBottom: "1px solid var(--border-light)",
              opacity: opts.hidden ? 0.55 : 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <PanelIcon svg={icon.svg} svgFallback={icon.svgFallback} fallback={icon.fallback} size={14} />
              <input
                type="color"
                value={obj.color}
                onChange={e => onUpdate(obj.id, { color: e.target.value })}
                title="Object colour"
                style={{
                  width: 20, height: 20, padding: 0, flexShrink: 0,
                  border: "1px solid var(--border-main)", background: "var(--bg-input)",
                  borderRadius: 2, cursor: "pointer",
                }}
              />
              <span
                style={{
                  fontSize: 11, fontWeight: 600, color: "var(--text-primary)", flex: 1,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
                title={obj.topicName}
              >
                {obj.label}
              </span>
              <IconToggle
                svg={opts.hidden ? "hidden.svg" : "visible.svg"}
                icon={opts.hidden ? "ti-eye-off" : "ti-eye"}
                active={opts.hidden}
                title={opts.hidden ? "Show on the field" : "Hide (keeps the object in the list)"}
                onClick={() => onUpdate(obj.id, { hidden: !opts.hidden })}
              />
              <IconToggle
                svg="duplicate.svg"
                icon="ti-copy"
                active={false}
                title="Add a second view of the same topic"
                onClick={() => onDuplicate(obj.id)}
              />
              <IconToggle
                svg="delete.svg"
                icon="ti-trash"
                active={false}
                title="Remove"
                onClick={() => onRemove(obj.id)}
              />
            </div>

            <Row>
              <Select<Field3dObjectType>
                label="Type"
                value={obj.type}
                options={FIELD3D_OBJECT_TYPES.map(t => ({ value: t, label: FIELD3D_OBJECT_LABELS[t] }))}
                onChange={type => onUpdate(obj.id, { type })}
                help={FIELD3D_OBJECT_HELP[obj.type]}
              />
              <Slider
                label="Opacity"
                value={opts.opacity}
                min={0.05}
                max={1}
                step={0.05}
                onChange={opacity => onUpdate(obj.id, { opacity })}
                format={v => `${Math.round(v * 100)}%`}
              />
            </Row>

            {/* Only shows up when the topic is a numeric array: in a struct
                the format is already given and the selector would be pointless. */}
            {obj.topicType.endsWith("[]") && !obj.topicType.startsWith("struct:") && (
              <Select<Field3dArrayFormat>
                label="Array format"
                value={opts.arrayFormat}
                options={ARRAY_FORMAT_OPTIONS}
                onChange={arrayFormat => onUpdate(obj.id, { arrayFormat })}
                help={
                  "A double[] can carry [x, y, θ] triplets (the classic Field2d format) or " +
                  "[x, y, z, qw, qx, qy, qz] septets. Auto guesses from the length and " +
                  "prefers triplets when both fit."
                }
              />
            )}

            {(obj.type === "robot" || obj.type === "ghost") && (
              <>
                <Select
                  label="Robot model"
                  value={opts.robotAssetKey ?? ""}
                  options={[
                    { value: "", label: "Generic chassis" },
                    ...robotPacks.map(p => ({ value: p.key, label: p.config.name })),
                  ]}
                  onChange={key => onUpdate(obj.id, { robotAssetKey: key === "" ? null : key })}
                  help="Assets are installed from the Assets tab. Without one you get a box with coloured bumpers, which is enough to read odometry."
                />
                {robotPack && (
                  <Check
                    label="Draw the model"
                    checked={opts.useModel}
                    onChange={useModel => onUpdate(obj.id, { useModel })}
                    help="Off falls back to the generic chassis — useful to compare the published footprint against the CAD."
                  />
                )}
              </>
            )}

            {obj.type === "component" && (
              <>
                <Select
                  label="Attached to"
                  value={opts.anchorId ?? ""}
                  options={anchorOptions}
                  onChange={id => onUpdate(obj.id, { anchorId: id === "" ? null : id })}
                  help="Component poses are published RELATIVE to the robot, so they need to know which robot."
                />
                <Select
                  label="Robot model"
                  value={opts.robotAssetKey ?? ""}
                  options={[
                    { value: "", label: "None — nothing to draw" },
                    ...robotPacks.map(p => ({ value: p.key, label: p.config.name })),
                  ]}
                  onChange={key => onUpdate(obj.id, { robotAssetKey: key === "" ? null : key })}
                />
                <Hint>
                  {robotPack
                    ? `${robotPack.config.components.length} components declared. Pose 0 moves the first, pose 1 the second, and so on.`
                    : "Pick the robot asset whose model_0.glb, model_1.glb… are the moving parts."}
                </Hint>
              </>
            )}

            {obj.type === "trajectory" && (
              <>
                <Row>
                  <Select<Field3dTrajectoryStyle>
                    label="Style"
                    value={opts.trajectoryStyle}
                    options={TRAJECTORY_STYLES}
                    onChange={trajectoryStyle => onUpdate(obj.id, { trajectoryStyle })}
                  />
                  <Num
                    label="Width"
                    suffix="m"
                    value={opts.trajectoryWidth}
                    step={0.01}
                    min={0.005}
                    onChange={trajectoryWidth => onUpdate(obj.id, { trajectoryWidth })}
                  />
                </Row>
                <Row>
                  <Num
                    label="Height"
                    suffix="m"
                    value={opts.trajectoryHeight}
                    step={0.01}
                    min={0}
                    onChange={trajectoryHeight => onUpdate(obj.id, { trajectoryHeight })}
                    help="How far above the carpet the path floats. Zero makes it fight the floor for the depth buffer and it starts flickering."
                  />
                  <Check
                    label="Waypoints"
                    checked={opts.showWaypoints}
                    onChange={showWaypoints => onUpdate(obj.id, { showWaypoints })}
                  />
                </Row>
              </>
            )}

            {obj.type === "vision" && (
              <>
                <Select
                  label="Seen from"
                  value={opts.anchorId ?? ""}
                  options={anchorOptions}
                  onChange={id => onUpdate(obj.id, { anchorId: id === "" ? null : id })}
                />
                <Select
                  label="Camera"
                  value={String(opts.visionCameraIndex)}
                  options={[
                    { value: "-1", label: "Robot centre" },
                    ...(robotPack?.config.cameras ?? []).map((camera, index) => ({
                      value: String(index), label: camera.name,
                    })),
                  ]}
                  onChange={value => onUpdate(obj.id, { visionCameraIndex: Number(value) })}
                  help="Where the sight lines start. Cameras come from the robot asset's config.json."
                />
                <Num
                  label="Marker size"
                  suffix="m"
                  value={opts.markerSize}
                  step={0.05}
                  min={0.02}
                  onChange={markerSize => onUpdate(obj.id, { markerSize })}
                />
              </>
            )}

            {obj.type === "gamePiece" && (
              gamePieceNames.length > 0 ? (
                <Select
                  label="Piece"
                  value={String(Math.min(opts.gamePieceIndex, gamePieceNames.length - 1))}
                  options={gamePieceNames.map((name, index) => ({ value: String(index), label: name }))}
                  onChange={value => onUpdate(obj.id, { gamePieceIndex: Number(value) })}
                  help="The models come from the field asset. Publishing this topic also hides the copies the field model ships pre-placed, so you do not see each piece twice."
                />
              ) : (
                <Hint>
                  The current field has no game piece models, so this draws a plain sphere.
                  Install a season field from the Assets tab to get the real shapes.
                </Hint>
              )
            )}

            {(obj.type === "cone" || obj.type === "axes") && (
              <Num
                label="Size"
                suffix="m"
                value={opts.markerSize}
                step={0.05}
                min={0.02}
                onChange={markerSize => onUpdate(obj.id, { markerSize })}
              />
            )}

            {(obj.type === "robot" || obj.type === "ghost") && (
              <>
                <Row>
                  <Num
                    label="Trail"
                    suffix="s"
                    value={opts.trailSeconds}
                    step={0.5}
                    min={0}
                    max={120}
                    onChange={trailSeconds => onUpdate(obj.id, { trailSeconds })}
                    help="Seconds of path kept behind the robot. Zero turns it off. The tab's master switch overrides this."
                  />
                  <Check
                    label="Label"
                    checked={opts.showLabel}
                    onChange={showLabel => onUpdate(obj.id, { showLabel })}
                  />
                </Row>
                {samples > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Hint>{samples.toLocaleString()} trail samples</Hint>
                    <button
                      onClick={() => onClearTrail(obj.id)}
                      style={{
                        marginLeft: "auto", background: "none", border: "none", padding: 0,
                        fontSize: 9.5, color: "var(--mars-accent)", cursor: "pointer",
                      }}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </>
            )}

            {needsAnchor(obj.type) && robots.length === 0 && (
              <Hint>
                This object hangs off a robot and there is none in the list yet — drop the
                robot pose first or it will not be drawn.
              </Hint>
            )}
          </div>
        )
      })}
    </div>
  )
}
