import { describe, it, expect } from "vitest"
import {
  fullTopicName, suggestJavaName, publishPayload, javaNumber, javaValueLiteral,
  javaDeclaration, javaGetter, javaSnippet, javaBlock, makeEntry, changeKind,
  normalizeEntries, kindSpec, isListKind,
  structBytes, eulerToQuaternion, schemaPublications, schemasForEntries,
  keyFromTopicName, NT_SESSION_ROOT,
} from "./ntSession"
import { NTSessionEntry, NTSessionKind } from "../../store/appStore"

const entry = (kind: NTSessionKind, over: Partial<NTSessionEntry> = {}): NTSessionEntry => ({
  ...makeEntry("e1", "Arm/kP", kind),
  ...over,
})

describe("nombres", () => {
  it("builds the full path with a single slash", () => {
    expect(fullTopicName("MarsDesktop", "Arm/kP")).toBe("/MarsDesktop/Arm/kP")
    expect(fullTopicName("/MarsDesktop/", "/Arm/kP/")).toBe("/MarsDesktop/Arm/kP")
  })

  it("tolerates an empty root", () => {
    expect(fullTopicName("", "kP")).toBe("/kP")
  })

  it("keyFromTopicName trims the root and drops what does not hang from it", () => {
    expect(keyFromTopicName("/MarsDesktop/Arm/kP")).toBe("Arm/kP")
    expect(keyFromTopicName("/SmartDashboard/x")).toBeNull()
    // The root alone is not a key either.
    expect(keyFromTopicName(`/${NT_SESSION_ROOT}`)).toBeNull()
  })

  it("keyFromTopicName can undo what fullTopicName publishes", () => {
    const key = "Auto/start pose"
    expect(keyFromTopicName(fullTopicName(NT_SESSION_ROOT, key))).toBe(key)
  })

  it("suggests a camelCase variable name from the key", () => {
    expect(suggestJavaName("Arm/kP")).toBe("kP")
    expect(suggestJavaName("drive speed")).toBe("driveSpeed")
    expect(suggestJavaName("Auto/start-pose")).toBe("startPose")
  })

  it("never leaves a name starting with a digit", () => {
    expect(suggestJavaName("2ndStage")).toBe("v2ndStage")
  })
})

describe("publishPayload", () => {
  it("publishes scalars with their native type", () => {
    expect(publishPayload(entry("double", { numbers: [0.3] })))
      .toEqual({ topicType: "double", value: 0.3 })
    expect(publishPayload(entry("boolean", { booleans: [true] })))
      .toEqual({ topicType: "boolean", value: true })
    expect(publishPayload(entry("string", { strings: ["auto"] })))
      .toEqual({ topicType: "string", value: "auto" })
  })

  it("rounds the integer instead of sending a decimal", () => {
    expect(publishPayload(entry("int", { numbers: [2.7] })))
      .toEqual({ topicType: "int", value: 3 })
  })

  it("publishes whole arrays", () => {
    expect(publishPayload(entry("double[]", { numbers: [1, 2, 3] })))
      .toEqual({ topicType: "double[]", value: [1, 2, 3] })
    expect(publishPayload(entry("string[]", { strings: ["a", "b"] })))
      .toEqual({ topicType: "string[]", value: ["a", "b"] })
  })

  it("sends geometry as a binary struct, not as an array", () => {
    const payload = publishPayload(entry("Pose2d", { numbers: [1.5, 2, 90] }))
    expect(payload.topicType).toBe("struct:Pose2d")
    // A Pose2d's bytes: three doubles.
    expect(payload.value).toHaveLength(24)
  })

  it("fills missing components with zero", () => {
    // A Pose3d is 56 bytes even if only X was written.
    expect(publishPayload(entry("Pose3d", { numbers: [1] })).value).toHaveLength(56)
  })
})

