import { describe, it, expect } from "vitest"
import {
  defaultField3dTypeFor, isField3dDroppable, nextField3dLabel,
  normalizeField3dObjects, normalizeField3dSettings, resolveField3dOptions,
} from "./objects"
import { Field3dObjectConfig, defaultField3dSettings, EVERGREEN_FIELD_KEY } from "../../store/appStore"

function object(overrides: Partial<Field3dObjectConfig> = {}): Field3dObjectConfig {
  return {
    id: "1", topicName: "/Robot/Pose", topicType: "struct:Pose3d",
    label: "Pose", type: "robot", color: "#2f6fdb", ...overrides,
  }
}

describe("opciones resueltas", () => {
  it("the ghost is born translucent", () => {
    // It is what sets it apart from the real robot; having to lower its
    // opacity by hand every time would be absurd.
    const ghost = resolveField3dOptions(object({ type: "ghost" }), defaultField3dSettings)
    expect(ghost.opacity).toBeLessThan(1)
    const robot = resolveField3dOptions(object({ type: "robot" }), defaultField3dSettings)
    expect(robot.opacity).toBe(1)
  })

  it("the master switch turns off every trail", () => {
    const settings = { ...defaultField3dSettings, showTrails: false }
    const opts = resolveField3dOptions(object({ trailSeconds: 10 }), settings)
    expect(opts.trailSeconds).toBe(0)
  })

  it("an object without a trail of its own inherits the tab's", () => {
    const settings = { ...defaultField3dSettings, showTrails: true, trailSeconds: 7 }
    expect(resolveField3dOptions(object(), settings).trailSeconds).toBe(7)
  })

  it("the robot asset falls back to the tab's default", () => {
    const settings = { ...defaultField3dSettings, robotAssetKey: "Robot_Kit" }
    expect(resolveField3dOptions(object(), settings).robotAssetKey).toBe("Robot_Kit")
    expect(resolveField3dOptions(object({ robotAssetKey: "Robot_Mio" }), settings).robotAssetKey)
      .toBe("Robot_Mio")
  })

  it("with no camera chosen vision comes from the robot's center", () => {
    expect(resolveField3dOptions(object({ type: "vision" }), defaultField3dSettings).visionCameraIndex)
      .toBe(-1)
  })

  it("a corrupt number falls back to its default instead of leaving the mesh invisible", () => {
    const opts = resolveField3dOptions(
      object({ trajectoryWidth: NaN, markerSize: -3 }),
      defaultField3dSettings,
    )
    expect(opts.trajectoryWidth).toBeGreaterThan(0)
    expect(opts.markerSize).toBeGreaterThan(0)
  })
})

describe("what can be dropped", () => {
  it("accepts geometry and rejects the rest", () => {
    expect(isField3dDroppable("struct:Pose3d[]")).toBe(true)
    expect(isField3dDroppable("double[]")).toBe(true)
    expect(isField3dDroppable("boolean")).toBe(false)
  })
})

describe("default type on drop", () => {
  it("a loose pose is the robot and an array is a trajectory", () => {
    expect(defaultField3dTypeFor("/Odometry/Pose", "struct:Pose3d")).toBe("robot")
    expect(defaultField3dTypeFor("/Auto/Poses", "struct:Pose3d[]")).toBe("trajectory")
  })

  it("the name wins over the shape", () => {
    // A `Targets` with three poses is not a path.
    expect(defaultField3dTypeFor("/Vision/Targets", "struct:Pose3d[]")).toBe("vision")
    expect(defaultField3dTypeFor("/Robot/Components", "struct:Pose3d[]")).toBe("component")
    expect(defaultField3dTypeFor("/Drive/Setpoint", "struct:Pose2d")).toBe("ghost")
    expect(defaultField3dTypeFor("/Shooter/Notes", "struct:Translation3d[]")).toBe("gamePiece")
  })
})

describe("etiquetas", () => {
  it("numbers repeats of the same topic", () => {
    const objects = [object()]
    expect(nextField3dLabel(objects, "/Robot/Pose")).toBe("Pose (2)")
    expect(nextField3dLabel([], "/Robot/Pose")).toBe("Pose")
  })
})

describe("sanitizing saved layouts", () => {
  it("drops entries with neither an id nor a topic", () => {
    expect(normalizeField3dObjects([{ id: "a" }, { topicName: "/x" }, null, 5])).toEqual([])
    expect(normalizeField3dObjects("not an array")).toEqual([])
  })

  it("a made-up type falls back to the robot instead of leaving the object undrawn", () => {
    const [result] = normalizeField3dObjects([{ id: "a", topicName: "/x", type: "hologram" }])
    expect(result.type).toBe("robot")
  })

  it("leaves out numbers that are not finite", () => {
    // A NaN here leaves the geometry with an invalid matrix and the piece
    // disappears without any visible error.
    const [result] = normalizeField3dObjects([{
      id: "a", topicName: "/x", opacity: NaN, trajectoryWidth: "ancho", markerSize: Infinity,
    }])
    expect(result.opacity).toBeUndefined()
    expect(result.trajectoryWidth).toBeUndefined()
    expect(result.markerSize).toBeUndefined()
  })

  it("keeps whatever is valid", () => {
    const [result] = normalizeField3dObjects([{
      id: "a", topicName: "/x", type: "trajectory", color: "#fff",
      trajectoryStyle: "line", trajectoryWidth: 0.08, arrayFormat: "pose3d",
    }])
    expect(result.trajectoryStyle).toBe("line")
    expect(result.trajectoryWidth).toBe(0.08)
    expect(result.arrayFormat).toBe("pose3d")
  })
})

describe("sanitizing the settings", () => {
  it("an empty layout gives the defaults", () => {
    const settings = normalizeField3dSettings(undefined)
    expect(settings.fieldKey).toBe(EVERGREEN_FIELD_KEY)
    expect(settings.quality).toBe("standard")
    expect(settings.cameraMode).toBe("orbit")
  })

  it("bounds the indices and the ranges", () => {
    const settings = normalizeField3dSettings({
      driverStationIndex: 99, fov: 500, gridCell: 0, robotLength: -1, trailSeconds: 1e6,
    })
    expect(settings.driverStationIndex).toBeLessThanOrEqual(5)
    expect(settings.fov).toBeLessThanOrEqual(110)
    expect(settings.gridCell).toBeGreaterThan(0)
    expect(settings.robotLength).toBeGreaterThan(0)
    expect(settings.trailSeconds).toBeLessThanOrEqual(120)
  })

  it("a made-up enum falls back to its default", () => {
    const settings = normalizeField3dSettings({
      quality: "ultra", cameraMode: "dron", origin: "verde", coordinateSystem: "polar",
    })
    expect(settings.quality).toBe("standard")
    expect(settings.cameraMode).toBe("orbit")
    expect(settings.origin).toBe("auto")
    // null = "use whatever the field's config declares".
    expect(settings.coordinateSystem).toBeNull()
  })

  it("respects a valid coordinate system", () => {
    expect(normalizeField3dSettings({ coordinateSystem: "center-red" }).coordinateSystem)
      .toBe("center-red")
  })
})
