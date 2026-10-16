import { useEffect, useRef } from "react"
import { useSelectionStore } from "../../store/selectionStore"

/**
 * Advances `selectedTime` in real time while `isPlaying` is active.
 *
 * It relies on performance.now() and not on a frame counter: if the browser
 * drops to 30fps (a background tab, a heavy canvas) playback has to keep going
 * at clock speed, not at half of it.
 */
export function usePlaybackEngine(getEndUs: () => number | null) {
  const isPlaying = useSelectionStore(s => s.isPlaying)
  const playbackSpeed = useSelectionStore(s => s.playbackSpeed)

  // The getters are read on every frame so the rAF does not restart on every
  // change of speed or of end of data.
  const latest = useRef({ getEndUs, playbackSpeed })
  useEffect(() => { latest.current = { getEndUs, playbackSpeed } })

  useEffect(() => {
    if (!isPlaying) return

    let raf: number | null = null
    let lastPerf = performance.now()

    const step = () => {
      const now = performance.now()
      const elapsedUs = (now - lastPerf) * 1000 * latest.current.playbackSpeed
      lastPerf = now

      const state = useSelectionStore.getState()
      if (!state.isPlaying) return

      const current = state.selectedTime
      if (current === null) {
        useSelectionStore.getState().stop()
        return
      }

      const endUs = latest.current.getEndUs()
      const next = current + elapsedUs

      // On reaching the end of the data it stops on its own. Live the end moves
      // by itself, so this only fires with a log: advancing further over an area
      // with no data would leave the cursor in the void.
      if (endUs !== null && next >= endUs) {
        useSelectionStore.getState().scrubTo(endUs)
        useSelectionStore.getState().stop()
        return
      }

      useSelectionStore.getState().scrubTo(next)
      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)
    return () => { if (raf !== null) cancelAnimationFrame(raf) }
  }, [isPlaying])
}
