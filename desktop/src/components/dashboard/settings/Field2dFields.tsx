import React from "react"
import { labelStyle, inputStyle } from "../DashboardCard.styles"
import {
  FIELDS, SCHEMATIC_FIELD_KEY, COORDINATE_SYSTEM_LABELS, CoordinateSystem,
} from "../../../utils/field/fieldImages"
import { FieldOrientation } from "../../../store/appStore"

interface Props {
  fieldKey: string
  coordinateSystem: CoordinateSystem
  orientation: FieldOrientation
  robotSize: number
  robotWidth: number
  showGrid: boolean
  allianceFlip: boolean
  trailSeconds: number
  onChangeFieldKey: (v: string) => void
  onChangeCoordinateSystem: (v: CoordinateSystem) => void
  onChangeOrientation: (v: FieldOrientation) => void
  onChangeRobotSize: (v: number) => void
  onChangeRobotWidth: (v: number) => void
  onChangeShowGrid: (v: boolean) => void
  onChangeAllianceFlip: (v: boolean) => void
  onChangeTrailSeconds: (v: number) => void
}

const ORIENTATIONS: FieldOrientation[] = [0, 90, 180, 270]
const COORDINATE_SYSTEMS: CoordinateSystem[] = ["wall_blue", "center", "center_rotated"]

export default function Field2dFields({
  fieldKey, coordinateSystem, orientation, robotSize, robotWidth,
  showGrid, allianceFlip, trailSeconds,
  onChangeFieldKey, onChangeCoordinateSystem, onChangeOrientation,
  onChangeRobotSize, onChangeRobotWidth,
  onChangeShowGrid, onChangeAllianceFlip, onChangeTrailSeconds,
}: Props) {
  return (
    <>
      <div>
        <label style={labelStyle}>FIELD IMAGE</label>
        <select value={fieldKey} onChange={e => onChangeFieldKey(e.target.value)} style={inputStyle}>
          {FIELDS.map(f => <option key={f.key} value={f.key}>{f.game} ({f.program})</option>)}
          <option value={SCHEMATIC_FIELD_KEY}>Schematic (no image)</option>
        </select>
      </div>

      {/* If the pose comes out mirrored or rotated 90°, it is almost always
          that the robot publishes in another coordinate frame and not that the
          data is wrong. */}
      <div>
        <label style={labelStyle}>COORDINATE SYSTEM</label>
        <select
          value={coordinateSystem}
          onChange={e => onChangeCoordinateSystem(e.target.value as CoordinateSystem)}
          style={inputStyle}
        >
          {COORDINATE_SYSTEMS.map(s => (
            <option key={s} value={s}>{COORDINATE_SYSTEM_LABELS[s]}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>ROTATION</label>
          <select
            value={orientation}
            onChange={e => onChangeOrientation(Number(e.target.value) as FieldOrientation)}
            style={inputStyle}
          >
            {ORIENTATIONS.map(o => <option key={o} value={o}>{o}°</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>TRAIL (s)</label>
          <input
            type="number" step={0.5} min={0}
            value={trailSeconds}
            onChange={e => onChangeTrailSeconds(Math.max(0, Number(e.target.value) || 0))}
            style={inputStyle}
          />
        </div>
      </div>

      {/* The rectangular chassis matters: a 33"x27" robot drawn square
          lies about how much room it has left against the wall. */}
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>LENGTH (m)</label>
          <input
            type="number" step={0.05} min={0.1}
            value={robotSize}
            onChange={e => onChangeRobotSize(Number(e.target.value) || 0.85)}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>WIDTH (m)</label>
          <input
            type="number" step={0.05} min={0.1}
            value={robotWidth}
            onChange={e => onChangeRobotWidth(Number(e.target.value) || 0.85)}
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 14 }}>
        <label style={checkboxStyle}>
          <input type="checkbox" checked={showGrid} onChange={e => onChangeShowGrid(e.target.checked)} />
          GRID
        </label>
        <label style={checkboxStyle} title="Flips the field half a turn: the view the red driver station has">
          <input type="checkbox" checked={allianceFlip} onChange={e => onChangeAllianceFlip(e.target.checked)} />
          RED VIEW
        </label>
      </div>
    </>
  )
}

const checkboxStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5,
  fontSize: 9, fontWeight: 600, color: "var(--text-muted)", cursor: "pointer",
}
