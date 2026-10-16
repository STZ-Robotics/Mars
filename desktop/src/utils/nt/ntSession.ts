// The NT Session's core: what shape each type has, how it is published, and how
// it turns into Java code ready to paste.
//
// Everything here is PURE. It is the part that gets silently wrong — an angle
// published in degrees when the robot expects radians, a `1` Java reads as an
// int instead of a double — and that is worth being able to test without a
// connection or UI.
//
// ANGLE CONVENTION: the UI and the copied Java work in DEGREES, because it is
// what you have in your head. What goes out on the wire is in RADIANS, which is
// what WPILib's constructors take (`new Rotation2d(double)`,
// `ChassisSpeeds(..., omegaRadiansPerSecond)`). The conversion is done only
// once, here.

import { NTSessionCopyMode, NTSessionEntry, NTSessionKind } from "../../store/appStore"

const DEG = Math.PI / 180

/**
 * The table the session publishes under. It is fixed on purpose: if it were
 * editable, changing it would orphan everything already published under the
 * previous one, and the robot would have to guess which table to look in.
 */
export const NT_SESSION_ROOT = "MarsDesktop"

export interface ComponentSpec {
  label: string
  /** Suffix shown in the UI. */
  suffix: string
  /** Published in radians even though it is edited in degrees. */
  angle?: boolean
}

export interface KindSpec {
  /** The type it is published with on NetworkTables. */
  ntType: string
  /** The WPILib struct's name, if it is published as one. */
  structName?: string
  /** Which of the entry's arrays holds the value. */
  store: "numbers" | "booleans" | "strings"
  /** Fixed components (geometry) or null if the length is free (arrays). */
  components: ComponentSpec[] | null
  /** The declaration's Java type. */
  javaType: string
  /** The import that type needs, if it is not a primitive. */
  javaImport?: string
}

export const NT_SESSION_KINDS: Record<NTSessionKind, KindSpec> = {
  double: { ntType: "double", store: "numbers", components: [{ label: "Value", suffix: "" }], javaType: "double" },
  int: { ntType: "int", store: "numbers", components: [{ label: "Value", suffix: "" }], javaType: "int" },
  boolean: { ntType: "boolean", store: "booleans", components: [{ label: "Value", suffix: "" }], javaType: "boolean" },
  string: { ntType: "string", store: "strings", components: [{ label: "Value", suffix: "" }], javaType: "String" },

  "double[]": { ntType: "double[]", store: "numbers", components: null, javaType: "double[]" },
  "boolean[]": { ntType: "boolean[]", store: "booleans", components: null, javaType: "boolean[]" },
  "string[]": { ntType: "string[]", store: "strings", components: null, javaType: "String[]" },

  Rotation2d: {
    ntType: "struct:Rotation2d", structName: "Rotation2d", store: "numbers", javaType: "Rotation2d",
    javaImport: "edu.wpi.first.math.geometry.Rotation2d",
    components: [{ label: "θ", suffix: "°", angle: true }],
  },
  Translation2d: {
    ntType: "struct:Translation2d", structName: "Translation2d", store: "numbers", javaType: "Translation2d",
    javaImport: "edu.wpi.first.math.geometry.Translation2d",
    components: [{ label: "X", suffix: "m" }, { label: "Y", suffix: "m" }],
  },
  Pose2d: {
    ntType: "struct:Pose2d", structName: "Pose2d", store: "numbers", javaType: "Pose2d",
    javaImport: "edu.wpi.first.math.geometry.Pose2d",
    components: [{ label: "X", suffix: "m" }, { label: "Y", suffix: "m" }, { label: "θ", suffix: "°", angle: true }],
  },
  Translation3d: {
    ntType: "struct:Translation3d", structName: "Translation3d", store: "numbers", javaType: "Translation3d",
    javaImport: "edu.wpi.first.math.geometry.Translation3d",
    components: [{ label: "X", suffix: "m" }, { label: "Y", suffix: "m" }, { label: "Z", suffix: "m" }],
  },
  Pose3d: {
    ntType: "struct:Pose3d", structName: "Pose3d", store: "numbers", javaType: "Pose3d",
    javaImport: "edu.wpi.first.math.geometry.Pose3d",
    components: [
      { label: "X", suffix: "m" }, { label: "Y", suffix: "m" }, { label: "Z", suffix: "m" },
      { label: "Roll", suffix: "°", angle: true },
      { label: "Pitch", suffix: "°", angle: true },
      { label: "Yaw", suffix: "°", angle: true },
    ],
  },
  ChassisSpeeds: {
    ntType: "struct:ChassisSpeeds", structName: "ChassisSpeeds", store: "numbers", javaType: "ChassisSpeeds",
    javaImport: "edu.wpi.first.math.kinematics.ChassisSpeeds",
    components: [
      { label: "vx", suffix: "m/s" }, { label: "vy", suffix: "m/s" },
      { label: "ω", suffix: "°/s", angle: true },
    ],
  },
}

