// The field as a sketch instead of an assembly: its photo turned into a line
// drawing, black on white like a printed plan, with the alliance-colored
// parts kept in dark red and dark blue.
//
// No CAD needed: any calibrated field image works. The edges come from a
// blurred gray copy (Sobel gradient, thinned to one pixel by non-maximum
// suppression, a soft threshold relative to the image's own contrast), and
// each edge takes the alliance color when the photo is red or blue there.

const WIDTH = 1900
const cache = new Map<string, Promise<HTMLCanvasElement>>()

const BACKGROUND = [255, 255, 255]
const LINE = [22, 22, 26]
const RED = [168, 24, 24]
const BLUE = [22, 66, 160]

export function fieldSketch(image: HTMLImageElement): Promise<HTMLCanvasElement> {
  const hit = cache.get(image.src)
  if (hit) return hit
  const job = new Promise<HTMLCanvasElement>(resolve => {
    // Off the current frame: it is a few hundred milliseconds of work.
    setTimeout(() => resolve(sketch(image)), 0)
  })
  cache.set(image.src, job)
  return job
}

function sketch(image: HTMLImageElement): HTMLCanvasElement {
  const w = WIDTH
  const h = Math.round((image.height * w) / image.width)
  const src = document.createElement("canvas")
  src.width = w
  src.height = h
  const sctx = src.getContext("2d", { willReadFrequently: true })!
  sctx.drawImage(image, 0, 0, w, h)
  const rgba = sctx.getImageData(0, 0, w, h).data

  const n = w * h
  const gray = new Float32Array(n)
  for (let i = 0; i < n; i++) gray[i] = (rgba[4 * i] + rgba[4 * i + 1] + rgba[4 * i + 2]) / (3 * 255)

  const g = blur(gray, w, h)
  const gx = new Float32Array(n)
  const gy = new Float32Array(n)
  const mag = new Float32Array(n)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      gx[i] = g[i + 1] - g[i - 1]
      gy[i] = g[i + w] - g[i - w]
      mag[i] = Math.hypot(gx[i], gy[i])
    }
  }

  // Thin to one pixel: keep a pixel only where it beats both neighbors
  // across the edge.
  const thin = new Float32Array(n)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const m = mag[i]
      if (m === 0) continue
      const a = Math.atan2(gy[i], gx[i])
      const q = ((Math.round(a / (Math.PI / 4)) % 4) + 4) % 4
      const [dx, dy] = q === 0 ? [1, 0] : q === 1 ? [1, 1] : q === 2 ? [0, 1] : [-1, 1]
      if (m >= mag[i + dy * w + dx] && m >= mag[i - dy * w - dx]) thin[i] = m
    }
  }

  // Threshold relative to the image: the 88th percentile of the gradient.
  const sorted = Float32Array.from(mag).sort()
  const t = sorted[Math.floor(n * 0.88)] || 1e-3

  const out = new ImageData(w, h)
  const o = out.data
  for (let i = 0; i < n; i++) {
    const e = Math.min(1, Math.max(0, (thin[i] - t * 0.6) / (t * 0.8)))
    const r = rgba[4 * i] / 255, gg = rgba[4 * i + 1] / 255, b = rgba[4 * i + 2] / 255
    const color = r > gg + 0.18 && r > b + 0.18 ? RED : b > r + 0.12 && b > gg + 0.03 ? BLUE : LINE
    for (let c = 0; c < 3; c++) o[4 * i + c] = BACKGROUND[c] * (1 - e) + color[c] * e
    o[4 * i + 3] = 255
  }
  const dst = document.createElement("canvas")
  dst.width = w
  dst.height = h
  dst.getContext("2d")!.putImageData(out, 0, 0)
  return dst
}

/** A 5-tap binomial blur, horizontal then vertical. */
function blur(a: Float32Array, w: number, h: number): Float32Array {
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16]
  const tmp = new Float32Array(a.length)
  const out = new Float32Array(a.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let j = -2; j <= 2; j++) s += a[y * w + Math.min(w - 1, Math.max(0, x + j))] * k[j + 2]
      tmp[y * w + x] = s
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let j = -2; j <= 2; j++) s += tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x] * k[j + 2]
      out[y * w + x] = s
    }
  }
  return out
}
