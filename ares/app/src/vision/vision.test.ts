import { describe, expect, it } from "vitest"
import type { CameraConfig, RobotConfig } from "../robot/types"
import { newRobot } from "../robot/types"
import { bestView, blocks, cameraPose, detections, estimateOccluders, fovOnFloor, fovPolygon, ODOMETRY_DRIFT, Occluder, poseSigma, sees, Tag, tagsForField } from "./vision"

const cam = (yawDeg = 0): CameraConfig => ({ name: `c${yawDeg}`, xM: 0.3, yM: 0, zM: 0.5, yawDeg, horizontalFovDeg: 80, verticalFovDeg: 56, maxRangeM: 5 })
const tag = (id: number, x: number, y: number, facingDeg: number, z = 0.5): Tag => {
  const f = (facingDeg * Math.PI) / 180
  return { id, x, y, z, nx: Math.cos(f), ny: Math.sin(f), nz: 0 }
}

// The same cases as ares-core's vision tests: the app draws what the planner aims for.
describe("vision", () => {
  it("sees a tag ahead and facing it", () => {
    expect(sees(cam(), cameraPose(cam(), 0, 0, 0), tag(1, 3, 0, 180))).toBe(true)
  })

  it("not behind, outside the FOV, too far, edge-on or facing away", () => {
    const p = cameraPose(cam(), 0, 0, 0)
    expect(sees(cam(), p, tag(1, -3, 0, 0))).toBe(false)
    expect(sees(cam(), p, tag(2, 1, 3, -90))).toBe(false)
    expect(sees(cam(), p, tag(3, 8, 0, 180))).toBe(false)
    expect(sees(cam(), p, tag(4, 3, 0, 90))).toBe(false)
    expect(sees(cam(), p, tag(5, 3, 0, 0))).toBe(false)
  })

  it("the robot's heading and the camera's yaw both turn it", () => {
    const t = tag(1, 0, 3, -90)
    expect(sees(cam(), cameraPose(cam(), 0, 0, 0), t)).toBe(false)
    expect(sees(cam(), cameraPose(cam(), 0, 0, Math.PI / 2), t)).toBe(true)
    expect(sees(cam(90), cameraPose(cam(90), 0, 0, 0), t)).toBe(true)
  })

  it("WPILib's pitch is positive tilting down", () => {
    const floor: Tag = { id: 1, x: 2.3, y: 0, z: 0, nx: -0.7071, ny: 0, nz: 0.7071 }
    expect(sees({ ...cam(), pitchDeg: 40 }, cameraPose({ ...cam(), pitchDeg: 40 }, 0, 0, 0), floor)).toBe(true)
    expect(sees({ ...cam(), pitchDeg: -40 }, cameraPose({ ...cam(), pitchDeg: -40 }, 0, 0, 0), floor)).toBe(false)
  })

  it("reads each year's layout, faces pointing out", () => {
    const tags = tagsForField("2026-rebuilt")
    expect(tags).toHaveLength(32)
    const t1 = tags.find(t => t.id === 1)!
    expect(t1.nx).toBeCloseTo(-1)
    expect(tagsForField("2024-crescendo").length).toBeGreaterThan(0)
    expect(tagsForField("schematic")).toEqual([])
  })

  it("lists which camera sees which tag, from where the camera is", () => {
    const robot: RobotConfig = { ...newRobot(), cameras: [cam(0), cam(180)] }
    const d = detections(robot, { tags: [tag(1, 3, 0, 180), tag(2, -3, 0, 0)], occluders: [] }, 0, 0, 0)
    expect(d.map(x => [x.camera, x.tag.id])).toEqual([[0, 1], [1, 2]])
    expect(d[0].from[0]).toBeCloseTo(0.3)
  })

  it("projects the FOV on the floor around the camera's direction", () => {
    const f = fovOnFloor(cam(90), 0, 0, 0)
    expect(f.left - f.right).toBeCloseTo((80 * Math.PI) / 180)
    expect((f.left + f.right) / 2).toBeCloseTo(Math.PI / 2)
  })

  // The same cases as ares-core's occlusion tests.
  it("an occluder blocks through its height only", () => {
    const o: Occluder = { name: "box", x: 2, y: 0, lengthM: 1, widthM: 1, zMinM: 0, zMaxM: 1 }
    expect(blocks(o, [0, 0, 0.5], [4, 0, 0.5])).toBe(true)
    expect(blocks(o, [0, 0, 1.5], [4, 0, 1.5])).toBe(false)
    expect(blocks(o, [0, 2, 0.5], [4, 2, 0.5])).toBe(false)
    expect(blocks(o, [0, 0, 0.5], [1.5, 0, 0.5])).toBe(false)
    expect(blocks({ ...o, yawDeg: 45 }, [0, 0, 0.5], [4, 0, 0.5])).toBe(true)
  })

  it("estimates the hub from its tags, and in front of it only its face is seen", () => {
    const hub = tagsForField("2026-rebuilt").filter(t => [18, 19, 20, 21, 24, 25, 26, 27].includes(t.id))
    const occ = estimateOccluders(hub)
    expect(occ).toHaveLength(1)
    const robot: RobotConfig = { ...newRobot(), cameras: [{ ...cam(), horizontalFovDeg: 100 }] }
    const face = hub.filter(t => t.id === 25 || t.id === 26)
    const x = face[0].x - 2.5, y = (face[0].y + face[1].y) / 2
    const ids = detections(robot, { tags: hub, occluders: occ }, x, y, 0).map(d => d.tag.id)
    expect(ids).toContain(25)
    expect(ids).toContain(26)
    expect(ids.every(id => id === 25 || id === 26)).toBe(true)
    // A tag behind the hub, facing the camera: in its view and range, hidden only by the hub;
    // withHidden lists it, flagged.
    const behind = tag(99, face[0].x + 2.0, y, 180, 1.0)
    const all = detections(robot, { tags: [...hub, behind], occluders: occ }, x, y, 0, true)
    expect(all.find(d => d.tag.id === 99)?.hidden).toBe(true)
    expect(detections(robot, { tags: [...hub, behind], occluders: [] }, x, y, 0).some(d => d.tag.id === 99)).toBe(true)
  })

  it("the pose drifts blind and tightens with tags", () => {
    const robot: RobotConfig = { ...newRobot(), cameras: [cam()] }
    const path = Array.from({ length: 11 }, (_, i) => ({ x: 0.5 * i, y: 0, heading: 0, vx: 1, vy: 0 }))
    const blind = poseSigma(robot, { tags: [], occluders: [] }, path, 0.05)
    expect(blind[10]).toBeCloseTo(0.05 + ODOMETRY_DRIFT * 5)
    const seeing = poseSigma(robot, { tags: [tag(1, 8, 0, 180)], occluders: [] }, path, 0.5)
    expect(seeing[10]).toBeLessThan(seeing[5] - 0.2)
  })

  it("the best view turns to the tags", () => {
    const robot: RobotConfig = { ...newRobot(), cameras: [cam()] }
    const b = bestView(robot, { tags: [tag(1, 0, 3, -90)], occluders: [] }, 0, 0, 24)
    expect(b.count).toBe(1)
    expect(Math.abs(b.heading - Math.PI / 2)).toBeLessThan(0.6)
  })
})

describe("the field of view on the floor", () => {
  it("is cut short by a structure as tall as the camera, not by one lower than the lens", () => {
    const c: CameraConfig = { name: "c", xM: 0, yM: 0, zM: 0.5, horizontalFovDeg: 20, verticalFovDeg: 20, maxRangeM: 5 }
    const box: Occluder = { name: "box", x: 2.5, y: 0, lengthM: 1, widthM: 4, zMinM: 0, zMaxM: 1.8 }
    const reach = (occ: Occluder[]) => Math.max(...fovPolygon(c, 0, 0, 0, occ).points.map(([x, y]) => Math.hypot(x, y)))
    expect(reach([])).toBeCloseTo(5)
    expect(reach([box])).toBeLessThan(2.2)
    expect(reach([{ ...box, zMaxM: 0.2 }])).toBeCloseTo(5)
  })
})