export const NT_SESSION_KIND_ORDER: NTSessionKind[] = [
  "double", "int", "boolean", "string",
  "double[]", "boolean[]", "string[]",
  "Rotation2d", "Translation2d", "Pose2d", "Translation3d", "Pose3d", "ChassisSpeeds",
]

export function kindSpec(kind: NTSessionKind): KindSpec {
  return NT_SESSION_KINDS[kind] ?? NT_SESSION_KINDS.double
}

/** true if the type is a free-length list (elements can be added). */
export function isListKind(kind: NTSessionKind): boolean {
  return kindSpec(kind).components === null
}

// --- Nombres -------------------------------------------------------------------

/**
 * The topic's full path. NT4 requires it to start with "/", and the root is
 * cleaned of extra slashes so "MarsDesktop/" and "/MarsDesktop" give the same.
 */
export function fullTopicName(root: string, key: string): string {
  const cleanRoot = root.replace(/^\/+|\/+$/g, "")
  const cleanKey = key.replace(/^\/+|\/+$/g, "")
  if (cleanRoot.length === 0) return `/${cleanKey}`
  return cleanKey.length === 0 ? `/${cleanRoot}` : `/${cleanRoot}/${cleanKey}`
}

/** The part of a topic after the root, or null if it does not hang from it. */
export function keyFromTopicName(topicName: string, root = NT_SESSION_ROOT): string | null {
  const prefix = `/${root.replace(/^\/+|\/+$/g, "")}/`
  return topicName.startsWith(prefix) ? topicName.slice(prefix.length) : null
}

/**
 * A suggested Java variable name for a key. "Arm/kP" -> "kP",
 * "drive speed" -> "driveSpeed". It never returns something starting with a digit.
 */
export function suggestJavaName(key: string): string {
  const last = key.split("/").filter(Boolean).pop() ?? "value"
  const parts = last.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return "value"

  const head = parts[0]
  const camel = head.charAt(0).toLowerCase() + head.slice(1)
    + parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("")

  return /^[0-9]/.test(camel) ? `v${camel}` : camel
}

// --- Publishing ------------------------------------------------------------------

export interface PublishPayload {
  topicType: string
  /** For a struct it is the struct's BYTES, not its components. */
  value: number | boolean | string | number[] | boolean[] | string[]
}

/**
 * What has to be sent to `set_value` for this entry. Angles are converted to
 * radians here and nowhere else.
 */
export function publishPayload(entry: NTSessionEntry): PublishPayload {
  const spec = kindSpec(entry.kind)

  if (spec.store === "booleans") {
    return entry.kind === "boolean"
      ? { topicType: "boolean", value: entry.booleans[0] ?? false }
      : { topicType: "boolean[]", value: [...entry.booleans] }
  }

  if (spec.store === "strings") {
    return entry.kind === "string"
      ? { topicType: "string", value: entry.strings[0] ?? "" }
      : { topicType: "string[]", value: [...entry.strings] }
  }

  if (entry.kind === "double") return { topicType: "double", value: entry.numbers[0] ?? 0 }
  if (entry.kind === "int") return { topicType: "int", value: Math.round(entry.numbers[0] ?? 0) }
  if (entry.kind === "double[]") return { topicType: "double[]", value: [...entry.numbers] }

  // Geometry: it goes out as a WPILib binary struct, not as an array of
  // numbers. That way the robot reads it with `getStructTopic(name, Pose2d.struct)`
  // instead of having to rebuild it component by component.
  return { topicType: spec.ntType, value: structBytes(entry.kind, entry.numbers) }
}

