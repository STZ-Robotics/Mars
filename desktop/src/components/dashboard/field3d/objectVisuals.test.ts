import { describe, it, expect } from "vitest"
import { Group, Mesh, Object3D } from "three"
import { createObjectVisual, RenderedField3dObject, VisualContext, visualSignature } from "./objectVisuals"
import { Pose3D, quatFromYaw } from "../../../utils/field3d/frames"
import { resolveField3dOptions } from "../../../utils/field3d/objects"
import { TrailStore } from "../../../utils/field3d/trails"
import { makeEvergreenField, makeFieldGrid, DEFAULT_FIELD_SIZE } from "../../../utils/field3d/evergreen"
import {
  Field3dObjectConfig, Field3dObjectType, defaultField3dSettings,
} from "../../../store/appStore"

// These tests run real three but without WebGL: the objects are built and it
// is checked where their matrices end up, which is where frame and composition
// bugs live. What cannot be tested here is the painting.
//
// Nothing built here uses `makeTextSprite`, which needs a 2D canvas: that is
// why the labels are off in every case.

const ctx: VisualContext = {
  settings: defaultField3dSettings,
  quality: "standard",
  robotAssets: new Map(),
  gamePieces: [],
}

function pose(x: number, y: number, z = 0, yaw = 0): Pose3D {
  const q = quatFromYaw(yaw)
  return { x, y, z, qw: q[0], qx: q[1], qy: q[2], qz: q[3] }
}

function object(
  type: Field3dObjectType,
  poses: Pose3D[],
  overrides: Partial<Field3dObjectConfig> = {},
): RenderedField3dObject {
  const config: Field3dObjectConfig = {
    id: "obj", topicName: "/x", topicType: "struct:Pose3d",
    label: "Obj", type, color: "#2f6fdb", ...overrides,
  }
  return {
    id: config.id, type, color: config.color, label: config.label, poses,
    options: resolveField3dOptions(config, defaultField3dSettings),
  }
}

function frame(trails = new TrailStore(), anchor: Pose3D | null = null) {
  return {
    now: 1_000_000,
    trails,
    anchorPose: () => anchor,
    anchorCamera: () => anchor,
  }
}

/** Counts the meshes of a tree, skipping what is turned off. */
function visibleMeshes(root: Object3D): number {
  let count = 0
  const walk = (node: Object3D) => {
    if (!node.visible) return
    if ((node as Mesh).isMesh) count++
    node.children.forEach(walk)
  }
  walk(root)
  return count
}

describe("schematic field", () => {
  it("is built with carpet, walls and a midfield line", () => {
    const field = makeEvergreenField(DEFAULT_FIELD_SIZE)
    // Alfombra + dos franjas de alianza + cuatro paredes = 7 mallas.
    expect(visibleMeshes(field)).toBe(7)
  })

  it("the grid covers the whole field", () => {
    const grid = makeFieldGrid({ length: 4, width: 2 }, 1)
    const position = grid.geometry.getAttribute("position")
    // 5 vertical lines + 3 horizontal + the 2 closing edges = 10
    // segments, 2 vertices each.
    expect(position.count).toBe(20)
  })
})

describe("robot", () => {
  it("draws the generic chassis when there is no asset", () => {
    const visual = createObjectVisual(object("robot", [pose(0, 0)]), ctx)
    // Bumper + body + wedge = 3 meshes (the outline is LineSegments).
    expect(visibleMeshes(visual.group)).toBe(3)
    visual.dispose()
  })

  it("places the chassis at the pose without turning the trail with it", () => {
    const next = object("robot", [pose(2, -1, 0.3, Math.PI / 2)], { trailSeconds: 5 })
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())

    // The outer group stays at the field's origin: the trail hangs from it and
    // has to stay marked on the floor, not turn with the robot.
    expect(visual.group.position.toArray()).toEqual([0, 0, 0])

    const poseGroup = visual.group.children.find(c => c instanceof Group)!
    expect(poseGroup.position.x).toBeCloseTo(2, 6)
    expect(poseGroup.position.y).toBeCloseTo(-1, 6)
    expect(poseGroup.position.z).toBeCloseTo(0.3, 6)
    // three stores the quaternion as (x, y, z, w).
    expect(poseGroup.quaternion.w).toBeCloseTo(Math.cos(Math.PI / 4), 6)
    expect(poseGroup.quaternion.z).toBeCloseTo(Math.sin(Math.PI / 4), 6)
    visual.dispose()
  })

  it("turns off when the topic stops carrying a pose", () => {
    const empty = object("robot", [])
    const visual = createObjectVisual(empty, ctx)
    visual.update(empty, frame())
    expect(visual.group.visible).toBe(false)
    visual.dispose()
  })

  it("accumulates the trail and dumps it into the line's buffer", () => {
    const trails = new TrailStore()
    const visual = createObjectVisual(object("robot", [pose(0, 0)], { trailSeconds: 30 }), ctx)

    // Three positions apart in time and in space, so neither the minimum period
    // nor the minimum step discards them.
    for (let i = 0; i < 3; i++) {
      const next = object("robot", [pose(i, i * 2)], { trailSeconds: 30 })
      visual.update(next, { ...frame(trails), now: 1_000_000 + i * 200 })
    }

    expect(trails.count("obj")).toBe(3)
    const line = visual.group.children.find(c => (c as any).isLine) as any
    expect(line.geometry.drawRange.count).toBe(3)
    // Trails are drawn a hair above the carpet so they do not fight it in the
    // z-buffer.
    expect(line.geometry.getAttribute("position").array[2]).toBeGreaterThan(0)
    visual.dispose()
  })

  it("does not record a standing robot twice", () => {
    const trails = new TrailStore()
    const next = object("robot", [pose(1, 1)], { trailSeconds: 30 })
    const visual = createObjectVisual(next, ctx)
    for (let i = 0; i < 5; i++) {
      visual.update(next, { ...frame(trails), now: 1_000_000 + i * 500 })
    }
    expect(trails.count("obj")).toBe(1)
    visual.dispose()
  })
})

