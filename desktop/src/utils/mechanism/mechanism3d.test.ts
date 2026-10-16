import { describe, it, expect } from "vitest"
import {
  jointValue, jointTransform, resolveJointScalar, poseTransform, unitScale,
  normalizeAxis, axisAngleQuat, buildPartTree, flattenTree, descendantIds,
  canReparent, normalizeParts, normalizeSettings, serializeMechanism3d,
  parseMechanism3d, duplicatePart, isJointTopic, bindJointTopic,
  applyJointToPoint, travelRange, sweepRange,
  evaluateRoutine, routineDuration, normalizeRoutines, sweepStep,
} from "./mechanism3d"
import {
  Mechanism3dJoint, Mechanism3dRoutine, Mechanism3dRoutineStep,
  defaultMechanism3dJoint, defaultMechanism3dSettings, makeMechanism3dPart,
} from "../../store/appStore"

const joint = (overrides: Partial<Mechanism3dJoint> = {}): Mechanism3dJoint => ({
  ...defaultMechanism3dJoint,
  ...overrides,
})

// Packs little-endian doubles just like WPILib's struct schema, to be able to
// feed the decoder real bytes.
function doublesToBytes(values: number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 8)
  const view = new DataView(buffer)
  values.forEach((v, i) => view.setFloat64(i * 8, v, true))
  return Array.from(new Uint8Array(buffer))
}

describe("unidades", () => {
  it("converts to radians or meters according to the joint type", () => {
    expect(unitScale("degrees", "angle")).toBeCloseTo(Math.PI / 180)
    expect(unitScale("rotations", "angle")).toBeCloseTo(Math.PI * 2)
    expect(unitScale("radians", "angle")).toBe(1)
    expect(unitScale("millimeters", "length")).toBeCloseTo(0.001)
    expect(unitScale("inches", "length")).toBeCloseTo(0.0254)
  })

  it("falls back to neutral if the unit does not match the joint type", () => {
    // Degrees on a prismatic joint mean nothing: better not to move the piece
    // than to shift it 0.0174 m per degree.
    expect(unitScale("degrees", "length")).toBe(1)
    expect(unitScale("meters", "angle")).toBeCloseTo(Math.PI / 180)
  })
})

describe("normalizeAxis", () => {
  it("normaliza", () => {
    expect(normalizeAxis([0, 0, 5])).toEqual([0, 0, 1])
    const n = normalizeAxis([3, 4, 0])
    expect(n[0]).toBeCloseTo(0.6)
    expect(n[1]).toBeCloseTo(0.8)
  })

  it("a null axis falls back to +Z instead of producing NaN", () => {
    expect(normalizeAxis([0, 0, 0])).toEqual([0, 0, 1])
    expect(normalizeAxis([NaN, 0, 0])).toEqual([0, 0, 1])
  })
})

describe("axisAngleQuat", () => {
  it("90° about Z", () => {
    const q = axisAngleQuat([0, 0, 1], Math.PI / 2)
    expect(q[2]).toBeCloseTo(Math.SQRT1_2)
    expect(q[3]).toBeCloseTo(Math.SQRT1_2)
  })

  it("zero angle gives the identity", () => {
    expect(axisAngleQuat([0, 1, 0], 0)).toEqual([0, 0, 0, 1])
  })
})

