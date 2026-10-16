import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { TopicAnnounce } from "../store/appStore"
import { useStructSchemaStore } from "../store/structSchemaStore"

// WPILib publishes each struct's descriptor in a sibling topic under
// ".schema". The path can be nested (AdvantageKit logs under
// "/AdvantageKit/.schema/..."), so the fragment is looked for in any position
// instead of requiring it to start the name.
const SCHEMA_MARKER = "/.schema/struct:"

export function structNameFromSchemaKey(topicName: string): string | null {
  const idx = topicName.indexOf(SCHEMA_MARKER)
  if (idx === -1) return null
  let name = topicName.slice(idx + SCHEMA_MARKER.length)
  if (name.endsWith("[]")) name = name.slice(0, -2)
  return name.length > 0 ? name : null
}

const RETRY_MS = 1000

/**
 * Discovers the schema topics and registers their contents in the store, so
 * the app understands structs that are not in the hand-written table.
 *
 * It retries because a topic is announced BEFORE it has a value: live, the
 * announce and the first sample arrive in different messages, so the first
 * read of a freshly appeared schema usually comes back empty.
 */
export function useStructSchemas(topics: Map<string, TopicAnnounce>) {
  const registerSchemas = useStructSchemaStore(s => s.registerSchemas)
  const clear = useStructSchemaStore(s => s.clear)

  useEffect(() => {
    // No topics, no data source (it disconnected or the log was closed): the
    // previous robot's schemas do not apply to the next one.
    if (topics.size === 0) {
      clear()
      return
    }

    const schemaTopics: { topic: string; name: string }[] = []
    topics.forEach(t => {
      const name = structNameFromSchemaKey(t.name)
      if (name !== null) schemaTopics.push({ topic: t.name, name })
    })
    if (schemaTopics.length === 0) return

    let cancelled = false
    let timer: number | null = null

    const poll = async () => {
      if (cancelled) return

      const known = useStructSchemaStore.getState().texts
      const pending = schemaTopics.filter(s => !(s.name in known))
      if (pending.length === 0) return // all resolved, no need to retry

      try {
        const data = await invoke<Record<string, any>>("get_live_values", {
          topicNames: pending.map(s => s.topic),
        })
        if (cancelled) return

        const entries: Record<string, string> = {}
        for (const s of pending) {
          const bytes = data[s.topic]?.Raw
          if (!Array.isArray(bytes) || bytes.length === 0) continue
          entries[s.name] = new TextDecoder().decode(new Uint8Array(bytes))
        }
        if (Object.keys(entries).length > 0) registerSchemas(entries)
      } catch {
        // The backend may be reconnecting; it retries on the next tick.
      }

      if (!cancelled) timer = window.setTimeout(poll, RETRY_MS)
    }

    poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [topics, registerSchemas, clear])
}
