// The Mechanism 3D's scene settings, the animation routine editor, and the
// configuration's import/export.
//
// The exported config is a self-contained JSON (parts + joints + routines +
// view settings): the idea is to build the mechanism once, keep it in the
// team's repository and have anyone open it without placing anything again.

import { useState } from "react"
import {
  Mechanism3dEasing, Mechanism3dGizmo, Mechanism3dPart, Mechanism3dRoutine,
  Mechanism3dRoutineStep, Mechanism3dSettings, Swerve3dProjection,
} from "../../../store/appStore"
import { routineDuration, unitLabel } from "../../../utils/mechanism/mechanism3d"
import {
  Section, Row, Num, Text, Check, Select, Slider, PanelButton, Hint, ErrorNote,
  FieldLabel, PanelIcon, inputStyle,
} from "../three/PanelFields"

interface Props {
  settings: Mechanism3dSettings
  parts: Mechanism3dPart[]
  onUpdate: (updates: Partial<Mechanism3dSettings>) => void
  onExport: () => void
  onImport: () => void
  /** Imports from the text pasted in the box; returns the error if it fails. */
  onImportText: (text: string) => string | null
  /** The current JSON, to copy or review it. */
  configText: string
  /** Message from the last import/export operation. */
  status: { kind: "ok" | "error"; message: string } | null

  selectedPartId: string | null
  onAddRoutine: () => void
  onRemoveRoutine: (id: string) => void
  onUpdateRoutine: (id: string, updates: Partial<Mechanism3dRoutine>) => void
  onAddStep: (routineId: string, partId: string) => void
  onUpdateStep: (routineId: string, stepId: string, updates: Partial<Mechanism3dRoutineStep>) => void
  onRemoveStep: (routineId: string, stepId: string) => void
}

const HELP = {
  name: "Just a label for the mechanism. It travels inside the exported JSON and shows in the tab header.",
  gizmo: "Off = clicking only selects. Move and Rotate drag the selected part's placement inside its parent. Pivot drags the orange cross, which is the point the part spins around.",
  space: "Local = the gizmo arrows follow the part's own axes. World = they always point along the floor axes.",
  snap: "Rounds to 1 cm and 5° while you drag, so parts land on round numbers.",
  manual: "Ignores every topic and uses each joint's manual value instead. This is how you sweep a mechanism through its range with no robot connected.",
  projection: "Orthographic drops the perspective, so parallel edges stay parallel — it is what CAD uses to check that two things line up.",
  background: "Dark makes light-coloured meshes and the joint indicators pop; light matches the rest of the app.",
  floor: "A grid on the z = 0 plane, to judge heights and distances against something.",
  gridCell: "Distance between grid lines, in metres.",
  worldAxes: "The triad at the origin: red = X forward, green = Y left, blue = Z up. Those are the same axes the position and axis fields use.",
  jointAxes: "Draws a ring on every joint that spins and a rail on every joint that slides, with the travelled part highlighted — so you can tell at a glance which joint is which and how far it has moved.",
  jointScale: "Size of those rings and rails. Turn it down for a small wrist, up for a whole robot.",
  jointLimits: "Shades the span between Min and Max on the indicator and puts a stop at each end, so you can see how much travel is left.",
  labels: "Each part's name floating over it in the scene.",
  bounds: "A blue box around the selected part, so you know what you are about to move.",
  config: "A self-contained JSON with every part, joint, routine and view setting. Model files are referenced by absolute path, so keep them where they are (or re-pick them after importing on another machine).",
  routines: "A routine animates joints on its own, with no robot connected — for a demo at a stand, for checking a path does not collide with itself, or for recording a clip. Steps run in PARALLEL on one timeline, each with its own start time, so you can stagger them into a sequence or have several move at once.",
  step: "One joint moving from one value to another. The values are in that joint's own units.",
  stepTiming: "Start = when it begins, counted from the start of the routine. Duration = how long the trip takes. A ping-pong step takes twice as long in total, because it comes back.",
  pingPong: "Goes to the end value and then back to the start. This is the classic side-to-side sweep.",
  easing: "Linear moves at a constant rate. Smooth eases in and out, which stops a repeating motion from looking robotic.",
  loop: "Starts over when the routine finishes.",
}

