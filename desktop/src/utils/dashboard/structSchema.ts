// Compiler of WPILib struct schemas.
//
// Alongside each "struct:Foo" topic, WPILib publishes a sibling topic
// "/.schema/struct:Foo" whose value is a TEXT describing the binary layout:
//
//     Pose2d              -> "Translation2d translation;Rotation2d rotation"
//     Translation2d       -> "double x;double y"
//     SwerveModuleState   -> "double speed;Rotation2d angle"
//     with an enum        -> "enum {kOff=0, kOn=1} int8 mode"
//     with a bitfield     -> "int32 flags:4"
//     with an array       -> "double xs[3]"
//
// Compiling that text is what makes it possible to understand structs the team
// defined on its own, instead of depending on valueDecoding.ts' hand-written
// table (which only covers the types WPILib carries).
//
// Spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/struct.adoc

import type { StructDef, StructField, StructPrimitive } from "./valueDecoding"

// Width in BITS of each primitive type. It is also the maximum size a bitfield
// of that type can declare.
const PRIMITIVE_BITS: Record<StructPrimitive, number> = {
  bool: 8,
  char: 8,
  int8: 8,
  int16: 16,
  int32: 32,
  int64: 64,
  uint8: 8,
  uint16: 16,
  uint32: 32,
  uint64: 64,
  float: 32,
  float32: 32,
  double: 64,
  float64: 64,
}

const PRIMITIVES = Object.keys(PRIMITIVE_BITS) as StructPrimitive[]

// Only integers and bool can be packed into a bitfield; a double with ":4" is
// invalid and is discarded.
const BITFIELD_TYPES = new Set<StructPrimitive>([
  "bool", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
])

function isPrimitive(type: string): type is StructPrimitive {
  return (PRIMITIVES as string[]).includes(type)
}

// Cap on the fields flattened from a struct. A "Pose3d poses[200]" would
// generate thousands of rows no card can show; better to cut and warn.
const MAX_FLAT_FIELDS = 64

// --- Parseo del texto -------------------------------------------------------

interface ParsedField {
  name: string
  /** A primitive, or another struct's name. */
  type: string
  enumValues: Record<number, string> | null
  bitWidth: number | null
  arrayLength: number | null
}

function parseEnumBody(body: string): Record<number, string> {
  const out: Record<number, string> = {}
  body.split(",").forEach(pair => {
    const [name, value] = pair.split("=")
    if (name === undefined || value === undefined) return
    const parsed = Number(value.trim())
    if (!isNaN(parsed)) out[parsed] = name.trim()
  })
  return out
}

export function parseSchema(text: string): ParsedField[] {
  const fields: ParsedField[] = []

  // Enum bodies use "," and never ";", so splitting on ";" is safe.
  for (const rawDecl of text.split(";")) {
    let decl = rawDecl.trim()
    if (decl.length === 0) continue

    let enumValues: Record<number, string> | null = null
    if (decl.startsWith("enum")) {
      const open = decl.indexOf("{")
      const close = decl.indexOf("}")
      if (open === -1 || close === -1) continue
      enumValues = parseEnumBody(decl.substring(open + 1, close))
      decl = decl.substring(close + 1).trim()
    }

    const parts = decl.split(/\s+/).filter(p => p.length > 0)
    if (parts.length < 2) continue
    const type = parts[0]
    const nameSpec = parts.slice(1).join("")

    let name = nameSpec
    let bitWidth: number | null = null
    let arrayLength: number | null = null

    if (nameSpec.includes(":")) {
      const [n, w] = nameSpec.split(":")
      name = n
      bitWidth = Number(w)
      if (isNaN(bitWidth) || bitWidth <= 0) continue
      // A bitfield on a type that does not allow it (or a bool wider than 1 bit)
      // is invalid according to the spec.
      if (!isPrimitive(type) || !BITFIELD_TYPES.has(type)) continue
      if (type === "bool" && bitWidth !== 1) continue
    } else if (nameSpec.includes("[")) {
      const [n, rest] = nameSpec.split("[")
      name = n
      arrayLength = Number(rest.split("]")[0])
      if (isNaN(arrayLength) || arrayLength < 0) continue
    }

    fields.push({ name, type, enumValues, bitWidth, arrayLength })
  }

  return fields
}

// --- Position calculation --------------------------------------------------

interface CompiledField extends ParsedField {
  /** [start, end) in BITS from the start of the struct. */
  bitRange: [number, number]
}

export interface CompiledSchema {
  /** Total size in BITS. */
  bitLength: number
  fields: CompiledField[]
}

/**
 * Assigns bit positions. Returns null if the schema references another struct
 * that has not been compiled yet (it has to be retried when that one arrives).
 *
 * Bitfield packing follows the spec: consecutive bits of the same type share a
 * word, and a new word is opened when the type changes or when the value no
 * longer fits in the current one.
 */
