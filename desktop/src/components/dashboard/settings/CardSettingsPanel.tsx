import { useState } from "react"
import { DashboardWidget, FieldOrientation } from "../../../store/appStore"
import Field2dFields from "./Field2dFields"
import { CoordinateSystem, FIELDS, SCHEMATIC_FIELD_KEY, getField } from "../../../utils/field/fieldImages"
import { TopicClassification } from "../../../utils/dashboard/topicClassification"
import SizeFields from "./SizeFields"
import StyleSelect from "./StyleSelect"
import RotationUnitField from "./RotationUnitField"
import NumberUnitField from "./NumberUnitField"
import BooleanCustomLabelsFields from "./BooleanCustomLabelsFields"
import RangeFields from "./RangeFields"
import MatchTimeFields from "./MatchTimeFields"
import GraphFields from "./GraphFields"
import GaugeFields from "./GaugeFields"
import VoltageFields from "./VoltageFields"
import UnsupportedStyleNote from "./UnsupportedStyleNote"

interface Props {
  widget: DashboardWidget
  classification: TopicClassification
  onSave: (updates: Partial<DashboardWidget>) => void
}

// Owner of all the editing state (local drafts that are only applied to the
// real widget when the user presses "Apply Changes").
export default function CardSettingsPanel({ widget, classification, onSave }: Props) {
  const { isBoolean, isNumber, isRotationSingle, isField2d, hasStyleOptions } = classification

  const [editStyle, setEditStyle] = useState(widget.style)
  const [editMin, setEditMin] = useState(widget.min ?? 0)
  const [editMax, setEditMax] = useState(widget.max ?? 100)
  const [editTrue, setEditTrue] = useState(widget.customTrue ?? "True")
  const [editFalse, setEditFalse] = useState(widget.customFalse ?? "False")
  const [editWidth, setEditWidth] = useState(widget.width)
  const [editHeight, setEditHeight] = useState(widget.height)
  // On doubles it is only a suffix label (it does not convert the value).
  // On Rotation2d it is a real conversion, because we know the WPILib struct
  // always serializes the angle in radians.
  const [editUnit, setEditUnit] = useState(widget.unit ?? "")

  // --- Match Time ---
  const [editMatchTimeMode, setEditMatchTimeMode] = useState<"mmss" | "seconds">(widget.matchTimeMode ?? "mmss")
  const [editMatchTimeYellow, setEditMatchTimeYellow] = useState(widget.matchTimeYellow ?? 30)
  const [editMatchTimeRed, setEditMatchTimeRed] = useState(widget.matchTimeRed ?? 15)

  // --- Graph ---
  const [editGraphTime, setEditGraphTime] = useState(widget.graphTimeDisplayed ?? 5)
  const [editGraphColor, setEditGraphColor] = useState(widget.graphColor ?? "#6262f1")
  const [editGraphLineWidth, setEditGraphLineWidth] = useState(widget.graphLineWidth ?? 2)
  const [editGraphAutoRange, setEditGraphAutoRange] = useState(widget.graphAutoRange ?? true)
  const [editGraphMin, setEditGraphMin] = useState(widget.graphMin ?? 0)
  const [editGraphMax, setEditGraphMax] = useState(widget.graphMax ?? 100)

  // --- Radial Gauge ---
  const [editGaugeStartAngle, setEditGaugeStartAngle] = useState(widget.gaugeStartAngle ?? -140)
  const [editGaugeEndAngle, setEditGaugeEndAngle] = useState(widget.gaugeEndAngle ?? 140)
  const [editGaugeMin, setEditGaugeMin] = useState(widget.gaugeMin ?? 0)
  const [editGaugeMax, setEditGaugeMax] = useState(widget.gaugeMax ?? 100)
  const [editGaugeNumberOfLabels, setEditGaugeNumberOfLabels] = useState(widget.gaugeNumberOfLabels ?? 8)
  const [editGaugeWrapValue, setEditGaugeWrapValue] = useState(widget.gaugeWrapValue ?? false)
  const [editGaugeShowPointer, setEditGaugeShowPointer] = useState(widget.gaugeShowPointer ?? true)
  const [editGaugeShowTicks, setEditGaugeShowTicks] = useState(widget.gaugeShowTicks ?? true)

  // --- Field2d ---
  const defaultFieldKey = FIELDS[0]?.key ?? SCHEMATIC_FIELD_KEY
  const [editFieldKey, setEditFieldKey] = useState(widget.fieldKey ?? defaultFieldKey)
  const [editFieldCoords, setEditFieldCoords] = useState<CoordinateSystem>(
    (widget.fieldCoordinateSystem as CoordinateSystem | undefined) ??
      getField(widget.fieldKey ?? defaultFieldKey)?.coordinateSystem ??
      "wall_blue",
  )
  const [editFieldOrientation, setEditFieldOrientation] = useState<FieldOrientation>(widget.fieldOrientation ?? 0)
  const [editFieldRobotSize, setEditFieldRobotSize] = useState(widget.fieldRobotSize ?? 0.85)
  const [editFieldRobotWidth, setEditFieldRobotWidth] = useState(widget.fieldRobotWidth ?? widget.fieldRobotSize ?? 0.85)
  const [editFieldShowGrid, setEditFieldShowGrid] = useState(widget.fieldShowGrid ?? false)
  const [editFieldAllianceFlip, setEditFieldAllianceFlip] = useState(widget.fieldAllianceFlip ?? false)
  const [editFieldTrailSeconds, setEditFieldTrailSeconds] = useState(widget.fieldTrailSeconds ?? 0)

  // --- Voltage View ---
  const [editVoltageMin, setEditVoltageMin] = useState(widget.voltageMin ?? 4)
  const [editVoltageMax, setEditVoltageMax] = useState(widget.voltageMax ?? 13)
  const [editVoltageDivisions, setEditVoltageDivisions] = useState(widget.voltageDivisions ?? 5)
  const [editVoltageInverted, setEditVoltageInverted] = useState(widget.voltageInverted ?? false)
  const [editVoltageOrientation, setEditVoltageOrientation] = useState<"horizontal" | "vertical">(widget.voltageOrientation ?? "horizontal")

  const handleSave = () => {
    onSave({
      style: editStyle, min: editMin, max: editMax, customTrue: editTrue, customFalse: editFalse,
      width: editWidth, height: editHeight, unit: editUnit,
      matchTimeMode: editMatchTimeMode, matchTimeYellow: editMatchTimeYellow, matchTimeRed: editMatchTimeRed,
      graphTimeDisplayed: editGraphTime, graphColor: editGraphColor, graphLineWidth: editGraphLineWidth,
      graphAutoRange: editGraphAutoRange, graphMin: editGraphMin, graphMax: editGraphMax,
      gaugeStartAngle: editGaugeStartAngle, gaugeEndAngle: editGaugeEndAngle, gaugeMin: editGaugeMin, gaugeMax: editGaugeMax,
      gaugeNumberOfLabels: editGaugeNumberOfLabels, gaugeWrapValue: editGaugeWrapValue,
      gaugeShowPointer: editGaugeShowPointer, gaugeShowTicks: editGaugeShowTicks,
      voltageMin: editVoltageMin, voltageMax: editVoltageMax, voltageDivisions: editVoltageDivisions,
      voltageInverted: editVoltageInverted, voltageOrientation: editVoltageOrientation,
      fieldKey: editFieldKey, fieldCoordinateSystem: editFieldCoords,
      fieldOrientation: editFieldOrientation, fieldRobotSize: editFieldRobotSize,
      fieldRobotWidth: editFieldRobotWidth, fieldShowGrid: editFieldShowGrid,
      fieldAllianceFlip: editFieldAllianceFlip, fieldTrailSeconds: editFieldTrailSeconds,
    })
  }

  return (
    <div style={{ flex: 1, padding: 12, background: "var(--bg-panel)", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }} onMouseDown={e => e.stopPropagation()}>

      <SizeFields width={editWidth} height={editHeight} onChangeWidth={setEditWidth} onChangeHeight={setEditHeight} />

      {isField2d && (
        <Field2dFields
          fieldKey={editFieldKey}
          coordinateSystem={editFieldCoords}
          orientation={editFieldOrientation}
          robotSize={editFieldRobotSize}
          robotWidth={editFieldRobotWidth}
          showGrid={editFieldShowGrid}
          allianceFlip={editFieldAllianceFlip}
          trailSeconds={editFieldTrailSeconds}
          onChangeFieldKey={(key) => {
            setEditFieldKey(key)
            // On switching fields the system its JSON declares is adopted:
            // carrying over the previous field's override would be a worse default.
            const next = getField(key)?.coordinateSystem
            if (next) setEditFieldCoords(next)
          }}
          onChangeCoordinateSystem={setEditFieldCoords}
          onChangeOrientation={setEditFieldOrientation}
          onChangeRobotSize={setEditFieldRobotSize}
          onChangeRobotWidth={setEditFieldRobotWidth}
          onChangeShowGrid={setEditFieldShowGrid}
          onChangeAllianceFlip={setEditFieldAllianceFlip}
          onChangeTrailSeconds={setEditFieldTrailSeconds}
        />
      )}

      {hasStyleOptions && (
        <StyleSelect isBoolean={isBoolean} isRotationSingle={isRotationSingle} value={editStyle} onChange={setEditStyle} />
      )}

      {isRotationSingle && <RotationUnitField value={editUnit} onChange={setEditUnit} />}

      {isNumber && <NumberUnitField value={editUnit} onChange={setEditUnit} />}

      {isBoolean && editStyle === "Custom" && (
        <BooleanCustomLabelsFields trueLabel={editTrue} falseLabel={editFalse} onChangeTrue={setEditTrue} onChangeFalse={setEditFalse} />
      )}

      {isNumber && (editStyle === "Bar" || editStyle === "Deviation") && (
        <RangeFields style={editStyle} min={editMin} max={editMax} onChangeMin={setEditMin} onChangeMax={setEditMax} />
      )}

      {isNumber && editStyle === "MatchTime" && (
        <MatchTimeFields
          mode={editMatchTimeMode} yellowAt={editMatchTimeYellow} redAt={editMatchTimeRed}
          onChangeMode={setEditMatchTimeMode} onChangeYellow={setEditMatchTimeYellow} onChangeRed={setEditMatchTimeRed}
        />
      )}

      {isNumber && editStyle === "Graph" && (
        <GraphFields
          timeDisplayed={editGraphTime} color={editGraphColor} lineWidth={editGraphLineWidth}
          autoRange={editGraphAutoRange} yMin={editGraphMin} yMax={editGraphMax}
          onChangeTimeDisplayed={setEditGraphTime} onChangeColor={setEditGraphColor} onChangeLineWidth={setEditGraphLineWidth}
          onChangeAutoRange={setEditGraphAutoRange} onChangeYMin={setEditGraphMin} onChangeYMax={setEditGraphMax}
        />
      )}

      {isNumber && editStyle === "Gauge" && (
        <GaugeFields
          startAngle={editGaugeStartAngle} endAngle={editGaugeEndAngle} min={editGaugeMin} max={editGaugeMax}
          numberOfLabels={editGaugeNumberOfLabels} wrapValue={editGaugeWrapValue} showPointer={editGaugeShowPointer} showTicks={editGaugeShowTicks}
          onChangeStartAngle={setEditGaugeStartAngle} onChangeEndAngle={setEditGaugeEndAngle}
          onChangeMin={setEditGaugeMin} onChangeMax={setEditGaugeMax} onChangeNumberOfLabels={setEditGaugeNumberOfLabels}
          onChangeWrapValue={setEditGaugeWrapValue} onChangeShowPointer={setEditGaugeShowPointer} onChangeShowTicks={setEditGaugeShowTicks}
        />
      )}

      {isNumber && editStyle === "Voltage" && (
        <VoltageFields
          orientation={editVoltageOrientation} min={editVoltageMin} max={editVoltageMax}
          divisions={editVoltageDivisions} inverted={editVoltageInverted}
          onChangeOrientation={setEditVoltageOrientation} onChangeMin={setEditVoltageMin} onChangeMax={setEditVoltageMax}
          onChangeDivisions={setEditVoltageDivisions} onChangeInverted={setEditVoltageInverted}
        />
      )}

      {!hasStyleOptions && !isField2d && <UnsupportedStyleNote classification={classification} />}

      <button
        onClick={handleSave}
        style={{ marginTop: "auto", background: "var(--border-light)", color: "var(--text-primary)", border: "1px solid var(--border-main)", padding: "6px", borderRadius: 3, fontSize: 11, fontWeight: 600, cursor: "pointer" }}
      >
        Apply Changes
      </button>
    </div>
  )
}
