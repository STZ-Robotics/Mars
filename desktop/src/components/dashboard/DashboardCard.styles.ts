import React from "react"

export const labelStyle: React.CSSProperties = { display: "block", fontSize: 9, color: "var(--text-muted)", marginBottom: 4, fontWeight: 600 }
export const inputStyle: React.CSSProperties = { width: "100%", background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-main)", padding: "4px 6px", borderRadius: 2, fontSize: 11, outline: "none", boxSizing: "border-box" }

// A free suffix for doubles: ONLY a visual label, it does not convert the value
// (we do not know what unit the raw double from NT4 comes in).
export const NUMBER_UNIT_OPTIONS = [
  { value: "", label: "None" },
  { value: "V", label: "Volts (V)" },
  { value: "RPM", label: "RPM" },
  { value: "RPS", label: "RPS" },
  { value: "deg", label: "Degrees (°)" },
  { value: "rad", label: "Radians (rad)" },
  { value: "rot", label: "Rotations (rot)" },
  { value: "m", label: "Meters (m)" },
  { value: "%", label: "Percent (%)" },
]

// Rotation2d IS really converted: the WPILib struct always arrives in radians.
export const ROTATION_UNIT_OPTIONS = [
  { value: "deg", label: "Degrees (°)" },
  { value: "rad", label: "Radians (rad)" },
]

export function unitSuffix(unit?: string) {
  if (!unit) return ""
  return unit === "%" ? "%" : ` ${unit}`
}
