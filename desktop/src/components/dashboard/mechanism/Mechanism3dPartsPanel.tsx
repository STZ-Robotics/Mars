// The Mechanism 3D's part tree and the selected part's inspector.
//
// It is the equivalent of RViz's "Displays" panel: the hierarchy on top, and
// below every property of whatever is selected. Each joint's topic is bound by
// dragging it from the Data Directory, like in the rest of the app.
//
// Each control carries its "?" button with what it really does: they are
// settings that look alike (model offset vs. center of rotation, placement vs.
// axis) and without saying it explicitly it is impossible to guess which one to
// touch.

import React, { useState } from "react"
import {
  Mechanism3dPart, Mechanism3dJoint, Mechanism3dJointType, Mechanism3dJointUnits,
  Mechanism3dShape, Mechanism3dAnchor,
} from "../../../store/appStore"
import { LoadedModel, fileNameOf } from "../../../utils/field/robotModel"
import {
  ANGULAR_UNITS, LINEAR_UNITS, PartNode, bindJointTopic, buildPartTree, canReparent,
  flattenTree, isJointTopic, jointKind, jointValue, unitLabel,
} from "../../../utils/mechanism/mechanism3d"
import {
  Section, Row, Num, Text, Check, Select, Slider, Vector3Field, PanelButton, Hint,
  ErrorNote, FieldLabel, PanelIcon, IconToggle, inputStyle,
} from "../three/PanelFields"

