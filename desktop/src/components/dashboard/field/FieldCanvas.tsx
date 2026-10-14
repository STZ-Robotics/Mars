import React, { useEffect, useMemo, useRef, useState } from "react"
import { FieldObjectType, FieldSettings } from "../../../store/appStore"
import { FieldPose, FIELD_LENGTH_M, FIELD_WIDTH_M } from "../../../utils/field/poseExtraction"
import {
  CoordinateSystem, FieldConfig, InternalPose, toInternal, flipInternal,
} from "../../../utils/field/fieldImages"
import { HistoryStore } from "../../../utils/field/poseHistory"
import { Heatmap } from "../../../utils/field/heatmap"
import { RobotSprite } from "../../../utils/field/robotSprite"
import { drawGridOverlay, drawOriginAxes, drawSchematicField } from "./canvas/drawField"
import { drawObject, drawTrail } from "./canvas/drawObjects"
import {
  collectLabels, drawCursorReadout, drawLabels, drawMeasurement, drawScaleBar,
} from "./canvas/drawOverlay"
import type { DrawContext, Label, RenderedObject } from "./canvas/types"

export type { RenderedObject } from "./canvas/types"

interface Props {
  objects: RenderedObject[]
  settings: FieldSettings
  /** null = schematic drawing (no photo of the field). */
  field: FieldConfig | null
  /** The system the robot publishes in; overrides the JSON's. */
  coordinateSystem: CoordinateSystem
  /** Top-down bitmap of the team's model, if one is loaded. */
  sprite?: RobotSprite | null
  /** Meters per file unit of the sprite (auto-fit or manual scale). */
  spriteScale?: number
  /** false on the dashboard cards: no zoom, pan or measuring. */
  interactive?: boolean
  /** Measuring tool: click and drag for a ruler over the field. */
  measureMode?: boolean
  /** Changing it brings the framing back to its initial position. */
  resetToken?: number
  /** History shared with the page, so it can be cleared from the panel. */
  history?: HistoryStore
}

const FIELD_MARGIN_M = 0.4 // air around the schematic field, in meters

const MIN_ZOOM = 0.5
const MAX_ZOOM = 14

// Paint order. The heat map goes at the bottom and the robot on top of
// everything: otherwise the heatmap's blob would cover exactly what you are
// looking at.
const DRAW_ORDER: Record<FieldObjectType, number> = {
  heatmap: 0,
  trajectory: 1,
  target: 2,
  arrow: 3,
  ghost: 4,
  swerve: 5,
  robot: 6,
}

interface View {
  zoom: number
  panX: number
  panY: number
}

const IDENTITY_VIEW: View = { zoom: 1, panX: 0, panY: 0 }

