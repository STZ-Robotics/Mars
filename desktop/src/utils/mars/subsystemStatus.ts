// Reading the diagnostic state each ModularSubsystem of the MARS framework
// publishes.
//
// Each subsystem writes, on every loop (ModularSubsystem.java):
//
//   <Subsystem>/Status/Name      string   e.g. "NOMINAL", "INTAKING"
//   <Subsystem>/Status/Hex       string   color ALREADY resolved by the robot
//   <Subsystem>/Status/Message   string   formatted text
//
// The color changes with the action the subsystem is running, not only with its
// health: it is the same color that goes to the LEDs.

import { TopicAnnounce } from "../../store/appStore"
import { unpackLiveValue } from "../dashboard/valueDecoding"

const HEX_SUFFIX = "/Status/Hex"

/**
 * A state's severity. They are the four of StatusColorCode.Severity, plus
 * "unknown" for whatever the app cannot classify.
 *
 * IMPORTANT: the severity does NOT travel over NetworkTables — the framework
 * only publishes Name, Hex and Message. So here it is INFERRED, and that is why
 * the robot's raw color is always shown, even if the classification fails.
 */
export type Severity = "ok" | "warning" | "error" | "critical" | "unknown"

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  error: "Error",
  warning: "Working",
  ok: "Nominal",
  unknown: "Unknown",
}

/** Icons per severity; the file lives in public/icons. */
export const SEVERITY_ICONS: Record<Severity, string> = {
  critical: "status-critical.svg",
  error: "status-error.svg",
  warning: "status-warning.svg",
  ok: "status-ok.svg",
  unknown: "status-unknown.svg",
}

/** Most to least severe: it is the order they are best looked at in. */
export const SEVERITY_ORDER: Severity[] = ["critical", "error", "warning", "ok", "unknown"]

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0, error: 1, warning: 2, ok: 3, unknown: 4,
}

/** GlobalColorCode's four codes, which do have a known severity. */
const GLOBAL_CODES: Record<string, Severity> = {
  NOMINAL: "ok",
  WORKING: "warning",
  TIMEOUT: "error",
  HARDWARE_FAULT: "critical",
}

export interface SubsystemStatus {
  /** The subsystem table's path, e.g. "/Arm". */
  prefix: string
  /** The last segment, for display. */
  name: string
  /** Status/Name's value: the code, not the subsystem. */
  code: string | null
  hex: string | null
  message: string | null
  severity: Severity
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const clean = hex.trim().replace(/^#/, "")
  const full = clean.length === 3
    ? clean.split("").map(c => c + c).join("")
    : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null

  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const l = (max + min) / 2

  if (delta === 0) return { h: 0, s: 0, l }

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let h: number
  if (max === r) h = ((g - b) / delta) % 6
  else if (max === g) h = (b - r) / delta + 2
  else h = (r - g) / delta + 4

  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/**
 * Classifies by hue. The framework uses green/yellow/orange/red for the four
 * global severities, and each team's own codes (ModuleColorCode) follow the
 * same color convention.
 *
 * A desaturated, very dark, or other-hued color (blue, violet) is left as
 * "unknown" instead of forcing it into a severity: better to say it is not
 * known than to paint red a state the team chose to be light blue.
 */
export function severityFromHex(hex: string | null): Severity {
  if (!hex) return "unknown"
  const hsl = hexToHsl(hex)
  if (hsl === null) return "unknown"

  // Grey, white or almost black: it conveys no severity.
  if (hsl.s < 0.18 || hsl.l < 0.08 || hsl.l > 0.95) return "unknown"

  const h = hsl.h
  if (h < 15 || h >= 330) return "critical"  // rojo
  if (h < 40) return "error"                 // naranja
  if (h < 75) return "warning"               // amarillo
  if (h < 170) return "ok"                   // verde
  return "unknown"                           // cian/azul/violeta
}

/** The code's name wins over the color when it is one of the global ones. */
export function severityOf(code: string | null, hex: string | null): Severity {
  if (code && code.toUpperCase() in GLOBAL_CODES) return GLOBAL_CODES[code.toUpperCase()]
  return severityFromHex(hex)
}

/** Subsystem paths that publish a state, detected by their Hex topic. */
export function findStatusSubsystems(topics: Map<string, TopicAnnounce>): string[] {
  const out: string[] = []
  topics.forEach(topic => {
    if (!topic.name.endsWith(HEX_SUFFIX)) return
    if (!topic.topic_type.includes("string")) return
    out.push(topic.name.slice(0, -HEX_SUFFIX.length))
  })
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** The topics to ask the backend for to draw the board. */
export function statusTopicNames(prefixes: string[]): string[] {
  return prefixes.flatMap(p => [`${p}/Status/Name`, `${p}/Status/Hex`, `${p}/Status/Message`])
}

function readString(values: Record<string, any>, key: string): string | null {
  const value = unpackLiveValue(values[key])
  return typeof value === "string" && value.length > 0 ? value : null
}

export function readSubsystemStatus(values: Record<string, any>, prefix: string): SubsystemStatus {
  const code = readString(values, `${prefix}/Status/Name`)
  const hex = readString(values, `${prefix}/Status/Hex`)
  const message = readString(values, `${prefix}/Status/Message`)
  const segments = prefix.split("/").filter(Boolean)

  return {
    prefix,
    name: segments.length > 0 ? segments[segments.length - 1] : prefix,
    code,
    hex,
    message,
    severity: severityOf(code, hex),
  }
}

/** Most severe first; at equal severity, alphabetical. */
export function sortBySeverity(statuses: SubsystemStatus[]): SubsystemStatus[] {
  return [...statuses].sort((a, b) => {
    const diff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    return diff !== 0 ? diff : a.name.localeCompare(b.name, undefined, { numeric: true })
  })
}

export function countBySeverity(statuses: SubsystemStatus[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { ok: 0, warning: 0, error: 0, critical: 0, unknown: 0 }
  for (const s of statuses) counts[s.severity]++
  return counts
}

/**
 * The equivalent of AlertRegistry.hasCriticalAlerts(): the quick check before
 * enabling for a match.
 */
export function hasCriticalAlerts(statuses: SubsystemStatus[]): boolean {
  return statuses.some(s => s.severity === "critical")
}

/** A state change, for each subsystem's history strip. */
export interface StatusChange {
  atMs: number
  code: string | null
  hex: string | null
  message: string | null
  severity: Severity
}

/**
 * Adds a change to the history only if something really changed. Without
 * this, at a 4Hz poll, the history would fill with identical entries and hide
 * the real changes.
 */
export function pushStatusChange(
  history: StatusChange[],
  status: SubsystemStatus,
  atMs: number,
  limit = 12,
): StatusChange[] {
  const last = history[history.length - 1]
  if (last && last.code === status.code && last.hex === status.hex && last.message === status.message) {
    return history
  }
  const next = [...history, {
    atMs,
    code: status.code,
    hex: status.hex,
    message: status.message,
    severity: status.severity,
  }]
  return next.length > limit ? next.slice(next.length - limit) : next
}