interface Props {
  parts: Mechanism3dPart[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAdd: (parentId: string | null) => void
  onAddFromFiles: (parentId: string | null) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  onUpdate: (id: string, updates: Partial<Mechanism3dPart>) => void
  onPickModel: (id: string) => void
  /** Creates a back-and-forth routine for the selected part and starts it. */
  onAnimate: () => void
  models: Map<string, LoadedModel>
  modelErrors: Map<string, string>
  loadingPaths: Set<string>
  /** Live value of each bound topic, for the inspector's readout. */
  values: Record<string, any>
  manualOverride: boolean
}

const JOINT_TYPES: { value: Mechanism3dJointType; label: string }[] = [
  { value: "fixed", label: "Fixed — welded to the parent" },
  { value: "revolute", label: "Revolute — spins, with limits" },
  { value: "continuous", label: "Continuous — spins freely" },
  { value: "prismatic", label: "Prismatic — slides" },
  { value: "pose", label: "Pose — placed by a Pose3d / Pose2d" },
]

const SHAPES: { value: Mechanism3dShape; label: string }[] = [
  { value: "box", label: "Box" },
  { value: "cylinder", label: "Cylinder" },
  { value: "sphere", label: "Sphere" },
  { value: "none", label: "Nothing" },
]

const ANCHORS: { value: Mechanism3dAnchor; label: string }[] = [
  { value: "origin", label: "File origin (CAD)" },
  { value: "center", label: "Bounding box centre" },
  { value: "base", label: "Centred, sitting on z = 0" },
]

const HELP = {
  name: "Only a label. It shows in this tree and floating in the scene when part labels are on.",
  parent: "The part this one hangs from. The parent's joint drags it along: rotate the arm and the wrist goes with it. Pick “— world —” to anchor it in place.",
  visible: "Hides the mesh only. The part still moves and still drags its children.",
  locked: "Stops the gizmo from grabbing it by accident. You can still type values by hand.",
  modelFile: "STL, GLB, or a self-contained glTF. The file is referenced by its path on disk, so keep it where it is (or re-pick it after moving it).",
  anchor: "Which point of the FILE lands on the part's origin. CAD exports usually put the origin at the joint, so “File origin” is right most of the time. The other two recentre a mesh that was exported off in a corner.",
  autoFit: "Scales the mesh so its largest side matches the size below. Use it when you don't know what units the file was drawn in.",
  fitSize: "Metres. The longest of the model's three sides ends up this long.",
  scale: "Multiplies the file's units. 0.001 turns millimetres into metres; 0.0254 turns inches into metres.",
  shape: "The primitive drawn while the part has no model file. Useful to block out a mechanism before the CAD is ready.",
  modelOffset: "Moves the MESH inside the part, without touching the joint. If the part then swings in a circle instead of spinning in place, that is what “Rotation centre” below fixes.",
  modelRotation: "Turns the MESH inside the part, in degrees. Use it when the file was exported lying on its side.",
  colour: "Paints the whole part one colour. Off = keep whatever colours the file has (an STL has none, so it comes out grey).",
  opacity: "Below 100% you can see through the part — handy to check that a shaft lines up inside its tube.",
  wireframe: "Draws only the edges of the mesh.",
  origin: "Where this part's joint sits inside its parent, in metres. +X forward (red axis), +Y to the left (green), +Z up (blue) — the same three axes drawn at the floor origin.",
  originRotation: "Turns the part's whole frame inside its parent, in degrees, applied X then Y then Z. It turns the joint axis with it.",
  pivot: "The point the part spins around, in its own coordinates. 0,0,0 = it spins around its origin. Moving this does NOT move the mesh — that is the difference with “Model offset”, which moves the mesh and leaves it orbiting the old centre. Set GIZMO to “Pivot” to drag the orange cross in the scene.",
  jointType: "Fixed = welded. Revolute = spins around the axis, with limits. Continuous = spins with no limits (a wheel, a flywheel). Prismatic = slides along the axis (an elevator). Pose = a published Pose3d/Pose2d places the part outright, all six degrees of freedom.",
  axis: "The direction the part spins around, or slides along, in the part's own frame. 0,0,1 is the blue Z axis. Only the direction counts: 0,0,5 is the same as 0,0,1.",
  topic: "Drag any numeric, boolean or struct topic here from the Data Directory on the left. Without one, the joint just uses its manual value.",
  arrayIndex: "Which element of the array to read (0 = the first one).",
  structField: "Which field of the struct to read. A Rotation2d has one field (0); in a Pose2d, field 2 is the heading.",
  units: "What the published number means, before any scaling. Angles that come out of a WPILib struct are already converted to degrees.",
  jointScale: "Multiplies the published number. The gear ratio goes here: 1/25 turns motor rotations into arm rotations.",
  jointOffset: "Added after the scale, in the units above. This is where an encoder's zero offset goes.",
  invert: "Flips the sign, for when the mechanism moves the right amount in the wrong direction.",
  limits: "Clamps the value so a bad reading cannot fold the model through itself. In the units above; leave empty for no limit. They also draw the shaded travel sector on the joint indicator.",
  manual: "Used when the joint has no topic, and whenever MANUAL is on in the header. Drag it to sweep the mechanism with no robot connected.",
}

export default function Mechanism3dPartsPanel({
  parts, selectedId, onSelect, onAdd, onAddFromFiles, onDuplicate, onRemove, onUpdate,
  onPickModel, onAnimate, models, modelErrors, loadingPaths, values, manualOverride,
}: Props) {
  const nodes = flattenTree(buildPartTree(parts))
  const selected = parts.find(p => p.id === selectedId) ?? null

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 5, padding: "8px 10px", borderBottom: "1px solid var(--border-light)" }}>
        <PanelButton
          label="Add"
          svg="add-part.svg"
          icon="ti-plus"
          title="New part, hanging from the selected one"
          onClick={() => onAdd(selectedId)}
        />
        <PanelButton
          label="Import STL"
          svg="import-model.svg"
          icon="ti-file-3d"
          title="Pick one or more models; each becomes a part"
          onClick={() => onAddFromFiles(selectedId)}
        />
        <PanelButton
          svg="duplicate.svg"
          icon="ti-copy"
          title="Duplicate"
          disabled={!selected}
          onClick={() => selected && onDuplicate(selected.id)}
        />
        <PanelButton
          svg="delete.svg"
          icon="ti-trash"
          title="Delete (its children go too)"
          danger
          disabled={!selected}
          onClick={() => selected && onRemove(selected.id)}
        />
      </div>

      {nodes.length === 0 ? (
        <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.55 }}>
          No parts yet. <b>Import STL</b> loads one or more models as parts, or <b>Add</b> creates an
          empty one you can shape by hand. Then hang parts off each other and give each a joint.
        </div>
      ) : (
        <div style={{ borderBottom: "1px solid var(--border-main)", maxHeight: 200, overflowY: "auto" }}>
          {nodes.map(node => (
            <PartRow
              key={node.part.id}
              node={node}
              selected={node.part.id === selectedId}
              missing={node.part.modelPath !== null && modelErrors.has(node.part.modelPath)}
              onSelect={() => onSelect(node.part.id)}
              onToggleVisible={() => onUpdate(node.part.id, { visible: !node.part.visible })}
              onToggleLocked={() => onUpdate(node.part.id, { locked: !node.part.locked })}
            />
          ))}
        </div>
      )}

      {selected && (
        <PartInspector
          part={selected}
          parts={parts}
          onUpdate={updates => onUpdate(selected.id, updates)}
          onPickModel={() => onPickModel(selected.id)}
          onAnimate={onAnimate}
          model={selected.modelPath ? models.get(selected.modelPath) ?? null : null}
          modelError={selected.modelPath ? modelErrors.get(selected.modelPath) ?? null : null}
          loading={selected.modelPath !== null && loadingPaths.has(selected.modelPath)}
          liveValue={selected.joint.topicName ? values[selected.joint.topicName] : undefined}
          manualOverride={manualOverride}
        />
      )}
    </div>
  )
}

