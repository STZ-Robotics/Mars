// Reads a swerve tab's sources and turns them into the sets both the 2D canvas
// and the 3D scene draw.
//
// It lives here and not in each page because both views consume EXACTLY the
// same sources: the only thing that changes is how they are drawn.

import { useMemo } from "react"
import { SwerveSourceConfig } from "../store/appStore"
import { useNTSnapshot } from "../utils/nt/useNTSnapshot"
import {
  extractModuleStates, extractModulePositions, extractChassisVelocities, extractRotation,
  isSwerveTopic, defaultSourceTypeFor, ModulePosition,
} from "../utils/field/swerveExtraction"
import { ModuleSet, ChassisSet } from "../components/dashboard/swerve/SwerveCanvas"

export interface PositionSet {
  id: string
  label: string
  color: string
  values: ModulePosition[]
}

export interface SwerveSourceData {
  moduleSets: ModuleSet[]
  positionSets: PositionSet[]
  chassisSets: ChassisSet[]
  /** The chassis' heading in radians; 0 if no source publishes it. */
  rotation: number
}

// Reorders the topic's modules to the drawn corners (FL, FR, BL, BR) according
// to the chosen "arrangement".
export function applyArrangement<T>(values: T[], arrangement: string): T[] {
  const order = arrangement.split(",").map(n => parseInt(n, 10))
  if (order.length !== 4 || order.some(isNaN)) return values
  return order.map(sourceIndex => values[sourceIndex]).filter((v): v is T => v !== undefined)
}

export function useSwerveSources(sources: SwerveSourceConfig[], intervalMs = 33): SwerveSourceData {
  const topicNames = useMemo(() => sources.map(s => s.topicName), [sources])
  const liveValues = useNTSnapshot(topicNames, intervalMs)

  return useMemo(() => {
    const moduleSets: ModuleSet[] = []
    const positionSets: PositionSet[] = []
    const chassisSets: ChassisSet[] = []
    let rotation = 0

    sources.forEach(source => {
      const value = liveValues[source.topicName]
      if (source.type === "modules") {
        const values = applyArrangement(extractModuleStates(value, source.topicType), source.arrangement)
        if (values.length > 0) {
          moduleSets.push({ id: source.id, label: source.label, color: source.color, values, role: source.role })
        }
      } else if (source.type === "positions") {
        const values = applyArrangement(extractModulePositions(value, source.topicType), source.arrangement)
        if (values.length > 0) {
          positionSets.push({ id: source.id, label: source.label, color: source.color, values })
        }
      } else if (source.type === "chassis") {
        const speeds = extractChassisVelocities(value, source.topicType)
        if (speeds) {
          chassisSets.push({ id: source.id, label: source.label, color: source.color, value: speeds })
        }
      } else {
        const theta = extractRotation(value, source.topicType, source.angleUnits)
        if (theta !== null) rotation = theta
      }
    })

    return { moduleSets, positionSets, chassisSets, rotation }
  }, [sources, liveValues])
}

const SOURCE_COLORS = ["#2f6fdb", "#d63b3b", "#1f9e4a", "#d4a94a", "#8a4fd1", "#0e9aa7"]

/**
 * The source that matches a topic just dropped on a swerve view, or null if
 * that topic is no use or was already added.
 */
export function swerveSourceFromDrop(
  topicName: string,
  topicType: string,
  existing: SwerveSourceConfig[],
): Omit<SwerveSourceConfig, "id"> | null {
  if (!topicName || !isSwerveTopic(topicType)) return null
  if (existing.some(s => s.topicName === topicName)) return null

  const parts = topicName.split("/").filter(Boolean)
  const label = parts.length > 0 ? parts[parts.length - 1] : topicName
  const usedColors = new Set(existing.map(s => s.color))
  const color = SOURCE_COLORS.find(c => !usedColors.has(c))
    ?? SOURCE_COLORS[existing.length % SOURCE_COLORS.length]

  // The first set of modules is assumed measured; the second, commanded.
  const alreadyHasMeasured = existing.some(s => s.type === "modules" && s.role === "measured")

  return {
    topicName, topicType, label, color,
    type: defaultSourceTypeFor(topicType),
    arrangement: "0,1,2,3",
    angleUnits: "degrees",
    role: alreadyHasMeasured ? "setpoint" : "measured",
  }
}
