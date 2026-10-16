// Decoding of NT4 values and of WPILib binary structs (Little Endian).

// Unpacks the value coming from Rust (the NTValue enum) into a plain JS value.
export function unpackLiveValue(liveValue: any): any {
  if (!liveValue) return null
  if (liveValue.Number !== undefined) return liveValue.Number
  if (liveValue.Boolean !== undefined) return liveValue.Boolean
  if (liveValue.String !== undefined) return liveValue.String
  if (liveValue.NumberArray !== undefined) return liveValue.NumberArray
  if (liveValue.BooleanArray !== undefined) return liveValue.BooleanArray
  if (liveValue.StringArray !== undefined) return liveValue.StringArray
  if (liveValue.Raw !== undefined) return liveValue.Raw
  return null
}

// IMPORTANT: WPILib's struct schema serializes in Little Endian.
export function readDoubleLE(bytes: number[], offset: number): number {
  if (bytes.length < offset + 8) return 0.0
  const buf = new Uint8Array(bytes.slice(offset, offset + 8)).buffer
  return new DataView(buf).getFloat64(0, true) // true = Little Endian
}

// Primitive types a WPILib schema can declare. The hand-written table below is
// all "double", which is the default when `type` is missing.
export type StructPrimitive =
  | "bool" | "char"
  | "int8" | "int16" | "int32" | "int64"
  | "uint8" | "uint16" | "uint32" | "uint64"
  | "float" | "float32" | "double" | "float64"

export interface StructField {
  label: string
  /** Offset in BYTES from the start of the struct. */
  offset: number
  /** Missing = "double" (every field of STRUCT_DEFS). */
  type?: StructPrimitive
  /** Bitfields only: position and width in BITS; when present, it wins over `offset`. */
  bitOffset?: number
  bitWidth?: number
  /** char[] only: number of characters to read as a single string. */
  charLength?: number
  /** Enums only: number -> name declared in the schema. */
  enumValues?: Record<number, string>
  suffix?: string
  isAngle?: boolean
}

export interface StructDef {
  /** Size in bytes of ONE instance (the stride for slicing a struct:X[]). */
  length: number
  fields: StructField[]
  /** The struct had more fields than get flattened (very big arrays). */
  truncated?: boolean
}

