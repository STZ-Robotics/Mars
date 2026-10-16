import { readDoubleLE } from "../../../utils/dashboard/valueDecoding"
import CompassDial from "./CompassDial"
import StructRow from "./StructRow"
import UnsupportedValue from "../../common/UnsupportedValue"

interface Props {
  rawVal: any
  style: string
  unit?: string
}

// A dedicated struct with a compass option and a real unit (rad/deg). WPILib's
// Rotation2d struct always serializes in radians.
export default function RotationWidget({ rawVal, style, unit }: Props) {
  if (!Array.isArray(rawVal) || rawVal.length < 8) {
    return <UnsupportedValue message="Unsupported struct: Rotation2d" />
  }

  const radians = readDoubleLE(rawVal, 0)
  const degrees = radians * (180 / Math.PI)
  const useRadians = unit === "rad"
  const displayValue = useRadians ? radians : degrees
  const suffix = useRadians ? " rad" : "°"

  if (style === "Compass") {
    return <CompassDial angleDeg={degrees} needleColor="var(--mars-accent)" valueLabel={`${displayValue.toFixed(2)}${suffix}`} />
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", padding: "0 12px" }}>
      <StructRow label="θ" val={displayValue.toFixed(2)} suffix={suffix} />
    </div>
  )
}