describe("resolveJointScalar", () => {
  it("reads a double", () => {
    expect(resolveJointScalar({ Number: 12.5 }, joint({ topicName: "/a", topicType: "double" }))).toBe(12.5)
  })

  it("reads an index of a double[]", () => {
    const j = joint({ topicName: "/a", topicType: "double[]", arrayIndex: 2 })
    expect(resolveJointScalar({ NumberArray: [1, 2, 3, 4] }, j)).toBe(3)
  })

  it("turns a boolean into 0/1 to drive a solenoid", () => {
    const j = joint({ topicName: "/a", topicType: "boolean" })
    expect(resolveJointScalar({ Boolean: true }, j)).toBe(1)
    expect(resolveJointScalar({ Boolean: false }, j)).toBe(0)
  })

  it("reads an index of a boolean[]", () => {
    const j = joint({ topicName: "/a", topicType: "boolean[]", arrayIndex: 1 })
    expect(resolveJointScalar({ BooleanArray: [false, true] }, j)).toBe(1)
  })

  it("reads a field of a struct", () => {
    // Pose2d = X, Y, θ(rad on the wire). The decoder returns θ in degrees.
    const bytes = doublesToBytes([1.5, -2.5, Math.PI / 2])
    const j = joint({ topicName: "/a", topicType: "struct:Pose2d", structField: 2 })
    expect(resolveJointScalar({ Raw: bytes }, j)).toBeCloseTo(90)
  })

  it("reads an element of a struct array", () => {
    const bytes = doublesToBytes([0, 0, 0, 4, 5, 0])   // dos Translation... no: dos Rotation? usamos Pose2d
    const j = joint({ topicName: "/a", topicType: "struct:Pose2d[]", arrayIndex: 1, structField: 0 })
    expect(resolveJointScalar({ Raw: bytes }, j)).toBe(4)
  })

  it("returns null without a value or without a topic", () => {
    expect(resolveJointScalar(null, joint({ topicName: "/a", topicType: "double" }))).toBeNull()
    expect(resolveJointScalar({ Number: 1 }, joint({ topicName: null, topicType: "double" }))).toBeNull()
  })
})

describe("jointValue", () => {
  it("applies invert, scale and offset in that order", () => {
    const j = joint({ topicName: "/a", topicType: "double", invert: true, scale: 2, offset: 10 })
    // -(3) * 2 + 10 = 4
    expect(jointValue(j, { Number: 3 }, false)).toBe(4)
  })

  it("respects the limits in the selector's units", () => {
    const j = joint({ topicName: "/a", topicType: "double", min: -90, max: 90 })
    expect(jointValue(j, { Number: 400 }, false)).toBe(90)
    expect(jointValue(j, { Number: -400 }, false)).toBe(-90)
  })

  it("uses the manual value when the override is active", () => {
    const j = joint({ topicName: "/a", topicType: "double", manual: 45, scale: 10 })
    expect(jointValue(j, { Number: 3 }, true)).toBe(45)
  })

  it("falls back to the manual value if the topic has published nothing yet", () => {
    const j = joint({ topicName: "/a", topicType: "double", manual: 7 })
    expect(jointValue(j, undefined, false)).toBe(7)
  })
})

describe("jointTransform", () => {
  it("a fixed joint moves nothing", () => {
    const t = jointTransform(joint({ type: "fixed" }), null, false)
    expect(t.position).toEqual([0, 0, 0])
    expect(t.quaternion).toEqual([0, 0, 0, 1])
  })

  it("a revolute turns around its axis and converts the degrees", () => {
    const j = joint({ type: "revolute", axis: [0, 0, 1], units: "degrees", manual: 90 })
    const t = jointTransform(j, null, true)
    expect(t.quaternion[2]).toBeCloseTo(Math.SQRT1_2)
    expect(t.position).toEqual([0, 0, 0])
  })

  it("a prismatic slides along the axis, in meters", () => {
    const j = joint({ type: "prismatic", axis: [0, 0, 2], units: "millimeters", manual: 500 })
    const t = jointTransform(j, null, true)
    expect(t.position[2]).toBeCloseTo(0.5)
    expect(t.position[0]).toBeCloseTo(0)
    expect(t.quaternion).toEqual([0, 0, 0, 1])
  })

  it("a prismatic on a diagonal axis splits the displacement", () => {
    const j = joint({ type: "prismatic", axis: [1, 1, 0], units: "meters", manual: Math.SQRT2 })
    const t = jointTransform(j, null, true)
    expect(t.position[0]).toBeCloseTo(1)
    expect(t.position[1]).toBeCloseTo(1)
  })
})

