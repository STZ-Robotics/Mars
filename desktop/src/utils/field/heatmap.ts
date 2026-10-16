// The field's heat map: where an object was and for how long.
//
// The grid is filled INCREMENTALLY. The history only grows, so each frame only
// splats the new samples; recomputing the 30 000 from scratch at 30 fps would
// not keep up. If the framing or the parameters change, the signature changes
// and the caller throws this object away and creates another.

/** Which frame the grid lives in: the internal one, with the origin at the center. */
export interface HeatmapFrame {
  /** Length and width of the playing area, in meters. */
  sizeMeters: [number, number]
  /** The cell's side, in meters. */
  cell: number
  /** Each sample's radius of influence, in meters. */
  radius: number
}

// Gradient stops, from cold to hot. It is the classic heat map ramp: the eye
// reads where the maximum is at a glance without reading a scale.
const RAMP: [number, [number, number, number]][] = [
  [0.00, [43, 63, 176]],
  [0.28, [31, 158, 201]],
  [0.52, [47, 191, 95]],
  [0.76, [227, 197, 58]],
  [1.00, [214, 59, 59]],
]

/** The map's maximum alpha: above this it covers the field's photo. */
const MAX_ALPHA = 0.82
/** Lifts the low values, which otherwise go invisible next to a peak. */
const GAMMA = 0.62

export class Heatmap {
  readonly signature: string
  private cols: number
  private rows: number
  private cell: number
  private halfL: number
  private halfW: number
  private grid: Float32Array
  private kernel: Float32Array
  private kernelRadius: number
  private max = 0
  /** How many samples of the history already went into the grid. */
  consumed = 0
  private image: HTMLCanvasElement | null = null
  private imageVersion = -1
  private version = 0

  constructor(frame: HeatmapFrame) {
    // The cell is bounded below: 0.02 m over a 16 m field is 800 columns, and
    // the splatting ends up costing more than the rest of the drawing.
    this.cell = Math.max(0.05, frame.cell)
    this.halfL = frame.sizeMeters[0] / 2
    this.halfW = frame.sizeMeters[1] / 2
    this.cols = Math.max(1, Math.ceil(frame.sizeMeters[0] / this.cell))
    this.rows = Math.max(1, Math.ceil(frame.sizeMeters[1] / this.cell))
    this.grid = new Float32Array(this.cols * this.rows)

    const radius = Math.max(this.cell, frame.radius)
    this.kernelRadius = Math.min(24, Math.ceil(radius / this.cell))
    this.kernel = buildKernel(this.kernelRadius)

    this.signature = signatureOf(frame)
  }

  /** Splats samples already converted to the internal frame. */
  add(points: { x: number; y: number }[]): void {
    if (points.length === 0) return
    const { cols, rows, cell, halfL, halfW, kernel, kernelRadius: k } = this
    const side = 2 * k + 1

    for (const p of points) {
      const col = Math.floor((p.x + halfL) / cell)
      const row = Math.floor((halfW - p.y) / cell)
      // A pose outside the playing area (no odometry yet, or the wrong
      // coordinate system) is not clipped at the edge: it is ignored, so as not
      // to leave a hot band stuck to the wall.
      if (col < -k || col > cols + k || row < -k || row > rows + k) continue

      for (let dy = -k; dy <= k; dy++) {
        const r = row + dy
        if (r < 0 || r >= rows) continue
        const rowBase = r * cols
        const kernelBase = (dy + k) * side + k
        for (let dx = -k; dx <= k; dx++) {
          const c = col + dx
          if (c < 0 || c >= cols) continue
          const weight = kernel[kernelBase + dx]
          if (weight === 0) continue
          const next = this.grid[rowBase + c] + weight
          this.grid[rowBase + c] = next
          if (next > this.max) this.max = next
        }
      }
    }
    this.version++
  }

  reset(): void {
    this.grid.fill(0)
    this.max = 0
    this.consumed = 0
    this.version++
  }

  get isEmpty(): boolean {
    return this.max === 0
  }

  /**
   * The painted grid, one pixel per cell. The caller stretches it over the
   * playing area with `imageSmoothingEnabled`, which is what gives it the blur.
   */
  toCanvas(): HTMLCanvasElement | null {
    if (this.max === 0) return null
    if (this.image && this.imageVersion === this.version) return this.image

    const canvas = this.image ?? document.createElement("canvas")
    canvas.width = this.cols
    canvas.height = this.rows
    const ctx = canvas.getContext("2d")
    if (!ctx) return null

    const data = ctx.createImageData(this.cols, this.rows)
    const pixels = data.data
    for (let i = 0; i < this.grid.length; i++) {
      const raw = this.grid[i]
      if (raw === 0) continue
      const t = Math.pow(Math.min(1, raw / this.max), GAMMA)
      const [r, g, b] = sampleRamp(t)
      const o = i * 4
      pixels[o] = r
      pixels[o + 1] = g
      pixels[o + 2] = b
      // The alpha rises with the value: the areas it barely passed through fade
      // over the field instead of covering it with a flat blue.
      pixels[o + 3] = Math.round(255 * MAX_ALPHA * Math.min(1, t * 1.6))
    }
    ctx.putImageData(data, 0, 0)

    this.image = canvas
    this.imageVersion = this.version
    return canvas
  }
}

export function signatureOf(frame: HeatmapFrame): string {
  return [
    frame.sizeMeters[0].toFixed(3),
    frame.sizeMeters[1].toFixed(3),
    frame.cell.toFixed(3),
    frame.radius.toFixed(3),
  ].join("|")
}

/** A Gaussian truncated at `k` cells, normalized to 1 at the center. */
function buildKernel(k: number): Float32Array {
  const side = 2 * k + 1
  const out = new Float32Array(side * side)
  // σ = k/2 leaves the bell almost off (≈2σ) right at the radius' edge.
  const sigma = Math.max(0.5, k / 2)
  const twoSigmaSq = 2 * sigma * sigma
  for (let dy = -k; dy <= k; dy++) {
    for (let dx = -k; dx <= k; dx++) {
      const d2 = dx * dx + dy * dy
      out[(dy + k) * side + (dx + k)] = d2 > k * k ? 0 : Math.exp(-d2 / twoSigmaSq)
    }
  }
  return out
}

function sampleRamp(t: number): [number, number, number] {
  for (let i = 1; i < RAMP.length; i++) {
    const [stop, color] = RAMP[i]
    if (t > stop) continue
    const [prevStop, prevColor] = RAMP[i - 1]
    const span = stop - prevStop
    const f = span === 0 ? 0 : (t - prevStop) / span
    return [
      Math.round(prevColor[0] + (color[0] - prevColor[0]) * f),
      Math.round(prevColor[1] + (color[1] - prevColor[1]) * f),
      Math.round(prevColor[2] + (color[2] - prevColor[2]) * f),
    ]
  }
  return RAMP[RAMP.length - 1][1]
}
