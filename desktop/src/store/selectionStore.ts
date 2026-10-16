import { create } from "zustand"

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const

interface SelectionState {
  /** true = following "now" in real time. false = frozen/scrubbing. */
  isLive: boolean
  /** A timestamp in MICROSECONDS (the same format as client.rs), only valid when isLive=false. */
  selectedTime: number | null
  /** The timestamp under the mouse cursor on the timeline, for the crosshair. */
  hoveredTime: number | null

  /** Playing forward from selectedTime (it is NOT the same as being live). */
  isPlaying: boolean
  playbackSpeed: number

  goLive: () => void
  pauseAt: (timestampUs: number) => void
  scrubTo: (timestampUs: number) => void
  setHovered: (timestampUs: number | null) => void

  /** Starts from where the cursor is; if it was live, it pins it first. */
  play: (fallbackTimeUs: number) => void
  stop: () => void
  setPlaybackSpeed: (speed: number) => void
}

export const useSelectionStore = create<SelectionState>((set) => ({
  isLive: true,
  selectedTime: null,
  hoveredTime: null,
  isPlaying: false,
  playbackSpeed: 1,

  // Going live cancels playback: they are two different ways of advancing in
  // time and leaving both active makes them fight over selectedTime.
  goLive: () => set({ isLive: true, selectedTime: null, isPlaying: false }),

  // Math.round here is on purpose: selectedTime travels as is to invoke()
  // -> get_values_at/get_values_range in Rust, which declare timestamp/start/end
  // as u64. A decimal (it comes from scaleValue()/performance.now(), which are
  // float arithmetic) makes serde reject the call and the hooks' silent catch{}
  // swallow the error without warning. Rounding HERE, at the store's only entry
  // point, means nobody has to remember to do it in every place that calls
  // pauseAt/scrubTo.
  pauseAt: (timestampUs) => set({ isLive: false, selectedTime: Math.round(timestampUs), isPlaying: false }),

  scrubTo: (timestampUs) => set((state) => {
    const t = Math.round(timestampUs)
    // If for some reason scrubTo is called while live, we treat it as an
    // implicit pause at that point, so the store is not left in an odd state.
    if (state.isLive) return { isLive: false, selectedTime: t }
    return { selectedTime: t }
  }),

  setHovered: (timestampUs) => set({ hoveredTime: timestampUs }),

  // Play does NOT jump to the last data point: it continues from where the line
  // was. Going to the present is what the "go to the end" button (goLive) does.
  play: (fallbackTimeUs) => set((state) => ({
    isPlaying: true,
    isLive: false,
    selectedTime: state.selectedTime ?? Math.round(fallbackTimeUs),
  })),

  stop: () => set({ isPlaying: false }),

  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),
}))
