import { describe, it, expect } from "vitest"
import {
  Pose3D, composePose, frameTransform, fromFieldFrame, normalizeQuat,
  quatFromYaw, quatMultiply, rotateVector, toFieldFrame, yawOf,
} from "./frames"

// Real measurements of the 2026 field, so the calculations read like real life
// and not like made-up numbers.
const SIZE = { length: 16.541, width: 8.069 }
const HALF_X = SIZE.length / 2
const HALF_Y = SIZE.width / 2

function pose(x: number, y: number, z = 0, yaw = 0): Pose3D {
  const q = quatFromYaw(yaw)
  return { x, y, z, qw: q[0], qx: q[1], qy: q[2], qz: q[3] }
}

function expectClose(actual: number, expected: number, precision = 9) {
  expect(actual).toBeCloseTo(expected, precision)
}

describe("cuaterniones", () => {
  it("gets back the yaw that was put in", () => {
    for (const yaw of [0, 0.5, Math.PI / 2, -1.2, 3]) {
      expectClose(yawOf(quatFromYaw(yaw)), yaw)
    }
  })

  it("composes turns in the order they are applied", () => {
    const combined = quatMultiply(quatFromYaw(0.4), quatFromYaw(0.3))
    expectClose(yawOf(combined), 0.7)
  })

  it("turns a vector around Z", () => {
    const [x, y, z] = rotateVector(quatFromYaw(Math.PI / 2), [1, 0, 0])
    expectClose(x, 0)
    expectClose(y, 1)
    expectClose(z, 0)
  })

  it("falls back to the identity when the quaternion arrives as zero", () => {
    // A half-filled struct leaves (0,0,0,0), which as a matrix is degenerate:
    // without this sanitizing the piece disappears without any visible error.
    expect(normalizeQuat([0, 0, 0, 0])).toEqual([1, 0, 0, 0])
  })
})

describe("marco wall-blue (WPILib <= 2026)", () => {
  const transform = frameTransform("wall-blue", SIZE, "blue")

  it("sends the blue corner to the model's -X edge", () => {
    const result = toFieldFrame(pose(0, 0), transform)
    expectClose(result.x, -HALF_X)
    expectClose(result.y, -HALF_Y)
  })

  it("sends the red corner to the +X edge", () => {
    const result = toFieldFrame(pose(SIZE.length, SIZE.width), transform)
    expectClose(result.x, HALF_X)
    expectClose(result.y, HALF_Y)
  })

  it("does not touch the orientation: the axes already point the same way", () => {
    const result = toFieldFrame(pose(3, 2, 0, 1.1), transform)
    expectClose(yawOf([result.qw, result.qx, result.qy, result.qz]), 1.1)
  })

  it("does not depend on the alliance", () => {
    const red = frameTransform("wall-blue", SIZE, "red")
    expect(red.offset).toEqual(transform.offset)
  })
})

describe("marco wall-alliance", () => {
  it("with the blue alliance it is identical to wall-blue", () => {
    const alliance = frameTransform("wall-alliance", SIZE, "blue")
    const blue = frameTransform("wall-blue", SIZE, "blue")
    expect(alliance.offset).toEqual(blue.offset)
    expect(alliance.rotation).toEqual(blue.rotation)
  })

  it("with the red alliance the origin jumps to the red wall", () => {
    const transform = frameTransform("wall-alliance", SIZE, "red")
    const result = toFieldFrame(pose(0, 0), transform)
    expectClose(result.x, HALF_X)
    expectClose(result.y, HALF_Y)
  })

  it("with the red alliance the orientation turns half around", () => {
    const transform = frameTransform("wall-alliance", SIZE, "red")
    const result = toFieldFrame(pose(1, 1, 0, 0), transform)
    expectClose(Math.abs(yawOf([result.qw, result.qx, result.qy, result.qz])), Math.PI)
  })
})

describe("marco center-red (WPILib 2027+)", () => {
  it("it is already the model's frame", () => {
    const transform = frameTransform("center-red", SIZE, "blue")
    const result = toFieldFrame(pose(2.5, -1.5, 0.8, 0.6), transform)
    expectClose(result.x, 2.5)
    expectClose(result.y, -1.5)
    expectClose(result.z, 0.8)
    expectClose(yawOf([result.qw, result.qx, result.qy, result.qz]), 0.6)
  })
})

describe("marco center-rotated (FTC)", () => {
  it("turns a quarter turn", () => {
    const transform = frameTransform("center-rotated", SIZE, "blue")
    const result = toFieldFrame(pose(1, 0), transform)
    expectClose(result.x, 0)
    expectClose(result.y, -1)
  })
})

describe("round trip", () => {
  // The coordinate readout under the pointer has to show the SAME numbers you
  // would see in the robot code, so the inverse cannot be approximate.
  const cases = ["wall-blue", "wall-alliance", "center-red", "center-rotated"] as const

  for (const system of cases) {
    for (const alliance of ["blue", "red"] as const) {
      it(`${system} / ${alliance} comes back to the starting point`, () => {
        const transform = frameTransform(system, SIZE, alliance)
        const original = pose(3.4, -1.2, 0.75, 0.9)
        const back = fromFieldFrame(toFieldFrame(original, transform), transform)

        expectClose(back.x, original.x, 8)
        expectClose(back.y, original.y, 8)
        expectClose(back.z, original.z, 8)
        expectClose(yawOf([back.qw, back.qx, back.qy, back.qz]), 0.9, 8)
      })
    }
  }
})

describe("composePose", () => {
  it("adds translations when the parent does not turn", () => {
    const result = composePose(pose(1, 2, 3), pose(0.5, 0, 0.25))
    expectClose(result.x, 1.5)
    expectClose(result.y, 2)
    expectClose(result.z, 3.25)
  })

  it("turns the child with the parent", () => {
    // A component 1 m in front of the robot, with the robot facing +Y, ends up
    // 1 m to the left on the field.
    const result = composePose(pose(0, 0, 0, Math.PI / 2), pose(1, 0, 0))
    expectClose(result.x, 0)
    expectClose(result.y, 1)
  })

  it("accumulates the orientations", () => {
    const result = composePose(pose(0, 0, 0, 0.4), pose(0, 0, 0, 0.3))
    expectClose(yawOf([result.qw, result.qx, result.qy, result.qz]), 0.7)
  })
})
