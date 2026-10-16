// 2D Visualizer settings that apply to the WHOLE field, separate from the
// objects panel: which model is drawn, how big the chassis is and which help
// layers are on.

import { FieldSettings, RobotRenderMode } from "../../../store/appStore"
import { fileNameOf } from "../../../utils/field/robotModel"
import { SpriteStatus } from "../../../hooks/useRobotSprite"
import { RobotSprite } from "../../../utils/field/robotSprite"
import {
  Check, ErrorNote, Hint, Num, PanelButton, Row, Section, Select, Slider,
} from "../three/PanelFields"

interface Props {
  settings: FieldSettings
  onUpdate: (updates: Partial<FieldSettings>) => void
  sprite: RobotSprite | null
  spriteScale: number
  status: SpriteStatus
  error: string | null
  onPickModel: () => void
  onClearModel: () => void
  /** Samples accumulated across all objects. */
  totalSamples: number
  onClearHistory: () => void
}

export default function FieldViewPanel({
  settings, onUpdate, sprite, spriteScale, status, error,
  onPickModel, onClearModel, totalSamples, onClearHistory,
}: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      <Section title="Robot" defaultOpen svg="robot.svg" svgFallback="part.svg" icon="ti-robot">
        <Select<RobotRenderMode>
          label="Drawn as"
          value={settings.robotRender}
          options={[
            { value: "icon", label: "Icon (chassis + bumpers)" },
            { value: "model", label: "3D model, seen from above" },
          ]}
          onChange={robotRender => onUpdate({ robotRender })}
          help="This is the default for every robot and ghost. Each object can still override it from the Objects tab."
        />

        {settings.robotRender === "model" && (
          <>
            <Row>
              <PanelButton
                label={status === "loading" ? "Loading…" : settings.robotModelPath ? "Change…" : "Choose model…"}
                svg="import-model.svg"
                icon="ti-file-3d"
                disabled={status === "loading"}
                onClick={onPickModel}
              />
              {settings.robotModelPath && (
                <PanelButton svg="delete.svg" icon="ti-x" title="Remove the model" onClick={onClearModel} />
              )}
            </Row>

            <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5, wordBreak: "break-all" }}>
              {settings.robotModelPath
                ? settings.robotModelName ?? fileNameOf(settings.robotModelPath)
                : "No model loaded — the icon is drawn instead. STL, GLB or self-contained glTF."}
            </div>

            {status === "ready" && sprite && (
              <Hint>
                {sprite.triangles.toLocaleString()} triangles · footprint{" "}
                {(sprite.spanX * spriteScale).toFixed(2)} × {(sprite.spanY * spriteScale).toFixed(2)} m
              </Hint>
            )}

            {status === "error" && error && <ErrorNote>{error}</ErrorNote>}

            <Check
              label="Fit to chassis length"
              checked={settings.robotModelAutoFit}
              onChange={robotModelAutoFit => onUpdate({ robotModelAutoFit })}
              help="Scales the model until its footprint matches the LENGTH below, whatever units the file was drawn in. Turn it off only if your CAD is already in metres and you want the real size."
            />
            {!settings.robotModelAutoFit && (
              <Num
                label="Scale"
                step={0.0001}
                min={0.00001}
                value={settings.robotModelScale}
                onChange={robotModelScale => robotModelScale > 0 && onUpdate({ robotModelScale })}
                help="File units to metres. 0.001 turns millimetres into metres; 0.0254 turns inches into metres."
              />
            )}

            <Slider
              label="Rotation"
              min={-180}
              max={180}
              step={15}
              value={settings.robotModelRotation}
              format={v => `${v}°`}
              onChange={robotModelRotation => onUpdate({ robotModelRotation })}
              help="Turns the model until its FRONT points along +X. Most CAD exports come out facing some other way, and the heading arrow would be wrong without this."
            />

            <Check
              label="Override colour"
              checked={settings.robotModelColor !== null}
              onChange={on => onUpdate({ robotModelColor: on ? "#8f9299" : null })}
              help="STL files carry no colour at all, so they come out grey. A GLB keeps its own materials unless you turn this on."
            />
            {settings.robotModelColor !== null && (
              <input
                type="color"
                value={settings.robotModelColor}
                onChange={e => onUpdate({ robotModelColor: e.target.value })}
                style={{
                  width: "100%", height: 24, padding: 0, cursor: "pointer",
                  border: "1px solid var(--border-main)", background: "var(--bg-input)", borderRadius: 2,
                }}
              />
            )}

            <Check
              label="Bumper outline"
              checked={settings.showBumpers}
              onChange={showBumpers => onUpdate({ showBumpers })}
              help="Draws the object's colour around the model. Two robots in the same CAD are impossible to tell apart without it."
            />
          </>
        )}

        <Row>
          <Num
            label="Length"
            suffix="m"
            step={0.05}
            min={0.1}
            value={settings.robotSizeMeters}
            onChange={robotSizeMeters => robotSizeMeters > 0 && onUpdate({ robotSizeMeters })}
            help="Bumper to bumper along +X (the direction the robot faces). It also sets where the swerve modules are drawn."
          />
          <Num
            label="Width"
            suffix="m"
            step={0.05}
            min={0.1}
            value={settings.robotWidthMeters}
            onChange={robotWidthMeters => robotWidthMeters > 0 && onUpdate({ robotWidthMeters })}
          />
        </Row>
      </Section>

      <Section title="View" defaultOpen svg="visualizer2d.svg" icon="ti-map-2">
        <Check
          label="Red alliance view"
          checked={settings.allianceFlip}
          onChange={allianceFlip => onUpdate({ allianceFlip })}
          help="Spins the field half a turn so it matches what the red driver station sees. The numbers do not change — only the picture."
        />
        <Check
          label="Grid"
          checked={settings.showGrid}
          onChange={showGrid => onUpdate({ showGrid })}
        />
        {settings.showGrid && (
          <Slider
            label="Grid spacing"
            min={0.25}
            max={2}
            step={0.25}
            value={settings.gridSpacing}
            format={v => `${v} m`}
            onChange={gridSpacing => onUpdate({ gridSpacing })}
          />
        )}
        <Check
          label="Origin axes"
          checked={settings.showAxes}
          onChange={showAxes => onUpdate({ showAxes })}
          help="Red +X and green +Y at the robot's (0, 0). If the red arrow does not point at the opposite alliance, the coordinate system in the header is the wrong one."
        />
        <Check
          label="Cursor coordinates"
          checked={settings.showCursor}
          onChange={showCursor => onUpdate({ showCursor })}
          help="Reads out the point under the mouse in the SAME frame the robot publishes, so you can copy a position straight into your code."
        />
        <Check
          label="Object labels"
          checked={settings.showLabels}
          onChange={showLabels => onUpdate({ showLabels })}
          help="Master switch. Which objects actually carry a label is set per object."
        />
      </Section>

      <Section title="Trails" defaultOpen svg="trail.svg" svgFallback="sweep.svg" icon="ti-line" badge={settings.showTrails ? undefined : "off"}>
        <Check
          label="Show trails"
          checked={settings.showTrails}
          onChange={showTrails => onUpdate({ showTrails })}
        />
        {settings.showTrails && (
          <Slider
            label="Default length"
            min={0.5}
            max={30}
            step={0.5}
            value={settings.trailSeconds}
            format={v => `${v} s`}
            onChange={trailSeconds => onUpdate({ trailSeconds })}
            help="Used by every object that has not set its own trail length."
          />
        )}
      </Section>

      <Section title="Collected data" svg="samples.svg" svgFallback="data-directory.svg" icon="ti-database" badge={totalSamples > 0 ? totalSamples.toLocaleString() : undefined}>
        <Hint>
          Trails and heat maps are built from what arrives over NetworkTables while this tab is
          open — nothing is read from disk. Clearing starts both over.
        </Hint>
        <PanelButton label="Clear all samples" svg="delete.svg" icon="ti-eraser" onClick={onClearHistory} danger />
      </Section>
    </div>
  )
}
