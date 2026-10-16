// Field 3D trails: where each object went in the last few seconds.
//
// The point is stored ALREADY CONVERTED to the model's frame, the opposite of
// the 2D visualizer's history (which stores the raw value). Here the conversion
// depends on the alliance and the coordinate system, which do not change in the
// middle of a match; and the trail is drawn as a strip of vertices uploaded to
// the GPU as is, so having it in scene coordinates already avoids redoing the
// conversion of hundreds of points on every frame.
//
// There are no logs involved: this is filled with what arrives over NT while
// the tab is open, and it can be cleared by hand.

export interface TrailSample {
  x: number
  y: number
  z: number
  /** Wall-clock milliseconds (Date.now()). */
  t: number
}

/** Hard cap on samples per object: ~8 min at 60 Hz. */
const MAX_SAMPLES = 30000
/** How many are dropped at once when reaching the cap (a shift per sample would be O(n²)). */
const DROP_CHUNK = 5000
/** Minimum period between samples. Faster than this the poll only repeats data. */
const MIN_PERIOD_MS = 30
/** Minimum movement to record a new point, in meters. */
const MIN_STEP_M = 0.005

export class Trail {
  private samples: TrailSample[] = []

  push(x: number, y: number, z: number, t: number): void {
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return

    const last = this.samples[this.samples.length - 1]
    if (last) {
      if (t - last.t < MIN_PERIOD_MS) return
      // The robot standing still on the starting line would fill the buffer with
      // identical points and leave out the path that does matter.
      const moved = Math.hypot(x - last.x, y - last.y, z - last.z)
      if (moved < MIN_STEP_M) return
    }

    this.samples.push({ x, y, z, t })
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, DROP_CHUNK)
  }

  /** The samples of the last `seconds`, in chronological order. */
  since(seconds: number, now: number): TrailSample[] {
    if (seconds <= 0) return []
    const cutoff = now - seconds * 1000

    // Binary search: with 30 000 samples and 60 fps, walking back to front on
    // every frame is noticeable.
    let lo = 0
    let hi = this.samples.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.samples[mid].t < cutoff) lo = mid + 1
      else hi = mid
    }
    return this.samples.slice(lo)
  }

  get length(): number {
    return this.samples.length
  }

  /** Keeps a copy of another trail (duplicating must not start from zero). */
  adopt(samples: readonly TrailSample[]): void {
    this.samples = samples.slice()
  }

  all(): readonly TrailSample[] {
    return this.samples
  }

  clear(): void {
    this.samples = []
  }
}

/** One trail per object, cleaning up the ones no longer in the list. */
export class TrailStore {
  private byId = new Map<string, Trail>()

  get(id: string): Trail {
    let hit = this.byId.get(id)
    if (!hit) {
      hit = new Trail()
      this.byId.set(id, hit)
    }
    return hit
  }

  /** Discards the trail of the objects removed from the panel. */
  prune(aliveIds: Iterable<string>): void {
    const alive = new Set(aliveIds)
    for (const id of Array.from(this.byId.keys())) {
      if (!alive.has(id)) this.byId.delete(id)
    }
  }

  /** Copies what was accumulated to the object that duplicates another. */
  copy(fromId: string, toId: string): void {
    const source = this.byId.get(fromId)
    if (source) this.get(toId).adopt(source.all())
  }

  clear(id?: string): void {
    if (id === undefined) this.byId.forEach(trail => trail.clear())
    else this.byId.get(id)?.clear()
  }

  count(id: string): number {
    return this.byId.get(id)?.length ?? 0
  }
}