// --- Tree row -----------------------------------------------------------

function PartRow({
  node, selected, missing, onSelect, onToggleVisible, onToggleLocked,
}: {
  node: PartNode
  selected: boolean
  missing: boolean
  onSelect: () => void
  onToggleVisible: () => void
  onToggleLocked: () => void
}) {
  const part = node.part
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
        padding: "3px 8px 3px 0",
        paddingLeft: 8 + node.depth * 13,
        background: selected ? "var(--toolbar-active-bg)" : "transparent",
        borderLeft: selected ? "2px solid var(--mars-accent)" : "2px solid transparent",
      }}
    >
      <PanelIcon
        svg={missing ? "status-error.svg" : part.modelPath ? "part-mesh.svg" : "part-shape.svg"}
        fallback={missing ? "ti-alert-triangle" : part.modelPath ? "ti-file-3d" : "ti-cube"}
        size={13}
        color={missing ? "var(--status-error)" : undefined}
      />
      <span style={{
        flex: 1, fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        color: part.visible ? "var(--text-primary)" : "var(--text-light)",
      }}>
        {part.name}
      </span>
      <JointBadge joint={part.joint} />
      <IconToggle
        svg={part.locked ? "locked.svg" : "unlocked.svg"}
        icon={part.locked ? "ti-lock" : "ti-lock-open"}
        active={part.locked}
        title={part.locked ? "Locked — the gizmo will not move it" : "Lock in place"}
        onClick={onToggleLocked}
      />
      <IconToggle
        svg={part.visible ? "visible.svg" : "hidden.svg"}
        icon={part.visible ? "ti-eye" : "ti-eye-off"}
        active={!part.visible}
        title={part.visible ? "Hide" : "Show"}
        onClick={onToggleVisible}
      />
    </div>
  )
}

const JOINT_ICONS: Record<Mechanism3dJointType, { svg: string; fallback: string; color: string }> = {
  fixed: { svg: "joint-fixed.svg", fallback: "ti-link", color: "#6b6b70" },
  revolute: { svg: "joint-revolute.svg", fallback: "ti-rotate-360", color: "#7c3aed" },
  continuous: { svg: "joint-revolute.svg", fallback: "ti-rotate-clockwise", color: "#7c3aed" },
  prismatic: { svg: "joint-prismatic.svg", fallback: "ti-arrows-vertical", color: "#0e9aa7" },
  pose: { svg: "joint-pose.svg", fallback: "ti-axis-x", color: "#8a5a08" },
}

function JointBadge({ joint }: { joint: Mechanism3dJoint }) {
  if (joint.type === "fixed") return null
  const meta = JOINT_ICONS[joint.type]
  return (
    <span
      title={`${joint.type} · ${joint.topicName ?? "manual"}`}
      style={{ display: "flex", flexShrink: 0, opacity: joint.topicName ? 1 : 0.45 }}
    >
      <PanelIcon svg={meta.svg} fallback={meta.fallback} size={12} color={meta.color} />
    </span>
  )
}

