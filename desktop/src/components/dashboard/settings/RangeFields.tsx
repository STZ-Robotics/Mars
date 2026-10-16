import { labelStyle, inputStyle } from "../DashboardCard.styles"

interface Props {
  style: string
  min: number
  max: number
  onChangeMin: (v: number) => void
  onChangeMax: (v: number) => void
}

// MIN only applies to "Bar" (Deviation is symmetric about 0, it only uses MAX as the range).
export default function RangeFields({ style, min, max, onChangeMin, onChangeMax }: Props) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {style === "Bar" && (
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>MIN</label>
          <input type="number" value={min} onChange={e => onChangeMin(parseFloat(e.target.value) || 0)} style={inputStyle} />
        </div>
      )}
      <div style={{ flex: 1 }}>
        <label style={labelStyle}>MAX (RANGE)</label>
        <input type="number" value={max} onChange={e => onChangeMax(parseFloat(e.target.value) || 100)} style={inputStyle} />
      </div>
    </div>
  )
}
