import { describe, it, expect } from "vitest"
import { toInternal, fromInternal, flipInternal, CoordinateSystem } from "./fieldImages"
import { PoseHistory, HistoryStore } from "./poseHistory"
import { Heatmap, signatureOf } from "./heatmap"
import {
  defaultObjectTypeFor, normalizeFieldObjects, normalizeFieldSettings,
  resolveObjectOptions, isFieldDroppable, needsRobotAnchor,
  nextObjectLabel, FIELD_OBJECT_ICONS, FIELD_OBJECT_TYPES,
} from "./fieldObjects"
import { defaultFieldSettings, FieldObjectConfig } from "../../store/appStore"

const SIZE: [number, number] = [16.535, 8.069]

describe("fromInternal", () => {
  const SYSTEMS: CoordinateSystem[] = ["wall_blue", "center", "center_rotated"]

  it("undoes toInternal in the three systems", () => {
    // It is the calculation the cursor readout does: the point you point at on
    // screen has to come out in the same numbers the robot publishes.
    for (const system of SYSTEMS) {
      const internal = toInternal(system, 3.2, 1.7, 0.9, SIZE)
      const back = fromInternal(system, internal.x, internal.y, internal.theta, SIZE)
      expect(back.x).toBeCloseTo(3.2, 9)
      expect(back.y).toBeCloseTo(1.7, 9)
      expect(back.theta).toBeCloseTo(0.9, 9)
    }
  })
})

describe("flipInternal", () => {
  it("is a half turn, so applying it twice changes nothing", () => {
    const once = flipInternal({ x: 2, y: -1, theta: 0.5 })
    expect(once.x).toBe(-2)
    expect(once.y).toBe(1)

    const twice = flipInternal(once)
    expect(twice.x).toBeCloseTo(2, 9)
    expect(twice.y).toBeCloseTo(-1, 9)
    expect(Math.cos(twice.theta)).toBeCloseTo(Math.cos(0.5), 9)
  })
})

describe("PoseHistory", () => {
  it("drops the repeated value the poll returns between publishes", () => {
    // The poll runs at 30 Hz and the robot may publish at 10: without this
    // filter, the heat map would count the same instant three times.
    const history = new PoseHistory()
    history.push([{ x: 1, y: 2, theta: 0 }], 1000)
    history.push([{ x: 1, y: 2, theta: 0 }], 1100)
    history.push([{ x: 1.5, y: 2, theta: 0 }], 1200)

    expect(history.length).toBe(2)
  })

  it("ignores samples that arrive faster than the minimum period", () => {
    const history = new PoseHistory()
    history.push([{ x: 0, y: 0, theta: 0 }], 1000)
    history.push([{ x: 5, y: 5, theta: 0 }], 1010)

    expect(history.length).toBe(1)
  })

  it("keeps no trail for a long array: that is a trajectory", () => {
    const history = new PoseHistory()
    const path = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0, theta: 0 }))
    history.push(path, 1000)

    expect(history.length).toBe(0)
  })

  it("since() returns only the requested window", () => {
    const history = new PoseHistory()
    for (let i = 0; i < 10; i++) {
      history.push([{ x: i, y: 0, theta: 0 }], 1000 + i * 100)
    }

    // The samples go from t=1000 to t=1900. The last 0.5 s are from t=1400.
    const recent = history.since(0.5, 1900)
    expect(recent.length).toBe(6)
    expect(recent[0].x).toBe(4)
  })

  it("drops a non-finite value without cutting the series", () => {
    const history = new PoseHistory()
    history.push([{ x: NaN, y: 0, theta: 0 }], 1000)
    history.push([{ x: 1, y: 0, theta: 0 }], 1100)

    expect(history.length).toBe(1)
  })
})

describe("HistoryStore", () => {
  it("forgets the objects removed from the panel", () => {
    const store = new HistoryStore()
    store.get("a").push([{ x: 0, y: 0, theta: 0 }], 1000)
    store.get("b").push([{ x: 1, y: 1, theta: 0 }], 1000)

    store.prune(["a"])

    expect(store.get("a").length).toBe(1)
    // Asking for it again creates an empty one: the "b" one no longer exists.
    expect(store.get("b").length).toBe(0)
  })
})

