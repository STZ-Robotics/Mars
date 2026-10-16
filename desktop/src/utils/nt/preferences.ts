// WPILib's /Preferences table.
//
// It is the only NetworkTables table that DOES survive a restart: when the
// robot calls `Preferences.initDouble(...)`, WPILib marks the topic with the
// `persistent` property and the server saves it in the roboRIO's
// `networktables.json`. That is why it is where the constants that are
// calibrated once and should not be lost live — encoder offsets, gains, limits.
//
// A detail that changes how this page is used: preferences are DECLARED by the
// robot, not the dashboard. From here values can be changed (and that does
// persist, because the topic already comes marked) and new entries created, but
// an entry created from the dashboard is not marked as persistent until the
// robot code declares it. Same with deleting: really removing a preference is
// `Preferences.remove(...)` on the robot side.

import { TopicAnnounce } from "../../store/appStore"
import { classifyTopic } from "../dashboard/topicClassification"

export const PREFERENCES_TABLE = "Preferences"
const PREFIX = `/${PREFERENCES_TABLE}/`

/** The types `Preferences` knows how to store. */
export type PreferenceKind = "double" | "int" | "boolean" | "string" | "float"

export const PREFERENCE_KINDS: PreferenceKind[] = ["double", "int", "boolean", "string", "float"]

export interface PreferenceRow {
  topicName: string
  /** The key as the robot code uses it, without the prefix. */
  key: string
  kind: PreferenceKind
  topicType: string
}

/** A preference's key, or null if the topic is not one. */
export function preferenceKeyOf(topicName: string): string | null {
  if (!topicName.startsWith(PREFIX)) return null
  const key = topicName.slice(PREFIX.length)

  // WPILib publishes `/Preferences/.type = "RobotPreferences"` to mark the
  // table. It is not a preference and must not appear in the list.
  if (key.length === 0 || key.startsWith(".")) return null
  return key
}

export function preferenceKind(topicType: string): PreferenceKind | null {
  switch (topicType) {
    case "double": return "double"
    case "float": return "float"
    case "int": return "int"
    case "boolean": return "boolean"
    case "string": return "string"
    default: {
      // An odd type (an array, a struct) is not produced by Preferences, but if
      // someone wrote there by hand it is still better to show it than to hide
      // it.
      const c = classifyTopic(topicType)
      if (c.isNumber) return "double"
      if (c.isBoolean) return "boolean"
      if (c.isString) return "string"
      return null
    }
  }
}

/** Everything under /Preferences right now, sorted by key. */
export function collectPreferences(topics: Map<string, TopicAnnounce>): PreferenceRow[] {
  const rows: PreferenceRow[] = []

  topics.forEach(topic => {
    const key = preferenceKeyOf(topic.name)
    if (key === null) return
    const kind = preferenceKind(topic.topic_type)
    if (kind === null) return
    rows.push({ topicName: topic.name, key, kind, topicType: topic.topic_type })
  })

  return rows.sort((a, b) => a.key.localeCompare(b.key))
}

export function preferenceTopicName(key: string): string {
  return `${PREFIX}${key.replace(/^\/+/, "")}`
}

// --- Valores ---------------------------------------------------------------------

export type PreferenceValue = number | boolean | string

export function defaultValueFor(kind: PreferenceKind): PreferenceValue {
  if (kind === "boolean") return false
  if (kind === "string") return ""
  return 0
}

/**
 * Converts what was typed in the box into the type's value, or null if it is
 * not valid yet (half typed, empty, letters in a number).
 */
export function parsePreferenceValue(kind: PreferenceKind, text: string): PreferenceValue | null {
  if (kind === "string") return text
  if (kind === "boolean") {
    const lower = text.trim().toLowerCase()
    if (lower === "true" || lower === "1") return true
    if (lower === "false" || lower === "0") return false
    return null
  }

  if (text.trim().length === 0) return null
  const value = Number(text)
  if (!isFinite(value)) return null
  return kind === "int" ? Math.round(value) : value
}

/** How a value is shown in the edit box. */
export function formatPreferenceValue(value: PreferenceValue | null | undefined): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

// --- Java --------------------------------------------------------------------------

const JAVA_SUFFIX: Record<PreferenceKind, string> = {
  double: "Double",
  float: "Float",
  int: "Int",
  boolean: "Boolean",
  string: "String",
}

const JAVA_TYPE: Record<PreferenceKind, string> = {
  double: "double",
  float: "float",
  int: "int",
  boolean: "boolean",
  string: "String",
}

function javaLiteral(kind: PreferenceKind, value: PreferenceValue): string {
  if (kind === "string") {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  if (kind === "boolean") return value ? "true" : "false"

  const num = typeof value === "number" ? value : 0
  if (kind === "int") return String(Math.round(num))

  // Java infers int from a literal without a dot, and a float needs its suffix.
  const trimmed = Number(num.toFixed(6)).toString()
  const withPoint = /[.eE]/.test(trimmed) ? trimmed : `${trimmed}.0`
  return kind === "float" ? `${withPoint}f` : withPoint
}

function javaKey(key: string): string {
  return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * The line that DECLARES the preference. It is the one that makes the entry
 * exist and be marked as persistent; without it, a key created from the
 * dashboard disappears when the server restarts.
 */
export function javaInit(key: string, kind: PreferenceKind, value: PreferenceValue): string {
  return `Preferences.init${JAVA_SUFFIX[kind]}(${javaKey(key)}, ${javaLiteral(kind, value)});`
}

/** The line that READS it, with the current value as the fallback. */
export function javaGet(key: string, kind: PreferenceKind, value: PreferenceValue, variable?: string): string {
  const name = variable && variable.length > 0 ? variable : javaVariableName(key)
  return `${JAVA_TYPE[kind]} ${name} = Preferences.get${JAVA_SUFFIX[kind]}(${javaKey(key)}, ${javaLiteral(kind, value)});`
}

/** The only thing that really deletes a preference: it runs on the robot side. */
export function javaRemove(key: string): string {
  return `Preferences.remove(${javaKey(key)});`
}

export function javaVariableName(key: string): string {
  const parts = key.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return "value"

  const head = parts[0]
  const camel = head.charAt(0).toLowerCase() + head.slice(1)
    + parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("")
  return /^[0-9]/.test(camel) ? `v${camel}` : camel
}

export interface PreferenceSnapshot {
  key: string
  kind: PreferenceKind
  value: PreferenceValue
}

/** All the declarations together, with the import on top. */
export function javaInitBlock(rows: PreferenceSnapshot[]): string {
  if (rows.length === 0) return ""
  const body = rows.map(row => javaInit(row.key, row.kind, row.value)).join("\n")
  return `import edu.wpi.first.wpilibj.Preferences;\n\n${body}`
}

/** All the reads together, with the import on top. */
export function javaGetBlock(rows: PreferenceSnapshot[]): string {
  if (rows.length === 0) return ""
  const body = rows.map(row => javaGet(row.key, row.kind, row.value)).join("\n")
  return `import edu.wpi.first.wpilibj.Preferences;\n\n${body}`
}
