// Short text shown next to each topic in the Data Directory, like the values
// column of AdvantageScope's sidebar.
//
// It is not the same as what a widget draws: here everything has to fit on one
// line, so arrays are summarized and structs flattened.

import { classifyTopic } from "./topicClassification"
import { decodeStructBytes, unpackLiveValue } from "./valueDecoding"
import { getStructDef } from "../../store/structSchemaStore"

/** How many elements of an array are listed before cutting with "…". */
const ARRAY_PREVIEW_LIMIT = 6
const STRING_PREVIEW_LIMIT = 40

// The same scale AdvantageScope uses: scientific notation at the extremes,
// integers without decimals and 3 decimals for the rest. A "12.000000000001" in
// the tree adds nothing and throws the rows off.
export function formatNumber(value: number): string {
  if (!isFinite(value)) return String(value)
  if (Math.abs(value) < 1e-9) return "0"
  if (Math.abs(value) >= 1e5 || Math.abs(value) < 1e-3) {
    return value.toExponential(1).replace("+", "")
  }
  if (value % 1 === 0) return value.toString()
  return value.toFixed(3)
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text
}

function formatScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return formatNumber(value)
  if (typeof value === "string") return truncate(value, STRING_PREVIEW_LIMIT)
  return String(value)
}

/** Number of elements of an array, or null if the topic is not an array. */
export function arrayLengthOf(topicType: string, liveValue: any): number | null {
  const c = classifyTopic(topicType)

  if (c.isStructArray) {
    // A struct array is raw bytes: the count comes from dividing by the size of
    // ONE instance, which is only known if there is a schema.
    const def = getStructDef(c.structName)
    const bytes: number[] | undefined = liveValue?.Raw
    if (!def || !bytes || def.length === 0) return null
    return Math.floor(bytes.length / def.length)
  }

  if (!c.isArrayType || c.isStructType) return null
  const raw = unpackLiveValue(liveValue)
  return Array.isArray(raw) ? raw.length : null
}

/** The text of ONE element of an array (for the tree's index rows). */
export function formatArrayElement(topicType: string, liveValue: any, index: number): string | null {
  const c = classifyTopic(topicType)

  if (c.isStructArray) {
    const def = getStructDef(c.structName)
    const bytes: number[] | undefined = liveValue?.Raw
    if (!def || !bytes) return null
    const slice = bytes.slice(index * def.length, (index + 1) * def.length)
    if (slice.length < def.length) return null
    return decodeStructBytes(slice, def)
      .map(f => `${f.label}: ${f.text}${f.suffix ?? ""}`)
      .join(", ")
  }

  const raw = unpackLiveValue(liveValue)
  if (!Array.isArray(raw) || index >= raw.length) return null
  return formatScalar(raw[index])
}

/**
 * Summary of a topic's value. Returns null when nothing has arrived yet,
 * which is different from an empty value: the row simply shows no column.
 */
export function formatTopicValue(topicType: string, liveValue: any): string | null {
  if (liveValue === undefined || liveValue === null) return null
  const c = classifyTopic(topicType)

  // A loose struct: flattened to "field: value, field: value". Without a schema
  // it cannot be decoded, but it falls through to the byte count instead of
  // returning null: a blank row cannot be told from "nothing has arrived yet".
  if (c.isStructSingle) {
    const def = getStructDef(c.structName)
    const bytes: number[] | undefined = liveValue?.Raw
    if (def && bytes && bytes.length > 0) {
      return decodeStructBytes(bytes, def)
        .map(f => `${f.label}: ${f.text}${f.suffix ?? ""}`)
        .join(", ")
    }
  }

  if (c.isStructArray) {
    const count = arrayLengthOf(topicType, liveValue)
    if (count !== null) return `${count} × ${c.structName}`
  }

  // The Raw check goes BEFORE the array one: unpackLiveValue returns the bytes
  // as number[], so a struct without a schema was printed as a list of loose
  // bytes ("[1, 2, 3, 4]") instead of saying how many there are.
  if (Array.isArray(liveValue?.Raw)) {
    return `${liveValue.Raw.length} bytes`
  }

  const raw = unpackLiveValue(liveValue)
  if (raw === null) return null

  if (Array.isArray(raw)) {
    if (raw.length === 0) return "empty"
    const shown = raw.slice(0, ARRAY_PREVIEW_LIMIT).map(formatScalar)
    if (raw.length > ARRAY_PREVIEW_LIMIT) shown.push("…")
    return `[${shown.join(", ")}]`
  }

  return formatScalar(raw)
}
