export function degrees(radians: number): number {
  return (radians * 180) / Math.PI
}

/** Brings an angle into (-π, π]. */
export function normalizeAngle(radians: number): number {
  let angle = radians
  while (angle > Math.PI) angle -= 2 * Math.PI
  while (angle <= -Math.PI) angle += 2 * Math.PI
  return angle
}

/** Alpha over a hex color; it is all that is needed of a CSS parser. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim()
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return color
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.arcTo(x + width, y, x + width, y + r, r)
  ctx.lineTo(x + width, y + height - r)
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r)
  ctx.lineTo(x + r, y + height)
  ctx.arcTo(x, y + height, x, y + height - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}