// Everything is drawn in the INTERNAL frame: origin at the center of the
// playing area, +X to the right of the screen and +Y up (see fieldImages.ts).
// The poses the robot publishes are translated into that frame according to
// the chosen coordinate system, so the photo and the schematic drawing line up.
//
// Text is NOT drawn inside that frame: with the scale in meters and the Y axis
// inverted, any `fillText` would come out upside down and microscopic. Objects
// put their labels on a list with coordinates already projected to pixels,
// and a second pass paints them once the canvas is back to its normal
// transform.
export default function FieldCanvas({
  objects, settings, field, coordinateSystem,
  sprite = null, spriteScale = 1,
  interactive = true, measureMode = false, resetToken = 0,
  history: sharedHistory,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The current draw lives in a ref so the ResizeObserver is mounted ONCE and
  // not recreated on every value poll (they arrive at ~30Hz).
  const drawRef = useRef<() => void>(() => {})

  const [image, setImage] = useState<HTMLImageElement | null>(null)

  const viewRef = useRef<View>({ ...IDENTITY_VIEW })
  // The meters -> pixels matrix of the last draw. The pointer handlers invert
  // it to know which point of the field the mouse is over.
  const matrixRef = useRef<DOMMatrix | null>(null)
  const dprRef = useRef(1)
  const cursorRef = useRef<InternalPose | null>(null)
  const measureRef = useRef<{ from: InternalPose; to: InternalPose } | null>(null)
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  // A history of its own if the page does not share its: trails and the heat
  // map have to keep working on the dashboard cards.
  const ownHistory = useRef<HistoryStore | null>(null)
  if (ownHistory.current === null) ownHistory.current = new HistoryStore()
  const history = sharedHistory ?? ownHistory.current

  const heatmaps = useRef(new Map<string, Heatmap>())

  const sizeMeters = useMemo<[number, number]>(
    () => (field !== null ? field.sizeMeters : [FIELD_LENGTH_M, FIELD_WIDTH_M]),
    [field],
  )

  // The image is loaded once per field; meanwhile the schematic is drawn, so
  // switching fields never leaves the panel blank.
  useEffect(() => {
    if (field === null) {
      setImage(null)
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => { if (!cancelled) setImage(img) }
    img.onerror = () => { if (!cancelled) setImage(null) }
    img.src = field.imageUrl
    return () => { cancelled = true }
  }, [field?.imageUrl])

  // History accumulation. It goes in its own effect and not inside the draw:
  // the draw also runs when the settings or the size change, and that would
  // add repeated samples the heat map would count as real time.
  useEffect(() => {
    const now = Date.now()
    objects.forEach(obj => {
      if (obj.type === "trajectory" || obj.type === "swerve") return
      history.get(obj.id).push(obj.poses, now)
    })
    history.prune(objects.map(o => o.id))
  }, [objects, history])

  useEffect(() => {
    viewRef.current = { ...IDENTITY_VIEW }
    drawRef.current()
  }, [resetToken])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const draw = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      if (width === 0 || height === 0) return

      // Resizing the canvas clears it completely, so it is only done when the
      // size really changed, not on every data frame.
      const dpr = window.devicePixelRatio || 1
      dprRef.current = dpr
      const pixelW = Math.round(width * dpr)
      const pixelH = Math.round(height * dpr)
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
        canvas.width = pixelW
        canvas.height = pixelH
      }

      const ctx = canvas.getContext("2d")
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.lineCap = "round"
      ctx.lineJoin = "round"

      const view = viewRef.current
      const rotation = (-settings.orientation * Math.PI) / 180
      const cos = Math.abs(Math.cos(rotation))
      const sin = Math.abs(Math.sin(rotation))

      const useImage = field !== null && image !== null

      let ppmX: number
      let ppmY: number

      ctx.save()
      ctx.translate(width / 2 + view.panX, height / 2 + view.panY)
      ctx.scale(view.zoom, view.zoom)
      ctx.rotate(rotation)

      if (useImage) {
        const img = image!
        // The WHOLE image is framed (not only the playing area): the walls and
        // the driver stations are part of what you want to see.
        const rotW = img.naturalWidth * cos + img.naturalHeight * sin
        const rotH = img.naturalHeight * cos + img.naturalWidth * sin
        const scale = Math.min(width / rotW, height / rotH)

        const [tlx, tly] = field!.topLeft
        const [brx, bry] = field!.bottomRight
        ppmX = ((brx - tlx) * scale) / sizeMeters[0]
        ppmY = ((bry - tly) * scale) / sizeMeters[1]

        // The image is shifted so the CENTER OF THE PLAYING AREA (not the
        // photo's) lands on the origin: the playing area is almost never
        // centered in the image, and every pose is measured from its center.
        const fieldCenterX = (tlx + brx) / 2
        const fieldCenterY = (tly + bry) / 2
        ctx.drawImage(
          img,
          -fieldCenterX * scale,
          -fieldCenterY * scale,
          img.naturalWidth * scale,
          img.naturalHeight * scale,
        )
      } else {
        const contentW = sizeMeters[0] + FIELD_MARGIN_M * 2
        const contentH = sizeMeters[1] + FIELD_MARGIN_M * 2
        const rotW = contentW * cos + contentH * sin
        const rotH = contentH * cos + contentW * sin
        ppmX = ppmY = Math.min(width / rotW, height / rotH)
      }

      // From here on the units are METERS of the internal frame.
      ctx.scale(ppmX, -ppmY)
      matrixRef.current = ctx.getTransform()

      // SCREEN pixels per meter, with the zoom already applied: it is the
      // scale any width or radius that must stay constant while zooming has to
      // be converted with.
      const ppm = ppmX * view.zoom
      const px = (n: number) => n / ppm

      const flip = settings.allianceFlip
      const conv = (pose: FieldPose): InternalPose => {
        const internal = toInternal(coordinateSystem, pose.x, pose.y, pose.theta, sizeMeters)
        return flip ? flipInternal(internal) : internal
      }

      const matrix = matrixRef.current
      const project = (x: number, y: number) => {
        const point = matrix.transformPoint(new DOMPoint(x, y))
        return { x: point.x / dpr, y: point.y / dpr }
      }

      if (!useImage) drawSchematicField(ctx, px, sizeMeters, settings.showGrid, settings.gridSpacing)
      else if (settings.showGrid) drawGridOverlay(ctx, px, sizeMeters, settings.gridSpacing)

      if (settings.showAxes) drawOriginAxes(ctx, px, conv)

      const labels: Label[] = []
      const visible = objects.filter(o => !o.options.hidden)
      // The anchor of the objects that have no pose of their own: the first
      // robot in the list. Without a robot, a swerve or a vision mark would
      // not know where to stand, so they are simply not drawn.
      const anchor = visible.find(o => o.type === "robot" && o.poses.length > 0)
      const anchorPose = anchor ? conv(anchor.poses[0]) : null

      const env: DrawContext = {
        settings, anchorPose, sprite, spriteScale,
        heatmaps: heatmaps.current, history, sizeMeters,
        conv, project, labels,
      }

      const now = Date.now()
      const ordered = visible.slice().sort((a, b) => DRAW_ORDER[a.type] - DRAW_ORDER[b.type])

      for (const obj of ordered) {
        const opts = obj.options
        ctx.save()
        ctx.globalAlpha = opts.opacity

        if (opts.trailSeconds > 0 && obj.type !== "trajectory" && obj.type !== "heatmap") {
          const samples = history.get(obj.id).since(opts.trailSeconds, now)
          drawTrail(ctx, px, samples.map(conv), opts.trailColor ?? obj.color)
        }

        drawObject(ctx, px, obj, obj.poses.map(conv), env)

        if (settings.showLabels && opts.showLabel) {
          collectLabels(labels, obj, obj.poses, project, conv)
        }

        ctx.restore()
      }

      ctx.restore()

      // --- Screen pass: everything that carries text ---
      drawLabels(ctx, labels)
      if (interactive) {
        drawMeasurement(ctx, measureRef.current, project, coordinateSystem, sizeMeters, flip)
        drawScaleBar(ctx, height, ppm, view.zoom)
        if (settings.showCursor) {
          drawCursorReadout(ctx, width, height, cursorRef.current, coordinateSystem, sizeMeters, flip)
        }
      }
    }

    drawRef.current = draw
    draw()
  }, [
    objects, settings, field, image, coordinateSystem, sizeMeters,
    sprite, spriteScale, interactive, history,
  ])

  // Redraw when the container changes size, mounted only once.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => drawRef.current())
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // --- Pointer -----------------------------------------------------------------

  const toField = (event: { clientX: number; clientY: number }): InternalPose | null => {
    const matrix = matrixRef.current
    const canvas = canvasRef.current
    if (!matrix || !canvas) return null
    const rect = canvas.getBoundingClientRect()
    const dpr = dprRef.current
    const point = matrix.inverse().transformPoint(
      new DOMPoint((event.clientX - rect.left) * dpr, (event.clientY - rect.top) * dpr),
    )
    return { x: point.x, y: point.y, theta: 0 }
  }

  const handleWheel = (event: React.WheelEvent) => {
    if (!interactive) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const view = viewRef.current

    // deltaY comes in pixels or in lines depending on the device; only the
    // sign matters here, and a fixed step makes the zoom predictable.
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor))
    if (next === view.zoom) return

    // The point under the cursor is kept: always zooming towards the center
    // forces re-panning the view after every wheel turn.
    const cx = event.clientX - rect.left - rect.width / 2
    const cy = event.clientY - rect.top - rect.height / 2
    const ratio = next / view.zoom
    view.panX = cx - (cx - view.panX) * ratio
    view.panY = cy - (cy - view.panY) * ratio
    view.zoom = next
    drawRef.current()
  }

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!interactive) return
    if (event.button !== 0 && event.button !== 1) return
    canvasRef.current?.setPointerCapture(event.pointerId)

    if (measureMode && event.button === 0) {
      const point = toField(event)
      if (point) measureRef.current = { from: point, to: point }
      drawRef.current()
      return
    }

    const view = viewRef.current
    dragRef.current = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY }
  }

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!interactive) return
    cursorRef.current = toField(event)

    const measure = measureRef.current
    if (measureMode && measure && dragRef.current === null && event.buttons === 1) {
      const point = toField(event)
      if (point) measureRef.current = { from: measure.from, to: point }
      drawRef.current()
      return
    }

    const drag = dragRef.current
    if (drag) {
      const view = viewRef.current
      view.panX = drag.panX + (event.clientX - drag.x)
      view.panY = drag.panY + (event.clientY - drag.y)
    }
    drawRef.current()
  }

  const endDrag = (event: React.PointerEvent) => {
    if (!interactive) return
    canvasRef.current?.releasePointerCapture(event.pointerId)
    dragRef.current = null
  }

  const handlePointerLeave = () => {
    if (!interactive) return
    cursorRef.current = null
    dragRef.current = null
    drawRef.current()
  }

  const handleDoubleClick = () => {
    if (!interactive) return
    viewRef.current = { ...IDENTITY_VIEW }
    measureRef.current = null
    drawRef.current()
  }

  // Escape clears the ruler without having to turn the tool off.
  useEffect(() => {
    if (!interactive) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      measureRef.current = null
      drawRef.current()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [interactive])

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
        style={{
          display: "block",
          cursor: !interactive ? "default" : measureMode ? "crosshair" : "grab",
          touchAction: "none",
        }}
      />
    </div>
  )
}
