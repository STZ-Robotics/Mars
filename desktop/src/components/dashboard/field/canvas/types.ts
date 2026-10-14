import type { FieldObjectType, FieldSettings } from "../../../../store/appStore"
import type { FieldPose } from "../../../../utils/field/poseExtraction"
import type { InternalPose } from "../../../../utils/field/fieldImages"
import type { ResolvedObjectOptions } from "../../../../utils/field/fieldObjects"
import type { HistoryStore } from "../../../../utils/field/poseHistory"
import type { Heatmap } from "../../../../utils/field/heatmap"
import type { RobotSprite } from "../../../../utils/field/robotSprite"
import type { ModuleState } from "../../../../utils/field/swerveExtraction"

export interface RenderedObject {
  id: string
  type: FieldObjectType
  color: string
  label: string
  /** Poses as the robot publishes them; the frame conversion is the canvas' job. */
  poses: FieldPose[]
  options: ResolvedObjectOptions
  /** Only for type === "swerve". */
  modules?: ModuleState[]
}

/** Screen pixels -> meters of the internal frame, at the current zoom. */
export type Px = (n: number) => number

/** Projects a point of the internal frame to CSS pixels on the canvas. */
export type Project = (x: number, y: number) => { x: number; y: number }

export interface Label {
  x: number
  y: number
  text: string
  color: string
}

/** What every object's drawing needs besides its own poses. */
export interface DrawContext {
  settings: FieldSettings
  anchorPose: InternalPose | null
  sprite: RobotSprite | null
  spriteScale: number
  heatmaps: Map<string, Heatmap>
  history: HistoryStore
  sizeMeters: [number, number]
  conv: (pose: FieldPose) => InternalPose
  project: Project
  labels: Label[]
}
