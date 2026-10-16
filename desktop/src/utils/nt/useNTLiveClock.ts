import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

interface TimeBounds { start: number | null; end: number | null }

/**
 * The single source of truth for the data clock. It asks Rust for the buffer's
 * REAL timestamp range (NTBuffer.start_time / end_time) — never the browser's
 * clock. This is what makes the timeline show the real connection time (it
 * survives remounts, it does not drift if the client's clock differs from the
 * NT source's).
 *
 * Between polls, it interpolates with performance.now() so the "LIVE" marker
 * keeps advancing smoothly instead of jumping in fits every 200ms.
 */
export function useNTLiveClock(pollMs = 200) {
  const [bounds, setBounds] = useState<TimeBounds>({ start: null, end: null })
  const lastPollPerfRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (cancelled) return
      try {
        const data = await invoke<TimeBounds>("get_time_bounds")
        if (!cancelled) {
          setBounds(data)
          lastPollPerfRef.current = performance.now()
        }
      } catch { /* the backend may not be ready yet, it retries */ }
      if (!cancelled) setTimeout(poll, pollMs)
    }
    poll()
    return () => { cancelled = true }
  }, [pollMs])

  /** The estimated "now" in microseconds, smoothly interpolated between polls. */
  const getEstimatedNowUs = (): number | null => {
    if (bounds.end === null) return null
    const elapsedSincePollMs = performance.now() - lastPollPerfRef.current
    return bounds.end + elapsedSincePollMs * 1000
  }

  return { startUs: bounds.start, endUs: bounds.end, getEstimatedNowUs }
}