describe("javaNumber", () => {
  it("always keeps the dot on doubles, so Java does not infer int", () => {
    expect(javaNumber(1)).toBe("1.0")
    expect(javaNumber(0)).toBe("0.0")
    expect(javaNumber(-3)).toBe("-3.0")
  })

  it("cleans binary noise", () => {
    expect(javaNumber(0.1 + 0.2)).toBe("0.3")
  })

  it("integers go without a dot", () => {
    expect(javaNumber(2.7, true)).toBe("3")
  })

  it("does not blow up on non-finite values", () => {
    expect(javaNumber(NaN)).toBe("0.0")
    expect(javaNumber(Infinity, true)).toBe("0")
  })
})

describe("declaraciones Java", () => {
  it("double", () => {
    expect(javaDeclaration(entry("double", { javaName: "kA", numbers: [0.3] })))
      .toBe("double kA = 0.3;")
  })

  it("boolean and String", () => {
    expect(javaDeclaration(entry("boolean", { javaName: "useVision", booleans: [true] })))
      .toBe("boolean useVision = true;")
    expect(javaDeclaration(entry("string", { javaName: "mode", strings: ["auto"] })))
      .toBe('String mode = "auto";')
  })

  it("escapes quotes and backslashes in a String", () => {
    expect(javaDeclaration(entry("string", { javaName: "s", strings: ['a "b" \\c'] })))
      .toBe('String s = "a \\"b\\" \\\\c";')
  })

  it("arreglos", () => {
    expect(javaDeclaration(entry("double[]", { javaName: "offsets", numbers: [0.1, 0.2] })))
      .toBe("double[] offsets = { 0.1, 0.2 };")
    expect(javaDeclaration(entry("string[]", { javaName: "names", strings: ["a", "b"] })))
      .toBe('String[] names = { "a", "b" };')
  })

  it("Rotation2d uses fromDegrees, which is what is shown on screen", () => {
    expect(javaDeclaration(entry("Rotation2d", { javaName: "heading", numbers: [45] })))
      .toBe("Rotation2d heading = Rotation2d.fromDegrees(45.0);")
  })

  it("Pose2d", () => {
    expect(javaDeclaration(entry("Pose2d", { javaName: "start", numbers: [1.5, 2, 45] })))
      .toBe("Pose2d start = new Pose2d(1.5, 2.0, Rotation2d.fromDegrees(45.0));")
  })

  it("Pose3d converts the three angles to radians", () => {
    expect(javaDeclaration(entry("Pose3d", { javaName: "p", numbers: [1, 2, 0.5, 0, 0, 90] })))
      .toBe("Pose3d p = new Pose3d(1.0, 2.0, 0.5, new Rotation3d("
        + "Math.toRadians(0.0), Math.toRadians(0.0), Math.toRadians(90.0)));")
  })

  it("ChassisSpeeds", () => {
    expect(javaDeclaration(entry("ChassisSpeeds", { javaName: "speeds", numbers: [1, 0, 30] })))
      .toBe("ChassisSpeeds speeds = new ChassisSpeeds(1.0, 0.0, Math.toRadians(30.0));")
  })
})

describe("value mode", () => {
  it("copies only the expression, without a type or a semicolon", () => {
    expect(javaValueLiteral(entry("Pose2d", { numbers: [1, 2, 90] })))
      .toBe("new Pose2d(1.0, 2.0, Rotation2d.fromDegrees(90.0))")
    expect(javaValueLiteral(entry("double", { numbers: [0.3] }))).toBe("0.3")
  })

  it("the note is not copied in value mode, because it would break the expression", () => {
    const e = entry("double", { numbers: [1], note: "ganancia" })
    expect(javaSnippet(e, "value", "MarsDesktop")).toBe("1.0")
    expect(javaSnippet(e, "declaration", "MarsDesktop")).toContain("// ganancia\n")
  })
})

describe("modo getter", () => {
  it("reads from the topic with the current value as the default", () => {
    const e = entry("double", { key: "Arm/kP", javaName: "kP", numbers: [0.3] })
    expect(javaGetter(e, "MarsDesktop"))
      .toBe('double kP = NetworkTableInstance.getDefault().getTable("MarsDesktop").getEntry("Arm/kP").getDouble(0.3);')
  })

  it("geometry is read with a typed struct subscriber", () => {
    const e = entry("Pose2d", { key: "Auto/start", javaName: "start", numbers: [1, 2, 90] })
    const out = javaGetter(e, "MarsDesktop")
    expect(out).toContain("StructSubscriber<Pose2d> startSub =")
    expect(out).toContain("Pose2d start = startSub.get();")
  })
})