describe("poseTransform", () => {
  it("reads a full Pose3d and reorders the quaternion to (x,y,z,w)", () => {
    // X, Y, Z, QW, QX, QY, QZ
    const bytes = doublesToBytes([1, 2, 3, 0.5, 0.5, 0.5, 0.5])
    const j = joint({ topicName: "/a", topicType: "struct:Pose3d" })
    const t = poseTransform({ Raw: bytes }, j)!
    expect(t.position).toEqual([1, 2, 3])
    expect(t.quaternion).toEqual([0.5, 0.5, 0.5, 0.5])
  })

  it("a Pose2d turns only about Z and leaves Z at zero", () => {
    const bytes = doublesToBytes([4, 5, Math.PI])
    const j = joint({ topicName: "/a", topicType: "struct:Pose2d" })
    const t = poseTransform({ Raw: bytes }, j)!
    expect(t.position).toEqual([4, 5, 0])
    expect(t.quaternion[2]).toBeCloseTo(1)
  })

  it("a Translation3d provides no rotation", () => {
    const bytes = doublesToBytes([1, 2, 3])
    const j = joint({ topicName: "/a", topicType: "struct:Translation3d" })
    const t = poseTransform({ Raw: bytes }, j)!
    expect(t.position).toEqual([1, 2, 3])
    expect(t.quaternion).toEqual([0, 0, 0, 1])
  })

  it("takes the requested index of a Pose3d[]", () => {
    const bytes = doublesToBytes([
      0, 0, 0, 1, 0, 0, 0,
      9, 8, 7, 1, 0, 0, 0,
    ])
    const j = joint({ topicName: "/a", topicType: "struct:Pose3d[]", arrayIndex: 1 })
    const t = poseTransform({ Raw: bytes }, j)!
    expect(t.position).toEqual([9, 8, 7])
  })
})

describe("part tree", () => {
  const part = (id: string, parentId: string | null) => makeMechanism3dPart(id, id, parentId)

  it("nests by parentId", () => {
    const parts = [part("a", null), part("b", "a"), part("c", "b"), part("d", null)]
    const roots = buildPartTree(parts)
    expect(roots.map(r => r.part.id)).toEqual(["a", "d"])
    expect(flattenTree(roots).map(n => `${n.part.id}@${n.depth}`)).toEqual(["a@0", "b@1", "c@2", "d@0"])
  })

  it("a part with a missing parent stays at the root instead of getting lost", () => {
    const roots = buildPartTree([part("a", "fantasma")])
    expect(roots.map(r => r.part.id)).toEqual(["a"])
  })

  it("a cycle does not hang the build", () => {
    const parts = [part("a", "b"), part("b", "a")]
    const roots = buildPartTree(parts)
    expect(flattenTree(roots)).toHaveLength(2)
  })

  it("descendantIds gathers the whole branch", () => {
    const parts = [part("a", null), part("b", "a"), part("c", "b"), part("d", null)]
    expect(descendantIds(parts, "a").sort()).toEqual(["a", "b", "c"])
  })

  it("canReparent no deja crear ciclos", () => {
    const parts = [part("a", null), part("b", "a"), part("c", "b")]
    expect(canReparent(parts, "a", "c")).toBe(false)
    expect(canReparent(parts, "a", "a")).toBe(false)
    expect(canReparent(parts, "c", null)).toBe(true)
    expect(canReparent(parts, "b", null)).toBe(true)
  })
})

describe("normalization", () => {
  it("drops parts without an id and deduplicates", () => {
    const parts = normalizeParts([
      { id: "a", name: "A" },
      { id: "a", name: "duplicada" },
      { name: "sin id" },
      null,
    ])
    expect(parts.map(p => p.id)).toEqual(["a"])
    expect(parts[0].name).toBe("A")
  })

  it("fills the missing fields with the default", () => {
    const [part] = normalizeParts([{ id: "a" }])
    expect(part.opacity).toBe(1)
    expect(part.joint.type).toBe("fixed")
    expect(part.origin).toEqual([0, 0, 0])
  })

  it("cleans NaN in the number triples", () => {
    const [part] = normalizeParts([{ id: "a", origin: [1, "x", null], shapeSize: [NaN, 2, 3] }])
    expect(part.origin).toEqual([1, 0, 0])
    expect(part.shapeSize[0]).toBe(0.1)
  })

  it("falls back to the default on unknown enums", () => {
    const [part] = normalizeParts([{ id: "a", shape: "toroide", joint: { type: "helicoidal" } }])
    expect(part.shape).toBe("box")
    expect(part.joint.type).toBe("fixed")
  })

  it("settings tolera basura", () => {
    const settings = normalizeSettings({ gizmo: "escalar", gridCell: -5, background: "fucsia" })
    expect(settings.gizmo).toBe("off")
    expect(settings.gridCell).toBeGreaterThan(0)
    expect(settings.background).toBe("light")
  })
})