const EASINGS: { value: Mechanism3dEasing; label: string }[] = [
  { value: "smooth", label: "Smooth (ease in/out)" },
  { value: "linear", label: "Linear" },
]

export default function Mechanism3dScenePanel({
  settings, parts, onUpdate, onExport, onImport, onImportText, configText, status,
  selectedPartId, onAddRoutine, onRemoveRoutine, onUpdateRoutine,
  onAddStep, onUpdateStep, onRemoveStep,
}: Props) {
  const [pasted, setPasted] = useState("")
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handlePaste = () => {
    const error = onImportText(pasted)
    setPasteError(error)
    if (!error) setPasted("")
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(configText).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) },
      () => setCopied(false),
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Section title="Mechanism" defaultOpen svg="mechanism3d.svg" icon="ti-3d-cube-sphere">
        <Text
          label="Name"
          value={settings.name}
          placeholder="Arm, Elevator…"
          help={HELP.name}
          onChange={v => onUpdate({ name: v })}
        />
        <Hint>{parts.length} {parts.length === 1 ? "part" : "parts"}.</Hint>
      </Section>

      <Section title="Routines" defaultOpen icon="ti-movie" help={HELP.routines}>
        <RoutineEditor
          settings={settings}
          parts={parts}
          selectedPartId={selectedPartId}
          onUpdate={onUpdate}
          onAddRoutine={onAddRoutine}
          onRemoveRoutine={onRemoveRoutine}
          onUpdateRoutine={onUpdateRoutine}
          onAddStep={onAddStep}
          onUpdateStep={onUpdateStep}
          onRemoveStep={onRemoveStep}
        />
      </Section>

      <Section title="Editing" defaultOpen icon="ti-pointer">
        <Select<Mechanism3dGizmo>
          label="Gizmo"
          value={settings.gizmo}
          options={[
            { value: "off", label: "Off — click to select only" },
            { value: "translate", label: "Move the part" },
            { value: "rotate", label: "Rotate the part" },
            { value: "pivot", label: "Move the rotation centre" },
          ]}
          help={HELP.gizmo}
          onChange={v => onUpdate({ gizmo: v })}
        />
        <Row>
          <Select
            label="Space"
            value={settings.gizmoSpace}
            options={[
              { value: "local", label: "Local" },
              { value: "world", label: "World" },
            ]}
            help={HELP.space}
            onChange={v => onUpdate({ gizmoSpace: v })}
          />
          <div style={{ flex: 1, display: "flex", alignItems: "flex-end", paddingBottom: 4 }}>
            <Check label="Snap" checked={settings.gizmoSnap} onChange={v => onUpdate({ gizmoSnap: v })} help={HELP.snap} />
          </div>
        </Row>
        <Check
          label="Manual override"
          checked={settings.manualOverride}
          onChange={v => onUpdate({ manualOverride: v })}
          help={HELP.manual}
        />
      </Section>

      <Section title="Joint indicators" defaultOpen svg="joint.svg" icon="ti-rotate-360">
        <Check
          label="Show indicators"
          checked={settings.showJointAxes}
          onChange={v => onUpdate({ showJointAxes: v })}
          help={HELP.jointAxes}
        />
        <Hint>Purple ring = spins · teal rail = slides · orange cross = rotation centre.</Hint>
        <Slider
          label="Indicator size"
          value={settings.jointScale}
          min={0.2}
          max={4}
          step={0.1}
          format={v => `${v.toFixed(1)}×`}
          help={HELP.jointScale}
          onChange={v => onUpdate({ jointScale: v })}
        />
        <Check
          label="Show travel limits"
          checked={settings.showJointLimits}
          onChange={v => onUpdate({ showJointLimits: v })}
          help={HELP.jointLimits}
        />
      </Section>

      <Section title="Scene" svg="scene.svg" icon="ti-adjustments">
        <Select<Swerve3dProjection>
          label="Projection"
          value={settings.projection}
          options={[
            { value: "perspective", label: "Perspective" },
            { value: "orthographic", label: "Orthographic" },
          ]}
          help={HELP.projection}
          onChange={v => onUpdate({ projection: v })}
        />
        <Select
          label="Background"
          value={settings.background}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          help={HELP.background}
          onChange={v => onUpdate({ background: v })}
        />
        <Check label="Floor grid" checked={settings.showFloor} onChange={v => onUpdate({ showFloor: v })} help={HELP.floor} />
        {settings.showFloor && (
          <Num
            label="Grid cell"
            suffix="m"
            value={settings.gridCell}
            step={0.05}
            min={0.02}
            help={HELP.gridCell}
            onChange={v => onUpdate({ gridCell: Math.max(0.02, v) })}
          />
        )}
        <Check label="World axes" checked={settings.showWorldAxes} onChange={v => onUpdate({ showWorldAxes: v })} help={HELP.worldAxes} />
        <Check label="Part labels" checked={settings.showPartLabels} onChange={v => onUpdate({ showPartLabels: v })} help={HELP.labels} />
        <Check label="Selection box" checked={settings.showBounds} onChange={v => onUpdate({ showBounds: v })} help={HELP.bounds} />
      </Section>

      <Section title="Config file" defaultOpen icon="ti-file-code" help={HELP.config}>
        <Row>
          <PanelButton label="Export…" icon="ti-download" onClick={onExport} />
          <PanelButton label="Import…" icon="ti-upload" onClick={onImport} />
        </Row>

        {status && (
          status.kind === "error"
            ? <ErrorNote>{status.message}</ErrorNote>
            : <Hint>{status.message}</Hint>
        )}

        <PanelButton
          label={copied ? "Copied" : "Copy JSON"}
          icon={copied ? "ti-check" : "ti-clipboard"}
          onClick={handleCopy}
        />

        <div>
          <FieldLabel
            label="Paste a config"
            help="The same JSON as the exported file. Useful to load one a teammate sent over chat without saving it to disk first."
          />
          <textarea
            value={pasted}
            onChange={e => { setPasted(e.target.value); setPasteError(null) }}
            placeholder='{ "format": "mars-mechanism3d", … }'
            rows={4}
            style={{ ...inputStyle, width: "100%", fontFamily: "monospace", fontSize: 9.5, resize: "vertical" }}
          />
        </div>
        {pasteError && <ErrorNote>{pasteError}</ErrorNote>}
        <PanelButton label="Load pasted config" onClick={handlePaste} disabled={pasted.trim().length === 0} />
        <Hint>Importing REPLACES every part in this tab.</Hint>
      </Section>
    </div>
  )
}