// Adding a new struct (e.g. ChassisSpeeds) is just adding an entry here;
// StructWidget / StructArrayWidget pick it up automatically. "length" is the
// size in bytes of ONE instance of the struct (also key to being able to slice
// an array of structs into individual instances).
//
// All the offsets are computed by flattening nested structs: if a field is
// itself a struct (e.g. Pose2d.translation is a Translation2d), its inner fields
// are inserted at the offset where that sub-struct starts, in the same order
// WPILib declares them in its native Struct<T>.
export const STRUCT_DEFS: Record<string, StructDef> = {
  // --- geometry: 2D ---
  Translation2d: {
    length: 16,
    fields: [
      { label: "X", offset: 0, suffix: " m" },
      { label: "Y", offset: 8, suffix: " m" },
    ],
  },
  Rotation2d: {
    length: 8,
    fields: [{ label: "θ", offset: 0, suffix: "°", isAngle: true }],
  },
  Pose2d: {
    length: 24,
    fields: [
      { label: "X", offset: 0, suffix: " m" },
      { label: "Y", offset: 8, suffix: " m" },
      { label: "θ", offset: 16, suffix: "°", isAngle: true },
    ],
  },
  // Transform2d has EXACTLY the same binary layout as Pose2d
  // (relative translation + rotation instead of absolute).
  Transform2d: {
    length: 24,
    fields: [
      { label: "dX", offset: 0, suffix: " m" },
      { label: "dY", offset: 8, suffix: " m" },
      { label: "dθ", offset: 16, suffix: "°", isAngle: true },
    ],
  },
  Twist2d: {
    length: 24,
    fields: [
      { label: "dx", offset: 0, suffix: " m" },
      { label: "dy", offset: 8, suffix: " m" },
      { label: "dθ", offset: 16, suffix: "°/loop", isAngle: true },
    ],
  },

  // --- geometry: 3D ---
  Translation3d: {
    length: 24,
    fields: [
      { label: "X", offset: 0, suffix: " m" },
      { label: "Y", offset: 8, suffix: " m" },
      { label: "Z", offset: 16, suffix: " m" },
    ],
  },
  // Rotation3d serializes as a Quaternion (w,x,y,z) — not as roll/pitch/yaw.
  // The 4 raw components are kept: converting them to Euler needs real trig
  // (atan2 with gimbal-lock clamps), not a simple rad->deg factor, so it does not
  // fit this file's generic isAngle decoder.
  Rotation3d: {
    length: 32,
    fields: [
      { label: "W", offset: 0 },
      { label: "X", offset: 8 },
      { label: "Y", offset: 16 },
      { label: "Z", offset: 24 },
    ],
  },
  Quaternion: {
    length: 32,
    fields: [
      { label: "W", offset: 0 },
      { label: "X", offset: 8 },
      { label: "Y", offset: 16 },
      { label: "Z", offset: 24 },
    ],
  },
  // Pose3d = Translation3d (24B) + Rotation3d/Quaternion (32B) = 56B
  Pose3d: {
    length: 56,
    fields: [
      { label: "X", offset: 0, suffix: " m" },
      { label: "Y", offset: 8, suffix: " m" },
      { label: "Z", offset: 16, suffix: " m" },
      { label: "QW", offset: 24 },
      { label: "QX", offset: 32 },
      { label: "QY", offset: 40 },
      { label: "QZ", offset: 48 },
    ],
  },
  // Transform3d: the same binary layout as Pose3d (deltas instead of absolutes)
  Transform3d: {
    length: 56,
    fields: [
      { label: "dX", offset: 0, suffix: " m" },
      { label: "dY", offset: 8, suffix: " m" },
      { label: "dZ", offset: 16, suffix: " m" },
      { label: "QW", offset: 24 },
      { label: "QX", offset: 32 },
      { label: "QY", offset: 40 },
      { label: "QZ", offset: 48 },
    ],
  },
  Twist3d: {
    length: 48,
    fields: [
      { label: "dx", offset: 0, suffix: " m" },
      { label: "dy", offset: 8, suffix: " m" },
      { label: "dz", offset: 16, suffix: " m" },
      { label: "rx", offset: 24, suffix: "°/loop", isAngle: true },
      { label: "ry", offset: 32, suffix: "°/loop", isAngle: true },
      { label: "rz", offset: 40, suffix: "°/loop", isAngle: true },
    ],
  },

  // --- geometry: formas 2D (WPILib 2024+) ---
  // Ellipse2d / Rectangle2d = Pose2d (24B, el "center") + 2 doubles extra.
  Ellipse2d: {
    length: 40,
    fields: [
      { label: "Center X", offset: 0, suffix: " m" },
      { label: "Center Y", offset: 8, suffix: " m" },
      { label: "Center θ", offset: 16, suffix: "°", isAngle: true },
      { label: "X Semi-axis", offset: 24, suffix: " m" },
      { label: "Y Semi-axis", offset: 32, suffix: " m" },
    ],
  },
  Rectangle2d: {
    length: 40,
    fields: [
      { label: "Center X", offset: 0, suffix: " m" },
      { label: "Center Y", offset: 8, suffix: " m" },
      { label: "Center θ", offset: 16, suffix: "°", isAngle: true },
      { label: "X Width", offset: 24, suffix: " m" },
      { label: "Y Width", offset: 32, suffix: " m" },
    ],
  },

  // --- kinematics: chassis ---
  ChassisSpeeds: {
    length: 24,
    fields: [
      { label: "Vx", offset: 0, suffix: " m/s" },
      { label: "Vy", offset: 8, suffix: " m/s" },
      { label: "ω", offset: 16, suffix: "°/s", isAngle: true },
    ],
  },

  // --- kinematics: swerve ---
  SwerveModuleState: {
    length: 16,
    fields: [
      { label: "Speed", offset: 0, suffix: " m/s" },
      { label: "Angle", offset: 8, suffix: "°", isAngle: true },
    ],
  },
  SwerveModulePosition: {
    length: 16,
    fields: [
      { label: "Distance", offset: 0, suffix: " m" },
      { label: "Angle", offset: 8, suffix: "°", isAngle: true },
    ],
  },

  // --- kinematics: diferencial ---
  DifferentialDriveWheelSpeeds: {
    length: 16,
    fields: [
      { label: "Left", offset: 0, suffix: " m/s" },
      { label: "Right", offset: 8, suffix: " m/s" },
    ],
  },
  DifferentialDriveWheelPositions: {
    length: 16,
    fields: [
      { label: "Left", offset: 0, suffix: " m" },
      { label: "Right", offset: 8, suffix: " m" },
    ],
  },
  DifferentialDriveWheelVoltages: {
    length: 16,
    fields: [
      { label: "Left", offset: 0, suffix: " V" },
      { label: "Right", offset: 8, suffix: " V" },
    ],
  },

  // --- kinematics: mecanum ---
  MecanumDriveWheelSpeeds: {
    length: 32,
    fields: [
      { label: "Front Left", offset: 0, suffix: " m/s" },
      { label: "Front Right", offset: 8, suffix: " m/s" },
      { label: "Rear Left", offset: 16, suffix: " m/s" },
      { label: "Rear Right", offset: 24, suffix: " m/s" },
    ],
  },
  MecanumDriveWheelPositions: {
    length: 32,
    fields: [
      { label: "Front Left", offset: 0, suffix: " m" },
      { label: "Front Right", offset: 8, suffix: " m" },
      { label: "Rear Left", offset: 16, suffix: " m" },
      { label: "Rear Right", offset: 24, suffix: " m" },
    ],
  },

  // --- trajectory / control ---
  // The type string WPILib publishes for this is "TrapezoidProfile.State".
  "TrapezoidProfile.State": {
    length: 16,
    fields: [
      { label: "Position", offset: 0 },
      { label: "Velocity", offset: 8 },
    ],
  },
}

