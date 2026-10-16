// Reading WPILib's Field2d (SmartDashboard.putData("Field", field2d)).
//
// Like Mechanism2d, a Field2d is NOT a topic but a TABLE:
//
//   /SmartDashboard/Field/.type      string   = "Field2d"
//   /SmartDashboard/Field/Robot      double[] [x, y, DEGREES]  or struct:Pose2d
//   /SmartDashboard/Field/<anything>          same, or struct:Pose2d[]
//
// That is why it could not be dragged before: the tree only allowed dragging
// leaves with a topic of their own, and the table's root is not one.

import { TopicAnnounce } from "../../store/appStore"
import { FieldPose, extractPoses, isPoseTopic } from "./poseExtraction"

export const FIELD2D_TYPE = "Field2d"

/** The object WPILib creates by default for the robot. */
const ROBOT_KEY = "Robot"

// Elastic's thresholds for deciding whether an object is a trajectory or a
// handful of loose objects: nobody draws 9 robots, but a trajectory does have
// hundreds of points.
const TRAJECTORY_MIN_POSES = 8

export interface Field2dObject {
  /** The topic's full name, unique within the table. */
  key: string
  /** The last segment, which is how the robot code named it. */
  name: string
  isRobot: boolean
  isTrajectory: boolean
  poses: FieldPose[]
}

/** The topics to ask the backend for to draw this table. */
export function field2dTopicNames(topics: Map<string, TopicAnnounce>, prefix: string): string[] {
  const names: string[] = []
  topics.forEach(topic => {
    if (!topic.name.startsWith(prefix + "/")) return
    // The metadata subtopics (.type, .controllable) are not objects.
    const rest = topic.name.slice(prefix.length + 1)
    if (rest.startsWith(".")) return
    if (!isPoseTopic(topic.topic_type)) return
    names.push(topic.name)
  })
  return names
}

/**
 * A prefix is a Field2d if its ".type" says so. The topic's VALUE is needed,
 * not just the announce, which is why `tableTypes` comes from outside
 * (useNTTableTypes fills it by reading those strings).
 */
export function isField2dTable(tableTypes: Record<string, string>, prefix: string): boolean {
  return tableTypes[prefix] === FIELD2D_TYPE
}

export function findField2dTables(tableTypes: Record<string, string>): string[] {
  return Object.entries(tableTypes)
    .filter(([, type]) => type === FIELD2D_TYPE)
    .map(([prefix]) => prefix)
    .sort()
}

export function extractField2dObjects(
  values: Record<string, any>,
  topics: Map<string, TopicAnnounce>,
  prefix: string,
): Field2dObject[] {
  const out: Field2dObject[] = []

  for (const name of field2dTopicNames(topics, prefix)) {
    const topic = topics.get(name)
    if (!topic) continue

    const poses = extractPoses(values[name], topic.topic_type)
    if (poses.length === 0) continue

    const shortName = name.slice(prefix.length + 1)
    const isRobot = shortName === ROBOT_KEY

    // The same heuristic as Elastic: the name wins, and if it says nothing it
    // looks at how many poses it carries — a loose object does not have dozens.
    const isTrajectory =
      !isRobot &&
      (shortName.toLowerCase().endsWith("trajectory") || poses.length > TRAJECTORY_MIN_POSES)

    out.push({ key: name, name: shortName, isRobot, isTrajectory, poses })
  }

  // The robot always last so it is drawn on top of the rest.
  return out.sort((a, b) => Number(a.isRobot) - Number(b.isRobot))
}
