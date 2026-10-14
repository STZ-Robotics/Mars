// The NT4 connection: the backend's events, connecting and disconnecting, and
// opening a project.

import { useEffect } from "react"
import type { Dispatch, SetStateAction } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { listen } from "@tauri-apps/api/event"
import type { AppState, TopicAnnounce } from "../store/appStore"

export function useNTConnection(setState: Dispatch<SetStateAction<AppState>>) {
  useEffect(() => {
    const setupListeners = async () => {
      const unlistenDisconnect = await listen("nt-disconnected", () => {
        console.warn("NT4 connection lost or closed by the server.")
        setState(prev => prev.logSource !== null
          // Opening a log disconnects NT on purpose: the topics there now are
          // the file's, not those of the session that just closed.
          ? { ...prev, connection: "disconnected" }
          : { ...prev, connection: "disconnected", topics: new Map() })
      })

      const unlistenTopics = await listen<TopicAnnounce>("nt-topic-announced", (event) => {
        setState(prev => {
          const newTopics = new Map(prev.topics)
          newTopics.set(event.payload.name, event.payload)
          return { ...prev, topics: newTopics }
        })
      })

      // The server says when a topic stops existing (its last publisher left,
      // or MARS withdrew it from the NT Session). Without this the tree only
      // grows and shows topics that are no longer there.
      const unlistenUnannounce = await listen<string>("nt-topic-unannounced", (event) => {
        setState(prev => {
          if (!prev.topics.has(event.payload)) return prev
          const newTopics = new Map(prev.topics)
          newTopics.delete(event.payload)
          return { ...prev, topics: newTopics }
        })
      })

      // The backend retries the connection on its own (with backoff) when the
      // socket closes unexpectedly. This event says when it succeeded, so the
      // UI stops showing "disconnected". The topics repopulate on their own
      // through nt-topic-announced when it resubscribes.
      const unlistenReconnect = await listen<string>("nt-reconnected", (event) => {
        setState(prev => ({ ...prev, connection: event.payload === "real" ? "real" : "sim" }))
      })

      return () => {
        unlistenDisconnect()
        unlistenTopics()
        unlistenUnannounce()
        unlistenReconnect()
      }
    }

    const unlistenPromise = setupListeners()
    return () => {
      unlistenPromise.then(cleanup => cleanup())
    }
  }, [])

  const handleOpenProject = async () => {
    try {
      const selectedPath = await open({ directory: true, multiple: false })
      if (selectedPath && typeof selectedPath === "string") {
        const projectName = await invoke<string>("validate_mars_project", { path: selectedPath })
        setState(prev => ({ ...prev, projectName, projectPath: selectedPath }))
      }
    } catch (error) {
      alert(`Invalid Project:\n${error}`)
    }
  }

  const handleConnectSim = async () => {
    try {
      await invoke<string>("connect_sim")
      // Connecting replaces the buffer, so whatever log was loaded stops
      // existing: the state has to reflect it.
      setState(prev => ({ ...prev, connection: "sim", logSource: null }))
    } catch (error) {
      console.error("Failed to connect:", error)
      alert(`NT4 Error: ${error}`)
    }
  }

  const handleConnectReal = async () => {
    try {
      // No argument: the backend resolves address and port from Settings
      // (team number, custom address and NT4 target).
      await invoke<string>("connect_real")
      setState(prev => ({ ...prev, connection: "real", logSource: null }))
    } catch (error) {
      console.error("Failed to connect:", error)
      alert(`NT4 Error: ${error}`)
    }
  }

  const handleDisconnect = async () => {
    try {
      await invoke("disconnect_nt")
      setState(prev => ({ ...prev, connection: "disconnected", topics: new Map() }))
    } catch (error) {
      console.error(error)
    }
  }

  return { handleOpenProject, handleConnectSim, handleConnectReal, handleDisconnect }
}