describe("exportable configuration", () => {
  const parts = [
    { ...makeMechanism3dPart("base", "Base", null), modelPath: "C:/models/base.stl" },
    {
      ...makeMechanism3dPart("arm", "Arm", "base"),
      joint: { ...defaultMechanism3dJoint, type: "revolute" as const, axis: [0, 1, 0] as [number, number, number] },
    },
  ]

  it("round-trips without losing anything", () => {
    const text = serializeMechanism3d(parts, defaultMechanism3dSettings)
    const back = parseMechanism3d(text)
    expect(back.parts).toHaveLength(2)
    expect(back.parts[0].modelPath).toBe("C:/models/base.stl")
    expect(back.parts[1].parentId).toBe("base")
    expect(back.parts[1].joint.type).toBe("revolute")
    expect(back.parts[1].joint.axis).toEqual([0, 1, 0])
  })

  it("keeps the mechanism's name", () => {
    const text = serializeMechanism3d(parts, { ...defaultMechanism3dSettings, name: "Elevador" })
    expect(parseMechanism3d(text).settings.name).toBe("Elevador")
  })

  it("rejects a JSON that is not a mechanism config", () => {
    expect(() => parseMechanism3d('{"openTabs":[]}')).toThrow(/mechanism config/)
  })

  it("rejects text that is not JSON", () => {
    expect(() => parseMechanism3d("no soy json")).toThrow(/valid JSON/)
  })

  it("rejects a future version instead of reading it halfway", () => {
    const text = serializeMechanism3d(parts, defaultMechanism3dSettings).replace('"version": 1', '"version": 99')
    expect(() => parseMechanism3d(text)).toThrow(/newer version/)
  })

  it("rejects a config without usable parts", () => {
    const text = serializeMechanism3d([], defaultMechanism3dSettings)
    expect(() => parseMechanism3d(text)).toThrow(/no usable parts/)
  })
})

describe("duplicatePart", () => {
  it("deep-copies the triples so references are not shared", () => {
    const original = makeMechanism3dPart("a", "A", null)
    const copy = duplicatePart(original, "b")
    copy.origin[0] = 5
    copy.joint.axis[0] = 5
    expect(original.origin[0]).toBe(0)
    expect(original.joint.axis[0]).toBe(0)
    expect(copy.id).toBe("b")
  })
})

describe("isJointTopic", () => {
  it("accepts numbers, booleans, arrays and structs", () => {
    expect(isJointTopic("double")).toBe(true)
    expect(isJointTopic("boolean")).toBe(true)
    expect(isJointTopic("double[]")).toBe(true)
    expect(isJointTopic("boolean[]")).toBe(true)
    expect(isJointTopic("struct:Pose3d")).toBe(true)
    expect(isJointTopic("struct:Pose3d[]")).toBe(true)
  })

  it("rejects text and sendable tables", () => {
    expect(isJointTopic("string")).toBe(false)
    expect(isJointTopic("string[]")).toBe(false)
    expect(isJointTopic("Field2d")).toBe(false)
  })
})

describe("bindJointTopic", () => {
  it("a Pose3d suggests a pose joint", () => {
    const j = bindJointTopic(joint(), "/robot/comp", "struct:Pose3d[]")
    expect(j.type).toBe("pose")
    expect(j.arrayIndex).toBe(0)
    expect(j.topicName).toBe("/robot/comp")
  })

  it("a double suggests a revolute in degrees", () => {
    const j = bindJointTopic(joint(), "/arm/angle", "double")
    expect(j.type).toBe("revolute")
    expect(j.units).toBe("degrees")
    expect(j.arrayIndex).toBeNull()
  })

  it("a Rotation2d is not mistaken for a pose", () => {
    expect(bindJointTopic(joint(), "/a", "struct:Rotation2d").type).toBe("revolute")
  })

  it("does not override the type the user already chose", () => {
    const j = bindJointTopic(joint({ type: "prismatic", units: "meters" }), "/lift/height", "double")
    expect(j.type).toBe("prismatic")
    expect(j.units).toBe("meters")
  })

  it("fixes units that are incompatible with the type", () => {
    const j = bindJointTopic(joint({ type: "prismatic", units: "degrees" }), "/lift/height", "double")
    expect(j.units).toBe("meters")
  })

  it("a double[] starts at index 0", () => {
    expect(bindJointTopic(joint(), "/a", "double[]").arrayIndex).toBe(0)
  })
})

