// Automatic unit detection from a topic's name, in the same spirit as
// AdvantageScope's Units.getUnitForField: it looks at the suffix of the path's
// last segment (e.g. "Elevator/HeightMeters" -> "m") and only accepts it if the
// suffix starts at a "real" word boundary (an uppercase letter in camelCase, or
// an underscore) so as not to confuse "Timestamp" with "amp" or similar false
// positives.
//
// It does not try to be as exhaustive as AdvantageScope's full table, it covers
// the most common units in FRC telemetry.

const UNIT_SUFFIXES: Record<string, string> = {
  meters: "m",
  meter: "m",
  centimeters: "cm",
  centimeter: "cm",
  millimeters: "mm",
  millimeter: "mm",
  inches: "in",
  inch: "in",
  feet: "ft",
  foot: "ft",
  degrees: "°",
  degree: "°",
  deg: "°",
  radians: "rad",
  radian: "rad",
  rad: "rad",
  rotations: "rot",
  rotation: "rot",
  rot: "rot",
  volts: "V",
  volt: "V",
  voltage: "V",
  amps: "A",
  amp: "A",
  amperage: "A",
  current: "A",
  watts: "W",
  watt: "W",
  celsius: "°C",
  fahrenheit: "°F",
  percent: "%",
  percentage: "%",
  hertz: "Hz",
  hz: "Hz",
  rpm: "rpm",
  seconds: "s",
  second: "s",
  sec: "s",
  milliseconds: "ms",
  ms: "ms",
}

// Sorted from longest to shortest so "milliseconds" wins over "seconds" when
// looking for the most specific match.
const SORTED_SUFFIXES = Object.keys(UNIT_SUFFIXES).sort((a, b) => b.length - a.length)

function isUpperCaseChar(c: string | undefined): boolean {
  return !!c && c === c.toUpperCase() && c !== c.toLowerCase()
}

export function detectUnitSuffix(topicName: string): string | null {
  const lastSegment = topicName.split("/").filter(Boolean).pop() ?? topicName
  const lower = lastSegment.toLowerCase()

  for (const suffix of SORTED_SUFFIXES) {
    if (lower.length <= suffix.length) continue
    if (!lower.endsWith(suffix)) continue

    const boundaryChar = lastSegment[lastSegment.length - suffix.length - 1]
    const suffixStartChar = lastSegment[lastSegment.length - suffix.length]
    const isWordBoundary = isUpperCaseChar(suffixStartChar) || boundaryChar === "_" || boundaryChar === " "
    if (!isWordBoundary) continue

    return UNIT_SUFFIXES[suffix]
  }
  return null
}