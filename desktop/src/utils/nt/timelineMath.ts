// Ported directly from AdvantageScope's util.ts (Littleton Robotics, BSD)
// Only the functions the timeline needs.

export function clampValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function scaleValue(value: number, oldRange: [number, number], newRange: [number, number]): number {
  return ((value - oldRange[0]) / (oldRange[1] - oldRange[0])) * (newRange[1] - newRange[0]) + newRange[0]
}

export function cleanFloat(float: number) {
  let output = Math.round(float * 1e6) / 1e6
  if (output === -0) output = 0
  return output
}

/** Computes a "nice" axis step (1, 2, 5, 10, 20, 50...) for tick spacing. */
export function calcAxisStepSize(dataRange: [number, number], pixelRange: number, stepSizeTarget: number): number {
  const stepCount = pixelRange / stepSizeTarget
  const stepValueApprox = (dataRange[1] - dataRange[0]) / stepCount
  const roundBase = 10 ** Math.floor(Math.log10(stepValueApprox))
  const multiplierLookup = [0, 1, 2, 2, 5, 5, 5, 5, 5, 10, 10]
  return roundBase * multiplierLookup[Math.round(stepValueApprox / roundBase)]
}