describe("Heatmap", () => {
  const frame = { sizeMeters: SIZE, cell: 0.2, radius: 0.6 }

  it("starts empty and fills with a sample inside the field", () => {
    const heatmap = new Heatmap(frame)
    expect(heatmap.isEmpty).toBe(true)

    heatmap.add([{ x: 0, y: 0 }])
    expect(heatmap.isEmpty).toBe(false)
  })

  it("ignores a pose that falls outside the playing area", () => {
    // It really happens: with the wrong coordinate system the poses go up
    // against the wall, and clipping them at the edge would leave a hot band
    // that means nothing.
    const heatmap = new Heatmap(frame)
    heatmap.add([{ x: 500, y: 500 }])
    expect(heatmap.isEmpty).toBe(true)
  })

  it("the signature changes if the field or any parameter changes", () => {
    expect(signatureOf(frame)).toBe(signatureOf({ ...frame }))
    expect(signatureOf(frame)).not.toBe(signatureOf({ ...frame, cell: 0.3 }))
    expect(signatureOf(frame)).not.toBe(signatureOf({ ...frame, sizeMeters: [16, 8] }))
  })
})

describe("defaultObjectTypeFor", () => {
  it("the name wins over the topic's shape", () => {
    expect(defaultObjectTypeFor("/Vision/Targets", "struct:Pose2d[]")).toBe("target")
    expect(defaultObjectTypeFor("/Auto/Trajectory", "struct:Pose2d[]")).toBe("trajectory")
    expect(defaultObjectTypeFor("/Drive/Setpoint", "struct:Pose2d")).toBe("ghost")
  })

  it("an array with no hints in the name is a trajectory and a loose pose is the robot", () => {
    expect(defaultObjectTypeFor("/Odometry/Samples", "struct:Pose2d[]")).toBe("trajectory")
    expect(defaultObjectTypeFor("/Odometry/Pose", "struct:Pose2d")).toBe("robot")
  })

  it("a SwerveModuleState[] comes in as modules and not as a trajectory", () => {
    expect(defaultObjectTypeFor("/Drive/States", "struct:SwerveModuleState[]")).toBe("swerve")
    expect(isFieldDroppable("struct:SwerveModuleState[]")).toBe(true)
  })
})

describe("needsRobotAnchor", () => {
  it("marks the types that have no pose of their own", () => {
    expect(needsRobotAnchor("swerve")).toBe(true)
    expect(needsRobotAnchor("target")).toBe(true)
    expect(needsRobotAnchor("robot")).toBe(false)
  })
})

describe("resolveObjectOptions", () => {
  const base: FieldObjectConfig = {
    id: "1", topicName: "/Pose", topicType: "struct:Pose2d",
    label: "Pose", type: "robot", color: "#2f6fdb",
  }

  it("an object without options takes the panel's defaults", () => {
    const opts = resolveObjectOptions(base, defaultFieldSettings)
    expect(opts.trailSeconds).toBe(defaultFieldSettings.trailSeconds)
    expect(opts.opacity).toBe(1)
    expect(opts.useModel).toBe(false)
  })

  it("the master switch turns the trail off even if the object sets its own", () => {
    const settings = { ...defaultFieldSettings, showTrails: false }
    const opts = resolveObjectOptions({ ...base, trailSeconds: 8 }, settings)
    expect(opts.trailSeconds).toBe(0)
  })

  it("the panel's draw mode is the default and the object can override it", () => {
    const settings = { ...defaultFieldSettings, robotRender: "model" as const }
    expect(resolveObjectOptions(base, settings).useModel).toBe(true)
    expect(resolveObjectOptions({ ...base, useModel: false }, settings).useModel).toBe(false)
  })
})

describe("normalizeFieldObjects", () => {
  it("drops entries without an id or without a topic", () => {
    const out = normalizeFieldObjects([
      { id: "1", topicName: "/A", type: "robot", color: "#fff" },
      { topicName: "/B" },
      null,
    ])
    expect(out.length).toBe(1)
  })

  it("an unknown type falls back to the robot instead of leaving the object undrawn", () => {
    const out = normalizeFieldObjects([{ id: "1", topicName: "/A", type: "teleporter" }])
    expect(out[0].type).toBe("robot")
  })

  it("does not let a NaN through to the numeric options", () => {
    const out = normalizeFieldObjects([
      { id: "1", topicName: "/A", type: "robot", trailSeconds: NaN, heatmapCell: 0.25 },
    ])
    expect(out[0].trailSeconds).toBeUndefined()
    expect(out[0].heatmapCell).toBe(0.25)
  })
})