// --- Inspector ------------------------------------------------------------------

function PartInspector({
  part, parts, onUpdate, onPickModel, onAnimate, model, modelError, loading, liveValue, manualOverride,
}: {
  part: Mechanism3dPart
  parts: Mechanism3dPart[]
  onUpdate: (updates: Partial<Mechanism3dPart>) => void
  onPickModel: () => void
  onAnimate: () => void
  model: LoadedModel | null
  modelError: string | null
  loading: boolean
  liveValue: any
  manualOverride: boolean
}) {
  const updateJoint = (updates: Partial<Mechanism3dJoint>) =>
    onUpdate({ joint: { ...part.joint, ...updates } })

  const parentOptions = [
    { value: "", label: "— world —" },
    ...parts
      .filter(p => p.id !== part.id && canReparent(parts, part.id, p.id))
      .map(p => ({ value: p.id, label: p.name })),
  ]

  const shapeLabels: [string, string, string] =
    part.shape === "cylinder" ? ["R", "—", "H"]
    : part.shape === "sphere" ? ["R", "—", "—"]
    : ["X", "Y", "Z"]

  const shapeHelp =
    part.shape === "cylinder" ? "Radius and height, in metres. The cylinder stands along the part's Z axis; the middle box is unused."
    : part.shape === "sphere" ? "Radius, in metres. The other two boxes are unused."
    : "Metres, along the part's own X, Y and Z."

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Section title="Part" defaultOpen svg="part.svg" icon="ti-box">
        <Text label="Name" value={part.name} onChange={v => onUpdate({ name: v })} help={HELP.name} />
        <Select
          label="Hangs from"
          value={part.parentId ?? ""}
          options={parentOptions}
          help={HELP.parent}
          onChange={v => onUpdate({ parentId: v === "" ? null : v })}
        />
        <Row>
          <Check label="Visible" checked={part.visible} onChange={v => onUpdate({ visible: v })} help={HELP.visible} />
          <Check label="Locked" checked={part.locked} onChange={v => onUpdate({ locked: v })} help={HELP.locked} />
        </Row>
      </Section>

      <Section title="Model" defaultOpen svg="model-file.svg" icon="ti-file-3d" help={HELP.modelFile}>
        <Row>
          <PanelButton
            label={loading ? "Loading…" : part.modelPath ? "Change…" : "Choose model…"}
            onClick={onPickModel}
            disabled={loading}
          />
          {part.modelPath && (
            <PanelButton
              icon="ti-x"
              title="Drop the file and fall back to the primitive"
              onClick={() => onUpdate({ modelPath: null, modelName: null, shape: "box" })}
            />
          )}
        </Row>

        <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5, wordBreak: "break-all" }}>
          {part.modelPath ? part.modelName ?? fileNameOf(part.modelPath) : "No file — the primitive below is drawn."}
        </div>

        {model && (
          <Hint>
            {model.format.toUpperCase()} · {model.triangles.toLocaleString()} tris ·{" "}
            {model.size.x.toFixed(2)} × {model.size.y.toFixed(2)} × {model.size.z.toFixed(2)} file units
          </Hint>
        )}
        {modelError && <ErrorNote>{modelError}</ErrorNote>}

        {part.modelPath ? (
          <>
            <Select
              label="Model origin"
              value={part.modelAnchor}
              options={ANCHORS}
              help={HELP.anchor}
              onChange={v => onUpdate({ modelAnchor: v })}
            />
            <Check
              label="Scale to fit"
              checked={part.modelAutoFit}
              onChange={v => onUpdate({ modelAutoFit: v })}
              help={HELP.autoFit}
            />
            {part.modelAutoFit ? (
              <Num
                label="Fit size"
                suffix="m"
                value={part.modelFitSize}
                step={0.01}
                min={0.001}
                help={HELP.fitSize}
                onChange={v => onUpdate({ modelFitSize: Math.max(0.001, v) })}
              />
            ) : (
              <Num
                label="Scale"
                value={part.modelScale}
                step={0.001}
                help={HELP.scale}
                onChange={v => v !== 0 && onUpdate({ modelScale: v })}
              />
            )}
          </>
        ) : (
          <>
            <Select label="Shape" value={part.shape} options={SHAPES} help={HELP.shape} onChange={v => onUpdate({ shape: v })} />
            {part.shape !== "none" && (
              <Vector3Field
                label="Size"
                suffix="m"
                value={part.shapeSize}
                axisLabels={shapeLabels}
                help={shapeHelp}
                onChange={v => onUpdate({ shapeSize: v })}
              />
            )}
          </>
        )}

        <Vector3Field
          label="Model offset"
          suffix="m"
          value={part.modelOffset}
          help={HELP.modelOffset}
          onChange={v => onUpdate({ modelOffset: v })}
        />
        <Vector3Field
          label="Model rotation"
          suffix="°"
          step={15}
          value={part.modelRotation}
          help={HELP.modelRotation}
          onChange={v => onUpdate({ modelRotation: v })}
        />

        <Check
          label="Override colour"
          checked={part.color !== null}
          onChange={v => onUpdate({ color: v ? "#9aa0ad" : null })}
          help={HELP.colour}
        />
        {part.color !== null && (
          <input
            type="color"
            value={part.color}
            onChange={e => onUpdate({ color: e.target.value })}
            style={{ width: "100%", height: 24, padding: 0, border: "1px solid var(--border-main)", background: "var(--bg-input)", borderRadius: 2, cursor: "pointer" }}
          />
        )}
        <Slider
          label="Opacity"
          value={part.opacity}
          min={0.05}
          max={1}
          step={0.05}
          format={v => `${Math.round(v * 100)}%`}
          help={HELP.opacity}
          onChange={v => onUpdate({ opacity: v })}
        />
        <Check label="Wireframe" checked={part.wireframe} onChange={v => onUpdate({ wireframe: v })} help={HELP.wireframe} />
      </Section>

      <Section title="Placement" defaultOpen svg="placement.svg" icon="ti-arrows-move">
        <Vector3Field
          label="Position in parent"
          suffix="m"
          value={part.origin}
          help={HELP.origin}
          onChange={v => onUpdate({ origin: v })}
        />
        <Vector3Field
          label="Rotation in parent"
          suffix="°"
          step={15}
          value={part.originRotation}
          help={HELP.originRotation}
          onChange={v => onUpdate({ originRotation: v })}
        />
        <PanelButton
          label="Reset to parent origin"
          onClick={() => onUpdate({ origin: [0, 0, 0], originRotation: [0, 0, 0] })}
        />
      </Section>

      <Section title="Rotation centre" defaultOpen svg="pivot.svg" icon="ti-circle-dot" help={HELP.pivot}>
        <Vector3Field
          label="Pivot"
          suffix="m"
          value={part.pivot}
          help={HELP.pivot}
          onChange={v => onUpdate({ pivot: v })}
        />
        <Row>
          <PanelButton
            label="Match model offset"
            title="Puts the centre where the mesh's own origin ended up"
            onClick={() => onUpdate({ pivot: [...part.modelOffset] as [number, number, number] })}
          />
          <PanelButton label="Reset" onClick={() => onUpdate({ pivot: [0, 0, 0] })} />
        </Row>
        <Hint>
          The orange cross in the scene marks it while the part is selected. Set GIZMO to
          “Pivot” in the header to drag it.
        </Hint>
      </Section>

      <Section title="Joint" defaultOpen svg="joint.svg" icon="ti-rotate-360">
        <Select
          label="Type"
          value={part.joint.type}
          options={JOINT_TYPES}
          help={HELP.jointType}
          onChange={v => updateJoint({ type: v, units: unitsForType(v, part.joint.units) })}
        />

        {part.joint.type !== "fixed" && part.joint.type !== "pose" && (
          <>
            <Vector3Field
              label={part.joint.type === "prismatic" ? "Slide axis" : "Spin axis"}
              value={part.joint.axis}
              step={1}
              help={HELP.axis}
              onChange={v => updateJoint({ axis: v })}
            />
            <Row>
              {(["X", "Y", "Z"] as const).map((axis, i) => (
                <PanelButton
                  key={axis}
                  label={axis}
                  title={`Use the ${axis} axis`}
                  onClick={() => updateJoint({ axis: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0] })}
                />
              ))}
            </Row>
          </>
        )}

        <JointTopicField joint={part.joint} onUpdate={updateJoint} />

        {part.joint.type !== "pose" && (
          <>
            <Row>
              <Select
                label="Units"
                value={part.joint.units}
                options={unitOptionsFor(part.joint)}
                help={HELP.units}
                onChange={v => updateJoint({ units: v })}
              />
              <Num
                label="Scale"
                value={part.joint.scale}
                step={0.1}
                help={HELP.jointScale}
                onChange={v => updateJoint({ scale: v })}
              />
            </Row>
            <Row>
              <Num
                label="Offset"
                value={part.joint.offset}
                step={1}
                help={HELP.jointOffset}
                onChange={v => updateJoint({ offset: v })}
              />
              <div style={{ flex: 1, display: "flex", alignItems: "flex-end", paddingBottom: 4 }}>
                <Check label="Invert" checked={part.joint.invert} onChange={v => updateJoint({ invert: v })} help={HELP.invert} />
              </div>
            </Row>
            <Hint>value = (raw × scale) + offset, in {unitLabel(part.joint.units)}.</Hint>

            <div>
              <FieldLabel label={`Limits (${unitLabel(part.joint.units)})`} help={HELP.limits} />
              <Row>
                <LimitField label="Min" value={part.joint.min} onChange={v => updateJoint({ min: v })} />
                <LimitField label="Max" value={part.joint.max} onChange={v => updateJoint({ max: v })} />
              </Row>
            </div>

            <ManualControl joint={part.joint} onUpdate={updateJoint} />
          </>
        )}

        <JointReadout joint={part.joint} liveValue={liveValue} manualOverride={manualOverride} />

        {part.joint.type !== "fixed" && part.joint.type !== "pose" && (
          <PanelButton
            label="Animate this joint"
            svg="sweep.svg"
            icon="ti-arrows-left-right"
            title="Build a back-and-forth routine for this joint and play it"
            onClick={onAnimate}
          />
        )}
      </Section>
    </div>
  )
}

