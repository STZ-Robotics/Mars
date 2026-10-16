import { DashboardWidget, TopicAnnounce } from "../../../store/appStore"
import Field2dWidget from "./Field2dWidget"
import UnsupportedValue from "../../common/UnsupportedValue"
import { TopicClassification } from "../../../utils/dashboard/topicClassification"
import BooleanWidget from "./BooleanWidget"
import RotationWidget from "./RotationWidget"
import StructWidget from "./StructWidget"
import StructArrayWidget from "./StructArrayWidget"
import StructArraySingleWidget from "./StructArraySingleWidget"
import NumberArrayWidget from "./NumberArrayWidget"
import ValueListWidget from "./ValueListWidget"
import NumberWidget from "./NumberWidget"

interface Props {
  widget: DashboardWidget
  rawVal: any
  classification: TopicClassification
  /** Only needed for the widgets that read a whole TABLE (Field2d). */
  topics: Map<string, TopicAnnounce>
}

// The only place where "this topic type -> this component" is decided.
// To add a new type (e.g. ChassisSpeeds): 1) STRUCT_DEFS in
// utils/dashboard/valueDecoding.ts if it is a struct, 2) its component in
// ./widgets, 3) a case here.
export default function WidgetRenderer({ widget, rawVal, classification, topics }: Props) {
  const { isBoolean, isRotationSingle, isStructSingle, isStructArray, isNumericArray, isTextArray, isString, isField2d, structName } = classification

  // It goes BEFORE the rawVal check: a Field2d has no value of its own, it is
  // built by reading the topics hanging from its table.
  if (isField2d) {
    return <Field2dWidget widget={widget} topics={topics} />
  }

  if (rawVal === null) {
    return <span style={{ fontSize: 14, color: "var(--text-muted)", fontFamily: "monospace" }}>--</span>
  }

  if (isBoolean) {
    return <BooleanWidget value={rawVal as boolean} style={widget.style} customTrue={widget.customTrue} customFalse={widget.customFalse} />
  }

  if (isRotationSingle) {
    return <RotationWidget rawVal={rawVal} style={widget.style} unit={widget.unit} />
  }

  if (isStructSingle) {
    return <StructWidget rawVal={rawVal} structName={structName!} />
  }

  if (isStructArray) {
    // A widget created by dragging ONE single index (e.g. ModulePositions[2])
    // from the Data Directory, instead of the whole array.
    if (widget.arrayIndex !== undefined) {
      return <StructArraySingleWidget rawVal={rawVal} structName={structName!} index={widget.arrayIndex} />
    }
    return <StructArrayWidget rawVal={rawVal} structName={structName!} />
  }

  // A single element of the array (its index row was dragged in the tree).
  if ((isNumericArray || isTextArray) && widget.arrayIndex !== undefined) {
    const element = Array.isArray(rawVal) ? rawVal[widget.arrayIndex] : undefined
    if (element === undefined) {
      return <UnsupportedValue message={`Index ${widget.arrayIndex} out of range`} />
    }
    if (typeof element === "number") {
      return <NumberWidget value={element} style={widget.style} min={widget.min ?? 0} max={widget.max ?? 100} unit={widget.unit} />
    }
    return (
      <span style={{ fontSize: 18, color: "var(--text-primary)", fontWeight: 600, textAlign: "center", wordBreak: "break-all" }}>
        {typeof element === "boolean" ? (element ? "true" : "false") : String(element)}
      </span>
    )
  }

  if (isNumericArray) {
    return <NumberArrayWidget values={Array.isArray(rawVal) ? rawVal : []} />
  }

  // boolean[] / string[] — no magnitude to plot, they go as a text list.
  if (isTextArray) {
    return <ValueListWidget values={Array.isArray(rawVal) ? rawVal : []} />
  }

  if (isString) {
    return <span style={{ fontSize: 18, color: "var(--text-primary)", fontWeight: 600, textAlign: "center", wordBreak: "break-all" }}>{rawVal}</span>
  }

  return (
    <NumberWidget
      value={typeof rawVal === "number" ? rawVal : parseFloat(rawVal)}
      style={widget.style}
      min={widget.min ?? 0}
      max={widget.max ?? 100}
      unit={widget.unit}
      matchTimeMode={widget.matchTimeMode}
      matchTimeYellow={widget.matchTimeYellow}
      matchTimeRed={widget.matchTimeRed}
      graphTimeDisplayed={widget.graphTimeDisplayed}
      graphColor={widget.graphColor}
      graphLineWidth={widget.graphLineWidth}
      graphAutoRange={widget.graphAutoRange}
      graphMin={widget.graphMin}
      graphMax={widget.graphMax}
      gaugeStartAngle={widget.gaugeStartAngle}
      gaugeEndAngle={widget.gaugeEndAngle}
      gaugeMin={widget.gaugeMin}
      gaugeMax={widget.gaugeMax}
      gaugeNumberOfLabels={widget.gaugeNumberOfLabels}
      gaugeWrapValue={widget.gaugeWrapValue}
      gaugeShowPointer={widget.gaugeShowPointer}
      gaugeShowTicks={widget.gaugeShowTicks}
      voltageMin={widget.voltageMin}
      voltageMax={widget.voltageMax}
      voltageDivisions={widget.voltageDivisions}
      voltageInverted={widget.voltageInverted}
      voltageOrientation={widget.voltageOrientation}
    />
  )
}