// --- Serialization of WPILib structs ------------------------------------------
//
// The format is a run of little-endian doubles, with no header or padding, in
// the order WPILib declares the fields. It is exactly the layout the app already
// uses to DECODE structs (see STRUCT_DEFS in valueDecoding.ts); here it is
// walked in the opposite direction.

/**
 * A quaternion from three Euler angles, in the same order as WPILib's
 * `new Rotation3d(roll, pitch, yaw)`: R = Rz(yaw)·Ry(pitch)·Rx(roll).
 * Returns (w, x, y, z), which is the order the struct serializes them in.
 */
export function eulerToQuaternion(roll: number, pitch: number, yaw: number): [number, number, number, number] {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2)
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2)
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2)

  return [
    cr * cp * cy + sr * sp * sy,   // w
    sr * cp * cy - cr * sp * sy,   // x
    cr * sp * cy + sr * cp * sy,   // y
    cr * cp * sy - sr * sp * cy,   // z
  ]
}

/** The doubles that go on the wire, in order, already in WPILib units. */
export function structDoubles(kind: NTSessionKind, numbers: number[]): number[] {
  const at = (i: number) => numbers[i] ?? 0

  switch (kind) {
    case "Rotation2d": return [at(0) * DEG]
    case "Translation2d": return [at(0), at(1)]
    // Pose2d = Translation2d + Rotation2d, aplanado.
    case "Pose2d": return [at(0), at(1), at(2) * DEG]
    case "Translation3d": return [at(0), at(1), at(2)]
    case "Pose3d": {
      // Rotation3d serializes as a quaternion (w, x, y, z), not as roll/pitch/yaw.
      const [w, x, y, z] = eulerToQuaternion(at(3) * DEG, at(4) * DEG, at(5) * DEG)
      return [at(0), at(1), at(2), w, x, y, z]
    }
    case "ChassisSpeeds": return [at(0), at(1), at(2) * DEG]
    default: return []
  }
}

/** The struct's bytes, ready to send over IPC as an array of numbers. */
export function structBytes(kind: NTSessionKind, numbers: number[]): number[] {
  const doubles = structDoubles(kind, numbers)
  const buffer = new ArrayBuffer(doubles.length * 8)
  const view = new DataView(buffer)
  // true = little endian, which is what WPILib's struct format mandates.
  doubles.forEach((value, i) => view.setFloat64(i * 8, value, true))
  return Array.from(new Uint8Array(buffer))
}

// --- Schemas ----------------------------------------------------------------------
//
// A struct published without its schema reads fine on the robot (its Java class
// already knows the layout) but it is opaque to any dynamic consumer —
// AdvantageScope, or MARS' own Dashboard for a type not in its table. The
// schemas are the same strings WPILib publishes.

const STRUCT_SCHEMAS: Record<string, string> = {
  Rotation2d: "double value",
  Translation2d: "double x;double y",
  Pose2d: "Translation2d translation;Rotation2d rotation",
  Translation3d: "double x;double y;double z",
  Quaternion: "double w;double x;double y;double z",
  Rotation3d: "Quaternion q",
  Pose3d: "Translation3d translation;Rotation3d rotation",
  ChassisSpeeds: "double vx;double vy;double omega",
}

/** Which other structs each one depends on, to publish them too. */
const STRUCT_DEPENDENCIES: Record<string, string[]> = {
  Pose2d: ["Translation2d", "Rotation2d"],
  Rotation3d: ["Quaternion"],
  Pose3d: ["Translation3d", "Rotation3d"],
}

