// Loading of the team's model and its top-down render, for the 2D Visualizer.
//
// The bitmap is NOT regenerated on zooming: it is rendered once at 512 px and
// the canvas stretches it. A 0.85 m robot takes ~60 px in the full field view,
// so 512 px is more than enough even at maximum zoom, and re-rendering the STL
// on every mouse wheel turn would make the view jump.

import { useEffect, useMemo, useState } from "react"
import { FieldSettings } from "../store/appStore"
import { RobotSprite, getRobotSprite, quantizeSpriteSize } from "../utils/field/robotSprite"

export type SpriteStatus = "empty" | "loading" | "ready" | "error"

const SPRITE_PX = quantizeSpriteSize(512)

export interface RobotSpriteState {
  sprite: RobotSprite | null
  /** Meters per file unit: what has to be multiplied to draw it. */
  scale: number
  status: SpriteStatus
  error: string | null
}

export function useRobotSprite(settings: FieldSettings): RobotSpriteState {
  const [sprite, setSprite] = useState<RobotSprite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const { robotModelPath, robotModelColor, robotModelRotation } = settings

  useEffect(() => {
    if (robotModelPath === null) {
      setSprite(null)
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    getRobotSprite({
      path: robotModelPath,
      sizePx: SPRITE_PX,
      color: robotModelColor,
      rotationDeg: robotModelRotation,
    })
      .then(next => {
        if (cancelled) return
        setSprite(next)
        setLoading(false)
      })
      .catch(reason => {
        if (cancelled) return
        setSprite(null)
        setError(String(reason?.message ?? reason))
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [robotModelPath, robotModelColor, robotModelRotation])

  // Auto-fit matches the model's FOOTPRINT to the chassis' length, which is what
  // makes an STL in millimeters or in inches land right without anyone having to
  // find out what units their CAD exported it in.
  const scale = useMemo(() => {
    if (sprite === null) return 1
    if (!settings.robotModelAutoFit) return settings.robotModelScale
    return sprite.spanX > 0 ? settings.robotSizeMeters / sprite.spanX : 1
  }, [sprite, settings.robotModelAutoFit, settings.robotModelScale, settings.robotSizeMeters])

  const status: SpriteStatus =
    loading ? "loading"
      : error !== null ? "error"
        : sprite !== null ? "ready"
          : "empty"

  return { sprite, scale, status, error }
}