describe("javaBlock", () => {
  it("gathers the needed imports, sorted and without repeats", () => {
    const block = javaBlock([
      entry("Pose2d", { javaName: "a", numbers: [0, 0, 0] }),
      { ...entry("Rotation2d"), id: "e2", javaName: "b", numbers: [0] },
      { ...entry("double"), id: "e3", javaName: "c", numbers: [1] },
    ], "declaration", "MarsDesktop")

    expect(block).toContain("import edu.wpi.first.math.geometry.Pose2d;")
    expect(block).toContain("import edu.wpi.first.math.geometry.Rotation2d;")
    // Rotation2d appears only once even if two entries ask for it.
    expect(block.match(/geometry\.Rotation2d/g)).toHaveLength(1)
    expect(block).not.toContain("import double")
  })

  it("adds the NetworkTableInstance import only in getter mode", () => {
    const entries = [entry("double", { javaName: "a", numbers: [1] })]
    expect(javaBlock(entries, "getter", "T")).toContain("import edu.wpi.first.networktables.NetworkTableInstance;")
    expect(javaBlock(entries, "declaration", "T")).not.toContain("networktables")
  })

  it("an empty list produces nothing", () => {
    expect(javaBlock([], "declaration", "T")).toBe("")
  })
})

describe("tipos", () => {
  it("arrays are free-length and geometry is not", () => {
    expect(isListKind("double[]")).toBe(true)
    expect(isListKind("Pose2d")).toBe(false)
    expect(kindSpec("Pose2d").components).toHaveLength(3)
  })

  it("makeEntry creates the type's number of components", () => {
    expect(makeEntry("a", "k", "Pose3d").numbers).toHaveLength(6)
    expect(makeEntry("a", "k", "boolean").booleans).toEqual([false])
  })

  it("changing type keeps the components that match", () => {
    const before = entry("Translation2d", { numbers: [1.5, 2.5] })
    const after = changeKind(before, "Pose2d")
    expect(after.numbers).toEqual([1.5, 2.5, 0])
  })

  it("changing to a type of another family drags no garbage", () => {
    const after = changeKind(entry("Pose2d", { numbers: [1, 2, 3] }), "string")
    expect(after.strings).toEqual([""])
    expect(after.numbers).toEqual([])
  })
})