export interface SchemaPublication {
  /** The topic's full name, exactly as NT4 expects it. */
  topicName: string
  topicType: string
  /** The schema's text, already in bytes. */
  value: number[]
}

/**
 * The schemas that have to be published for a struct to be readable by a
 * client that does not know it beforehand, including the nested ones and
 * without repeats.
 */
export function schemaPublications(structName: string): SchemaPublication[] {
  const pending = [structName]
  const seen = new Set<string>()
  const out: SchemaPublication[] = []

  while (pending.length > 0) {
    const name = pending.shift()!
    if (seen.has(name)) continue
    seen.add(name)

    const schema = STRUCT_SCHEMAS[name]
    if (schema === undefined) continue

    out.push({
      topicName: `/.schema/struct:${name}`,
      topicType: "structschema",
      value: Array.from(new TextEncoder().encode(schema)),
    })
    pending.push(...(STRUCT_DEPENDENCIES[name] ?? []))
  }

  return out
}

/** Every schema a set of entries needs, without repeats. */
export function schemasForEntries(entries: NTSessionEntry[]): SchemaPublication[] {
  const seen = new Set<string>()
  const out: SchemaPublication[] = []

  entries.forEach(entry => {
    const structName = kindSpec(entry.kind).structName
    if (!structName) return
    schemaPublications(structName).forEach(publication => {
      if (seen.has(publication.topicName)) return
      seen.add(publication.topicName)
      out.push(publication)
    })
  })

  return out
}

// --- Java ---------------------------------------------------------------------------

/**
 * Java infers `int` from a literal without a dot, so `double x = 1` compiles
 * but `double[] a = {1}` does not. The dot is always emitted for doubles.
 */
export function javaNumber(value: number, integer = false): string {
  if (!isFinite(value)) return integer ? "0" : "0.0"
  if (integer) return String(Math.round(value))

  // toFixed(6) kills the binary noise (0.30000000000000004) without cutting
  // useful precision; Number() strips the extra zeros again.
  const trimmed = Number(value.toFixed(6)).toString()
  return /[.eE]/.test(trimmed) ? trimmed : `${trimmed}.0`
}

function javaString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** An angle edited in degrees, written as radians in the Java. */
function javaRadians(degrees: number): string {
  return `Math.toRadians(${javaNumber(degrees)})`
}

/** The value alone, without `Type name =` or a semicolon. */
export function javaValueLiteral(entry: NTSessionEntry): string {
  const spec = kindSpec(entry.kind)
  const n = (i: number) => javaNumber(entry.numbers[i] ?? 0)

  switch (entry.kind) {
    case "double": return javaNumber(entry.numbers[0] ?? 0)
    case "int": return javaNumber(entry.numbers[0] ?? 0, true)
    case "boolean": return String(entry.booleans[0] ?? false)
    case "string": return javaString(entry.strings[0] ?? "")

    case "double[]": return `{ ${entry.numbers.map(v => javaNumber(v)).join(", ")} }`
    case "boolean[]": return `{ ${entry.booleans.map(String).join(", ")} }`
    case "string[]": return `{ ${entry.strings.map(javaString).join(", ")} }`

    case "Rotation2d": return `Rotation2d.fromDegrees(${javaNumber(entry.numbers[0] ?? 0)})`
    case "Translation2d": return `new Translation2d(${n(0)}, ${n(1)})`
    case "Pose2d":
      return `new Pose2d(${n(0)}, ${n(1)}, Rotation2d.fromDegrees(${javaNumber(entry.numbers[2] ?? 0)}))`
    case "Translation3d": return `new Translation3d(${n(0)}, ${n(1)}, ${n(2)})`
    case "Pose3d":
      return `new Pose3d(${n(0)}, ${n(1)}, ${n(2)}, new Rotation3d(`
        + `${javaRadians(entry.numbers[3] ?? 0)}, ${javaRadians(entry.numbers[4] ?? 0)}, ${javaRadians(entry.numbers[5] ?? 0)}))`
    case "ChassisSpeeds":
      return `new ChassisSpeeds(${n(0)}, ${n(1)}, ${javaRadians(entry.numbers[2] ?? 0)})`

    default: return spec.javaType
  }
}

