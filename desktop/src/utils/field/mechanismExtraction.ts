// Rebuilding a WPILib Mechanism2d from the loose topics it publishes on
// NetworkTables.
//
// A Mechanism2d is NOT a topic: it is a TABLE with this shape
//
//   /Mech/.type                      string   = "Mechanism2d"
//   /Mech/dims                       double[] [width, height] in drawing units
//   /Mech/backgroundColor            string   "#RRGGBB"
//   /Mech/<root>/x                   double   the root's origin
//   /Mech/<root>/y                   double
//   /Mech/<root>/<lig>/.type         string   = "line"
//   /Mech/<root>/<lig>/angle         double   DEGREES, RELATIVE to the parent ligament
//   /Mech/<root>/<lig>/length        double
//   /Mech/<root>/<lig>/color         string
//   /Mech/<root>/<lig>/weight        double   thickness in px
//   /Mech/<root>/<lig>/<lig2>/...             nested ligaments
//
// Each ligament starts where its parent ends and adds its angle to the parent's.
// Flattening that chain into absolute segments is this file's whole job: the
// canvas only gets already resolved lines.

import { TopicAnnounce } from "../../store/appStore"
import { unpackLiveValue } from "../dashboard/valueDecoding"

const DEG_TO_RAD = Math.PI / 180

// Keys WPILib publishes as data leaves, which are therefore NEVER a root or a
// ligament.
const RESERVED_KEYS = new Set([".type", "dims", "backgroundColor", "x", "y", "angle", "length", "color", "weight"])

export type MechanismPoint = [number, number]

export interface MechanismLine {
  start: MechanismPoint
  end: MechanismPoint
  color: string
  weight: number
  /** The ligament's topic path, to identify it in the numeric readout. */
  path: string
  /** The segment's absolute angle, in radians. */
  angle: number
  length: number
}

export interface MechanismState {
  backgroundColor: string
  dimensions: MechanismPoint
  lines: MechanismLine[]
  /** Number of roots found (a Mechanism2d can have several). */
  rootCount: number
}

// --- Descubrimiento de tablas Mechanism2d -----------------------------------

// The value of "<prefix>/.type" cannot be asked for with only the announces,
// so the table is recognized by its shape: dims + backgroundColor are mandatory
// in every Mechanism2d and do not appear together in any other WPILib
// structure.
export function isMechanismTable(topics: Map<string, TopicAnnounce>, prefix: string): boolean {
  const dims = topics.get(prefix + "/dims")
  const background = topics.get(prefix + "/backgroundColor")
  if (!dims || !background) return false
  return dims.topic_type.endsWith("[]") && background.topic_type.includes("string")
}

// Every table path that is a Mechanism2d, sorted alphabetically.
export function findMechanismTables(topics: Map<string, TopicAnnounce>): string[] {
  const prefixes = new Set<string>()
  topics.forEach(topic => {
    const parts = topic.name.split("/").filter(Boolean)
    // Only the direct parent of "dims"/"backgroundColor" matters; walking every
    // possible prefix would multiply the work without finding more.
    if (parts.length < 2) return
    const prefix = "/" + parts.slice(0, parts.length - 1).join("/")
    if (isMechanismTable(topics, prefix)) prefixes.add(prefix)
  })
  return Array.from(prefixes).sort()
}

// The topics to ask the backend for to be able to draw this table.
export function mechanismTopicNames(topics: Map<string, TopicAnnounce>, prefix: string): string[] {
  const names: string[] = []
  topics.forEach(topic => {
    if (topic.name === prefix || topic.name.startsWith(prefix + "/")) names.push(topic.name)
  })
  return names
}

// --- Key tree --------------------------------------------------------

interface KeyNode {
  path: string
  children: Map<string, KeyNode>
}

function buildKeyTree(topicNames: string[], prefix: string): KeyNode {
  const root: KeyNode = { path: prefix, children: new Map() }

  for (const name of topicNames) {
    if (!name.startsWith(prefix + "/")) continue
    const parts = name.slice(prefix.length + 1).split("/").filter(Boolean)
    let node = root
    parts.forEach((part, index) => {
      if (!node.children.has(part)) {
        node.children.set(part, {
          path: prefix + "/" + parts.slice(0, index + 1).join("/"),
          children: new Map(),
        })
      }
      node = node.children.get(part)!
    })
  }

  return root
}

// A root or a ligament is ALWAYS a subtable (it has children: x/y, or
// angle/length/color/weight). Data leaves have no children, so this condition
// alone separates the structure from the values.
function subTables(node: KeyNode): KeyNode[] {
  const out: KeyNode[] = []
  node.children.forEach((child, key) => {
    if (child.children.size > 0 && !RESERVED_KEYS.has(key)) out.push(child)
  })
  return out
}

// --- Reading values --------------------------------------------------------

function readNumber(values: Record<string, any>, key: string, fallback: number): number {
  const value = unpackLiveValue(values[key])
  return typeof value === "number" && isFinite(value) ? value : fallback
}

function readString(values: Record<string, any>, key: string, fallback: string): string {
  const value = unpackLiveValue(values[key])
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function readNumberArray(values: Record<string, any>, key: string): number[] | null {
  const value = unpackLiveValue(values[key])
  return Array.isArray(value) ? value : null
}

// --- Building the state ------------------------------------------------

export function buildMechanismState(
  values: Record<string, any>,
  topicNames: string[],
  prefix: string,
): MechanismState | null {
  const dims = readNumberArray(values, prefix + "/dims")
  // Without dims there is no coordinate system: the drawing cannot be scaled,
  // so showing nothing is preferred over making up a size.
  if (!dims || dims.length < 2 || dims[0] <= 0 || dims[1] <= 0) return null

  const state: MechanismState = {
    backgroundColor: readString(values, prefix + "/backgroundColor", "#000020"),
    dimensions: [dims[0], dims[1]],
    lines: [],
    rootCount: 0,
  }

  const tree = buildKeyTree(topicNames, prefix)

  const addLigament = (node: KeyNode, start: MechanismPoint, parentAngle: number) => {
    const angle = parentAngle + readNumber(values, node.path + "/angle", 0) * DEG_TO_RAD
    const length = readNumber(values, node.path + "/length", 0)
    const end: MechanismPoint = [
      start[0] + length * Math.cos(angle),
      start[1] + length * Math.sin(angle),
    ]

    state.lines.push({
      start,
      end,
      color: readString(values, node.path + "/color", "#ffffff"),
      weight: readNumber(values, node.path + "/weight", 1),
      path: node.path,
      angle,
      length,
    })

    subTables(node).forEach(child => addLigament(child, end, angle))
  }

  subTables(tree).forEach(rootNode => {
    state.rootCount++
    const origin: MechanismPoint = [
      readNumber(values, rootNode.path + "/x", 0),
      readNumber(values, rootNode.path + "/y", 0),
    ]
    subTables(rootNode).forEach(child => addLigament(child, origin, 0))
  })

  return state
}

// Several tables on one canvas: the drawable area is the one that fits them all,
// and the background is set by the first one (the ones below are overlaid on top).
export function mergeMechanismStates(states: MechanismState[]): MechanismState | null {
  if (states.length === 0) return null
  return {
    backgroundColor: states[0].backgroundColor,
    dimensions: [
      Math.max(...states.map(s => s.dimensions[0])),
      Math.max(...states.map(s => s.dimensions[1])),
    ],
    lines: states.flatMap(s => s.lines),
    rootCount: states.reduce((sum, s) => sum + s.rootCount, 0),
  }
}
