import { describe, it, expect } from "vitest"
import { compileAll } from "./structSchema"
import { STRUCT_DEFS, decodeStructBytes, StructDef } from "./valueDecoding"

// Descriptors exactly as allwpilib publishes them in "/.schema/struct:<Type>".
const WPILIB_SCHEMAS: Record<string, string> = {
  Translation2d: "double x;double y",
  Rotation2d: "double value",
  Pose2d: "Translation2d translation;Rotation2d rotation",
  Transform2d: "Translation2d translation;Rotation2d rotation",
  Twist2d: "double dx;double dy;double dtheta",
  Translation3d: "double x;double y;double z",
  Quaternion: "double w;double x;double y;double z",
  Rotation3d: "Quaternion q",
  Pose3d: "Translation3d translation;Rotation3d rotation",
  Transform3d: "Translation3d translation;Rotation3d rotation",
  Twist3d: "double dx;double dy;double dz;double rx;double ry;double rz",
  ChassisSpeeds: "double vx;double vy;double omega",
  SwerveModuleState: "double speed;Rotation2d angle",
  SwerveModulePosition: "double distance;Rotation2d angle",
  DifferentialDriveWheelSpeeds: "double left;double right",
  DifferentialDriveWheelPositions: "double left;double right",
  DifferentialDriveWheelVoltages: "double left;double right",
  MecanumDriveWheelSpeeds: "double front_left;double front_right;double rear_left;double rear_right",
  MecanumDriveWheelPositions: "double front_left;double front_right;double rear_left;double rear_right",
  Ellipse2d: "Pose2d center;double xSemiAxis;double ySemiAxis",
  Rectangle2d: "Pose2d center;double xWidth;double yWidth",
}

// --- Helpers para armar buffers binarios ------------------------------------

function f64(value: number): number[] {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, value, true)
  return [...new Uint8Array(buf)]
}

function i32(value: number): number[] {
  const buf = new ArrayBuffer(4)
  new DataView(buf).setInt32(0, value, true)
  return [...new Uint8Array(buf)]
}

const labels = (def: StructDef) => def.fields.map(f => f.label)
const offsets = (def: StructDef) => def.fields.map(f => f.offset)

// ---------------------------------------------------------------------------

describe("compiling against the WPILib types", () => {
  const compiled = compileAll(WPILIB_SCHEMAS)

  // STRUCT_DEFS is the table that was already written by hand and that we know is
  // right, so it works as a reference: if the compiler gets the same offsets and
  // sizes for the 21 types, the bit arithmetic is the spec's.
  const shared = Object.keys(STRUCT_DEFS).filter(name => name in WPILIB_SCHEMAS)

  it("covers every type shared with the hand-written table", () => {
    expect(shared.length).toBe(21)
  })

  it.each(shared)("%s matches STRUCT_DEFS", name => {
    const actual = compiled[name]
    const expected = STRUCT_DEFS[name]
    expect(actual, `${name} did not compile`).toBeDefined()
    expect(actual.length).toBe(expected.length)
    expect(offsets(actual)).toEqual(offsets(expected))
  })
})

describe("the team's own structs", () => {
  const defs = compileAll({
    ...WPILIB_SCHEMAS,
    ArmState: "double angle;bool homed;int32 faultCount;Rotation2d target",
  })
  const arm = defs.ArmState

  it("adds up the sizes of mixed types without alignment", () => {
    // 8 (double) + 1 (bool) + 4 (int32) + 8 (Rotation2d) = 21
    expect(arm.length).toBe(21)
    expect(offsets(arm)).toEqual([0, 8, 9, 13])
    expect(arm.fields.map(f => f.type)).toEqual(["double", "bool", "int32", "double"])
  })

  it("flattens the nested struct with the path as the label", () => {
    expect(labels(arm)).toEqual(["angle", "homed", "faultCount", "target/value"])
  })

  it("decodes each field with its type", () => {
    const bytes = [...f64(1.25), 1, ...i32(-7), ...f64(0.5)]
    const fields = decodeStructBytes(bytes, arm)

    expect(fields[0].value).toBe(1.25)
    expect(fields[1].text).toBe("true")
    expect(fields[2].value).toBe(-7)
    // Integers are shown without decimals; everything used to go through toFixed(2).
    expect(fields[2].text).toBe("-7")
    expect(fields[3].value).toBe(0.5)
  })
})

describe("enums", () => {
  const defs = compileAll({ Mode: "enum {kOff=0, kAuto=1, kManual=2} int8 mode;double setpoint" })
  const mode = defs.Mode

  it("does not change the layout", () => {
    expect(mode.length).toBe(9)
    expect(offsets(mode)).toEqual([0, 1])
  })

  it("shows the declared name instead of the number", () => {
    const fields = decodeStructBytes([2, ...f64(3.5)], mode)
    expect(fields[0].value).toBe(2)
    expect(fields[0].text).toBe("kManual")
  })

  it("falls back to the number if the value is not in the enum", () => {
    const fields = decodeStructBytes([9, ...f64(0)], mode)
    expect(fields[0].text).toBe("9")
  })
})