/** `double kA = 0.3;` */
export function javaDeclaration(entry: NTSessionEntry): string {
  const spec = kindSpec(entry.kind)
  const name = entry.javaName || suggestJavaName(entry.key)
  const literal = javaValueLiteral(entry)

  // Arrays need `new type[] { ... }` outside a declaration, but inside one the
  // braces are enough.
  return `${spec.javaType} ${name} = ${literal};`
}

/**
 * Reading from NetworkTables with the current value as the default. Geometry
 * needs two lines: NT has no Pose2d getter, so the `double[]` is read and
 * rebuilt.
 */
export function javaGetter(entry: NTSessionEntry, root: string): string {
  const spec = kindSpec(entry.kind)
  const name = entry.javaName || suggestJavaName(entry.key)
  const cleanRoot = root.replace(/^\/+|\/+$/g, "")
  const cleanKey = entry.key.replace(/^\/+|\/+$/g, "")
  const table = `NetworkTableInstance.getDefault().getTable(${javaString(cleanRoot)}).getEntry(${javaString(cleanKey)})`

  switch (entry.kind) {
    case "double": return `double ${name} = ${table}.getDouble(${javaNumber(entry.numbers[0] ?? 0)});`
    case "int": return `int ${name} = (int) ${table}.getInteger(${javaNumber(entry.numbers[0] ?? 0, true)});`
    case "boolean": return `boolean ${name} = ${table}.getBoolean(${entry.booleans[0] ?? false});`
    case "string": return `String ${name} = ${table}.getString(${javaString(entry.strings[0] ?? "")});`

    case "double[]":
      return `double[] ${name} = ${table}.getDoubleArray(new double[] ${javaValueLiteral(entry)});`
    case "boolean[]":
      return `boolean[] ${name} = ${table}.getBooleanArray(new boolean[] ${javaValueLiteral(entry)});`
    case "string[]":
      return `String[] ${name} = ${table}.getStringArray(new String[] ${javaValueLiteral(entry)});`

    default: {
      // Geometry: it is published as a struct, so on the robot side it is read
      // with a typed StructSubscriber and there is nothing to rebuild by hand.
      const topic = javaString(fullTopicName(root, entry.key))
      const type = spec.javaType
      const subscribe = `NetworkTableInstance.getDefault().getStructTopic(${topic}, ${type}.struct)`
        + `.subscribe(${javaValueLiteral(entry)})`
      return `StructSubscriber<${type}> ${name}Sub = ${subscribe};\n${type} ${name} = ${name}Sub.get();`
    }
  }
}

/** The text that goes to the clipboard for an entry, according to the chosen mode. */
export function javaSnippet(entry: NTSessionEntry, mode: NTSessionCopyMode, root: string): string {
  const body = mode === "value" ? javaValueLiteral(entry)
    : mode === "getter" ? javaGetter(entry, root)
    : javaDeclaration(entry)

  // The note goes as a comment, except in "value" mode: there what is copied
  // is pasted in the middle of an expression and a // would break the line.
  return entry.note.trim().length > 0 && mode !== "value"
    ? `// ${entry.note.trim()}\n${body}`
    : body
}

/**
 * All the entries together, with whatever imports are needed on top. It is
 * what gets pasted in one go into a constants file.
 */
export function javaBlock(entries: NTSessionEntry[], mode: NTSessionCopyMode, root: string): string {
  if (entries.length === 0) return ""

  const imports = new Set<string>()
  entries.forEach(entry => {
    const spec = kindSpec(entry.kind)
    if (spec.javaImport) imports.add(spec.javaImport)
    // A Pose2d is built with a Rotation2d, so it drags its import along.
    if (entry.kind === "Pose2d") imports.add("edu.wpi.first.math.geometry.Rotation2d")
    if (entry.kind === "Pose3d") imports.add("edu.wpi.first.math.geometry.Rotation3d")
  })
  if (mode === "getter") {
    imports.add("edu.wpi.first.networktables.NetworkTableInstance")
    // Structs are read with a typed subscriber, which is another import.
    if (entries.some(entry => kindSpec(entry.kind).structName)) {
      imports.add("edu.wpi.first.networktables.StructSubscriber")
    }
  }

  const header = [...imports].sort().map(i => `import ${i};`).join("\n")
  const body = entries.map(entry => javaSnippet(entry, mode, root)).join("\n")
  return header.length > 0 ? `${header}\n\n${body}` : body
}