// --- Lectura de primitivos --------------------------------------------------

const SIGNED_INTS = new Set<StructPrimitive>(["int8", "int16", "int32", "int64"])

// Bitfields pack from the LEAST significant bit of each byte, so they cannot be
// read with DataView: they have to be gathered bit by bit.
function readBitsLE(bytes: number[], bitOffset: number, bitWidth: number): bigint {
  let out = 0n
  for (let i = 0; i < bitWidth; i++) {
    const bit = bitOffset + i
    const byte = bytes[bit >> 3] ?? 0
    if ((byte >> (bit & 7)) & 1) out |= 1n << BigInt(i)
  }
  return out
}

function signExtend(value: bigint, bits: number): bigint {
  const signBit = 1n << BigInt(bits - 1)
  return (value & signBit) !== 0n ? value - (1n << BigInt(bits)) : value
}

function readPrimitive(view: DataView, offset: number, type: StructPrimitive): number {
  try {
    switch (type) {
      case "bool": return view.getUint8(offset) !== 0 ? 1 : 0
      case "char": return view.getUint8(offset)
      case "int8": return view.getInt8(offset)
      case "int16": return view.getInt16(offset, true)
      case "int32": return view.getInt32(offset, true)
      // JS has no 64-bit integers: above 2^53 precision is lost, but it is the
      // same thing every dashboard in the ecosystem does.
      case "int64": return Number(view.getBigInt64(offset, true))
      case "uint8": return view.getUint8(offset)
      case "uint16": return view.getUint16(offset, true)
      case "uint32": return view.getUint32(offset, true)
      case "uint64": return Number(view.getBigUint64(offset, true))
      case "float":
      case "float32": return view.getFloat32(offset, true)
      case "double":
      case "float64": return view.getFloat64(offset, true)
    }
  } catch {
    // A buffer shorter than the schema declares (a freshly announced topic, a
    // truncated value): 0 is shown instead of breaking the whole widget.
  }
  return 0
}

const INTEGER_TYPES = new Set<StructPrimitive>([
  "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
])

export interface DecodedStructField {
  label: string
  /** Numeric view: bool -> 0/1, char[] -> NaN. It is the one the extractors use. */
  value: number
  /** Displayable view, already formatted by type (true/false, the enum's name...). */
  text: string
  suffix?: string
  isAngle?: boolean
}

export function decodeStructBytes(bytes: number[], def: StructDef): DecodedStructField[] {
  const view = new DataView(new Uint8Array(bytes).buffer)

  return def.fields.map(f => {
    const type = f.type ?? "double"

    // char[]: the bytes are a string, not loose numbers.
    if (type === "char" && f.charLength !== undefined) {
      let text = ""
      for (let i = 0; i < f.charLength; i++) {
        const code = bytes[f.offset + i]
        if (code === undefined || code === 0) break
        text += String.fromCharCode(code)
      }
      return { label: f.label, value: NaN, text, suffix: f.suffix }
    }

    let value: number
    if (f.bitOffset !== undefined && f.bitWidth !== undefined) {
      const raw = readBitsLE(bytes, f.bitOffset, f.bitWidth)
      value = Number(SIGNED_INTS.has(type) ? signExtend(raw, f.bitWidth) : raw)
    } else {
      value = readPrimitive(view, f.offset, type)
    }

    if (f.isAngle) value = value * (180 / Math.PI)

    let text: string
    if (f.enumValues !== undefined && f.enumValues[value] !== undefined) {
      text = f.enumValues[value]
    } else if (type === "bool") {
      text = value !== 0 ? "true" : "false"
    } else if (INTEGER_TYPES.has(type)) {
      text = value.toFixed(0)
    } else {
      text = value.toFixed(2)
    }

    return { label: f.label, value, text, suffix: f.suffix, isAngle: f.isAngle }
  })
}

// Slices a buffer of N consecutive structs (e.g. a "SwerveModuleState[]" topic)
// into individual, already decoded instances, using def.length as the stride.
export function decodeStructArrayBytes(bytes: number[], def: StructDef) {
  const count = Math.floor(bytes.length / def.length)
  const out: DecodedStructField[][] = []
  for (let i = 0; i < count; i++) {
    out.push(decodeStructBytes(bytes.slice(i * def.length, (i + 1) * def.length), def))
  }
  return out
}