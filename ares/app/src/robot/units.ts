// Quantities typed the way a team talks about them: "2in", "120 lb", "550mm".
// Everything is stored in SI; the unit is only how it was typed.

export type Dimension = "length" | "mass" | "plain"

const FACTORS: Record<Exclude<Dimension, "plain">, Record<string, number>> = {
  length: { "": 1, m: 1, cm: 0.01, mm: 0.001, in: 0.0254, '"': 0.0254, inch: 0.0254, inches: 0.0254, ft: 0.3048, "'": 0.3048 },
  mass: { "": 1, kg: 1, g: 0.001, lb: 0.45359237, lbs: 0.45359237 },
}

/** SI value of `text`, or null if it is not a number with a known unit. */
export function parseQuantity(text: string, dim: Dimension): number | null {
  const m = text.trim().toLowerCase().match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)\s*([a-z"']*)$/)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  if (dim === "plain") return m[2] === "" ? value : null
  const factor = FACTORS[dim][m[2]]
  return factor === undefined ? null : value * factor
}

/** A compact SI rendering, without float noise. */
export function formatSI(value: number, digits = 4): string {
  return String(Number(value.toPrecision(digits)))
}

/** The imperial reading next to a metric field, for teams that think in it. */
export function imperialHint(value: number, dim: Dimension): string | null {
  if (dim === "length") return `${(value / 0.0254).toFixed(2)} in`
  if (dim === "mass") return `${(value / 0.45359237).toFixed(1)} lb`
  return null
}
