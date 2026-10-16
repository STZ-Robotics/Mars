import { describe, expect, it } from "vitest"
import { defaultParams, gripUsed, javaSnippet, nominalWorld, robotCode } from "./model"

describe("tune model", () => {
  it("starts from what the robot code has", () => {
    const code = robotCode({ file: "T.java", driveKp: 0.2, driveKs: 0.1, driveKv: 0.12, speedAt12vMps: 5.5, slipCurrentA: 80, driveFrictionV: 0.2, translation: [7, 0, 0.1], rotation: [3, 0, 0] })
    expect(code.translation.kp).toBe(7)
    expect(code.driveKs).toBe(0.1)
    expect(code.statorLimitA).toBe(80)
    const params = defaultParams(code)
    expect(params.find(p => p.key === "translationKd")!.start).toBe(0.1)
    expect(params.filter(p => p.tune).map(p => p.key)).toEqual(["translationKp", "translationKd", "rotationKp", "rotationKd"])
  })
  it("falls back to Tuner X's defaults", () => {
    expect(robotCode(null).driveKv).toBe(0.124)
  })
  it("writes the gains as Java", () => {
    const params = defaultParams(robotCode(null))
    const values = params.map(p => p.start)
    values[0] = 12.3456
    const java = javaSnippet(params, values)
    expect(java).toContain("new AresController.Gains(12.3, 0, 0)")
    expect(java).not.toContain("Slot0Configs")
    params[6].tune = true
    expect(javaSnippet(params, values)).toContain("withKP(0.1)")
  })
  it("reads the robot into a world and a trajectory's grip", () => {
    const w = nominalWorld({ version: 1, name: "b", massKg: 58, moiKgM2: 7, cogHeightM: 0.35, bumper: { lengthM: 0.85, widthM: 0.85 },
      drivetrain: { type: "swerve", modules: [], wheelRadiusM: 0.0508, driveGearRatio: 5.27, driveMotor: "kraken_x60", driveMotorsPerModule: 1, driveCurrentLimitA: 120, wheelCof: 0.9, batteryVoltage: 12 } } as never)
    expect(w.mu).toBe(0.9)
    expect(gripUsed([{ modules: [{ gripUsed: 0.4 }, { gripUsed: 0.97 }] }])).toBe(0.97)
  })
})
