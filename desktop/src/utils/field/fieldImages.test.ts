import { describe, it, expect } from "vitest"
import { FIELDS, getField, toInternal, SCHEMATIC_FIELD_KEY } from "./fieldImages"
import { extractField2dObjects, field2dTopicNames, findField2dTables, isField2dTable } from "./field2d"
import { TopicAnnounce } from "../../store/appStore"

// The real size of the 2026 field, so the calculations read like real life and
// not like made-up numbers.
const SIZE: [number, number] = [16.535, 8.069]
const HALF_X = SIZE[0] / 2
const HALF_Y = SIZE[1] / 2

describe("field registry", () => {
  it("loads the fields in public/fields", () => {
    expect(FIELDS.length).toBeGreaterThan(0)
  })

  it("parses Elastic's JSON with underscore keys", () => {
    const field = FIELDS.find(f => f.game === "Rebuilt")
    expect(field).toBeDefined()
    expect(field!.sizeMeters).toEqual(SIZE)
    expect(field!.topLeft).toEqual([524, 94])
    expect(field!.bottomRight).toEqual([3378, 1490])
    expect(field!.coordinateSystem).toBe("wall_blue")
  })

  it("resolves the image to a servable URL and not to Elastic's internal path", () => {
    // The JSON says "assets/fields/frc/2026-field.png", which is the path INSIDE
    // Elastic; in this app the file is served from public/.
    const field = FIELDS.find(f => f.game === "Rebuilt")!
    expect(field.imageUrl).toBe("/fields/2026-field.png")
  })

  it("returns null for an unknown key", () => {
    expect(getField(SCHEMATIC_FIELD_KEY)).toBeNull()
    expect(getField("no-existe")).toBeNull()
  })
})

describe("toInternal", () => {
  // The internal frame has its origin at the center of the playing area, +X
  // towards the image's right and +Y up.

  describe("wall_blue (WPILib ≤2026)", () => {
    // In the 2026 image BLUE is on the right, so the robot's coordinate origin
    // (the blue corner) has to land on internal +X.
    it("sends the blue corner (0,0) to the right side", () => {
      const p = toInternal("wall_blue", 0, 0, 0, SIZE)
      expect(p.x).toBeCloseTo(HALF_X)
      expect(p.y).toBeCloseTo(HALF_Y)
    })

    it("sends the opposite red corner to the left side", () => {
      const p = toInternal("wall_blue", SIZE[0], SIZE[1], 0, SIZE)
      expect(p.x).toBeCloseTo(-HALF_X)
      expect(p.y).toBeCloseTo(-HALF_Y)
    })

    it("leaves the field's center at the origin", () => {
      const p = toInternal("wall_blue", HALF_X, HALF_Y, 0, SIZE)
      expect(p.x).toBeCloseTo(0)
      expect(p.y).toBeCloseTo(0)
    })

    it("turns the angle half around", () => {
      // The robot pointing at +X (towards red) has to be drawn pointing to the
      // left of the screen.
      expect(toInternal("wall_blue", 0, 0, 0, SIZE).theta).toBeCloseTo(Math.PI)
    })
  })

  describe("center (WPILib 2027+)", () => {
    it("is the identity: it is already in the internal frame", () => {
      const p = toInternal("center", 3, -2, 1.25, SIZE)
      expect(p.x).toBe(3)
      expect(p.y).toBe(-2)
      expect(p.theta).toBe(1.25)
    })
  })

  describe("center_rotated (FTC)", () => {
    it("swaps the axes and turns a quarter turn", () => {
      const p = toInternal("center_rotated", 1, 2, 0, SIZE)
      expect(p.x).toBe(2)
      expect(p.y).toBe(-1)
      expect(p.theta).toBeCloseTo(-Math.PI / 2)
    })
  })
})

// ---------------------------------------------------------------------------

const topic = (name: string, type: string): [string, TopicAnnounce] => [
  name,
  { id: 0, name, topic_type: type },
]

const FIELD_TOPICS = new Map<string, TopicAnnounce>([
  topic("/SmartDashboard/Field/.type", "string"),
  topic("/SmartDashboard/Field/Robot", "double[]"),
  topic("/SmartDashboard/Field/Trajectory", "double[]"),
  topic("/SmartDashboard/Field/Note", "double[]"),
  topic("/SmartDashboard/Field/SomeLabel", "string"),
  topic("/Other/Thing", "double"),
])

const PREFIX = "/SmartDashboard/Field"

describe("Field2d", () => {
  it("recognizes the table by its .type and not by its shape", () => {
    const types = { [PREFIX]: "Field2d", "/SmartDashboard/Chooser": "String Chooser" }
    expect(isField2dTable(types, PREFIX)).toBe(true)
    expect(isField2dTable(types, "/SmartDashboard/Chooser")).toBe(false)
    expect(findField2dTables(types)).toEqual([PREFIX])
  })

  it("only takes the subtopics that can be a pose", () => {
    const names = field2dTopicNames(FIELD_TOPICS, PREFIX)
    // Left out: ".type" (metadata), the loose string and whatever does not hang
    // from the prefix.
    expect(names.sort()).toEqual([
      "/SmartDashboard/Field/Note",
      "/SmartDashboard/Field/Robot",
      "/SmartDashboard/Field/Trajectory",
    ])
  })

  it("tells robot, trajectory and loose objects apart", () => {
    const manyPoses: number[] = []
    for (let i = 0; i < 12; i++) manyPoses.push(i, i, 0)

    const values = {
      "/SmartDashboard/Field/Robot": { NumberArray: [1, 2, 90] },
      "/SmartDashboard/Field/Trajectory": { NumberArray: manyPoses },
      "/SmartDashboard/Field/Note": { NumberArray: [5, 5, 0] },
    }

    const objects = extractField2dObjects(values, FIELD_TOPICS, PREFIX)
    const byName = Object.fromEntries(objects.map(o => [o.name, o]))

    expect(byName.Robot.isRobot).toBe(true)
    expect(byName.Robot.poses).toHaveLength(1)
    // Field2d publishes the angle in DEGREES; extractPoses converts it to radians.
    expect(byName.Robot.poses[0].theta).toBeCloseTo(Math.PI / 2)

    expect(byName.Trajectory.isTrajectory).toBe(true)
    expect(byName.Trajectory.poses).toHaveLength(12)

    // Three numbers = a single pose: it is a loose object, not a trajectory.
    expect(byName.Note.isTrajectory).toBe(false)
    expect(byName.Note.isRobot).toBe(false)
  })

  it("classifies as a trajectory by the name even if it carries few poses", () => {
    const values = { "/SmartDashboard/Field/Trajectory": { NumberArray: [0, 0, 0, 1, 1, 0] } }
    const objects = extractField2dObjects(values, FIELD_TOPICS, PREFIX)
    expect(objects.find(o => o.name === "Trajectory")!.isTrajectory).toBe(true)
  })

  it("draws the robot last so it ends up on top of the rest", () => {
    const values = {
      "/SmartDashboard/Field/Robot": { NumberArray: [1, 2, 0] },
      "/SmartDashboard/Field/Note": { NumberArray: [5, 5, 0] },
    }
    const objects = extractField2dObjects(values, FIELD_TOPICS, PREFIX)
    expect(objects[objects.length - 1].isRobot).toBe(true)
  })

  it("ignores topics with no value yet", () => {
    const objects = extractField2dObjects({}, FIELD_TOPICS, PREFIX)
    expect(objects).toEqual([])
  })
})
