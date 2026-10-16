import { labelStyle, inputStyle, NUMBER_UNIT_OPTIONS } from "../DashboardCard.styles"

export default function NumberUnitField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={labelStyle}>UNIT LABEL</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={inputStyle}>
        {NUMBER_UNIT_OPTIONS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
      </select>
      <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.4 }}>
        Only adds the suffix to the displayed value; it does not convert the number.
      </div>
    </div>
  )
}
