interface Props {
  value: number
  min: number
  max: number
  startAngle: number
  endAngle: number
  numberOfLabels: number
  wrapValue: boolean
  showPointer: boolean
  showTicks: boolean
  suffix: string
}

// Angle convention: 0° = up (12 o'clock), clockwise positive (CW+), the same
// as Elastic documents its start_angle/end_angle.
function angleToPoint(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) }
}

function wrapAngleValue(value: number, min: number, max: number) {
  if (value >= min && value <= max) return value
  const modulus = max - min
  if (modulus <= 0) return value
  let v = value
  v -= Math.floor((v - min) / modulus) * modulus
  return v
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = angleToPoint(cx, cy, r, startAngle)
  const end = angleToPoint(cx, cy, r, endAngle)
  const largeArcFlag = Math.abs(endAngle - startAngle) > 180 ? 1 : 0
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
}

export default function RadialGaugeWidget({
  value, min, max, startAngle, endAngle, numberOfLabels, wrapValue: shouldWrap, showPointer, showTicks, suffix,
}: Props) {
  let v = shouldWrap ? wrapAngleValue(value, min, max) : value
  v = Math.max(min, Math.min(max, v))

  const range = max - min || 1
  const angleForValue = (val: number) => startAngle + ((val - min) / range) * (endAngle - startAngle)

  const size = 160
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 22

  const trackPath = describeArc(cx, cy, r, startAngle, endAngle)
  const valuePath = describeArc(cx, cy, r, startAngle, angleForValue(v))
  const needleAngle = angleForValue(v)
  const needleTip = angleToPoint(cx, cy, r - 6, needleAngle)

  const labels: { angle: number; text: string }[] = []
  if (showTicks) {
    const steps = Math.max(1, numberOfLabels - 1)
    for (let i = 0; i < numberOfLabels; i++) {
      const val = min + (range / steps) * i
      labels.push({ angle: angleForValue(val), text: val.toFixed(range / steps < 1 ? 1 : 0) })
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path d={trackPath} fill="none" stroke="var(--border-main)" strokeWidth={10} strokeLinecap="round" />
        <path d={valuePath} fill="none" stroke="var(--mars-accent)" strokeWidth={10} strokeLinecap="round" />

        {showTicks && labels.map((l, i) => {
          const tickLabelPos = angleToPoint(cx, cy, r + 18, l.angle)
          return (
            <text key={i} x={tickLabelPos.x} y={tickLabelPos.y} fontSize={8} fill="var(--text-muted)" textAnchor="middle" dominantBaseline="middle">
              {l.text}
            </text>
          )
        })}

        {showPointer && (
          <>
            <line x1={cx} y1={cy} x2={needleTip.x} y2={needleTip.y} stroke="var(--text-primary)" strokeWidth={2.5} strokeLinecap="round" />
            <circle cx={cx} cy={cy} r={5} fill="var(--text-primary)" />
          </>
        )}
      </svg>
      <span style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "var(--text-primary)", marginTop: -8 }}>
        {v.toFixed(2)}{suffix}
      </span>
    </div>
  )
}