describe("normalizeFieldSettings", () => {
  it("an old layout (square chassis) inherits the width from the length", () => {
    const settings = normalizeFieldSettings({ robotSizeMeters: 0.9 })
    expect(settings.robotSizeMeters).toBe(0.9)
    expect(settings.robotWidthMeters).toBe(0.9)
  })

  it("fills in the fields the previous version did not save", () => {
    const settings = normalizeFieldSettings({ orientation: 90, showGrid: false })
    expect(settings.orientation).toBe(90)
    expect(settings.showGrid).toBe(false)
    expect(settings.robotRender).toBe("icon")
    expect(settings.gridSpacing).toBe(defaultFieldSettings.gridSpacing)
  })

  it("bounds the numbers that are drawn as geometry", () => {
    const settings = normalizeFieldSettings({
      robotSizeMeters: NaN,
      gridSpacing: 0,
      robotModelScale: -3,
      orientation: 45,
    })
    expect(settings.robotSizeMeters).toBe(defaultFieldSettings.robotSizeMeters)
    expect(settings.gridSpacing).toBe(0.1)
    expect(settings.robotModelScale).toBeGreaterThan(0)
    expect(settings.orientation).toBe(0)
  })

  it("a missing layout returns the complete defaults", () => {
    expect(normalizeFieldSettings(undefined)).toEqual(defaultFieldSettings)
  })
})

describe("nextObjectLabel", () => {
  it("numbers repeats of the same topic", () => {
    // It is what allows having /Odometry/Pose as a chassis and again as a heat
    // map, without publishing the pose twice from the robot.
    const objects = [{ topicName: "/Odometry/Pose" }]
    expect(nextObjectLabel([], "/Odometry/Pose")).toBe("Pose")
    expect(nextObjectLabel(objects, "/Odometry/Pose")).toBe("Pose (2)")
    expect(nextObjectLabel([...objects, { topicName: "/Odometry/Pose" }], "/Odometry/Pose"))
      .toBe("Pose (3)")
  })

  it("does not number a different topic", () => {
    expect(nextObjectLabel([{ topicName: "/A/Pose" }], "/B/Pose")).toBe("Pose")
  })

  it("accepts a base name of its own (the Field2d's, which is not the leaf)", () => {
    expect(nextObjectLabel([], "/SmartDashboard/Field/Robot", "Field")).toBe("Field")
  })
})

describe("trailColor", () => {
  const base: FieldObjectConfig = {
    id: "1", topicName: "/Pose", topicType: "struct:Pose2d",
    label: "Pose", type: "robot", color: "#2f6fdb",
  }

  it("without a color of its own the trail inherits the object's", () => {
    expect(resolveObjectOptions(base, defaultFieldSettings).trailColor).toBeNull()
  })

  it("with a color of its own it returns it as is", () => {
    const opts = resolveObjectOptions({ ...base, trailColor: "#d63b3b" }, defaultFieldSettings)
    expect(opts.trailColor).toBe("#d63b3b")
  })

  it("survives saving and loading the layout", () => {
    const out = normalizeFieldObjects([{ ...base, trailColor: "#d63b3b" }])
    expect(out[0].trailColor).toBe("#d63b3b")
    expect(normalizeFieldObjects([{ ...base, trailColor: 42 }])[0].trailColor).toBeUndefined()
  })
})

describe("HistoryStore.copy", () => {
  it("the duplicated object inherits what the original had already collected", () => {
    const store = new HistoryStore()
    store.get("robot").push([{ x: 1, y: 1, theta: 0 }], 1000)
    store.get("robot").push([{ x: 2, y: 2, theta: 0 }], 1100)

    store.copy("robot", "heatmap")
    expect(store.get("heatmap").length).toBe(2)

    // And they are copies: feeding the original further does not touch the duplicate.
    store.get("robot").push([{ x: 3, y: 3, theta: 0 }], 1200)
    expect(store.get("heatmap").length).toBe(2)
  })

  it("copying from an id that does not exist creates nothing odd", () => {
    const store = new HistoryStore()
    store.copy("nope", "nuevo")
    expect(store.get("nuevo").length).toBe(0)
  })
})

describe("FIELD_OBJECT_ICONS", () => {
  it("every type has an icon, with a tabler fallback for the ones without an SVG", () => {
    for (const type of FIELD_OBJECT_TYPES) {
      const icon = FIELD_OBJECT_ICONS[type]
      expect(icon.svg.endsWith(".svg")).toBe(true)
      expect(icon.fallback.startsWith("ti-")).toBe(true)
    }
  })
})
