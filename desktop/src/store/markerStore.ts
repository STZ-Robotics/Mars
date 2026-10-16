import { create } from "zustand"

// Marks on the timeline: "the swerve failed here", "autonomous started here".
// They exist to get back to a specific instant later, without having to
// remember the second number.
export interface TimelineMarker {
  id: string
  /** Microsegundos, misma escala que selectedTime. */
  timeUs: number
  label: string
  color: string
}

// A fixed palette: the colors are handed out in creation order so two marks in
// a row never come out the same.
export const MARKER_COLORS = ["#d63b3b", "#d4a94a", "#1f9e4a", "#2f6fdb", "#8a4fd1", "#0e9aa7"]

interface MarkerState {
  markers: TimelineMarker[]
  addMarker: (timeUs: number, label: string) => void
  removeMarker: (id: string) => void
  renameMarker: (id: string, label: string) => void
  clearMarkers: () => void
  /** Replaces the whole set (when restoring a saved layout). */
  setMarkers: (markers: TimelineMarker[]) => void
}

let idCounter = 0

export const useMarkerStore = create<MarkerState>((set, get) => ({
  markers: [],

  addMarker: (timeUs, label) => {
    const color = MARKER_COLORS[get().markers.length % MARKER_COLORS.length]
    const marker: TimelineMarker = {
      id: `${Date.now()}-${idCounter++}`,
      timeUs: Math.round(timeUs),
      label: label.trim() || "Marker",
      color,
    }
    // Sorted by time: that way "jump to the next mark" is just advancing an
    // index, and the drawing does not depend on creation order.
    set(state => ({ markers: [...state.markers, marker].sort((a, b) => a.timeUs - b.timeUs) }))
  },

  removeMarker: (id) => set(state => ({ markers: state.markers.filter(m => m.id !== id) })),

  renameMarker: (id, label) => set(state => ({
    markers: state.markers.map(m => m.id === id ? { ...m, label: label.trim() || m.label } : m),
  })),

  clearMarkers: () => set({ markers: [] }),

  setMarkers: (markers) => set({ markers: [...markers].sort((a, b) => a.timeUs - b.timeUs) }),
}))

/** The mark immediately before/after an instant, to jump between them. */
export function findAdjacentMarker(
  markers: TimelineMarker[],
  timeUs: number,
  direction: "prev" | "next",
): TimelineMarker | null {
  if (direction === "next") {
    return markers.find(m => m.timeUs > timeUs + 1) ?? null
  }
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i].timeUs < timeUs - 1) return markers[i]
  }
  return null
}
