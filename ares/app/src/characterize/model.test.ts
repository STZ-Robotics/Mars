import { describe, expect, it } from "vitest"
import { fit, readRoutines, runTopic, slot0 } from "./model"

describe("characterize", () => {
  it("reads a routine's topics", () => {
    const r = readRoutines({
      "/Ares/Characterize/Drive/State": { String: "running" },
      "/Ares/Characterize/Drive/Progress": { Number: 0.5 },
      "/Ares/Characterize/Drive/Volts": { NumberArray: [1, 2, -1] },
      "/Ares/Characterize/Drive/Speed": { NumberArray: [7.5, 16.2, 7.4] },
      "/Ares/Characterize/Drive/kV": { Number: 0.1156 },
    })
    expect(r.Drive!.state).toBe("running")
    expect(r.Drive!.volts).toEqual([1, 2, -1])
    expect(r.Drive!.results.kV).toBe(0.1156)
    expect(r.Steer).toBeNull()
  })
  it("fits |V| = kS + kV·speed over the points that moved", () => {
    const speed = [0, 7.53, 11.85, 16.18, 24.83, -1]
    const volts = speed.map(s => (s > 0 ? 0.13 + 0.1156 * s : 0.1))
    const f = fit(volts, speed.map(Math.abs), 1)!
    expect(f.kS).toBeCloseTo(0.13, 6)
    expect(f.kV).toBeCloseTo(0.1156, 6)
    expect(f.n).toBe(4)
  })
  it("writes Tuner X's Slot0", () => {
    expect(slot0("driveGains", 0.12951, 0.115612, 0.2, 0)).toContain("withKS(0.1295).withKV(0.1156)")
    expect(runTopic("Steer")).toBe("/SmartDashboard/Ares Characterize/Steer/running")
  })
})