// --- Enlace del topic ------------------------------------------------------------

function JointTopicField({
  joint, onUpdate,
}: { joint: Mechanism3dJoint; onUpdate: (updates: Partial<Mechanism3dJoint>) => void }) {
  const [over, setOver] = useState(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const topicName = e.dataTransfer.getData("topicName")
    const topicType = e.dataTransfer.getData("topicType")
    if (!topicName || !isJointTopic(topicType)) return
    onUpdate(bindJointTopic(joint, topicName, topicType))
  }

  const isArray = joint.topicType.endsWith("[]")
  const isStruct = joint.topicType.startsWith("struct:")

  return (
    <div>
      <FieldLabel label="Driven by" help={HELP.topic} />
      <div
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!over) setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
        style={{
          border: over ? "1px dashed var(--mars-red)" : "1px dashed var(--border-main)",
          background: over ? "var(--bg-panel-header)" : "var(--bg-input)",
          borderRadius: 2, padding: "5px 6px", fontSize: 10, minHeight: 28,
          display: "flex", alignItems: "center", gap: 6,
        }}
      >
        {joint.topicName ? (
          <>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={joint.topicName}>
              {joint.topicName}
            </span>
            <button
              onClick={() => onUpdate({ topicName: null, topicType: "" })}
              title="Unbind — the joint falls back to its manual value"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, padding: 0, lineHeight: 1 }}
            >
              <i className="ti ti-x" aria-hidden />
            </button>
          </>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>Drag a topic here (manual only for now)</span>
        )}
      </div>
      {joint.topicName && <Hint>{joint.topicType}</Hint>}

      {(isArray || isStruct) && (
        <Row>
          {isArray && (
            <Num
              label="Index"
              value={joint.arrayIndex ?? 0}
              step={1}
              min={0}
              help={HELP.arrayIndex}
              onChange={v => onUpdate({ arrayIndex: Math.max(0, Math.round(v)) })}
            />
          )}
          {isStruct && joint.type !== "pose" && (
            <Num
              label="Field"
              value={joint.structField}
              step={1}
              min={0}
              help={HELP.structField}
              onChange={v => onUpdate({ structField: Math.max(0, Math.round(v)) })}
            />
          )}
        </Row>
      )}
    </div>
  )
}

