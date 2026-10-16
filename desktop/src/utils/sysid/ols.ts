// Ordinary least squares: solves β in X·β ≈ y.
//
// It uses the normal equation (XᵀX)β = Xᵀy with Gaussian elimination and
// partial pivoting. For 3 or 4 columns —which is all a feedforward fit needs—
// it is more than enough and does not drag in an algebra library.

export interface OlsResult {
  /** Coefficients, in the same order as X's columns. */
  coefficients: number[]
  /** Coefficient of determination: 1 = perfect fit, 0 = explains nothing. */
  rSquared: number
  /** Root mean square error, in y's units (volts). */
  rmse: number
  /** Muestras usadas. */
  count: number
  /**
   * The system's numeric health: smallest pivot over largest pivot, from 0 to
   * 1. Near 0 means two columns are almost the same thing and the
   * coefficients, even if R² looks fine, are garbage. The typical case is
   * running only the quasistatic tests: there the acceleration is almost
   * proportional to sgn(v) and kS/kA become indistinguishable.
   */
  conditioning: number
}

/**
 * @param x Design matrix: one row per sample, one column per term.
 * @param y Target vector, the same length as `x`.
 * @returns null if the system cannot be solved (too few samples, linearly
 *          dependent columns). That really happens: if a test did not move
 *          the mechanism, the acceleration column is all zeros.
 */
export function solveOls(x: number[][], y: number[]): OlsResult | null {
  const n = x.length
  if (n === 0 || y.length !== n) return null
  const cols = x[0].length
  if (cols === 0 || n < cols) return null

  // XᵀX (symmetric) and Xᵀy
  const xtx: number[][] = Array.from({ length: cols }, () => new Array(cols).fill(0))
  const xty: number[] = new Array(cols).fill(0)

  for (let row = 0; row < n; row++) {
    const r = x[row]
    if (r.length !== cols) return null
    for (let i = 0; i < cols; i++) {
      if (!isFinite(r[i])) return null
      for (let j = i; j < cols; j++) xtx[i][j] += r[i] * r[j]
      xty[i] += r[i] * y[row]
    }
  }
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < i; j++) xtx[i][j] = xtx[j][i]
  }

  const solved = solveWithPivots(xtx, xty)
  if (solved === null) return null
  const { solution: coefficients, conditioning } = solved

  // R² and RMSE over the predictions.
  const meanY = y.reduce((a, b) => a + b, 0) / n
  let ssRes = 0
  let ssTot = 0
  for (let row = 0; row < n; row++) {
    let pred = 0
    for (let i = 0; i < cols; i++) pred += x[row][i] * coefficients[i]
    ssRes += (y[row] - pred) ** 2
    ssTot += (y[row] - meanY) ** 2
  }

  return {
    coefficients,
    // With a constant y ssTot is 0: there is no variance to explain. 1 is
    // reported if the residual is also zero, and 0 if not, instead of dividing
    // by zero.
    rSquared: ssTot > 1e-12 ? 1 - ssRes / ssTot : (ssRes < 1e-12 ? 1 : 0),
    rmse: Math.sqrt(ssRes / n),
    count: n,
    conditioning,
  }
}

/** Below this the fit is not reliable even if R² looks high. */
export const POOR_CONDITIONING = 1e-6

/** Gaussian elimination with partial pivoting. Returns null if singular. */
export function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  return solveWithPivots(a, b)?.solution ?? null
}

// Same as solveLinearSystem but it also reports how ill-conditioned the system
// ended up, by looking at how the pivots collapsed.
function solveWithPivots(
  a: number[][],
  b: number[],
): { solution: number[]; conditioning: number } | null {
  const n = b.length
  // An augmented copy [A | b] so the input is not mutated.
  const m = a.map((row, i) => [...row, b[i]])
  let maxPivot = 0
  let minPivot = Infinity

  for (let col = 0; col < n; col++) {
    // Partial pivoting: without this, a tiny pivot amplifies the rounding error
    // until the result is useless.
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    }
    const magnitude = Math.abs(m[pivot][col])
    if (magnitude < 1e-12) return null
    if (magnitude > maxPivot) maxPivot = magnitude
    if (magnitude < minPivot) minPivot = magnitude
    if (pivot !== col) { const t = m[pivot]; m[pivot] = m[col]; m[col] = t }

    for (let r = col + 1; r < n; r++) {
      const factor = m[r][col] / m[col][col]
      if (factor === 0) continue
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c]
    }
  }

  const out = new Array(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row][n]
    for (let c = row + 1; c < n; c++) sum -= m[row][c] * out[c]
    out[row] = sum / m[row][row]
  }
  if (!out.every(isFinite)) return null
  return { solution: out, conditioning: maxPivot > 0 ? minPivot / maxPivot : 0 }
}
