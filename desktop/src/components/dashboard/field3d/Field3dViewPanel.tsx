// The Field 3D's scene settings: field, coordinate system, camera, quality and
// visual aids.
//
// It is split into collapsible sections (the same as Swerve 3D and Mechanism
// 3D) because there are almost thirty controls: in a flat list, the four touched
// daily would be lost among the ones touched once a season.

import { memo } from "react"
import {
  Field3dSettings, Field3dCameraMode, Field3dQuality, Field3dOrigin,
  EVERGREEN_FIELD_KEY,
} from "../../../store/appStore"
import {
  COORDINATE_SYSTEMS, COORDINATE_SYSTEM_LABELS, Field3dCoordinateSystem, Alliance,
} from "../../../utils/field3d/frames"
import { FieldPack, RobotPack } from "../../../utils/field3d/assetStore"
import { Check, Hint, Num, Row, Section, Select, Slider } from "../three/PanelFields"

interface Props {
  settings: Field3dSettings
  fieldPacks: FieldPack[]
  robotPacks: RobotPack[]
  fieldPack: FieldPack | null
  /** The effective alliance, already resolved (manual or read from FMSInfo). */
  alliance: Alliance
  /** true if the robot is publishing it; only to explain it in the panel. */
  allianceFromRobot: boolean
  /** Counts of the loaded model, so it shows what each mode does. */
  stats: { triangles: number; drawCalls: number; culled: number } | null
  totalTrailSamples: number
  onUpdate: (updates: Partial<Field3dSettings>) => void
  onClearTrails: () => void
}

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

const ORIGINS: { value: Field3dOrigin; label: string }[] = [
  { value: "auto", label: "Auto (follow alliance)" },
  { value: "blue", label: "Blue" },
  { value: "red", label: "Red" },
]

