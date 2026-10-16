import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { FunctionSeriesConfig } from "../../store/appStore"
import { useSelectionStore } from "../../store/selectionStore"
import { TimeSeriesPoint } from "./mathTransforms"

const REFRESH_INTERVAL_MS = 50 // ~20Hz of REDRAWING (not of sampling)

interface TimeBounds { start: number | null; end: number | null }

/**
 * A {t,v} buffer per TOPIC, in SECONDS of the NT server's scale.
 *
 * This used to accumulate samples on the client side with `Date.now()`. That
 * brought two serious problems:
 *
 *  1. **Two different time scales.** Live, the points were stored with Unix
 *     epoch (~1.77e9 s) and paused with the server's timestamp (~1e4 s, which
 *     counts from when the robot started). On pausing, the X axis jumped
 *     several orders of magnitude and the plot broke.
 *  2. **Aliasing.** Polling "the current value" at 20Hz on a signal the robot
 *     publishes at 200Hz throws away 9 out of every 10 samples, and on top of
 *     that stamps them with the poll's timestamp and not the real one. A
 *     derivative computed that way is garbage.
 *
 * Now both modes ask the backend for `get_values_range`, which returns the
 * REAL samples with their real timestamps. Live, the window is anchored to the
 * last data point received; paused, to the scrubbed instant.
 */
export function useLiveSeriesBuffers(series: FunctionSeriesConfig[], windowSeconds: number) {
  const topicNames = Array.from(new Set(series.map(s => s.topicName)))
  const topicKey = topicNames.slice().sort().join("|")

  const isLive = useSelectionStore((s) => s.isLive)
  const selectedTime = useSelectionStore((s) => s.selectedTime)

  const [buffers, setBuffers] = useState<Record<string, TimeSeriesPoint[]>>({})
  // The end of the live window: it is read again from the backend so as not to
  // depend on the client's clock, which can differ from the robot's.
  const endUsRef = useRef<number | null>(null)

  useEffect(() => {
    if (topicNames.length === 0) {
      setBuffers({})
      return
    }
    let cancelled = false

    const fetchWindow = async () => {
      if (cancelled) return

      let endUs: number | null
      if (isLive) {
        try {
          const bounds = await invoke<TimeBounds>("get_time_bounds")
          endUs = bounds.end
          endUsRef.current = endUs
        } catch {
          endUs = endUsRef.current
        }
      } else {
        endUs = selectedTime
      }
      if (cancelled || endUs === null) return

      const startUs = Math.max(0, endUs - windowSeconds * 1e6)
      try {
        const data: Record<string, [number, any][]> = await invoke("get_values_range", {
          topicNames,
          start: startUs,
          end: endUs,
        })
        if (cancelled) return

        const next: Record<string, TimeSeriesPoint[]> = {}
        for (const name of topicNames) {
          next[name] = (data[name] ?? [])
            .filter(([, v]) => typeof v?.Number === "number")
            // To seconds: all the transforms' math works in seconds, so a
            // derivative comes out directly in units/second.
            .map(([ts, v]) => ({ t: ts / 1e6, v: v.Number as number }))
        }
        // A new object on every tick: the parent has to see the reference change
        // to recompute the transforms.
        setBuffers(next)
      } catch {
        // No data in that range yet; it retries on the next tick.
      }
    }

    fetchWindow()
    // Paused there is no need to repeat: the window only changes if the user
    // moves the cursor, and that fires this effect again.
    if (!isLive) return () => { cancelled = true }

    const interval = setInterval(fetchWindow, REFRESH_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(interval) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicKey, windowSeconds, isLive, selectedTime])

  return buffers
}
