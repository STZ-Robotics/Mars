// Configuration panel of the Swerve 3D view: which model is loaded, how it is
// oriented, and where each module is drawn.
//
// The module positions can be edited by hand because the rectangular chassis is
// not always enough: there are drivetrains with the modules tucked inwards, or
// with three modules, or with the center of rotation offset.

import {
  Swerve3dSettings, Swerve3dModulePlacement, Swerve3dProjection, SwerveSettings,
} from "../../../store/appStore"
import { LoadedModel, fileNameOf } from "../../../utils/field/robotModel"
import {
  Section, Row, Num, Check, Select, Slider, Hint, ErrorNote, buttonStyle,
} from "../three/PanelFields"

export type ModelStatus = "empty" | "loading" | "ready" | "error"

interface Props {
  view: Swerve3dSettings
  settings: SwerveSettings
  onUpdate: (updates: Partial<Swerve3dSettings>) => void
  model: LoadedModel | null
  status: ModelStatus
  error: string | null
  onPickModel: () => void
  onClearModel: () => void
  /** Puts the four corners back according to frameLength/frameWidth. */
  onResetModules: () => void
}

const CORNER_LABELS = ["FL", "FR", "BL", "BR"]

export default function Swerve3dConfigPanel({
  view, settings, onUpdate, model, status, error, onPickModel, onClearModel, onResetModules,
}: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Section title="Robot model" defaultOpen>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onPickModel} style={buttonStyle} disabled={status === "loading"}>
            {status === "loading" ? "Loading…" : view.modelPath ? "Change…" : "Choose model…"}
          </button>
          {view.modelPath && (
            <button onClick={onClearModel} style={{ ...buttonStyle, flex: "0 0 auto" }} title="Remove the model">
              <i className="ti ti-x" aria-hidden />
            </button>
          )}
        </div>

        <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5, wordBreak: "break-all" }}>
          {view.modelPath
            ? view.modelName ?? fileNameOf(view.modelPath)
            : "No model loaded — a generic chassis is drawn instead. STL, GLB or self-contained glTF."}
        </div>

        {status === "ready" && model && (
          <div style={{ fontSize: 9.5, color: "var(--text-muted)" }}>
            {model.format.toUpperCase()} · {model.triangles.toLocaleString()} triangles ·{" "}
            {model.size.x.toFixed(2)} × {model.size.y.toFixed(2)} × {model.size.z.toFixed(2)} file units
          </div>
        )}

        {status === "error" && error && <ErrorNote>{error}</ErrorNote>}

        <Check
          label="Fit to frame size"
          help="Scales the model so its footprint matches the LENGTH and WIDTH in the header, whatever units the file was drawn in."
          checked={view.modelAutoFit}
          onChange={v => onUpdate({ modelAutoFit: v })}
        />
        {!view.modelAutoFit && (
          <Num
            label="Scale"
            value={view.modelScale}
            step={0.001}
            min={0.00001}
            help="Multiplies the file units. 0.001 turns millimetres into metres; 0.0254 turns inches into metres."
            onChange={v => onUpdate({ modelScale: v > 0 ? v : view.modelScale })}
          />
        )}

        <Row>
          <Num label="Rot X" value={view.modelRotX} step={15} suffix="°" onChange={v => onUpdate({ modelRotX: v })} />
          <Num label="Rot Y" value={view.modelRotY} step={15} suffix="°" onChange={v => onUpdate({ modelRotY: v })} />
          <Num label="Rot Z" value={view.modelRotZ} step={15} suffix="°" onChange={v => onUpdate({ modelRotZ: v })} />
        </Row>
        <Row>
          <Num label="Off X" value={view.modelOffsetX} step={0.01} suffix="m" onChange={v => onUpdate({ modelOffsetX: v })} />
          <Num label="Off Y" value={view.modelOffsetY} step={0.01} suffix="m" onChange={v => onUpdate({ modelOffsetY: v })} />
          <Num label="Off Z" value={view.modelOffsetZ} step={0.01} suffix="m" onChange={v => onUpdate({ modelOffsetZ: v })} />
        </Row>

        <Check
          label="Sit on the floor"
          help="Drops the model until its lowest point touches the floor, applied AFTER the rotations above — which face is the bottom depends on how you turned it."
          checked={view.modelDropToFloor}
          onChange={v => onUpdate({ modelDropToFloor: v })}
        />

        <Check
          label="Override colour"
          checked={view.modelColor !== null}
          onChange={v => onUpdate({ modelColor: v ? "#8f9299" : null })}
        />
        {view.modelColor !== null && (
          <input
            type="color"
            value={view.modelColor}
            onChange={e => onUpdate({ modelColor: e.target.value })}
            style={{ width: "100%", height: 24, padding: 0, border: "1px solid var(--border-main)", background: "var(--bg-input)", borderRadius: 2, cursor: "pointer" }}
          />
        )}

        <Slider
          label="Opacity"
          value={view.modelOpacity}
          min={0.05}
          max={1}
          step={0.05}
          format={v => `${Math.round(v * 100)}%`}
          onChange={v => onUpdate({ modelOpacity: v })}
        />
        <Check label="Wireframe" checked={view.modelWireframe} onChange={v => onUpdate({ modelWireframe: v })} />
      </Section>

      <Section title="Module placement" defaultOpen>
        <Check
          label="Derive from frame size"
          help="Puts the four modules at the corners of the LENGTH x WIDTH rectangle. Turn it off to place them by hand — for a three-module drive, or modules tucked inside the frame."
          checked={view.moduleAuto}
          onChange={v => onUpdate({ moduleAuto: v })}
        />

        {view.moduleAuto ? (
          <>
            <Num
              label="Wheel height"
              value={view.moduleAutoHeight}
              step={0.01}
              suffix="m"
              help="How high the centre of each wheel sits above the floor, in metres."
              onChange={v => onUpdate({ moduleAutoHeight: v })}
            />
            <Hint>
              {`FL (${(settings.frameLength / 2).toFixed(2)}, ${(settings.frameWidth / 2).toFixed(2)}) · `}
              {`FR (${(settings.frameLength / 2).toFixed(2)}, ${(-settings.frameWidth / 2).toFixed(2)}) · `}
              {`BL (${(-settings.frameLength / 2).toFixed(2)}, ${(settings.frameWidth / 2).toFixed(2)}) · `}
              {`BR (${(-settings.frameLength / 2).toFixed(2)}, ${(-settings.frameWidth / 2).toFixed(2)})`}
            </Hint>
          </>
        ) : (
          <>
            <Hint>Robot frame: +X forward, +Y to the left, +Z up.</Hint>
            {view.modules.map((placement, index) => (
              <ModuleRow
                key={index}
                label={CORNER_LABELS[index] ?? `M${index}`}
                placement={placement}
                onChange={next => onUpdate({
                  modules: view.modules.map((m, i) => i === index ? next : m),
                })}
              />
            ))}
            <button onClick={onResetModules} style={buttonStyle}>Reset from frame size</button>
          </>
        )}

        <Row>
          <Num label="Wheel r" value={view.wheelRadius} step={0.005} suffix="m" onChange={v => onUpdate({ wheelRadius: Math.max(0.005, v) })} />
          <Num label="Wheel w" value={view.wheelWidth} step={0.005} suffix="m" onChange={v => onUpdate({ wheelWidth: Math.max(0.005, v) })} />
        </Row>
      </Section>

      <Section title="Scene">
        <Select<Swerve3dProjection>
          label="Projection"
          value={view.projection}
          options={[
            { value: "perspective", label: "Perspective" },
            { value: "orthographic", label: "Orthographic" },
          ]}
          onChange={v => onUpdate({ projection: v })}
        />

        <Check label="Robot model" checked={view.showModel} onChange={v => onUpdate({ showModel: v })} />
        <Check label="Frame outline" checked={view.showFrame} onChange={v => onUpdate({ showFrame: v })} />
        <Check label="Modules" checked={view.showModules} onChange={v => onUpdate({ showModules: v })} />
        <Check label="Module vectors" checked={view.showVectors} onChange={v => onUpdate({ showVectors: v })} />
        <Check label="Setpoint vectors" checked={view.showSetpoints} onChange={v => onUpdate({ showSetpoints: v })} />
        <Check label="Chassis speed arrow" checked={view.showChassisVector} onChange={v => onUpdate({ showChassisVector: v })} />
        <Check label="Rotation arc (ω)" checked={view.showOmega} onChange={v => onUpdate({ showOmega: v })} />
        <Check label="Corner labels" checked={view.showLabels} onChange={v => onUpdate({ showLabels: v })} />
        <Check label="Robot axes" checked={view.showAxes} onChange={v => onUpdate({ showAxes: v })} />
        <Check label="Floor grid" checked={view.showFloor} onChange={v => onUpdate({ showFloor: v })} />
        <Check
          label="Scrolling floor"
          help="The robot stays put and the floor slides underneath at the chassis speed, so you can see it driving without needing odometry or a field."
          checked={view.motionFloor}
          onChange={v => onUpdate({ motionFloor: v })}
        />
        <Check
          label="Rotate with gyro"
          help="On, the chassis turns with the gyro heading. Off, the chassis holds still and the floor turns instead — the view from inside the robot."
          checked={view.followHeading}
          onChange={v => onUpdate({ followHeading: v })}
        />
        <Check
          label="Speed gradient"
          help="Colours each speed vector green to red by how much of MAX it is using, so saturation is obvious at a glance."
          checked={view.gradient}
          onChange={v => onUpdate({ gradient: v })}
        />
      </Section>
    </div>
  )
}

// --- Piezas de UI -----------------------------------------------------------

function ModuleRow({
  label, placement, onChange,
}: { label: string; placement: Swerve3dModulePlacement; onChange: (next: Swerve3dModulePlacement) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 5 }}>
      <span style={{ width: 20, fontSize: 10, fontWeight: 600, color: "var(--text-muted)", paddingBottom: 4 }}>
        {label}
      </span>
      <Num label="X" value={placement.x} step={0.01} onChange={v => onChange({ ...placement, x: v })} />
      <Num label="Y" value={placement.y} step={0.01} onChange={v => onChange({ ...placement, y: v })} />
      <Num label="Z" value={placement.z} step={0.01} onChange={v => onChange({ ...placement, z: v })} />
    </div>
  )
}
