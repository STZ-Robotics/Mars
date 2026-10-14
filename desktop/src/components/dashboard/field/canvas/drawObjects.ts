// The objects on the field: robots, ghosts, trajectories, arrows, heat maps,
// vision targets and swerve modules, plus the trails behind them. Everything
// here is in meters of the internal frame.

import type { InternalPose } from "../../../../utils/field/fieldImages"
import type { ResolvedObjectOptions } from "../../../../utils/field/fieldObjects"
import { Heatmap, signatureOf } from "../../../../utils/field/heatmap"
import type { RobotSprite } from "../../../../utils/field/robotSprite"
import { moduleLocations } from "../../../../utils/field/swerveKinematics"
import { applyArrangement } from "../../../../hooks/useSwerveSources"
import { degrees, normalizeAngle, roundRect, withAlpha } from "./canvasUtils"
import type { DrawContext, Px, RenderedObject } from "./types"

export function drawObject(
  ctx: CanvasRenderingContext2D,
  px: Px,
  obj: RenderedObject,
  poses: InternalPose[],
  env: DrawContext,
) {
  const opts = obj.options
  const length = env.settings.robotSizeMeters
  const widthM = env.settings.robotWidthMeters

  switch (obj.type) {
    case "trajectory":
      drawTrajectory(ctx, px, poses, obj.color, opts)
      break

    case "robot":
    case "ghost": {
      const ghost = obj.type === "ghost"
      const useSprite = opts.useModel && env.sprite !== null
      poses.forEach(pose => {
        if (useSprite) {
          drawSprite(ctx, pose, env.sprite!, env.spriteScale, ghost)
          if (env.settings.showBumpers) {
            drawChassisOutline(ctx, px, pose, length, widthM, obj.color, ghost)
          }
        } else {
          drawChassis(ctx, px, pose, length, widthM, obj.color, ghost)
        }
      })
      break
    }

    case "arrow":
      poses.forEach(pose => {
        ctx.save()
        ctx.translate(pose.x, pose.y)
        ctx.rotate(pose.theta)
        ctx.strokeStyle = obj.color
        ctx.fillStyle = obj.color
        ctx.lineWidth = px(2.5)
        drawAnchoredArrow(ctx, opts.arrowLength, opts.arrowAnchor)
        ctx.restore()
      })
      break

    case "heatmap":
      drawHeatmap(ctx, obj, env)
      break

    case "target":
      drawTargets(ctx, px, poses, obj, env)
      break

    case "swerve":
      if (env.anchorPose && obj.modules && obj.modules.length > 0) {
        drawSwerveModules(ctx, px, env.anchorPose, obj, length, widthM)
      }
      break
  }
}

// --- Trajectories ------------------------------------------------------------