describe("bitfields", () => {
  it("packs consecutive bools into a single word", () => {
    const flags = compileAll({ Flags: "bool a:1;bool b:1;bool c:1;bool d:1;double value" }).Flags

    // The four bools share a byte; the double starts on the next one.
    expect(flags.length).toBe(9)
    expect(flags.fields.slice(0, 4).map(f => f.bitOffset)).toEqual([0, 1, 2, 3])
    expect(flags.fields[4].offset).toBe(1)

    // a=1, b=0, c=1, d=0 -> 0b0101
    const fields = decodeStructBytes([0b0101, ...f64(2)], flags)
    expect(fields.map(f => f.text)).toEqual(["true", "false", "true", "false", "2.00"])
  })

  it("opens a new word when the value no longer fits", () => {
    // 6 + 4 bits do not fit in a single uint8: the second one opens another word.
    const packed = compileAll({ P: "uint8 a:6;uint8 b:4" }).P
    expect(packed.length).toBe(2)
    expect(packed.fields.map(f => f.bitOffset)).toEqual([0, 8])
  })

  it("sign-extends signed integers", () => {
    const signed = compileAll({ S: "int8 v:4" }).S
    expect(signed.length).toBe(1)
    // 0b1101 is 13 unsigned, but -3 read as a signed 4-bit value.
    expect(decodeStructBytes([0b1101], signed)[0].value).toBe(-3)
  })

  it("drops bitfields that are invalid according to the spec", () => {
    // A double does not allow a bitfield and a bool only allows width 1.
    const invalid = compileAll({ Bad: "double d:4;bool b:3;double ok" }).Bad
    expect(labels(invalid)).toEqual(["ok"])
  })
})

describe("arrays", () => {
  const defs = compileAll({ ...WPILIB_SCHEMAS, Path: "double xs[3];Translation2d pts[2]" })
  const path = defs.Path

  it("flattens arrays of primitives and of structs", () => {
    // 3*8 + 2*16 = 56
    expect(path.length).toBe(56)
    expect(labels(path)).toEqual([
      "xs[0]", "xs[1]", "xs[2]",
      "pts[0]/x", "pts[0]/y", "pts[1]/x", "pts[1]/y",
    ])
    expect(offsets(path)).toEqual([0, 8, 16, 24, 32, 40, 48])
  })

  it("treats char[] as a single string", () => {
    const named = compileAll({ Named: "char name[4];double v" }).Named
    expect(named.length).toBe(12)
    expect(named.fields.length).toBe(2)

    const fields = decodeStructBytes([65, 66, 67, 0, ...f64(9)], named)
    expect(fields[0].text).toBe("ABC")
    expect(fields[1].value).toBe(9)
  })

  it("cuts the flattening of huge arrays and marks it", () => {
    // A Pose3d poses[200] would generate 1400 rows no card shows.
    const huge = compileAll({ ...WPILIB_SCHEMAS, Huge: "Pose3d poses[200]" }).Huge
    expect(huge.truncated).toBe(true)
    expect(huge.fields.length).toBeLessThanOrEqual(64)
    // The instance's size is still the real one, which is what
    // decodeStructArrayBytes uses as the stride.
    expect(huge.length).toBe(200 * 56)
  })
})

describe("dependency resolution", () => {
  it("compiles even if the child arrives after the parent", () => {
    // The arrival order over NetworkTables is not guaranteed.
    const defs = compileAll({
      Parent: "Child c;double after",
      Child: "double a;double b",
    })
    expect(defs.Parent.length).toBe(24)
    expect(labels(defs.Parent)).toEqual(["c/a", "c/b", "after"])
  })

  it("does not compile a struct whose dependency never arrived", () => {
    const defs = compileAll({ Orphan: "Unknown u;double x" })
    expect(defs.Orphan).toBeUndefined()
  })

  it("compiles the rest even if one stays unresolved", () => {
    const defs = compileAll({
      Orphan: "Unknown u",
      Fine: "double x;double y",
    })
    expect(defs.Orphan).toBeUndefined()
    expect(defs.Fine.length).toBe(16)
  })
})

describe("entradas degeneradas", () => {
  it("ignores empty or nameless declarations", () => {
    const defs = compileAll({ Broken: ";;garbage;;double ok;" })
    expect(labels(defs.Broken)).toEqual(["ok"])
  })

  it("accepts an empty schema", () => {
    const defs = compileAll({ Empty: "" })
    expect(defs.Empty.length).toBe(0)
    expect(defs.Empty.fields).toEqual([])
  })

  it("does not break if the buffer is shorter than the schema", () => {
    // It really happens: the topic is announced before it has a complete value.
    const def = compileAll({ Big: "double a;double b;double c" }).Big
    const fields = decodeStructBytes(f64(1.5), def)
    expect(fields[0].value).toBe(1.5)
    expect(fields[1].value).toBe(0)
    expect(fields[2].value).toBe(0)
  })
})
