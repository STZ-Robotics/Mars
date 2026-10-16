import { describe, it, expect } from "vitest"
import { extractPose3d, extractPoses3d, isPose3dTopic, isSinglePoseTopic } from "./pose3d"
import { yawOf } from "./frames"

// WPILib structs serialize as LITTLE ENDIAN doubles packed one after the other,
// which is what arrives in `liveValue.Raw`.
function structBytes(...values: number[]): { Raw: number[] } {
  const buffer = new ArrayBuffer(values.length * 8)
  const view = new DataView(buffer)
  values.forEach((value, i) => view.setFloat64(i * 8, value, true))
  return { Raw: Array.from(new Uint8Array(buffer)) }
}

function expectClose(actual: number, expected: number, precision = 9) {
  expect(actual).toBeCloseTo(expected, precision)
}

describe("which topics the 3D field accepts", () => {
  it("accepts WPILib geometry, loose and in an array", () => {
    for (const type of [
      "struct:Pose3d", "struct:Pose3d[]", "struct:Pose2d", "struct:Translation3d[]",
      "struct:Transform3d", "struct:Translation2d",
    ]) {
      expect(isPose3dTopic(type)).toBe(true)
    }
  })

  it("accepts numeric arrays, which is the format inherited from Field2d", () => {
    expect(isPose3dTopic("double[]")).toBe(true)
    expect(isPose3dTopic("float[]")).toBe(true)
  })

  it("rejects what is not geometry", () => {
    for (const type of ["double", "boolean", "string[]", "struct:SwerveModuleState[]"]) {
      expect(isPose3dTopic(type)).toBe(false)
    }
  })

  it("tells a loose struct from an array", () => {
    expect(isSinglePoseTopic("struct:Pose3d")).toBe(true)
    expect(isSinglePoseTopic("struct:Pose3d[]")).toBe(false)
  })
})

describe("Pose3d", () => {
  it("reads raw translation and quaternion", () => {
    // (x, y, z, qw, qx, qy, qz) — Pose3d serializes Rotation3d as a quaternion,
    // not as roll/pitch/yaw.
    const value = structBytes(1.5, -2.25, 0.75, Math.SQRT1_2, 0, 0, Math.SQRT1_2)
    const pose = extractPose3d(value, "struct:Pose3d")!

    expectClose(pose.x, 1.5)
    expectClose(pose.y, -2.25)
    expectClose(pose.z, 0.75)
    expectClose(yawOf([pose.qw, pose.qx, pose.qy, pose.qz]), Math.PI / 2)
  })

  it("slices an array by the struct's size", () => {
    const first = structBytes(1, 2, 3, 1, 0, 0, 0).Raw
    const second = structBytes(4, 5, 6, 1, 0, 0, 0).Raw
    const poses = extractPoses3d({ Raw: [...first, ...second] }, "struct:Pose3d[]")

    expect(poses).toHaveLength(2)
    expectClose(poses[1].x, 4)
    expectClose(poses[1].z, 6)
  })

  it("normalizes a zero-norm quaternion instead of leaving the mesh degenerate", () => {
    const pose = extractPose3d(structBytes(0, 0, 0, 0, 0, 0, 0), "struct:Pose3d")!
    expect(pose.qw).toBe(1)
  })
})

describe("Pose2d levantada a 3D", () => {
  it("leaves z at zero and turns θ into a turn around +Z", () => {
    // The struct stores θ in RADIANS; the generic decoder takes it to degrees
    // and this module brings it back to radians.
    const pose = extractPose3d(structBytes(3, 4, Math.PI / 3), "struct:Pose2d")!

    expectClose(pose.x, 3)
    expectClose(pose.y, 4)
    expect(pose.z).toBe(0)
    expectClose(yawOf([pose.qw, pose.qx, pose.qy, pose.qz]), Math.PI / 3, 6)
  })

  it("a Translation2d provides no orientation", () => {
    const pose = extractPose3d(structBytes(1, 2), "struct:Translation2d")!
    expect(pose.qw).toBe(1)
    expect(pose.z).toBe(0)
  })
})

describe("numeric arrays", () => {
  it("reads [x, y, θ°] triples — the Field2d format", () => {
    const poses = extractPoses3d({ NumberArray: [1, 2, 90, 3, 4, -90] }, "double[]")

    expect(poses).toHaveLength(2)
    expectClose(poses[0].x, 1)
    expectClose(yawOf([poses[0].qw, poses[0].qx, poses[0].qy, poses[0].qz]), Math.PI / 2)
    expectClose(yawOf([poses[1].qw, poses[1].qx, poses[1].qy, poses[1].qz]), -Math.PI / 2)
  })

  it("reads septets when the length can only be 3D", () => {
    // 7 numbers do not fit in triples, so no hint at all is needed.
    const poses = extractPoses3d({ NumberArray: [1, 2, 3, 1, 0, 0, 0] }, "double[]")
    expect(poses).toHaveLength(1)
    expectClose(poses[0].z, 3)
  })

  it("on a tie it prefers triples, which is the old format", () => {
    // 21 numbers fit both (7 triples or 3 septets).
    const array = Array.from({ length: 21 }, (_, i) => i)
    expect(extractPoses3d({ NumberArray: array }, "double[]")).toHaveLength(7)
  })

  it("respects the format pinned by hand when the heuristic is not enough", () => {
    const array = Array.from({ length: 21 }, (_, i) => i)
    expect(extractPoses3d({ NumberArray: array }, "double[]", "pose3d")).toHaveLength(3)
  })

  it("drops the incomplete tail instead of making up zeros", () => {
    expect(extractPoses3d({ NumberArray: [1, 2, 0, 4, 5] }, "double[]")).toHaveLength(1)
  })
})

describe("values that cannot be read", () => {
  it("returns an empty list instead of breaking", () => {
    expect(extractPoses3d(null, "struct:Pose3d")).toEqual([])
    expect(extractPoses3d({ Raw: [] }, "struct:Pose3d")).toEqual([])
    expect(extractPoses3d({ NumberArray: [] }, "double[]")).toEqual([])
    expect(extractPoses3d({ Number: 5 }, "double")).toEqual([])
    // A struct the app cannot read must not slip in as an empty pose.
    expect(extractPoses3d({ Raw: [1, 2, 3] }, "struct:Desconocido")).toEqual([])
  })

  it("filters out poses with NaN, which would leave the mesh undrawn", () => {
    expect(extractPoses3d({ NumberArray: [NaN, 1, 0] }, "double[]")).toEqual([])
  })
})
