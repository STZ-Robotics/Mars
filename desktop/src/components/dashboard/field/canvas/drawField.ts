// The field itself: the schematic drawing, the grid, and the origin axes.
// Everything here is in meters of the internal frame.

import type { FieldPose } from "../../../../utils/field/poseExtraction"
import type { InternalPose } from "../../../../utils/field/fieldImages"
import type { Px } from "./types"

// Drawn centered on the origin, like the photo. The BLUE alliance goes on the
// right because that is where the internal frame leaves it: in wall_blue the
// origin (blue corner) is X=0, which maps to internal +X.
export function drawSchematicField(
  ctx: CanvasRenderingContext2D,
  px: Px,
  size: [number, number],
  showGrid: boolean,
  gridSpacing: number,
) {
  const [length, widthM] = size
  const halfL = length / 2
  const halfW = widthM / 2

  ctx.fillStyle = "#fbfbfc"
  ctx.fillRect(-halfL, -halfW, length, widthM)

  // Alliance zones (a third of the field on each side)
  const zone = length / 3
  ctx.fillStyle = "rgba(40, 90, 200, 0.07)"
  ctx.fillRect(halfL - zone, -halfW, zone, widthM)
  ctx.fillStyle = "rgba(200, 40, 40, 0.07)"
  ctx.fillRect(-halfL, -halfW, zone, widthM)

  if (showGrid) drawGrid(ctx, px, size, gridSpacing, "rgba(0, 0, 0, 0.07)")

  // Center line
  ctx.strokeStyle = "rgba(0, 0, 0, 0.28)"
  ctx.lineWidth = px(1.5)
  ctx.beginPath()
  ctx.moveTo(0, -halfW)
  ctx.lineTo(0, halfW)
  ctx.stroke()

  // Perimeter
  ctx.strokeStyle = "#3f3f46"
  ctx.lineWidth = px(2)
  ctx.strokeRect(-halfL, -halfW, length, widthM)
}

/** The same grid, but over the photo: for reading distances by eye. */
export function drawGridOverlay(
  ctx: CanvasRenderingContext2D,
  px: Px,
  size: [number, number],
  gridSpacing: number,
) {
  drawGrid(ctx, px, size, gridSpacing, "rgba(255, 255, 255, 0.35)")

  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)"
  ctx.lineWidth = px(1.5)
  ctx.strokeRect(-size[0] / 2, -size[1] / 2, size[0], size[1])
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  px: Px,
  size: [number, number],
  spacing: number,
  color: string,
) {
  const step = spacing > 0.05 ? spacing : 1
  const halfL = size[0] / 2
  const halfW = size[1] / 2

  ctx.strokeStyle = color
  ctx.lineWidth = px(1)
  ctx.beginPath()
  for (let x = -Math.floor(halfL / step) * step; x < halfL; x += step) {
    ctx.moveTo(x, -halfW)
    ctx.lineTo(x, halfW)
  }
  for (let y = -Math.floor(halfW / step) * step; y < halfW; y += step) {
    ctx.moveTo(-halfL, y)
    ctx.lineTo(halfL, y)
  }
  ctx.stroke()
}

/**
 * Axes at the robot's (0, 0), drawn by passing the unit axes through the same
 * conversion as the poses. That shows at a glance whether the chosen
 * coordinate system is the one the robot is publishing: if the red arrow does
 * not point towards the opposite alliance, the selector is wrong.
 */
export function drawOriginAxes(
  ctx: CanvasRenderingContext2D,
  px: Px,
  conv: (pose: FieldPose) => InternalPose,
) {
  const origin = conv({ x: 0, y: 0, theta: 0 })
  const axisX = conv({ x: 1, y: 0, theta: 0 })
  const axisY = conv({ x: 0, y: 1, theta: 0 })

  ctx.lineWidth = px(2.5)
  ctx.strokeStyle = "#c21c1c"
  ctx.beginPath()
  ctx.moveTo(origin.x, origin.y)
  ctx.lineTo(axisX.x, axisX.y)
  ctx.stroke()

  ctx.strokeStyle = "#1c8f1c"
  ctx.beginPath()
  ctx.moveTo(origin.x, origin.y)
  ctx.lineTo(axisY.x, axisY.y)
  ctx.stroke()

  ctx.fillStyle = "#18181b"
  ctx.beginPath()
  ctx.arc(origin.x, origin.y, px(3), 0, Math.PI * 2)
  ctx.fill()
}
