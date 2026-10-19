import { describe, expect, it } from "vitest"
import { tagsForField } from "../vision/vision"
import { modelTurn } from "./field3dAlign"

// Where the 2026 model's config puts a few of its tags (centered on the field, its own frame).
const CONFIG_2026 = {
  aprilTags: [
    { id: 1, position: [-3.607, -3.39, 0.889] as [number, number, number], rotations: [], variant: "36h11-6.5in" },
    { id: 13, position: [-8.262, -3.369, 0.552] as [number, number, number], rotations: [], variant: "36h11-6.5in" },
    { id: 25, position: [4.249, -0.356, 1.124] as [number, number, number], rotations: [], variant: "36h11-6.5in" },
    { id: 31, position: [8.262, 0.289, 0.552] as [number, number, number], rotations: [], variant: "36h11-6.5in" },
  ],
}

describe("placing a 3D field", () => {
  it("turns the 2026 model 180 degrees: its tags then land on WPILib's", () => {
    expect(modelTurn(CONFIG_2026, tagsForField("2026-rebuilt"), 16.541, 8.069)).toBeCloseTo(Math.PI)
  })
  it("leaves a model alone when its tags are already where WPILib says", () => {
    const tags = tagsForField("2026-rebuilt")
    const centered = { aprilTags: tags.slice(0, 6).map(t => ({ id: t.id, position: [t.x - 16.541 / 2, t.y - 8.069 / 2, t.z] as [number, number, number], rotations: [], variant: "" })) }
    expect(modelTurn(centered, tags, 16.541, 8.069)).toBe(0)
  })
})
