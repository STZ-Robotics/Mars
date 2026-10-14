// The screen pass: everything that carries text, drawn after the canvas is
// back to its normal transform (in CSS pixels, not meters).

import type { FieldPose } from "../../../../utils/field/poseExtraction"
import {
  CoordinateSystem, InternalPose, fromInternal, flipInternal,
} from "../../../../utils/field/fieldImages"
import { degrees, roundRect } from "./canvasUtils"
import type { Label, Project, RenderedObject } from "./types"

export function collectLabels(
  labels: Label[],
  obj: RenderedObject,
  poses: FieldPose[],
  project: Project,
  conv: (pose: FieldPose) => InternalPose,
) {
  if (poses.length === 0) return
  // Only the first pose: labeling the 300 points of a trajectory would cover
  // the whole field.
  const raw = poses[0]
  const internal = conv(raw)
  const screen = project(internal.x, internal.y)

  const text = obj.type === "trajectory" || obj.type === "target"
    ? `${obj.label} (${poses.length})`
    : `${obj.label}  ${raw.x.toFixed(2)}, ${raw.y.toFixed(2)}, ${degrees(raw.theta).toFixed(0)}°`

  labels.push({ x: screen.x, y: screen.y - 16, text, color: obj.color })
}

export function drawLabels(ctx: CanvasRenderingContext2D, labels: Label[]) {
  if (labels.length === 0) return
  ctx.save()
  ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"

  labels.forEach(label => {
    const width = ctx.measureText(label.text).width + 10
    ctx.fillStyle = "rgba(16, 16, 20, 0.78)"
    roundRect(ctx, label.x - width / 2, label.y - 9, width, 18, 3)
    ctx.fill()
    ctx.fillStyle = label.color
    ctx.fillText(label.text, label.x, label.y)
  })

  ctx.restore()
}

export function drawMeasurement(
  ctx: CanvasRenderingContext2D,
  measure: { from: InternalPose; to: InternalPose } | null,
  project: Project,
  system: CoordinateSystem,
  sizeMeters: [number, number],
  flip: boolean,
) {
  if (!measure) return
  const distance = Math.hypot(measure.to.x - measure.from.x, measure.to.y - measure.from.y)
  if (distance === 0) return

  const from = project(measure.from.x, measure.from.y)
  const to = project(measure.to.x, measure.to.y)

  ctx.save()
  ctx.strokeStyle = "#f0b429"
  ctx.fillStyle = "#f0b429"
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.setLineDash([])

  for (const point of [from, to]) {
    ctx.beginPath()
    ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // The angle and the deltas are reported in the robot's frame and not the
  // internal one: they are the numbers you will later write in the code.
  const a = toUser(measure.from, system, sizeMeters, flip)
  const b = toUser(measure.to, system, sizeMeters, flip)
  const heading = degrees(Math.atan2(b.y - a.y, b.x - a.x))
  const text = `${distance.toFixed(3)} m · ${heading.toFixed(1)}° · Δ ${(b.x - a.x).toFixed(2)}, ${(b.y - a.y).toFixed(2)}`

  drawChip(ctx, (from.x + to.x) / 2, (from.y + to.y) / 2 - 18, text, "#f0b429")
  ctx.restore()
}

export function drawCursorReadout(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cursor: InternalPose | null,
  system: CoordinateSystem,
  sizeMeters: [number, number],
  flip: boolean,
) {
  if (!cursor) return
  const user = toUser(cursor, system, sizeMeters, flip)
  drawChip(ctx, width - 12, height - 16, `x ${user.x.toFixed(2)}   y ${user.y.toFixed(2)}`, "#e6e6ea", "right")
}

/** A reference ruler: without it, zooming leaves the scale up in the air. */
export function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  height: number,
  ppm: number,
  zoom: number,
) {
  // Pick the "round" multiple of a meter whose bar lands above 60 px: a 12 px
  // ruler cannot be read.
  const candidates = [0.25, 0.5, 1, 2, 5, 10]
  const meters = candidates.find(m => m * ppm >= 60) ?? candidates[candidates.length - 1]
  const bar = meters * ppm
  if (!isFinite(bar) || bar <= 0) return

  const x = 14
  const y = height - 18

  ctx.save()
  ctx.strokeStyle = "rgba(240, 240, 244, 0.9)"
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y - 4)
  ctx.lineTo(x, y + 4)
  ctx.moveTo(x, y)
  ctx.lineTo(x + bar, y)
  ctx.moveTo(x + bar, y - 4)
  ctx.lineTo(x + bar, y + 4)
  ctx.stroke()

  ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace"
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  const text = `${meters} m   ·   ${Math.round(zoom * 100)}%`
  const textWidth = ctx.measureText(text).width + 8
  ctx.fillStyle = "rgba(16, 16, 20, 0.7)"
  roundRect(ctx, x - 4, y - 22, textWidth, 15, 3)
  ctx.fill()
  ctx.fillStyle = "rgba(240, 240, 244, 0.95)"
  ctx.fillText(text, x, y - 14)
  ctx.restore()
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  align: CanvasTextAlign = "center",
) {
  ctx.save()
  ctx.font = "600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace"
  ctx.textAlign = align
  ctx.textBaseline = "middle"
  const width = ctx.measureText(text).width + 12
  const left = align === "right" ? x - width + 6 : x - width / 2
  ctx.fillStyle = "rgba(16, 16, 20, 0.82)"
  roundRect(ctx, left, y - 9, width, 18, 3)
  ctx.fill()
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** An internal-frame point back in the robot's coordinate system. */
function toUser(
  pose: InternalPose,
  system: CoordinateSystem,
  sizeMeters: [number, number],
  flip: boolean,
): InternalPose {
  const unflipped = flip ? flipInternal(pose) : pose
  return fromInternal(system, unflipped.x, unflipped.y, unflipped.theta, sizeMeters)
}
