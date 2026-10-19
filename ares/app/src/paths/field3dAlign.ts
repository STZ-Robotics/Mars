// Placing a 3D field (AdvantageScope's format) in WPILib's frame.
//
// Its config centers the model on the playing area, but which end is blue is not reliable: the
// 2026 model has red at -X once its config's rotations are applied. Its config lists where its
// AprilTags are, though, and WPILib's layout says where they really are, so the turn about Z that
// lands one on the other is the right one. Checked on 2026: turned 180 degrees, its 32 tags land
// within a millimeter of WPILib's.

import type { FieldAssetConfig } from "@desktop/utils/field3d/assetConfig"
import type { Tag } from "../vision/vision"

/** The turn about Z (radians) that puts the model's tags on WPILib's: 0 or 180 degrees. */
export function modelTurn(config: Pick<FieldAssetConfig, "aprilTags">, tags: Tag[], lengthM: number, widthM: number): number {
  const real = new Map(tags.map(t => [t.id, t]))
  const error = (turn: number) => {
    const c = Math.cos(turn), s = Math.sin(turn)
    let sum = 0, n = 0
    for (const t of config.aprilTags ?? []) {
      const w = real.get(t.id)
      if (!w) continue
      const [x, y] = t.position
      sum += Math.hypot(c * x - s * y + lengthM / 2 - w.x, s * x + c * y + widthM / 2 - w.y)
      n++
    }
    return n ? sum / n : Infinity
  }
  return error(Math.PI) < error(0) ? Math.PI : 0
}
