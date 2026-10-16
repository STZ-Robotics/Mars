// A "round" axis step (1-2-5 × 10^n) aiming at ~targetTicks visible divisions,
// in the same spirit as MATLAB/AdvantageScope's step size calculation.
export function niceStep(range: number, targetTicks: number): number {
  if (!isFinite(range) || range <= 0 || targetTicks <= 0) return 1
  const roughStep = range / targetTicks
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const residual = roughStep / magnitude
  let niceResidual: number
  if (residual > 5) niceResidual = 10
  else if (residual > 2) niceResidual = 5
  else if (residual > 1) niceResidual = 2
  else niceResidual = 1
  return niceResidual * magnitude
}

// A wrapper meant to be used directly with the axis' size in pixels (like
// LineGraphRenderer uses Y_STEP_TARGET_PX / X_STEP_TARGET_PX in
// AdvantageScope): from the available screen size and a "target" of pixels
// per tick, it computes how many divisions fit and delegates to niceStep.
// This is what makes the axis look "alive": when zooming or changing the time
// window, targetTicks changes and the step jumps from 2 by 2, to 5 by 5,
// to 10 by 10, etc.
export function calcAxisStepSize(range: [number, number], axisSizePx: number, targetStepPx: number): number {
  const span = range[1] - range[0]
  const targetTicks = Math.max(2, axisSizePx / targetStepPx)
  return niceStep(span, targetTicks)
}