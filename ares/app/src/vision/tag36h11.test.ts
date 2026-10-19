import { describe, expect, it } from "vitest"
import { tag36h11 } from "./tag36h11"

// What WPILib draws for these ids (AprilTag.generate36h11AprilTagImage), row by row, 1 = white.
const WPILIB: Record<number, string> = {
  0: "1111111111/1000000001/1011010101/1001110101/1001100001/1010100001/1001011001/1000010001/1000000001/1111111111",
  1: "1111111111/1000000001/1011011001/1001011101/1011110001/1001100001/1010110101/1000100101/1000000001/1111111111",
  25: "1111111111/1000000001/1010101101/1001110001/1001011001/1000110101/1010011101/1010101101/1000000001/1111111111",
  586: "1111111111/1000000001/1011101001/1000001101/1010111101/1010010001/1010110101/1011001101/1000000001/1111111111",
}

describe("tag36h11", () => {
  it("draws each tag exactly as WPILib does", () => {
    for (const [id, rows] of Object.entries(WPILIB)) {
      expect(tag36h11(Number(id))!.map(r => r.map(b => (b ? "1" : "0")).join("")).join("/")).toBe(rows)
    }
  })
  it("has no tag past the family", () => {
    expect(tag36h11(587)).toBeNull()
    expect(tag36h11(-1)).toBeNull()
  })
})
