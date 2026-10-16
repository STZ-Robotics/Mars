import { describe, it, expect, beforeEach } from "vitest"
import { useMarkerStore, findAdjacentMarker, TimelineMarker } from "./markerStore"

const marker = (timeUs: number, label = "m"): TimelineMarker => ({
  id: `id-${timeUs}`, timeUs, label, color: "#000",
})

describe("useMarkerStore", () => {
  beforeEach(() => useMarkerStore.getState().clearMarkers())

  it("keeps the marks sorted by time, not by creation order", () => {
    const { addMarker } = useMarkerStore.getState()
    addMarker(500, "tarde")
    addMarker(100, "temprano")
    addMarker(300, "medio")

    expect(useMarkerStore.getState().markers.map(m => m.label)).toEqual(["temprano", "medio", "tarde"])
  })

  it("rounds the timestamp", () => {
    // selectedTime travels to Rust as a u64: a decimal makes serde reject the
    // call.
    useMarkerStore.getState().addMarker(123.7, "x")
    expect(useMarkerStore.getState().markers[0].timeUs).toBe(124)
  })

  it("falls back to a default label if it comes empty", () => {
    useMarkerStore.getState().addMarker(10, "   ")
    expect(useMarkerStore.getState().markers[0].label).toBe("Marker")
  })

  it("hands out different colors to consecutive marks", () => {
    const { addMarker } = useMarkerStore.getState()
    addMarker(1, "a")
    addMarker(2, "b")
    const [a, b] = useMarkerStore.getState().markers
    expect(a.color).not.toBe(b.color)
  })

  it("generates unique ids even if created in the same millisecond", () => {
    const { addMarker } = useMarkerStore.getState()
    addMarker(1, "a")
    addMarker(2, "b")
    addMarker(3, "c")
    const ids = useMarkerStore.getState().markers.map(m => m.id)
    expect(new Set(ids).size).toBe(3)
  })

  it("deletes by id and clears everything", () => {
    const { addMarker } = useMarkerStore.getState()
    addMarker(1, "a")
    addMarker(2, "b")
    const first = useMarkerStore.getState().markers[0]
    useMarkerStore.getState().removeMarker(first.id)
    expect(useMarkerStore.getState().markers).toHaveLength(1)
    useMarkerStore.getState().clearMarkers()
    expect(useMarkerStore.getState().markers).toHaveLength(0)
  })

  it("setMarkers sorts whatever it is given", () => {
    useMarkerStore.getState().setMarkers([marker(300), marker(100), marker(200)])
    expect(useMarkerStore.getState().markers.map(m => m.timeUs)).toEqual([100, 200, 300])
  })
})

describe("findAdjacentMarker", () => {
  const markers = [marker(100, "a"), marker(200, "b"), marker(300, "c")]

  it("finds the next one", () => {
    expect(findAdjacentMarker(markers, 150, "next")!.label).toBe("b")
    expect(findAdjacentMarker(markers, 0, "next")!.label).toBe("a")
  })

  it("finds the previous one", () => {
    expect(findAdjacentMarker(markers, 250, "prev")!.label).toBe("b")
    expect(findAdjacentMarker(markers, 999, "prev")!.label).toBe("c")
  })

  it("does not get stuck on the mark it is already sitting on", () => {
    // Sitting exactly on "b", "next" has to go to "c" and not return "b" again
    // (otherwise the button would do nothing).
    expect(findAdjacentMarker(markers, 200, "next")!.label).toBe("c")
    expect(findAdjacentMarker(markers, 200, "prev")!.label).toBe("a")
  })

  it("returns null at the ends", () => {
    expect(findAdjacentMarker(markers, 300, "next")).toBeNull()
    expect(findAdjacentMarker(markers, 100, "prev")).toBeNull()
    expect(findAdjacentMarker([], 50, "next")).toBeNull()
  })
})