function drawTrajectory(
  ctx: CanvasRenderingContext2D,
  px: Px,
  poses: InternalPose[],
  color: string,
  opts: ResolvedObjectOptions,
) {
  if (poses.length === 0) return

  if (opts.trajectoryStyle === "points") {
    ctx.fillStyle = color
    poses.forEach(pose => {
      ctx.beginPath()
      ctx.arc(pose.x, pose.y, px(opts.trajectoryWidth * 0.9), 0, Math.PI * 2)
      ctx.fill()
    })
  } else if (poses.length >= 2) {
    ctx.lineWidth = px(opts.trajectoryWidth)

    if (opts.trajectoryStyle === "gradient") {
      // The gradient goes from the start of the path to its end: it is the
      // cheapest way to see which way the trajectory runs without filling it
      // with arrows.
      const first = poses[0]
      const last = poses[poses.length - 1]
      const gradient = ctx.createLinearGradient(first.x, first.y, last.x, last.y)
      gradient.addColorStop(0, withAlpha(color, 0.2))
      gradient.addColorStop(1, color)
      ctx.strokeStyle = gradient
    } else {
      ctx.strokeStyle = color
      if (opts.trajectoryStyle === "dashed") ctx.setLineDash([px(9), px(7)])
    }

    ctx.beginPath()
    poses.forEach((pose, i) => {
      if (i === 0) ctx.moveTo(pose.x, pose.y)
      else ctx.lineTo(pose.x, pose.y)
    })
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (opts.showWaypoints) {
    ctx.fillStyle = color
    poses.forEach(pose => {
      ctx.beginPath()
      ctx.arc(pose.x, pose.y, px(opts.trajectoryWidth * 0.8), 0, Math.PI * 2)
      ctx.fill()
    })
  }

  if (opts.showHeading) {
    // A dozen arrows at most: one per waypoint on a 300-point trajectory is a
    // solid smear.
    const stride = Math.max(1, Math.ceil(poses.length / 12))
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = px(1.5)
    for (let i = 0; i < poses.length; i += stride) {
      const pose = poses[i]
      ctx.save()
      ctx.translate(pose.x, pose.y)
      ctx.rotate(pose.theta)
      drawAnchoredArrow(ctx, 0.35, "back")
      ctx.restore()
    }
  }

  // Start and end: on a field with several overlapping trajectories it is
  // the first thing you look for.
  if (poses.length >= 2) {
    const first = poses[0]
    const last = poses[poses.length - 1]

    ctx.lineWidth = px(2)
    ctx.strokeStyle = color
    ctx.fillStyle = "#ffffff"
    ctx.beginPath()
    ctx.arc(first.x, first.y, px(4.5), 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = color
    const side = px(7)
    ctx.fillRect(last.x - side / 2, last.y - side / 2, side, side)
  }
}

// --- Chassis -----------------------------------------------------------------

function drawChassis(
  ctx: CanvasRenderingContext2D,
  px: Px,
  pose: InternalPose,
  length: number,
  widthM: number,
  color: string,
  ghost: boolean,
) {
  ctx.save()
  ctx.translate(pose.x, pose.y)
  ctx.rotate(pose.theta)

  const halfL = length / 2
  const halfW = widthM / 2
  // A real 3" bumper, capped so it does not eat everything on a small chassis.
  const bumper = Math.min(0.076, Math.min(length, widthM) * 0.16)
  const radius = Math.min(halfL, halfW) * 0.18

  if (ghost) {
    ctx.globalAlpha *= 0.55
    ctx.fillStyle = withAlpha(color, 0.16)
    roundRect(ctx, -halfL, -halfW, length, widthM, radius)
    ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = px(2)
    ctx.setLineDash([px(7), px(5)])
    roundRect(ctx, -halfL, -halfW, length, widthM, radius)
    ctx.stroke()
    ctx.setLineDash([])
  } else {
    // Colored bumpers outside and a dark chassis inside: it is the reading
    // everyone already has trained from watching the field from the stands.
    ctx.fillStyle = color
    roundRect(ctx, -halfL, -halfW, length, widthM, radius)
    ctx.fill()

    ctx.fillStyle = "rgba(24, 24, 28, 0.92)"
    roundRect(
      ctx,
      -halfL + bumper, -halfW + bumper,
      length - bumper * 2, widthM - bumper * 2,
      Math.max(0, radius - bumper),
    )
    ctx.fill()

    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)"
    ctx.lineWidth = px(1)
    roundRect(ctx, -halfL, -halfW, length, widthM, radius)
    ctx.stroke()
  }

  // A front wedge: a centered arrow gets confused with the next object's; a
  // wedge against the front bumper does not.
  ctx.fillStyle = ghost ? withAlpha(color, 0.8) : "#ffffff"
  const tip = halfL - bumper * 1.2
  const back = tip - Math.min(halfL, halfW) * 0.55
  ctx.beginPath()
  ctx.moveTo(tip, 0)
  ctx.lineTo(back, halfW * 0.42)
  ctx.lineTo(back, -halfW * 0.42)
  ctx.closePath()
  ctx.fill()

  ctx.restore()
}

/** Only the outline: drawn over the 3D model to mark the bumpers. */
function drawChassisOutline(
  ctx: CanvasRenderingContext2D,
  px: Px,
  pose: InternalPose,
  length: number,
  widthM: number,
  color: string,
  ghost: boolean,
) {
  ctx.save()
  ctx.translate(pose.x, pose.y)
  ctx.rotate(pose.theta)

  const radius = Math.min(length, widthM) * 0.09
  ctx.strokeStyle = color
  ctx.lineWidth = px(ghost ? 1.5 : 2.5)
  if (ghost) ctx.setLineDash([px(7), px(5)])
  roundRect(ctx, -length / 2, -widthM / 2, length, widthM, radius)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.restore()
}

/**
 * The model's top-down bitmap, placed at the pose.
 *
 * The `scale(1, -1)` is mandatory: the field canvas works with the Y axis
 * pointing up and `drawImage` assumes the opposite, so without that flip the
 * robot would come out mirrored.
 */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  pose: InternalPose,
  sprite: RobotSprite,
  metersPerUnit: number,
  ghost: boolean,
) {
  const width = sprite.spanX * metersPerUnit
  const height = sprite.spanY * metersPerUnit
  if (!isFinite(width) || width <= 0 || height <= 0) return

  ctx.save()
  ctx.translate(pose.x, pose.y)
  ctx.rotate(pose.theta)
  ctx.scale(1, -1)
  if (ghost) ctx.globalAlpha *= 0.45
  ctx.drawImage(sprite.canvas, -width / 2, -height / 2, width, height)
  ctx.restore()
}