// --- Creation and normalization ----------------------------------------------------

/** A new entry, already with the number of components its type needs. */
export function makeEntry(id: string, key: string, kind: NTSessionKind): NTSessionEntry {
  return {
    id,
    key,
    kind,
    javaName: suggestJavaName(key),
    ...emptyValues(kind),
    min: 0,
    max: 1,
    step: 0.01,
    useSlider: kind === "double",
    note: "",
  }
}

function emptyValues(kind: NTSessionKind): Pick<NTSessionEntry, "numbers" | "booleans" | "strings"> {
  const spec = kindSpec(kind)
  const length = spec.components?.length ?? 1
  return {
    numbers: spec.store === "numbers" ? new Array(length).fill(0) : [],
    booleans: spec.store === "booleans" ? new Array(length).fill(false) : [],
    strings: spec.store === "strings" ? new Array(length).fill("") : [],
  }
}

/**
 * Adjusts an entry's values when changing type, keeping what it can: going
 * from Translation2d to Pose2d should not erase the X and Y already set.
 */
export function changeKind(entry: NTSessionEntry, kind: NTSessionKind): NTSessionEntry {
  const spec = kindSpec(kind)
  const length = spec.components?.length ?? Math.max(1, entry[spec.store].length)
  const empty = emptyValues(kind)

  const keep = <T,>(previous: T[], blank: T[]): T[] =>
    blank.map((fallback, i) => (previous[i] !== undefined ? previous[i] : fallback))

  return {
    ...entry,
    kind,
    numbers: spec.store === "numbers" ? keep(entry.numbers, new Array(length).fill(0)) : [],
    booleans: spec.store === "booleans" ? keep(entry.booleans, new Array(length).fill(false)) : [],
    strings: spec.store === "strings" ? keep(entry.strings, new Array(length).fill("")) : [],
    useSlider: spec.components !== null && spec.store === "numbers" ? entry.useSlider : false,
    ...(spec.store === "numbers" ? {} : { numbers: empty.numbers }),
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && isFinite(value) ? value : fallback
}

export function normalizeEntry(raw: any): NTSessionEntry | null {
  if (!raw || typeof raw !== "object") return null
  if (typeof raw.id !== "string" || raw.id.length === 0) return null

  const kind: NTSessionKind = NT_SESSION_KIND_ORDER.includes(raw.kind) ? raw.kind : "double"
  const key = typeof raw.key === "string" ? raw.key : "value"
  const base = makeEntry(raw.id, key, kind)

  return {
    ...base,
    javaName: typeof raw.javaName === "string" && raw.javaName.length > 0 ? raw.javaName : base.javaName,
    numbers: Array.isArray(raw.numbers) ? raw.numbers.map((v: unknown) => num(v, 0)) : base.numbers,
    booleans: Array.isArray(raw.booleans) ? raw.booleans.map((v: unknown) => v === true) : base.booleans,
    strings: Array.isArray(raw.strings) ? raw.strings.map((v: unknown) => typeof v === "string" ? v : "") : base.strings,
    min: num(raw.min, base.min),
    max: num(raw.max, base.max),
    // A step of 0 leaves the slider stuck and the input unable to change anything.
    step: Math.abs(num(raw.step, base.step)) || base.step,
    useSlider: raw.useSlider === true,
    note: typeof raw.note === "string" ? raw.note : "",
  }
}

export function normalizeEntries(raw: unknown): NTSessionEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()

  return raw
    .map(normalizeEntry)
    .filter((entry): entry is NTSessionEntry => {
      if (entry === null || seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
}
