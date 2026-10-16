import { useEffect, useState } from "react"
import { useSelectionStore } from "../../store/selectionStore"

/**
 * The single source of truth for "when to re-read NetworkTables and with which
 * timestamp". Nothing else in the app should have its own polling setInterval
 * or its own isLive check — everything is built on top of this hook.
 *
 * LIVE: emits a tick every `intervalMs` with Date.now() in microseconds
 *       (the same format client.rs / SystemTime use in Rust).
 * PAUSED: no timer running. It only emits a tick when `selectedTime`
 *         changes (the user moves the timeline's cursor).
 */
export function useNTTick(intervalMs: number): number | null {
  const isLive = useSelectionStore((s) => s.isLive)
  const selectedTime = useSelectionStore((s) => s.selectedTime)
  const [tick, setTick] = useState<number | null>(null)

  useEffect(() => {
    if (!isLive) {
      setTick(selectedTime)
      return
    }

    let cancelled = false
    const loop = () => {
      if (cancelled) return
      setTick(Date.now() * 1000)
      timeoutId = setTimeout(loop, intervalMs)
    }
    let timeoutId = setTimeout(loop, 0)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [isLive, selectedTime, intervalMs])

  return tick
}