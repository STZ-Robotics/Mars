// Pose history per object, in the frame THE ROBOT PUBLISHES IN.
//
// The trails and heat maps come from here. The raw value is stored and not the
// one already converted to the internal frame on purpose: changing the field,
// the coordinate system or the alliance view remaps the whole history on the
// next draw, instead of leaving a trail stuck to the old framing.
//
// There are no logs involved: this is filled with what arrives over NT while
// the tab is open, and it can be cleared by hand.

import { FieldPose } from "./poseExtraction"

export interface PoseSample {
  x: number
  y: number
  theta: number
  /** Wall-clock milliseconds (Date.now()). */
  t: number
}

/** Hard cap on samples per object: ~25 min at 20 Hz. */
const MAX_SAMPLES = 30000
/** How many are dropped at once when reaching the cap (a shift per sample would be O(n²)). */
const DROP_CHUNK = 5000
/** Minimum period between samples. Faster than this the poll only repeats data. */
const MIN_PERIOD_MS = 45
/** An object with more poses than this is a path, not something that leaves a trail. */
const MAX_TRACKED_POSES = 4

export class PoseHistory {
  private samples: PoseSample[] = []
  /** Goes up with every accepted sample; used to invalidate derived caches. */
  version = 0

  push(poses: FieldPose[], t: number): void {
    if (poses.length === 0 || poses.length > MAX_TRACKED_POSES) return

    const last = this.samples[this.samples.length - 1]
    if (last && t - last.t < MIN_PERIOD_MS) return

    let added = false
    for (const pose of poses) {
      if (!isFinite(pose.x) || !isFinite(pose.y)) continue
      // The poll runs at 30 Hz and the robot may publish slower: without this, a
      // repeated value would weigh on the heat map as if the robot had really
      // been there all that time.
      if (last && last.x === pose.x && last.y === pose.y && last.theta === pose.theta) continue
      this.samples.push({ x: pose.x, y: pose.y, theta: pose.theta, t })
      added = true
    }
    if (!added) return

    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, DROP_CHUNK)
    this.version++
  }

  /** The samples of the last `seconds`, in chronological order. */
  since(seconds: number, now: number): PoseSample[] {
    if (seconds <= 0) return []
    const cutoff = now - seconds * 1000
    // Binary search: with 30 000 samples and 30 fps, walking back to front on
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

  all(): readonly PoseSample[] {
    return this.samples
  }

  /** Keeps a copy of another history (duplicating must not start from zero). */
  adopt(samples: readonly PoseSample[]): void {
    this.samples = samples.slice()
    this.version++
  }

  get length(): number {
    return this.samples.length
  }

  /** Seconds covered by what was accumulated. */
  get spanSeconds(): number {
    if (this.samples.length < 2) return 0
    return (this.samples[this.samples.length - 1].t - this.samples[0].t) / 1000
  }

  clear(): void {
    this.samples = []
    this.version++
  }
}

/** One history per object, cleaning up the ones no longer in the list. */
export class HistoryStore {
  private byId = new Map<string, PoseHistory>()

  get(id: string): PoseHistory {
    let hit = this.byId.get(id)
    if (!hit) {
      hit = new PoseHistory()
      this.byId.set(id, hit)
    }
    return hit
  }

  /** Discards the history of the objects removed from the panel. */
  prune(aliveIds: Iterable<string>): void {
    const alive = new Set(aliveIds)
    for (const id of Array.from(this.byId.keys())) {
      if (!alive.has(id)) this.byId.delete(id)
    }
  }

  clear(id?: string): void {
    if (id === undefined) this.byId.forEach(h => h.clear())
    else this.byId.get(id)?.clear()
  }

  /**
   * Copies what an object accumulated to the new one that duplicates it.
   *
   * Without this, duplicating the robot to see it as a heat map would start
   * the map empty even if the original had been collecting samples for half a
   * practice, which is exactly what you want to look at.
   */
  copy(fromId: string, toId: string): void {
    const source = this.byId.get(fromId)
    if (!source) return
    this.get(toId).adopt(source.all())
  }
}
