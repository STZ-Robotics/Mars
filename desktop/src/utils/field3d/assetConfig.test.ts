import { describe, it, expect } from "vitest"
import { composeRotations, formatBytes, parseAssetConfig } from "./assetConfig"
import { rotateVector } from "./frames"

// An excerpt of the real config.json of `Field3d_2026FRCFieldV1`, AdvantageScope's
// official package. It is copied verbatim (including the list of pieces already
// in place) so the tests fail if parsing stops accepting the format as they
// publish it.
const FIELD_2026 = JSON.stringify({
  name: "2026 Field",
  isFTC: false,
  coordinateSystem: "wall-blue",
  rotations: [{ axis: "x", degrees: 90 }],
  widthInches: 651.22,
  heightInches: 317.677,
  driverStations: [
    [8.2775425, -3.07975], [8.2775425, 0], [8.2775425, 3.07975],
    [-8.2775425, 3.07975], [-8.2775425, 0], [-8.2775425, -3.07975],
  ],
  gamePieces: [
    {
      name: "Fuel",
      rotations: [],
      position: [0, 0, 0],
      stagedObjects: ["GE-26900_Fuel", "GE-26900_Fuel_1"],
    },
  ],
  aprilTags: [
    { variant: "36h11-6.5in", id: 1, rotations: [{ axis: "z", degrees: 0 }], position: [-3.607, -3.39, 0.889] },
  ],
})

const ROBOT = JSON.stringify({
  name: "2026 KitBot",
  rotations: [{ axis: "z", degrees: 180 }],
  position: [0, 0, 0.05],
  cameras: [
    { name: "Front", rotations: [{ axis: "y", degrees: -20 }], position: [0.3, 0, 0.5], resolution: [1280, 800], fov: 75 },
  ],
  components: [
    { zeroedRotations: [{ axis: "y", degrees: 0 }], zeroedPosition: [0.1, 0, 0.2] },
    { zeroedRotations: [], zeroedPosition: [0, 0, 0.4] },
  ],
})

describe("field config", () => {
  const config = parseAssetConfig(FIELD_2026)!

  it("is recognized as a field because it carries the playing area", () => {
    expect(config.kind).toBe("field")
  })

  it("converts the config's inches to the scene's meters", () => {
    if (config.kind !== "field") throw new Error("not a field")
    // 651.22 in = 16.541 m; it is the usual FRC field.
    expect(config.size.length).toBeCloseTo(16.541, 3)
    expect(config.size.width).toBeCloseTo(8.069, 3)
  })

  it("reads the coordinate system, the driver stations and the tags", () => {
    if (config.kind !== "field") throw new Error("not a field")
    expect(config.coordinateSystem).toBe("wall-blue")
    expect(config.driverStations).toHaveLength(6)
    expect(config.aprilTags[0].id).toBe(1)
    expect(config.aprilTags[0].position).toEqual([-3.607, -3.39, 0.889])
  })

  it("keeps the nodes of the pieces already in place", () => {
    if (config.kind !== "field") throw new Error("not a field")
    // This list is where what to turn off comes from when the robot publishes its
    // own pieces, so each one is not seen twice.
    expect(config.gamePieces[0].stagedObjects).toEqual(["GE-26900_Fuel", "GE-26900_Fuel_1"])
  })

  it("the driver stations land on the end walls", () => {
    if (config.kind !== "field") throw new Error("not a field")
    const halfLength = config.size.length / 2
    config.driverStations.forEach(([x]) => {
      expect(Math.abs(Math.abs(x) - halfLength)).toBeLessThan(0.05)
    })
  })
})

describe("robot config", () => {
  const config = parseAssetConfig(ROBOT)!

  it("is recognized as a robot because it does NOT carry the playing area", () => {
    expect(config.kind).toBe("robot")
  })

  it("reads cameras and components", () => {
    if (config.kind !== "robot") throw new Error("not a robot")
    expect(config.cameras[0].fov).toBe(75)
    expect(config.cameras[0].resolution).toEqual([1280, 800])
    expect(config.components).toHaveLength(2)
    expect(config.components[1].zeroedPosition).toEqual([0, 0, 0.4])
  })
})

describe("tolerancia a configs incompletos", () => {
  it("rejects what is not JSON or has no name", () => {
    expect(parseAssetConfig("{ roto")).toBeNull()
    expect(parseAssetConfig("{}")).toBeNull()
    expect(parseAssetConfig("[]")).toBeNull()
  })

  it("a minimal config is still usable", () => {
    // Written by hand, with nothing optional: it has to load all the same.
    const config = parseAssetConfig(JSON.stringify({
      name: "Mi cancha", widthInches: 600, heightInches: 300,
    }))!
    if (config.kind !== "field") throw new Error("not a field")
    expect(config.coordinateSystem).toBe("wall-blue")
    expect(config.rotations).toEqual([])
    expect(config.gamePieces).toEqual([])
    expect(config.defaultOrigin).toBe("auto")
  })

  it("drops made-up axes instead of turning around an undefined axis", () => {
    const config = parseAssetConfig(JSON.stringify({
      name: "R", rotations: [{ axis: "w", degrees: 90 }, { axis: "x", degrees: 90 }],
    }))!
    expect(config.rotations).toEqual([{ axis: "x", degrees: 90 }])
  })
})

describe("composeRotations", () => {
  it("with no turns it returns the identity", () => {
    expect(composeRotations([])).toEqual([1, 0, 0, 0])
  })

  it("a +90° turn around X takes a glTF (Y up) into the Z-up frame", () => {
    // It is exactly what the 2026 field's config declares, and the reason the
    // model is loaded raw instead of rotating it blindly.
    const [x, y, z] = rotateVector(composeRotations([{ axis: "x", degrees: 90 }]), [0, 1, 0])
    expect(x).toBeCloseTo(0, 9)
    expect(y).toBeCloseTo(0, 9)
    expect(z).toBeCloseTo(1, 9)
  })

  it("applies the turns in the order they come", () => {
    // First +90° around Z (X becomes +Y) and then +90° around X (Y becomes +Z).
    const q = composeRotations([{ axis: "z", degrees: 90 }, { axis: "x", degrees: 90 }])
    const [x, y, z] = rotateVector(q, [1, 0, 0])
    expect(x).toBeCloseTo(0, 9)
    expect(y).toBeCloseTo(0, 9)
    expect(z).toBeCloseTo(1, 9)
  })
})

describe("formatBytes", () => {
  it("picks the unit by size", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(4096)).toBe("4 KB")
    expect(formatBytes(18_182_328)).toBe("17.3 MB")
  })
})
