import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useSelectionStore } from "../../store/selectionStore"
import { useNTTick } from "./useNTTick"

/**
 * A drop-in replacement for the manual polls DisplayPage.tsx and
 * TelemetryPage.tsx used to have. Returns the right { topicName -> NTValue }
 * map for the current instant (live or paused), without the component having
 * to know which of the two cases is happening.
 */
export function useNTSnapshot(topicNames: string[], intervalMs: number): Record<string, any> {
  const isLive = useSelectionStore((s) => s.isLive)
  const tick = useNTTick(intervalMs)
  const [values, setValues] = useState<Record<string, any>>({})

  // A stable topicKey so the effect does not re-fire if the array changes
  // reference but not content (e.g. widgets.map on every render).
  const topicKey = topicNames.slice().sort().join("|")

  useEffect(() => {
    if (tick === null || topicNames.length === 0) return
    let cancelled = false

    const cmd = isLive ? "get_live_values" : "get_values_at"
    const args = isLive
      ? { topicNames }
      : { topicNames, timestamp: tick }

    invoke(cmd, args)
      .then((data) => { if (!cancelled) setValues(data as Record<string, any>) })
      .catch(() => { /* silencioso: puede pasar mientras se reconecta */ })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, topicKey, isLive])

  return values
}