describe("componentes articulados", () => {
  it("without a robot asset it draws nothing, instead of breaking", () => {
    const next = object("component", [pose(0.5, 0, 0.4)])
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())
    expect(visual.group.visible).toBe(false)
    visual.dispose()
  })
})

describe("trayectoria", () => {
  it("builds the tube from the poses", () => {
    const next = object("trajectory", [pose(0, 0), pose(1, 0), pose(2, 1)])
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())
    expect(visibleMeshes(visual.group)).toBe(1)
    visual.dispose()
  })

  it("with fewer than two points there is no path to draw", () => {
    const next = object("trajectory", [pose(0, 0)])
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())
    expect(visibleMeshes(visual.group)).toBe(0)
    visual.dispose()
  })

  it("does not rebuild the geometry when the poses did not change", () => {
    // A trajectory is published once and does not change; redoing the tube every
    // frame would blow the whole budget.
    const next = object("trajectory", [pose(0, 0), pose(1, 1), pose(2, 0)])
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())
    const first = (visual.group.children.find(c => (c as Mesh).isMesh) as Mesh).geometry
    visual.update(next, frame())
    const second = (visual.group.children.find(c => (c as Mesh).isMesh) as Mesh).geometry
    expect(second).toBe(first)
    visual.dispose()
  })

  it("does rebuild it when the path changes", () => {
    const a = object("trajectory", [pose(0, 0), pose(1, 1)])
    const visual = createObjectVisual(a, ctx)
    visual.update(a, frame())
    const first = (visual.group.children.find(c => (c as Mesh).isMesh) as Mesh).geometry
    const b = object("trajectory", [pose(0, 0), pose(1, 2)])
    visual.update(b, frame())
    const second = (visual.group.children.find(c => (c as Mesh).isMesh) as Mesh).geometry
    expect(second).not.toBe(first)
    visual.dispose()
  })

  it("waypoints come out one point per pose", () => {
    const next = object("trajectory", [pose(0, 0), pose(1, 0), pose(2, 0)], { showWaypoints: true })
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())
    // The tube plus the three waypoints.
    expect(visibleMeshes(visual.group)).toBe(4)
    visual.dispose()
  })
})

describe("vision marks", () => {
  it("draws a line from the robot to each mark", () => {
    const next = object("vision", [pose(4, 1, 1), pose(4, -1, 1)])
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame(new TrailStore(), pose(0, 0, 0.2)))

    const lines = visual.group.children.find(c => (c as any).isLineSegments) as any
    // Two vertices per mark.
    expect(lines.geometry.drawRange.count).toBe(4)
    const array = lines.geometry.getAttribute("position").array
    expect(array[0]).toBeCloseTo(0, 6)   // from the robot
    expect(array[3]).toBeCloseTo(4, 6)   // to the mark
    visual.dispose()
  })

  it("with no robot to anchor to it draws no lines but does draw the marks", () => {
    const next = object("vision", [pose(4, 1, 1)])
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame(new TrailStore(), null))

    const lines = visual.group.children.find(c => (c as any).isLineSegments) as any
    expect(lines.visible).toBe(false)
    expect(visibleMeshes(visual.group)).toBe(1)
    visual.dispose()
  })

  it("reuses the markers when the mark count oscillates", () => {
    const visual = createObjectVisual(object("vision", []), ctx)
    const three = object("vision", [pose(1, 0), pose(2, 0), pose(3, 0)])
    visual.update(three, frame(new TrailStore(), pose(0, 0)))
    const created = visual.group.children.find(c => c instanceof Group)!.children.length

    const one = object("vision", [pose(1, 0)])
    visual.update(one, frame(new TrailStore(), pose(0, 0)))
    // The extra ones are turned off, not destroyed: the count swings a lot and
    // creating and throwing away meshes at that pace shows.
    expect(visual.group.children.find(c => c instanceof Group)!.children.length).toBe(created)
    expect(visibleMeshes(visual.group)).toBe(1)
    visual.dispose()
  })
})

describe("game pieces and markers", () => {
  it("without a model the piece falls back to a sphere, one per pose", () => {
    const next = object("gamePiece", [pose(1, 1, 0.5), pose(-1, 2, 0.5)])
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())
    expect(visibleMeshes(visual.group)).toBe(2)
    visual.dispose()
  })

  it("the cone marker is placed at each pose", () => {
    const next = object("cone", [pose(3, -2, 0)])
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())
    const pivot = visual.group.children[0]
    expect(pivot.position.x).toBeCloseTo(3, 6)
    expect(pivot.position.y).toBeCloseTo(-2, 6)
    visual.dispose()
  })

  it("a hidden object draws nothing", () => {
    const next = object("cone", [pose(0, 0)], { hidden: true })
    const visual = createObjectVisual(next, ctx)
    visual.update(next, frame())
    expect(visual.group.visible).toBe(false)
    visual.dispose()
  })
})

describe("rebuild signature", () => {
  it("changes with whatever alters meshes or materials", () => {
    const base = object("robot", [pose(0, 0)])
    expect(visualSignature(object("robot", [pose(5, 5)]))).toBe(visualSignature(base))
    expect(visualSignature(object("ghost", [pose(0, 0)]))).not.toBe(visualSignature(base))
    expect(visualSignature(object("robot", [pose(0, 0)], { color: "#ff0000" })))
      .not.toBe(visualSignature(base))
  })
})