// --- Arrows ------------------------------------------------------------------

/** An arrow `length` long pointing at +X, with the requested anchor at the origin. */
function drawAnchoredArrow(
  ctx: CanvasRenderingContext2D,
  length: number,
  anchor: "front" | "center" | "back",
) {
  const back = anchor === "front" ? -length : anchor === "back" ? 0 : -length / 2
  const front = back + length
  const head = Math.min(length * 0.32, 0.3)

  ctx.beginPath()
  ctx.moveTo(back, 0)
  ctx.lineTo(front, 0)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(front, 0)
  ctx.lineTo(front - head, head * 0.55)
  ctx.lineTo(front - head, -head * 0.55)
  ctx.closePath()
  ctx.fill()
}

// --- Trails ------------------------------------------------------------------

/**
 * The trail is drawn in segments with increasing alpha: a single `stroke` with
 * a gradient does not work because the path crosses itself and the canvas'
 * linear gradient does not follow the curve.
 */
export function drawTrail(
  ctx: CanvasRenderingContext2D,
  px: Px,
  samples: InternalPose[],
  color: string,
) {
  if (samples.length < 2) return

  // At 20 Hz and 10 s of trail there are 200 segments; above that samples are
  // skipped, which at that scale are a couple of millimeters.
  const stride = Math.max(1, Math.ceil(samples.length / 220))
  ctx.lineWidth = px(2)

  for (let i = stride; i < samples.length; i += stride) {
    const from = samples[i - stride]
    const to = samples[i]
    ctx.strokeStyle = withAlpha(color, 0.08 + 0.62 * (i / samples.length))
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }
}

// --- Heat map ----------------------------------------------------------------

function drawHeatmap(ctx: CanvasRenderingContext2D, obj: RenderedObject, env: DrawContext) {
  const frame = {
    sizeMeters: env.sizeMeters,
    cell: obj.options.heatmapCell,
    radius: obj.options.heatmapRadius,
  }
  const signature = signatureOf(frame)

  let heatmap = env.heatmaps.get(obj.id)
  // If the field or any parameter changed, the old grid no longer represents
  // anything: it is thrown away and rebuilt from the whole history.
  if (!heatmap || heatmap.signature !== signature) {
    heatmap = new Heatmap(frame)
    env.heatmaps.set(obj.id, heatmap)
  }

  const samples = env.history.get(obj.id).all()
  if (heatmap.consumed > samples.length) heatmap.reset()

  if (heatmap.consumed < samples.length) {
    // The history stores the RAW data, so the frame conversion happens here:
    // changing the alliance view remaps the whole map instead of leaving it
    // stuck to the framing it was recorded with.
    const fresh: { x: number; y: number }[] = []
    for (let i = heatmap.consumed; i < samples.length; i++) {
      fresh.push(env.conv(samples[i]))
    }
    heatmap.add(fresh)
    heatmap.consumed = samples.length
  }

  const image = heatmap.toCanvas()
  if (!image) return

  const [length, widthM] = env.sizeMeters
  ctx.save()
  // The same flip as the sprite: the grid was generated with row 0 at the top.
  ctx.scale(1, -1)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(image, -length / 2, -widthM / 2, length, widthM)
  ctx.restore()
}

// --- Vision targets ----------------------------------------------------------