describe("pivote", () => {
  it("at rest the model does not move however the pivot is shifted", () => {
    const identity = { position: [0, 0, 0] as const, quaternion: [0, 0, 0, 1] as const }
    const out = applyJointToPoint([0.3, 0, 0], [0.9, -0.4, 0.2], {
      position: [...identity.position], quaternion: [...identity.quaternion],
    })
    expect(out[0]).toBeCloseTo(0.3)
    expect(out[1]).toBeCloseTo(0)
    expect(out[2]).toBeCloseTo(0)
  })

  it("the point that IS at the pivot stays still when turning", () => {
    const t = jointTransform(
      joint({ type: "revolute", axis: [0, 0, 1], units: "degrees", manual: 90 }), null, true,
    )
    const out = applyJointToPoint([1, 0, 0], [1, 0, 0], t)
    expect(out[0]).toBeCloseTo(1)
    expect(out[1]).toBeCloseTo(0)
  })

  it("turns around the pivot and not around the origin", () => {
    const t = jointTransform(
      joint({ type: "revolute", axis: [0, 0, 1], units: "degrees", manual: 90 }), null, true,
    )
    // Turning 90° about Z around (1,0,0) takes (2,0,0) to (1,1,0).
    const out = applyJointToPoint([2, 0, 0], [1, 0, 0], t)
    expect(out[0]).toBeCloseTo(1)
    expect(out[1]).toBeCloseTo(1)

    // With the pivot at the origin the same point would go to (0,2,0).
    const noPivot = applyJointToPoint([2, 0, 0], [0, 0, 0], t)
    expect(noPivot[0]).toBeCloseTo(0)
    expect(noPivot[1]).toBeCloseTo(2)
  })

  it("a prismatic slides the same wherever the pivot is", () => {
    const t = jointTransform(
      joint({ type: "prismatic", axis: [0, 0, 1], units: "meters", manual: 0.5 }), null, true,
    )
    expect(applyJointToPoint([0, 0, 0], [3, 2, 1], t)[2]).toBeCloseTo(0.5)
  })
})

describe("indicator ranges", () => {
  it("travelRange converts to meters and sorts", () => {
    const r = travelRange(joint({ type: "prismatic", units: "millimeters", min: 500, max: 0 }), 0.1)
    expect(r.min).toBeCloseTo(0)
    expect(r.max).toBeCloseTo(0.5)
  })

  it("travelRange uses the fallback if there are no limits", () => {
    const r = travelRange(joint({ type: "prismatic", units: "meters" }), 0.2)
    expect(r.min).toBeCloseTo(-0.2)
    expect(r.max).toBeCloseTo(0.2)
  })

  it("sweepRange returns null without limits or if they make a full turn", () => {
    expect(sweepRange(joint({ min: null, max: 90 }))).toBeNull()
    expect(sweepRange(joint({ min: -180, max: 180 }))).toBeNull()
    expect(sweepRange(joint({ min: 90, max: 10 }))).toBeNull()
  })

  it("sweepRange convierte a radianes", () => {
    const r = sweepRange(joint({ units: "degrees", min: -90, max: 90 }))!
    expect(r.min).toBeCloseTo(-Math.PI / 2)
    expect(r.max).toBeCloseTo(Math.PI / 2)
  })
})