describe("normalizeEntries", () => {
  it("drops what has no id and deduplicates", () => {
    const entries = normalizeEntries([
      { id: "a", key: "x", kind: "double" },
      { id: "a", key: "duplicado" },
      { key: "sin id" },
      null,
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe("x")
  })

  it("falls back to the default with an unknown type", () => {
    expect(normalizeEntries([{ id: "a", kind: "Vector7d" }])[0].kind).toBe("double")
  })

  it("cleans NaN and a zero step", () => {
    const [e] = normalizeEntries([{ id: "a", numbers: [1, "x", null], step: 0, min: NaN }])
    expect(e.numbers).toEqual([1, 0, 0])
    expect(e.step).toBeGreaterThan(0)
    expect(isFinite(e.min)).toBe(true)
  })
})

describe("WPILib structs", () => {
  /** Reads back the little-endian doubles structBytes produced. */
  function readDoubles(bytes: number[]): number[] {
    const view = new DataView(new Uint8Array(bytes).buffer)
    const out: number[] = []
    for (let i = 0; i < bytes.length / 8; i++) out.push(view.getFloat64(i * 8, true))
    return out
  }

  it("geometry is published as a struct, not as an array", () => {
    expect(publishPayload(entry("Pose2d", { numbers: [1, 2, 90] })).topicType).toBe("struct:Pose2d")
    expect(publishPayload(entry("Rotation2d", { numbers: [0] })).topicType).toBe("struct:Rotation2d")
    // Explicit arrays are still arrays.
    expect(publishPayload(entry("double[]", { numbers: [1] })).topicType).toBe("double[]")
  })

  it("Rotation2d is 8 bytes with the angle in radians", () => {
    const bytes = structBytes("Rotation2d", [90])
    expect(bytes).toHaveLength(8)
    expect(readDoubles(bytes)[0]).toBeCloseTo(Math.PI / 2)
  })

  it("Pose2d is 24 bytes: x, y, θ flattened", () => {
    const bytes = structBytes("Pose2d", [1.5, -2, 180])
    expect(bytes).toHaveLength(24)
    const [x, y, theta] = readDoubles(bytes)
    expect(x).toBeCloseTo(1.5)
    expect(y).toBeCloseTo(-2)
    expect(theta).toBeCloseTo(Math.PI)
  })

  it("Translation3d and ChassisSpeeds have the length WPILib declares", () => {
    expect(structBytes("Translation3d", [1, 2, 3])).toHaveLength(24)
    expect(structBytes("ChassisSpeeds", [1, 0, 90])).toHaveLength(24)
    expect(readDoubles(structBytes("ChassisSpeeds", [1, 0, 90]))[2]).toBeCloseTo(Math.PI / 2)
  })

  it("Pose3d is 56 bytes and the rotation goes as a quaternion", () => {
    const bytes = structBytes("Pose3d", [1, 2, 3, 0, 0, 90])
    expect(bytes).toHaveLength(56)
    const [x, y, z, w, qx, qy, qz] = readDoubles(bytes)
    expect([x, y, z]).toEqual([1, 2, 3])
    // Yaw de 90° puro: w = z = cos(45°).
    expect(w).toBeCloseTo(Math.SQRT1_2)
    expect(qz).toBeCloseTo(Math.SQRT1_2)
    expect(qx).toBeCloseTo(0)
    expect(qy).toBeCloseTo(0)
  })

  it("the quaternion of three zero angles is the identity", () => {
    expect(eulerToQuaternion(0, 0, 0)).toEqual([1, 0, 0, 0])
  })

  it("eulerToQuaternion sale normalizado", () => {
    const q = eulerToQuaternion(0.3, -0.8, 2.1)
    const norm = Math.hypot(q[0], q[1], q[2], q[3])
    expect(norm).toBeCloseTo(1)
  })

  it("a struct drags along the schemas it depends on, without repeats", () => {
    const names = schemaPublications("Pose2d").map(s => s.topicName)
    expect(names).toContain("/.schema/struct:Pose2d")
    expect(names).toContain("/.schema/struct:Translation2d")
    expect(names).toContain("/.schema/struct:Rotation2d")
    expect(new Set(names).size).toBe(names.length)
  })

  it("Pose3d drags along Rotation3d and Quaternion", () => {
    const names = schemaPublications("Pose3d").map(s => s.topicName)
    expect(names).toContain("/.schema/struct:Rotation3d")
    expect(names).toContain("/.schema/struct:Quaternion")
  })

  it("the schema travels as text bytes and with the type NT expects", () => {
    const [schema] = schemaPublications("Rotation2d")
    expect(schema.topicType).toBe("structschema")
    expect(new TextDecoder().decode(new Uint8Array(schema.value))).toBe("double value")
  })

  it("schemasForEntries gathers everything from all the values once", () => {
    const names = schemasForEntries([
      entry("Pose2d", { numbers: [0, 0, 0] }),
      { ...entry("Rotation2d"), id: "e2" },
      { ...entry("double"), id: "e3" },
    ]).map(s => s.topicName)

    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain("/.schema/struct:Pose2d")
    // A double needs no schema at all.
    expect(names.every(n => n.startsWith("/.schema/struct:"))).toBe(true)
  })

  it("a struct's getter uses StructSubscriber and not a double[]", () => {
    const out = javaGetter(entry("Pose2d", { key: "Auto/start", javaName: "start", numbers: [1, 2, 45] }), "MarsDesktop")
    expect(out).toContain("StructSubscriber<Pose2d>")
    expect(out).toContain("getStructTopic(\"/MarsDesktop/Auto/start\", Pose2d.struct)")
    expect(out).not.toContain("getDoubleArray")
  })
})
