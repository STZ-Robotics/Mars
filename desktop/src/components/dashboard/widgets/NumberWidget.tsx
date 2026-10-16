import { unitSuffix } from "../DashboardCard.styles"
import TextValueWidget from "./TextValueWidget"
import BarWidget from "./BarWidget"
import DeviationWidget from "./DeviationWidget"
import NumberCompassWidget from "./NumberCompassWidget"
import MatchTimeWidget from "./MatchTimeWidget"
import GraphWidget from "./GraphWidget"
import RadialGaugeWidget from "./RadialGaugeWidget"
import VoltageWidget from "./VoltageWidget"

interface Props {
  value: number
  style: string
  min: number
  max: number
  unit?: string
  matchTimeMode?: "mmss" | "seconds"
  matchTimeYellow?: number
  matchTimeRed?: number
  graphTimeDisplayed?: number
  graphColor?: string
  graphLineWidth?: number
  graphAutoRange?: boolean
  graphMin?: number
  graphMax?: number
  gaugeStartAngle?: number
  gaugeEndAngle?: number
  gaugeMin?: number
  gaugeMax?: number
  gaugeNumberOfLabels?: number
  gaugeWrapValue?: boolean
  gaugeShowPointer?: boolean
  gaugeShowTicks?: boolean
  voltageMin?: number
  voltageMax?: number
  voltageDivisions?: number
  voltageInverted?: boolean
  voltageOrientation?: "horizontal" | "vertical"
}

// This component is only a "style" -> concrete widget router. Adding a new
// style for numbers = 1) add the widget's file in ./widgets, 2) add the case
// here, 3) add the option + fields in settings/.
export default function NumberWidget({
  value, style, min, max, unit,
  matchTimeMode = "mmss", matchTimeYellow = 30, matchTimeRed = 15,
  graphTimeDisplayed = 5, graphColor = "#6262f1", graphLineWidth = 2,
  graphAutoRange = true, graphMin = 0, graphMax = 100,
  gaugeStartAngle = -140, gaugeEndAngle = 140, gaugeMin = 0, gaugeMax = 100,
  gaugeNumberOfLabels = 8, gaugeWrapValue = false, gaugeShowPointer = true, gaugeShowTicks = true,
  voltageMin = 4, voltageMax = 13, voltageDivisions = 5, voltageInverted = false, voltageOrientation = "horizontal",
}: Props) {
  const suffix = unitSuffix(unit)

  switch (style) {
    case "Bar":
      return <BarWidget value={value} min={min} max={max} suffix={suffix} />

    case "Deviation":
      return <DeviationWidget value={value} max={max} suffix={suffix} />

    case "Compass":
      return <NumberCompassWidget value={value} />

    case "MatchTime":
      return <MatchTimeWidget value={value} mode={matchTimeMode} yellowAt={matchTimeYellow} redAt={matchTimeRed} />

    case "Graph":
      return (
        <GraphWidget
          value={value}
          timeDisplayed={graphTimeDisplayed}
          color={graphColor}
          lineWidth={graphLineWidth}
          minValue={graphAutoRange ? undefined : graphMin}
          maxValue={graphAutoRange ? undefined : graphMax}
          suffix={suffix}
        />
      )

    case "Gauge":
      return (
        <RadialGaugeWidget
          value={value}
          min={gaugeMin}
          max={gaugeMax}
          startAngle={gaugeStartAngle}
          endAngle={gaugeEndAngle}
          numberOfLabels={gaugeNumberOfLabels}
          wrapValue={gaugeWrapValue}
          showPointer={gaugeShowPointer}
          showTicks={gaugeShowTicks}
          suffix={suffix}
        />
      )

    case "Voltage":
      return (
        <VoltageWidget
          value={value}
          min={voltageMin}
          max={voltageMax}
          divisions={voltageDivisions}
          inverted={voltageInverted}
          orientation={voltageOrientation}
        />
      )

    case "Text":
    default:
      return <TextValueWidget value={value} suffix={suffix} />
  }
}