// --- Editor de rutinas -------------------------------------------------------------

function RoutineEditor({
  settings, parts, selectedPartId, onUpdate, onAddRoutine, onRemoveRoutine,
  onUpdateRoutine, onAddStep, onUpdateStep, onRemoveStep,
}: {
  settings: Mechanism3dSettings
  parts: Mechanism3dPart[]
  selectedPartId: string | null
  onUpdate: (updates: Partial<Mechanism3dSettings>) => void
  onAddRoutine: () => void
  onRemoveRoutine: (id: string) => void
  onUpdateRoutine: (id: string, updates: Partial<Mechanism3dRoutine>) => void
  onAddStep: (routineId: string, partId: string) => void
  onUpdateStep: (routineId: string, stepId: string, updates: Partial<Mechanism3dRoutineStep>) => void
  onRemoveStep: (routineId: string, stepId: string) => void
}) {
  const routine = settings.routines.find(r => r.id === settings.activeRoutineId) ?? null

  if (settings.routines.length === 0) {
    return (
      <>
        <Hint>
          No routines yet. The quickest way in is the <b>Animate</b> button in the bar above the scene:
          it builds a back-and-forth sweep of the selected joint that you can then edit here.
        </Hint>
        <PanelButton label="New empty routine" icon="ti-plus" onClick={onAddRoutine} />
      </>
    )
  }

  return (
    <>
      <Row>
        <Select
          label="Routine"
          value={routine?.id ?? ""}
          options={settings.routines.map(r => ({ value: r.id, label: r.name }))}
          onChange={v => onUpdate({ activeRoutineId: v })}
        />
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, paddingBottom: 1 }}>
          <PanelButton icon="ti-plus" title="New routine" onClick={onAddRoutine} />
          <PanelButton
            svg="delete.svg"
            icon="ti-trash"
            title="Delete this routine"
            danger
            disabled={!routine}
            onClick={() => routine && onRemoveRoutine(routine.id)}
          />
        </div>
      </Row>

      {routine && (
        <>
          <Text label="Routine name" value={routine.name} onChange={v => onUpdateRoutine(routine.id, { name: v })} />
          <Row>
            <Check
              label="Loop"
              checked={routine.loop}
              onChange={v => onUpdateRoutine(routine.id, { loop: v })}
              help={HELP.loop}
            />
            <Hint>{(routineDuration(routine) / 1000).toFixed(1)} s total</Hint>
          </Row>

          {routine.steps.length === 0 && <Hint>No steps yet. Add one for the part you want to move.</Hint>}

          {routine.steps.map((step, index) => (
            <StepEditor
              key={step.id}
              index={index}
              step={step}
              part={parts.find(p => p.id === step.partId) ?? null}
              onUpdate={updates => onUpdateStep(routine.id, step.id, updates)}
              onRemove={() => onRemoveStep(routine.id, step.id)}
            />
          ))}

          <PanelButton
            label={selectedPartId ? "Add step for selected part" : "Select a part to add a step"}
            icon="ti-plus"
            disabled={!selectedPartId}
            onClick={() => selectedPartId && onAddStep(routine.id, selectedPartId)}
          />
        </>
      )}
    </>
  )
}

