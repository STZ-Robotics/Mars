import { FieldObjectConfig, FieldObjectType, FieldSettings, SWERVE_ARRANGEMENTS } from "../../../store/appStore"
import {
  FIELD_OBJECT_HELP, FIELD_OBJECT_ICONS, FIELD_OBJECT_LABELS, FIELD_OBJECT_TYPES,
  needsRobotAnchor, resolveObjectOptions,
} from "../../../utils/field/fieldObjects"
import {
  Check, Hint, IconToggle, Num, PanelButton, PanelIcon, Select, Slider,
} from "../three/PanelFields"

interface Props {
  objects: FieldObjectConfig[]
  settings: FieldSettings
  /** Samples accumulated per object, for the trails and the heat map. */
  sampleCounts: Record<string, number>
  onUpdate: (id: string, updates: Partial<FieldObjectConfig>) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  onClearHistory: (id: string) => void
}

export default function FieldObjectPanel({
  objects, settings, sampleCounts, onUpdate, onDuplicate, onRemove, onClearHistory,
}: Props) {
  if (objects.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
        No objects yet. Drag a <i>Pose2d</i>, <i>Pose2d[]</i>, a <i>double[]</i> of [x, y, θ]
        triplets or a whole <i>Field2d</i> table from the Data Directory onto the field.
        <br /><br />
        A <i>SwerveModuleState[]</i> works too — it draws the module vectors on the robot.
        <br /><br />
        The same topic can be added as many times as you like: drop it twice to see one copy
        as the chassis and the other as a heat map.
      </div>
    )
  }

  // The robot-anchored types have no pose of their own. If there is no robot in
  // the list they are not drawn, and saying it here saves the time spent
  // believing the topic is wrong.
  const hasRobot = objects.some(o => o.type === "robot" && o.hidden !== true)

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {objects.map(obj => {
        const opts = resolveObjectOptions(obj, settings)
        const samples = sampleCounts[obj.id] ?? 0
        const icon = FIELD_OBJECT_ICONS[obj.type]

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
                title="Add the same topic again — a second view of it, drawn another way"
                onClick={() => onDuplicate(obj.id)}
              />
              <IconToggle
                svg="delete.svg"
                icon="ti-x"
                active={false}
                title="Remove object"
                onClick={() => onRemove(obj.id)}
              />
            </div>

            <div style={{ fontSize: 9.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {obj.topicType}
            </div>

            <Select<FieldObjectType>
              label="Type"
              value={obj.type}
              options={FIELD_OBJECT_TYPES.map(t => ({ value: t, label: FIELD_OBJECT_LABELS[t] }))}
              onChange={type => onUpdate(obj.id, { type })}
              help={FIELD_OBJECT_HELP[obj.type]}
            />

            {needsRobotAnchor(obj.type) && !hasRobot && (
              <Hint>Add a <b>Robot</b> object — this one is drawn relative to it.</Hint>
            )}

            {(obj.type === "robot" || obj.type === "ghost") && (
              <Check
                label="Use 3D model"
                checked={opts.useModel}
                onChange={useModel => onUpdate(obj.id, { useModel })}
                help="Draws the STL/GLB from the Field tab seen from above instead of the generic chassis. Without a model loaded it falls back to the icon."
              />
            )}

            {obj.type === "arrow" && (
              <>
                <Select<"front" | "center" | "back">
                  label="Anchor"
                  value={opts.arrowAnchor}
                  options={[
                    { value: "center", label: "Centre" },
                    { value: "front", label: "Tip at the pose" },
                    { value: "back", label: "Tail at the pose" },
                  ]}
                  onChange={arrowAnchor => onUpdate(obj.id, { arrowAnchor })}
                  help="Where the pose sits along the arrow. 'Tail at the pose' is the one you want for a velocity vector leaving the robot."
                />
                <Num
                  label="Length"
                  suffix="m"
                  step={0.05}
                  min={0.05}
                  value={opts.arrowLength}
                  onChange={arrowLength => onUpdate(obj.id, { arrowLength })}
                />
              </>
            )}

            {obj.type === "trajectory" && (
              <>
                <Select<"solid" | "dashed" | "points" | "gradient">
                  label="Style"
                  value={opts.trajectoryStyle}
                  options={[
                    { value: "solid", label: "Solid line" },
                    { value: "dashed", label: "Dashed" },
                    { value: "points", label: "Points only" },
                    { value: "gradient", label: "Fades from start" },
                  ]}
                  onChange={trajectoryStyle => onUpdate(obj.id, { trajectoryStyle })}
                  help="'Fades from start' washes out the beginning of the path, so you can see which way it runs without adding arrows."
                />
                <Slider
                  label="Width"
                  min={1}
                  max={8}
                  step={0.5}
                  value={opts.trajectoryWidth}
                  format={v => `${v} px`}
                  onChange={trajectoryWidth => onUpdate(obj.id, { trajectoryWidth })}
                />
                <Check
                  label="Waypoints"
                  checked={opts.showWaypoints}
                  onChange={showWaypoints => onUpdate(obj.id, { showWaypoints })}
                  help="A dot on every pose of the array — that is where the path generator actually sampled."
                />
                <Check
                  label="Heading arrows"
                  checked={opts.showHeading}
                  onChange={showHeading => onUpdate(obj.id, { showHeading })}
                  help="A dozen arrows spread along the path showing where the robot is meant to be POINTING, which on a swerve has nothing to do with the direction of travel."
                />
              </>
            )}

            {obj.type === "heatmap" && (
              <>
                <Slider
                  label="Spot radius"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={opts.heatmapRadius}
                  format={v => `${v.toFixed(2)} m`}
                  onChange={heatmapRadius => onUpdate(obj.id, { heatmapRadius })}
                />
                <Slider
                  label="Resolution"
                  min={0.05}
                  max={0.5}
                  step={0.05}
                  value={opts.heatmapCell}
                  format={v => `${v.toFixed(2)} m`}
                  onChange={heatmapCell => onUpdate(obj.id, { heatmapCell })}
                />
                <Hint>
                  {samples.toLocaleString()} samples collected. The map shows where the robot
                  spends TIME, so standing still builds up a hot spot.
                </Hint>
                <PanelButton
                  label="Clear samples"
                  svg="delete.svg"
                  icon="ti-eraser"
                  onClick={() => onClearHistory(obj.id)}
                />
              </>
            )}

            {obj.type === "target" && (
              <>
                <Check
                  label="Line from the robot"
                  checked={opts.targetLines}
                  onChange={targetLines => onUpdate(obj.id, { targetLines })}
                />
                <Check
                  label="Distance and bearing"
                  checked={opts.targetLabels}
                  onChange={targetLabels => onUpdate(obj.id, { targetLabels })}
                  help="The bearing is measured from the robot's FRONT, so it is the error you have to null out to aim — not an absolute field angle."
                />
              </>
            )}

            {obj.type === "swerve" && (
              <>
                <Select
                  label="Arrangement"
                  value={opts.swerveArrangement}
                  options={SWERVE_ARRANGEMENTS.map(a => ({ value: a.key, label: a.label }))}
                  onChange={swerveArrangement => onUpdate(obj.id, { swerveArrangement })}
                  help="The order the modules come in your array. Wrong order shows up as vectors that swap corners when the robot turns."
                />
                <Num
                  label="Max speed"
                  suffix="m/s"
                  step={0.1}
                  min={0.1}
                  value={opts.swerveMaxSpeed}
                  onChange={swerveMaxSpeed => onUpdate(obj.id, { swerveMaxSpeed })}
                />
              </>
            )}

            {obj.type !== "heatmap" && obj.type !== "trajectory" && obj.type !== "swerve" && (
              <>
                <Slider
                  label="Trail"
                  min={0}
                  max={30}
                  step={0.5}
                  value={opts.trailSeconds}
                  format={v => (v === 0 ? "off" : `${v} s`)}
                  onChange={trailSeconds => onUpdate(obj.id, { trailSeconds })}
                  help="Seconds of path drawn behind the object. Turn the master switch off in the Field tab to hide every trail at once."
                />
                {opts.trailSeconds > 0 && (
                  <>
                    <Check
                      label="Custom trail colour"
                      checked={opts.trailColor !== null}
                      onChange={on => onUpdate(obj.id, { trailColor: on ? obj.color : null })}
                      help="By default the trail takes the object's colour. Giving it its own is what lets you tell the chassis apart from where it has been."
                    />
                    {opts.trailColor !== null && (
                      <input
                        type="color"
                        value={opts.trailColor}
                        onChange={e => onUpdate(obj.id, { trailColor: e.target.value })}
                        style={{
                          width: "100%", height: 22, padding: 0, cursor: "pointer",
                          border: "1px solid var(--border-main)", background: "var(--bg-input)", borderRadius: 2,
                        }}
                      />
                    )}
                  </>
                )}
              </>
            )}

            <Check
              label="Label"
              checked={opts.showLabel}
              onChange={showLabel => onUpdate(obj.id, { showLabel })}
              help="Floats the object's name and its pose next to it. The master switch is in the Field tab."
            />

            {obj.type !== "heatmap" && (
              <Slider
                label="Opacity"
                min={0.1}
                max={1}
                step={0.05}
                value={opts.opacity}
                format={v => `${Math.round(v * 100)}%`}
                onChange={opacity => onUpdate(obj.id, { opacity })}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