export function compileSchema(
  parsed: ParsedField[],
  known: Record<string, CompiledSchema>,
): CompiledSchema | null {
  const fields: CompiledField[] = []
  let bitPosition = 0

  // The open bitfield word: how many bits are used and how wide the word is.
  // null in both = there is none open.
  let bitfieldPosition: number | null = null
  let bitfieldLength: number | null = null

  const closeBitfield = () => {
    if (bitfieldPosition !== null && bitfieldLength !== null) {
      // The word's leftover bits still take up room.
      bitPosition += bitfieldLength - bitfieldPosition
    }
    bitfieldPosition = null
    bitfieldLength = null
  }

  for (const field of parsed) {
    if (!isPrimitive(field.type)) {
      const child = known[field.type]
      if (child === undefined) return null // falta una dependencia
      closeBitfield()
      const length = child.bitLength * (field.arrayLength ?? 1)
      fields.push({ ...field, bitRange: [bitPosition, bitPosition + length] })
      bitPosition += length
      continue
    }

    if (field.bitWidth === null) {
      closeBitfield()
      const length = PRIMITIVE_BITS[field.type] * (field.arrayLength ?? 1)
      fields.push({ ...field, bitRange: [bitPosition, bitPosition + length] })
      bitPosition += length
      continue
    }

    const typeLength = PRIMITIVE_BITS[field.type]
    const valueBits = Math.min(field.bitWidth, typeLength)
    const needsNewWord =
      bitfieldPosition === null ||
      bitfieldLength === null ||
      // A bool fits in any word; the rest need one of their own size.
      (field.type !== "bool" && bitfieldLength !== typeLength) ||
      bitfieldPosition + valueBits > bitfieldLength

    if (needsNewWord) {
      closeBitfield()
      bitfieldPosition = 0
      bitfieldLength = typeLength
    }

    fields.push({ ...field, bitRange: [bitPosition, bitPosition + valueBits] })
    bitfieldPosition = (bitfieldPosition ?? 0) + valueBits
    bitPosition += valueBits
  }

  closeBitfield()

  return { bitLength: bitPosition, fields }
}

// --- Aplanado a StructDef ---------------------------------------------------

// The widgets and the extractors consume a FLAT list of fields with offsets,
// just like the hand-written table. Flattening here (instead of making each
// consumer understand nested structs) is what lets a dynamic schema come in by
// the same path as a good old Pose2d.
function flatten(
  schema: CompiledSchema,
  known: Record<string, CompiledSchema>,
  prefix: string,
  baseBit: number,
  out: StructField[],
): void {
  for (const field of schema.fields) {
    if (out.length >= MAX_FLAT_FIELDS) return

    const label = prefix.length > 0 ? `${prefix}/${field.name}` : field.name
    const startBit = baseBit + field.bitRange[0]

    if (!isPrimitive(field.type)) {
      const child = known[field.type]
      if (child === undefined) continue
      if (field.arrayLength === null) {
        flatten(child, known, label, startBit, out)
      } else {
        for (let i = 0; i < field.arrayLength; i++) {
          if (out.length >= MAX_FLAT_FIELDS) return
          flatten(child, known, `${label}[${i}]`, startBit + i * child.bitLength, out)
        }
      }
      continue
    }

    // char[] is a string, not a list of loose characters.
    if (field.type === "char" && field.arrayLength !== null) {
      out.push({
        label,
        offset: startBit / 8,
        type: "char",
        charLength: field.arrayLength,
      })
      continue
    }

    const push = (fieldLabel: string, bitOffset: number) => {
      const base: StructField = {
        label: fieldLabel,
        offset: Math.floor(bitOffset / 8),
        type: field.type as StructPrimitive,
      }
      if (field.bitWidth !== null) {
        base.bitOffset = bitOffset
        base.bitWidth = field.bitRange[1] - field.bitRange[0]
      }
      if (field.enumValues !== null) base.enumValues = field.enumValues
      out.push(base)
    }

    if (field.arrayLength === null) {
      push(label, startBit)
    } else {
      const itemBits = PRIMITIVE_BITS[field.type]
      for (let i = 0; i < field.arrayLength; i++) {
        if (out.length >= MAX_FLAT_FIELDS) return
        push(`${label}[${i}]`, startBit + i * itemBits)
      }
    }
  }
}

export function toStructDef(schema: CompiledSchema, known: Record<string, CompiledSchema>): StructDef {
  const fields: StructField[] = []
  flatten(schema, known, "", 0, fields)
  return {
    // The size of ONE instance, which is what decodeStructArrayBytes uses as the
    // stride to slice a struct:X[].
    length: Math.ceil(schema.bitLength / 8),
    fields,
    truncated: fields.length >= MAX_FLAT_FIELDS,
  }
}

// --- Registry with dependency resolution --------------------------------

/**
 * Compiles everything it can from the known texts. A schema that references
 * another cannot be compiled until that other one arrives, and the arrival
 * order over NetworkTables is not guaranteed, so it iterates until a pass
 * manages to compile nothing new.
 */
export function compileAll(texts: Record<string, string>): Record<string, StructDef> {
  const parsed: Record<string, ParsedField[]> = {}
  for (const [name, text] of Object.entries(texts)) {
    parsed[name] = parseSchema(text)
  }

  const compiled: Record<string, CompiledSchema> = {}
  let progress = true
  while (progress) {
    progress = false
    for (const [name, fields] of Object.entries(parsed)) {
      if (name in compiled) continue
      const result = compileSchema(fields, compiled)
      if (result !== null) {
        compiled[name] = result
        progress = true
      }
    }
  }

  const defs: Record<string, StructDef> = {}
  for (const [name, schema] of Object.entries(compiled)) {
    defs[name] = toStructDef(schema, compiled)
  }
  return defs
}
