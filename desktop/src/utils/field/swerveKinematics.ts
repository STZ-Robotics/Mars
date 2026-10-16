// Forward kinematics of a swerve, solved by least squares.
//
// Each module at position (x_i, y_i) of the robot's frame contributes two
// equations on the chassis' unknowns (vx, vy, ω):
//
//   vx_i = vx − ω·y_i
//   vy_i = vy + ω·x_i
//
// With 4 modules there are 8 equations and 3 unknowns: the system is
// overdetermined, so in general it has NO exact solution. That is exactly what
// is useful: the fit's residual measures how much the modules contradict each
// other. If all 4 describe the same rigid-body motion the residual is 0; if one
// slips, has a shifted encoder offset or the wrong wheel radius, that module
// comes off the fit and its residual goes up.

import { ModuleState } from "./swerveExtraction"

export interface ModuleLocation {
  x: number  // m, hacia adelante
  y: number  // m, hacia la izquierda
}

export interface KinematicsSolution {
  vx: number
  vy: number
  omega: number
  /** The vector EACH module should have if the fit were exact. */
  predicted: { vx: number; vy: number }[]
  /** |measured − predicted| per module, in m/s. */
  residuals: number[]
  /** Root mean square residual, in m/s. */
  rmsResidual: number
}

// Module locations in drawing order FL, FR, BL, BR.
export function moduleLocations(frameLength: number, frameWidth: number): ModuleLocation[] {
  const halfL = frameLength / 2
  const halfW = frameWidth / 2
  return [
    { x: halfL, y: halfW },    // FL
    { x: halfL, y: -halfW },   // FR
    { x: -halfL, y: halfW },   // BL
    { x: -halfL, y: -halfW },  // BR
  ]
}

// Cartesian components of a module's vector, in the robot's frame.
function moduleVector(state: ModuleState): { vx: number; vy: number } {
  return {
    vx: state.speed * Math.cos(state.angle),
    vy: state.speed * Math.sin(state.angle),
  }
}

// Inverse of a symmetric 3x3 matrix. Returns null if it is singular (it
// happens, for example, if all the modules are at the same point).
function invert3x3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0]
  const [d, e, f] = m[1]
  const [g, h, i] = m[2]

  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) return null

  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

// Solves the normal equations AᵀA·u = Aᵀb.
//
// For the usual symmetric layout, AᵀA becomes diagonal and this reduces to
// averaging the (vx, vy) vectors and sharing the moment among the modules;
// the general case is solved anyway, so it keeps working with asymmetric
// chassis or with fewer than 4 modules.
export function solveChassis(
  states: ModuleState[],
  locations: ModuleLocation[],
): KinematicsSolution | null {
  const n = Math.min(states.length, locations.length)
  if (n < 2) return null

  let ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  let atb = [0, 0, 0]

  for (let i = 0; i < n; i++) {
    const { x, y } = locations[i]
    const v = moduleVector(states[i])

    // Row [1, 0, −y] with independent term vx_i
    ata[0][0] += 1
    ata[0][2] += -y
    ata[2][0] += -y
    ata[2][2] += y * y
    atb[0] += v.vx
    atb[2] += -y * v.vx

    // Row [0, 1, x] with independent term vy_i
    ata[1][1] += 1
    ata[1][2] += x
    ata[2][1] += x
    ata[2][2] += x * x
    atb[1] += v.vy
    atb[2] += x * v.vy
  }

  const inv = invert3x3(ata)
  if (!inv) return null

  const vx = inv[0][0] * atb[0] + inv[0][1] * atb[1] + inv[0][2] * atb[2]
  const vy = inv[1][0] * atb[0] + inv[1][1] * atb[1] + inv[1][2] * atb[2]
  const omega = inv[2][0] * atb[0] + inv[2][1] * atb[1] + inv[2][2] * atb[2]

  const predicted: { vx: number; vy: number }[] = []
  const residuals: number[] = []
  let sumSquares = 0

  for (let i = 0; i < n; i++) {
    const { x, y } = locations[i]
    const p = { vx: vx - omega * y, vy: vy + omega * x }
    const m = moduleVector(states[i])
    const residual = Math.hypot(m.vx - p.vx, m.vy - p.vy)

    predicted.push(p)
    residuals.push(residual)
    sumSquares += residual * residual
  }

  return { vx, vy, omega, predicted, residuals, rmsResidual: Math.sqrt(sumSquares / n) }
}

// The instantaneous center of rotation, in the robot's frame: the point the
// chassis is turning around at this instant. For pure translation (ω ≈ 0) it
// goes to infinity, so nothing is returned.
export function computeICR(vx: number, vy: number, omega: number): { x: number; y: number } | null {
  if (Math.abs(omega) < 0.05) return null
  return { x: -vy / omega, y: vx / omega }
}

// Converts a cartesian vector of the robot's frame to the (speed, angle) form
// the module renderer uses.
export function vectorToModuleState(v: { vx: number; vy: number }): ModuleState {
  return { speed: Math.hypot(v.vx, v.vy), angle: Math.atan2(v.vy, v.vx) }
}

// Brings an angle to (−180, 180]. Modules usually publish the accumulated,
// unwrapped azimuth (11246° instead of 86°): for drawing it does not matter
// because sin/cos are periodic, but for READING it, it does.
export function wrapDegrees(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180
}

// The shortest angular difference between two angles, in degrees. Without this,
// the error between 179° and −179° would give 358° instead of 2°.
export function angleErrorDegrees(fromRadians: number, toRadians: number): number {
  const delta = (toRadians - fromRadians) * (180 / Math.PI)
  return wrapDegrees(delta)
}
