// What AresLib publishes under /Ares (AresTelemetry), decoded for the Live tab.

import type { NtValue } from "../characterize/model"
import { arr, num, str } from "../characterize/model"

export interface Pose { x: number; y: number; heading: number }

/** WPILib's Pose2d struct: x, y, then Rotation2d's value, as little-endian doubles. */
export function poses(v: NtValue | undefined): Pose[] {
  if (!v || !("Raw" in v)) return []
  const bytes = new Uint8Array(v.Raw)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Pose[] = []
  for (let o = 0; o + 24 <= bytes.byteLength; o += 24) {
    out.push({ x: view.getFloat64(o, true), y: view.getFloat64(o + 8, true), heading: view.getFloat64(o + 16, true) })
  }
  return out
}

export interface LiveState {
  active: string
  path: Pose[]
  target: Pose | null
  robot: Pose | null
  errorM: number
  timeS: number
  events: string[]
  replans: number
  commanded: number[]
  measured: number[]
  gainsSource: string
  translation: number[]
  rotation: number[]
}

export function readLive(values: Record<string, NtValue>): LiveState {
  const events = values["/Ares/Events"]
  return {
    active: str(values["/Ares/Active"]) ?? "",
    path: poses(values["/Ares/Path"]),
    target: poses(values["/Ares/Target"])[0] ?? null,
    robot: poses(values["/Ares/Robot"])[0] ?? null,
    errorM: num(values["/Ares/ErrorM"]) ?? 0,
    timeS: num(values["/Ares/TimeS"]) ?? 0,
    events: events && "StringArray" in events ? events.StringArray : [],
    replans: num(values["/Ares/Replans"]) ?? 0,
    commanded: arr(values["/Ares/CommandedSpeeds"]),
    measured: arr(values["/Ares/MeasuredSpeeds"]),
    gainsSource: str(values["/Ares/Gains/Source"]) ?? "",
    translation: arr(values["/Ares/Gains/Translation"]),
    rotation: arr(values["/Ares/Gains/Rotation"]),
  }
}

/** One moment of the history the charts draw. */
export interface Sample { t: number; cmdV: number; measV: number; cmdW: number; measW: number; err: number; active: string }

export function sample(t: number, s: LiveState): Sample {
  return {
    t,
    cmdV: Math.hypot(s.commanded[0] ?? 0, s.commanded[1] ?? 0),
    measV: Math.hypot(s.measured[0] ?? 0, s.measured[1] ?? 0),
    cmdW: s.commanded[2] ?? 0,
    measW: s.measured[2] ?? 0,
    err: s.active ? s.errorM : 0,
    active: s.active,
  }
}