/** A limit can be empty (no stop), so a Num is not enough. */
function LimitField({
  label, value, onChange,
}: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <label style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 9, color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
      <input
        type="number"
        value={value === null ? "" : value}
        placeholder="none"
        step={1}
        onChange={e => {
          const text = e.target.value
          if (text === "") return onChange(null)
          const next = Number(text)
          if (isFinite(next)) onChange(next)
        }}
        style={{ ...inputStyle, width: "100%" }}
      />
    </label>
  )
}

function ManualControl({
  joint, onUpdate,
}: { joint: Mechanism3dJoint; onUpdate: (updates: Partial<Mechanism3dJoint>) => void }) {
  // The slider's range comes from the limits; without limits a reasonable range
  // is used according to what the joint does.
  const kind = jointKind(joint)
  const fallback = kind === "length" ? 1 : joint.units === "radians" ? Math.PI : joint.units === "rotations" ? 1 : 180
  const min = joint.min ?? -fallback
  const max = joint.max ?? fallback
  const step = kind === "length" ? (max - min) / 200 : (max - min) / 360

  return (
    <div>
      <Slider
        label="Manual value"
        value={Math.min(Math.max(joint.manual, min), max)}
        min={min}
        max={max}
        step={step > 0 ? step : 0.01}
        format={v => `${v.toFixed(kind === "length" ? 3 : 1)} ${unitLabel(joint.units)}`}
        help={HELP.manual}
        onChange={v => onUpdate({ manual: v })}
      />
      <Row>
        <Num label="Exact" value={joint.manual} step={step > 0 ? step : 0.01} onChange={v => onUpdate({ manual: v })} />
        <div style={{ flex: 1, display: "flex", alignItems: "flex-end" }}>
          <PanelButton label="Zero" onClick={() => onUpdate({ manual: 0 })} />
        </div>
      </Row>
    </div>
  )
}