describe("rutinas", () => {
  const step = (over: Partial<Mechanism3dRoutineStep> = {}): Mechanism3dRoutineStep => ({
    id: "s1", partId: "arm", from: 0, to: 90,
    startMs: 0, durationMs: 1000, easing: "linear", pingPong: false,
    ...over,
  })
  const routine = (steps: Mechanism3dRoutineStep[]): Mechanism3dRoutine => ({
    id: "r1", name: "R", loop: true, steps,
  })

  it("interpola linealmente entre from y to", () => {
    const r = routine([step()])
    expect(evaluateRoutine(r, 0).arm).toBeCloseTo(0)
    expect(evaluateRoutine(r, 500).arm).toBeCloseTo(45)
    expect(evaluateRoutine(r, 1000).arm).toBeCloseTo(90)
  })

  it("stays at the final value when the step ends", () => {
    expect(evaluateRoutine(routine([step()]), 9999).arm).toBeCloseTo(90)
  })

  it("back and forth returns to the start", () => {
    const r = routine([step({ pingPong: true })])
    expect(evaluateRoutine(r, 1000).arm).toBeCloseTo(90)
    expect(evaluateRoutine(r, 1500).arm).toBeCloseTo(45)
    expect(evaluateRoutine(r, 2000).arm).toBeCloseTo(0)
  })

  it("waits at the initial value until it starts", () => {
    const r = routine([step({ startMs: 500 })])
    expect(evaluateRoutine(r, 0).arm).toBeCloseTo(0)
    expect(evaluateRoutine(r, 200).arm).toBeCloseTo(0)
    expect(evaluateRoutine(r, 1000).arm).toBeCloseTo(45)
  })

  it("smooth starts and stops softly but goes through the middle", () => {
    const r = routine([step({ easing: "smooth" })])
    expect(evaluateRoutine(r, 500).arm).toBeCloseTo(45)
    // At 25% of the travel, smoothstep lags quite a bit behind the linear one.
    expect(evaluateRoutine(r, 250).arm).toBeLessThan(22.5)
    expect(evaluateRoutine(r, 250).arm).toBeGreaterThan(0)
  })

  it("moves several parts at once", () => {
    const r = routine([step(), step({ id: "s2", partId: "wrist", from: 10, to: 20 })])
    const at = evaluateRoutine(r, 500)
    expect(at.arm).toBeCloseTo(45)
    expect(at.wrist).toBeCloseTo(15)
  })

  it("routineDuration counts the ping-pong's return", () => {
    expect(routineDuration(routine([step()]))).toBe(1000)
    expect(routineDuration(routine([step({ pingPong: true })]))).toBe(2000)
    expect(routineDuration(routine([step({ startMs: 500, durationMs: 200 })]))).toBe(700)
    expect(routineDuration(routine([]))).toBe(0)
  })

  it("a zero duration does not break interpolation", () => {
    const r = routine([step({ durationMs: 0 })])
    expect(isFinite(evaluateRoutine(r, 10).arm)).toBe(true)
  })

  it("normalizeRoutines drops what cannot be used and deduplicates", () => {
    const routines = normalizeRoutines([
      { id: "a", name: "A", steps: [{ id: "s", partId: "p" }, { id: "s2" }, null] },
      { id: "a", name: "duplicada" },
      { name: "sin id" },
    ])
    expect(routines).toHaveLength(1)
    expect(routines[0].name).toBe("A")
    expect(routines[0].steps).toHaveLength(1)
    expect(routines[0].steps[0].durationMs).toBe(1000)
  })

  it("sweepStep uses the joint's limits", () => {
    const part = {
      ...makeMechanism3dPart("arm", "Arm", null),
      joint: { ...defaultMechanism3dJoint, type: "revolute" as const, min: -30, max: 120 },
    }
    const s = sweepStep(part, "s1")!
    expect(s.from).toBe(-30)
    expect(s.to).toBe(120)
    expect(s.pingPong).toBe(true)
  })

  it("sweepStep makes up a travel if there are no limits", () => {
    const part = {
      ...makeMechanism3dPart("arm", "Arm", null),
      joint: { ...defaultMechanism3dJoint, type: "revolute" as const },
    }
    const s = sweepStep(part, "s1")!
    expect(s.from).toBe(-45)
    expect(s.to).toBe(45)
  })

  it("sweepStep does not apply to a fixed or pose joint", () => {
    const fixed = makeMechanism3dPart("a", "A", null)
    expect(sweepStep(fixed, "s")).toBeNull()
  })
})