function drawTargets(
  ctx: CanvasRenderingContext2D,
  px: Px,
  poses: InternalPose[],
  obj: RenderedObject,
  env: DrawContext,
) {
  const opts = obj.options
  const anchor = env.anchorPose
  const radius = px(7)

  poses.forEach(pose => {
    if (opts.targetLines && anchor) {
      ctx.strokeStyle = withAlpha(obj.color, 0.65)
      ctx.lineWidth = px(1.5)
      ctx.setLineDash([px(6), px(5)])
      ctx.beginPath()
      ctx.moveTo(anchor.x, anchor.y)
      ctx.lineTo(pose.x, pose.y)
      ctx.stroke()
      ctx.setLineDash([])

      if (opts.targetLabels) {
        const distance = Math.hypot(pose.x - anchor.x, pose.y - anchor.y)
        // The angle is given RELATIVE TO THE ROBOT'S FRONT: it is the error to
        // correct in order to aim, not an absolute orientation.
        const bearing = normalizeAngle(
          Math.atan2(pose.y - anchor.y, pose.x - anchor.x) - anchor.theta,
        )
        const mid = env.project((anchor.x + pose.x) / 2, (anchor.y + pose.y) / 2)
        env.labels.push({
          x: mid.x,
          y: mid.y,
          text: `${distance.toFixed(2)} m  ${degrees(bearing).toFixed(0)}°`,
          color: obj.color,
        })
      }
    }

    // Reticle: a circle with a cross. It reads as "point of interest" and is
    // not confused with a trajectory waypoint.
    ctx.strokeStyle = obj.color
    ctx.lineWidth = px(2)
    ctx.beginPath()
    ctx.arc(pose.x, pose.y, radius, 0, Math.PI * 2)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(pose.x - radius * 1.6, pose.y)
    ctx.lineTo(pose.x + radius * 1.6, pose.y)
    ctx.moveTo(pose.x, pose.y - radius * 1.6)
    ctx.lineTo(pose.x, pose.y + radius * 1.6)
    ctx.stroke()

    ctx.fillStyle = obj.color
    ctx.beginPath()
    ctx.arc(pose.x, pose.y, px(2), 0, Math.PI * 2)
    ctx.fill()
  })
}

// --- Swerve modules ----------------------------------------------------------

function drawSwerveModules(
  ctx: CanvasRenderingContext2D,
  px: Px,
  anchor: InternalPose,
  obj: RenderedObject,
  length: number,
  widthM: number,
) {
  const states = applyArrangement(obj.modules!, obj.options.swerveArrangement)
  const corners = moduleLocations(length, widthM)
  const maxSpeed = obj.options.swerveMaxSpeed
  const maxVector = Math.min(length, widthM) * 0.75

  ctx.save()
  ctx.translate(anchor.x, anchor.y)
  ctx.rotate(anchor.theta)

  corners.forEach((corner, i) => {
    const state = states[i]
    if (!state) return

    ctx.save()
    ctx.translate(corner.x, corner.y)

    // The module's mark: always visible, even with the wheel still. A stopped
    // module turned 90° is exactly the bug you come here looking for.
    ctx.strokeStyle = withAlpha(obj.color, 0.8)
    ctx.lineWidth = px(1.5)
    ctx.beginPath()
    ctx.arc(0, 0, px(3.5), 0, Math.PI * 2)
    ctx.stroke()

    ctx.rotate(state.angle)
    const ratio = maxSpeed > 0 ? Math.min(1.4, Math.abs(state.speed) / maxSpeed) : 0
    const vector = Math.max(0.06, ratio * maxVector) * (state.speed < 0 ? -1 : 1)

    ctx.strokeStyle = obj.color
    ctx.fillStyle = obj.color
    ctx.lineWidth = px(2.5)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(vector, 0)
    ctx.stroke()

    if (Math.abs(vector) > 0.1) {
      const head = Math.min(0.12, Math.abs(vector) * 0.35) * (vector < 0 ? -1 : 1)
      ctx.beginPath()
      ctx.moveTo(vector, 0)
      ctx.lineTo(vector - head, Math.abs(head) * 0.55)
      ctx.lineTo(vector - head, -Math.abs(head) * 0.55)
      ctx.closePath()
      ctx.fill()
    }

    ctx.restore()
  })

  ctx.restore()
}
