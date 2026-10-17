import { describe, expect, it } from "vitest"
import { poses, readLive, sample } from "./model"

function pose2d(...p: number[]): number[] {
  const buf = new ArrayBuffer(8 * p.length)
  const v = new DataView(buf)
  p.forEach((x, i) => v.setFloat64(8 * i, x, true))
  return [...new Uint8Array(buf)]
}

describe("live", () => {
  it("decodes WPILib's Pose2d structs", () => {
    expect(poses({ Raw: pose2d(1.5, 2.25, Math.PI / 2) })).toEqual([{ x: 1.5, y: 2.25, heading: Math.PI / 2 }])
    expect(poses({ Raw: pose2d(1, 2, 0, 3, 4, 1) }).length).toBe(2)
    expect(poses({ Number: 3 })).toEqual([])
  })
  it("reads what AresLib publishes", () => {
    const s = readLive({
      "/Ares/Active": { String: "Main" },
      "/Ares/Robot": { Raw: pose2d(2, 3, 0.1) },
      "/Ares/Target": { Raw: pose2d(2.1, 3, 0.1) },
      "/Ares/ErrorM": { Number: 0.1 },
      "/Ares/CommandedSpeeds": { NumberArray: [3, 4, 1] },
      "/Ares/MeasuredSpeeds": { NumberArray: [2.9, 3.9, 0.9] },
      "/Ares/Events": { StringArray: ["intake"] },
    })
    expect(s.robot!.x).toBe(2)
    expect(s.events).toEqual(["intake"])
    const k = sample(1, s)
    expect(k.cmdV).toBeCloseTo(5)
    expect(k.err).toBeCloseTo(0.1)
  })
})