function Field3dViewPanel({
  settings, fieldPacks, robotPacks, fieldPack, alliance, allianceFromRobot,
  stats, totalTrailSamples, onUpdate, onClearTrails,
}: Props) {
  // The system really in use: the panel's override, or the one the field's
  // config declares, or WPILib's classic one if there is no field with a model.
  const effectiveSystem: Field3dCoordinateSystem =
    settings.coordinateSystem ?? fieldPack?.config.coordinateSystem ?? "wall-blue"

  const driverStationCount = fieldPack?.config.driverStations.length || 6
  const cameras = settings.robotAssetKey
    ? robotPacks.find(p => p.key === settings.robotAssetKey)?.config.cameras ?? []
    : []

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Section title="Field" defaultOpen svg="field3d.svg" svgFallback="visualizer2d.svg" icon="ti-map-2">
        <Select
          label="Model"
          value={settings.fieldKey}
          options={[
            { value: EVERGREEN_FIELD_KEY, label: "Schematic (no download)" },
            ...fieldPacks.map(p => ({ value: p.key, label: p.config.name })),
          ]}
          onChange={fieldKey => onUpdate({ fieldKey })}
          help="Season models are installed from the Assets tab. The schematic is a to-scale carpet with walls and works offline."
        />

        <Select
          label="Robot model (default)"
          value={settings.robotAssetKey ?? ""}
          options={[
            { value: "", label: "Generic chassis" },
            ...robotPacks.map(p => ({ value: p.key, label: p.config.name })),
          ]}
          onChange={key => onUpdate({ robotAssetKey: key === "" ? null : key })}
          help="Used by every robot object that does not pick its own."
        />

        {stats && (
          <Hint>
            {stats.triangles.toLocaleString()} triangles in {stats.drawCalls} draw calls
            {stats.culled > 0 && `, ${stats.culled.toLocaleString()} small parts dropped`}.
            <br />
            Material colours are baked into the vertices so the whole field merges into a
            handful of meshes; the quality mode decides how much small hardware survives.
          </Hint>
        )}
      </Section>

      <Section title="Coordinates" svg="placement.svg" icon="ti-axis-x">
        <Select
          label="Published frame"
          value={settings.coordinateSystem ?? "auto"}
          options={[
            {
              value: "auto",
              label: `Auto (${COORDINATE_SYSTEM_LABELS[effectiveSystem].split(" (")[0]})`,
            },
            ...COORDINATE_SYSTEMS.map(s => ({ value: s, label: COORDINATE_SYSTEM_LABELS[s] })),
          ]}
          onChange={value => onUpdate({
            coordinateSystem: value === "auto" ? null : value as Field3dCoordinateSystem,
          })}
          help={
            "Which frame the robot publishes in. If a pose lands mirrored or a quarter turn " +
            "off, this is almost always the reason — not a bug in the render."
          }
        />

        <Select<Field3dOrigin>
          label="Origin"
          value={settings.origin}
          options={ORIGINS}
          onChange={origin => onUpdate({ origin })}
          help="Only matters for alliance-relative frames, where (0,0) moves to your own wall."
        />

        <Check
          label="Read alliance from FMSInfo"
          checked={settings.allianceFromFMS}
          onChange={allianceFromFMS => onUpdate({ allianceFromFMS })}
          help="Uses /FMSInfo/IsRedAlliance, which the Driver Station publishes on its own. Falls back to the selector when the topic is not there."
        />

        {!settings.allianceFromFMS || !allianceFromRobot ? (
          <Select<Alliance>
            label="Alliance"
            value={settings.alliance}
            options={[{ value: "blue", label: "Blue" }, { value: "red", label: "Red" }]}
            onChange={value => onUpdate({ alliance: value })}
          />
        ) : (
          <Hint>Alliance from FMSInfo: <b>{alliance}</b>.</Hint>
        )}
      </Section>

      <Section title="Camera" defaultOpen svg="capture.svg" icon="ti-video">
        <Select<Field3dCameraMode>
          label="Mode"
          value={settings.cameraMode}
          options={CAMERA_MODES}
          onChange={cameraMode => onUpdate({ cameraMode })}
          help={
            "Orbit field is free. Orbit robot keeps the robot centred without turning with " +
            "it. Driver station and robot camera are fixed viewpoints, so the mouse does nothing."
          }
        />

        {settings.cameraMode === "driverStation" && (
          <Select
            label="Station"
            value={String(settings.driverStationIndex)}
            options={Array.from({ length: driverStationCount }, (_, i) => ({
              value: String(i),
              // The first ones are blue and the next ones red, in the order the
              // asset's config lists them.
              label: `${i < driverStationCount / 2 ? "Blue" : "Red"} ${(i % (driverStationCount / 2)) + 1}`,
            }))}
            onChange={value => onUpdate({ driverStationIndex: Number(value) })}
          />
        )}

        {settings.cameraMode === "robotCamera" && (
          cameras.length > 0 ? (
            <Select
              label="Camera"
              value={String(Math.min(settings.robotCameraIndex, cameras.length - 1))}
              options={cameras.map((camera, index) => ({ value: String(index), label: camera.name }))}
              onChange={value => onUpdate({ robotCameraIndex: Number(value) })}
            />
          ) : (
            <Hint>
              The selected robot asset declares no cameras. Add a <i>cameras</i> array to its
              config.json with the position, rotations, resolution and horizontal fov.
            </Hint>
          )
        )}

        {settings.cameraMode !== "robotCamera" && (
          <Slider
            label="Field of view"
            value={settings.fov}
            min={20}
            max={100}
            step={1}
            onChange={fov => onUpdate({ fov })}
            format={v => `${v.toFixed(0)}°`}
          />
        )}
      </Section>

      <Section title="Rendering" svg="scene.svg" icon="ti-sparkles">
        <Select<Field3dQuality>
          label="Quality"
          value={settings.quality}
          options={QUALITIES}
          onChange={quality => onUpdate({ quality })}
          help={
            "Cinematic adds shadows, tone mapping and a reflection environment. Standard drops " +
            "them. Low power also halves the frame rate and drops to 1x pixel ratio — that is " +
            "the one for a laptop in the pit running on battery."
          }
        />

        <Row>
          <Check
            label="Grid"
            checked={settings.showGrid}
            onChange={showGrid => onUpdate({ showGrid })}
          />
          <Num
            label="Cell"
            suffix="m"
            value={settings.gridCell}
            step={0.25}
            min={0.1}
            onChange={gridCell => onUpdate({ gridCell })}
          />
        </Row>

        <Row>
          <Check
            label="Field axes"
            checked={settings.showFieldAxes}
            onChange={showFieldAxes => onUpdate({ showFieldAxes })}
            help="X/Y/Z triad at the robot's coordinate origin — the blue corner in the classic frame, not the centre of the field."
          />
          <Check
            label="Driver stations"
            checked={settings.showDriverStations}
            onChange={showDriverStations => onUpdate({ showDriverStations })}
          />
        </Row>

        <Row>
          <Check
            label="AprilTags"
            checked={settings.showAprilTags}
            onChange={showAprilTags => onUpdate({ showAprilTags })}
            help="Drawn from the tag layout in the field asset's config.json, so they land exactly where the official layout puts them."
          />
          <Check
            label="Tag IDs"
            checked={settings.showAprilTagIds}
            onChange={showAprilTagIds => onUpdate({ showAprilTagIds })}
          />
        </Row>

        <Check
          label="Pre-placed game pieces"
          checked={settings.showStagedPieces}
          onChange={showStagedPieces => onUpdate({ showStagedPieces })}
          help="The pieces the field model ships already staged. They hide themselves anyway for any piece your robot is publishing, so you never see one twice."
        />
      </Section>

      <Section title="Robot chassis" svg="robot.svg" icon="ti-robot">
        <Hint>Size of the generic box drawn when an object has no model.</Hint>
        <Row>
          <Num label="Length" suffix="m" value={settings.robotLength} step={0.01} min={0.1}
            onChange={robotLength => onUpdate({ robotLength })} />
          <Num label="Width" suffix="m" value={settings.robotWidth} step={0.01} min={0.1}
            onChange={robotWidth => onUpdate({ robotWidth })} />
        </Row>
        <Num label="Height" suffix="m" value={settings.robotHeight} step={0.01} min={0.05}
          onChange={robotHeight => onUpdate({ robotHeight })} />
      </Section>

      <Section title="Trails" svg="trail.svg" icon="ti-line-dashed" badge={totalTrailSamples > 0 ? totalTrailSamples.toLocaleString() : undefined}>
        <Check
          label="Show trails"
          checked={settings.showTrails}
          onChange={showTrails => onUpdate({ showTrails })}
          help="Master switch. With it on, each robot object can still set its own length."
        />
        <Num
          label="Default length"
          suffix="s"
          value={settings.trailSeconds}
          step={0.5}
          min={0}
          max={120}
          onChange={trailSeconds => onUpdate({ trailSeconds })}
        />
        {totalTrailSamples > 0 && (
          <button
            onClick={onClearTrails}
            style={{
              alignSelf: "flex-start", background: "none", border: "none", padding: 0,
              fontSize: 10, color: "var(--mars-accent)", cursor: "pointer",
            }}
          >
            Clear every trail
          </button>
        )}
      </Section>
    </div>
  )
}

// Same as the assets panel: nothing here depends on the NT poll, so it has no
// reason to redraw 30 times per second with the rest of the page.
export default memo(Field3dViewPanel)