function JointReadout({
  joint, liveValue, manualOverride,
}: { joint: Mechanism3dJoint; liveValue: any; manualOverride: boolean }) {
  if (joint.type === "fixed") return null

  if (joint.type === "pose") {
    return (
      <Hint>
        {joint.topicName
          ? `Pose taken straight from ${joint.topicType}. Scale, limits and manual value do not apply.`
          : "Bind a Pose3d / Pose2d topic to drive this part."}
      </Hint>
    )
  }

  const value = jointValue(joint, liveValue, manualOverride)
  const source = manualOverride || !joint.topicName ? "manual" : liveValue === undefined ? "no data — manual" : "live"

  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      background: "var(--bg-panel-header)", borderRadius: 2, padding: "4px 6px",
    }}>
      <span style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {source}
      </span>
      <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>
        {value.toFixed(jointKind(joint) === "length" ? 3 : 1)} {unitLabel(joint.units)}
      </span>
    </div>
  )
}

// --- Units by type -------------------------------------------------------

function unitOptionsFor(joint: Mechanism3dJoint): { value: Mechanism3dJointUnits; label: string }[] {
  const list = jointKind(joint) === "length" ? LINEAR_UNITS : ANGULAR_UNITS
  return list.map(u => ({ value: u, label: `${u} (${unitLabel(u)})` }))
}

/** Changing from revolute to prismatic has to carry the unit over to the other group. */
function unitsForType(type: Mechanism3dJointType, current: Mechanism3dJointUnits): Mechanism3dJointUnits {
  if (type === "prismatic") return LINEAR_UNITS.includes(current) ? current : "meters"
  if (type === "revolute" || type === "continuous") return ANGULAR_UNITS.includes(current) ? current : "degrees"
  return current
}