function StepEditor({
  index, step, part, onUpdate, onRemove,
}: {
  index: number
  step: Mechanism3dRoutineStep
  part: Mechanism3dPart | null
  onUpdate: (updates: Partial<Mechanism3dRoutineStep>) => void
  onRemove: () => void
}) {
  const units = part ? unitLabel(part.joint.units) : ""

  return (
    <div style={{
      border: "1px solid var(--border-main)", borderRadius: 3, padding: "7px 8px",
      display: "flex", flexDirection: "column", gap: 6,
      background: part ? "var(--bg-input)" : "var(--status-error-bg)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 600 }}>{index + 1}</span>
        <PanelIcon
          svg={part ? "joint-revolute.svg" : "status-error.svg"}
          fallback={part ? "ti-rotate-360" : "ti-alert-triangle"}
          size={12}
        />
        <span style={{
          flex: 1, fontSize: 10.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: part ? "var(--text-primary)" : "var(--status-error)",
        }}>
          {part ? part.name : "part deleted"}
        </span>
        <button
          onClick={onRemove}
          title="Remove this step"
          style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, padding: 0, lineHeight: 1 }}
        >
          <i className="ti ti-x" aria-hidden />
        </button>
      </div>

      <Row>
        <Num label="From" suffix={units} value={step.from} step={1} help={HELP.step} onChange={v => onUpdate({ from: v })} />
        <Num label="To" suffix={units} value={step.to} step={1} onChange={v => onUpdate({ to: v })} />
      </Row>
      <Row>
        <Num
          label="Start"
          suffix="ms"
          value={step.startMs}
          step={100}
          min={0}
          help={HELP.stepTiming}
          onChange={v => onUpdate({ startMs: Math.max(0, v) })}
        />
        <Num
          label="Duration"
          suffix="ms"
          value={step.durationMs}
          step={100}
          min={1}
          onChange={v => onUpdate({ durationMs: Math.max(1, v) })}
        />
      </Row>
      <Row>
        <Select<Mechanism3dEasing>
          label="Easing"
          value={step.easing}
          options={EASINGS}
          help={HELP.easing}
          onChange={v => onUpdate({ easing: v })}
        />
        <div style={{ flex: 1, display: "flex", alignItems: "flex-end", paddingBottom: 4 }}>
          <Check
            label="Back and forth"
            checked={step.pingPong}
            onChange={v => onUpdate({ pingPong: v })}
            help={HELP.pingPong}
          />
        </div>
      </Row>
    </div>
  )
}
