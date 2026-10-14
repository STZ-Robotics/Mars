// Opening, exporting and closing .wpilog files.
//
// The backend loads the log into the SAME buffer NT4 uses, so every tab
// (Field, Swerve, Mechanism, Display, Functions) reads from the file without
// changing anything: only where the data came from changes.

import type { Dispatch, SetStateAction } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import type { AppState, LogSource, TopicAnnounce } from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"

export function useLogFile(setState: Dispatch<SetStateAction<AppState>>) {
  const handleOpenLog = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "WPILib data log", extensions: ["wpilog"] }],
      })
      if (!path || typeof path !== "string") return

      const result = await invoke<{ summary: LogSource; topics: TopicAnnounce[] }>("open_wpilog", { path })

      const topics = new Map<string, TopicAnnounce>()
      result.topics.forEach(t => topics.set(t.name, t))

      setState(prev => ({ ...prev, connection: "disconnected", topics, logSource: result.summary }))

      // A log has no "now": it starts paused on its first sample, otherwise the
      // timeline sits waiting for new data that never arrives.
      if (result.summary.start_us !== null) {
        useSelectionStore.getState().pauseAt(result.summary.start_us)
      }
    } catch (error) {
      alert(`Could not open log:\n${error}`)
    }
  }

  const handleExportLog = async () => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const path = await save({
        title: "Export log",
        defaultPath: `mars-${stamp}.wpilog`,
        filters: [{ name: "WPILib data log", extensions: ["wpilog"] }],
      })
      if (!path) return
      const summary = await invoke<{ topic_count: number; sample_count: number; bytes: number }>(
        "export_wpilog", { path },
      )
      alert(
        `Log exported.\n\n${summary.topic_count} topics, ${summary.sample_count} samples\n` +
        `${(summary.bytes / 1024 / 1024).toFixed(2)} MB`,
      )
    } catch (error) {
      alert(`Could not export log:\n${error}`)
    }
  }

  const handleCloseLog = async () => {
    try {
      await invoke("close_log")
      setState(prev => ({ ...prev, topics: new Map(), logSource: null }))
      useSelectionStore.getState().goLive()
    } catch (error) {
      console.error("Failed to close log:", error)
    }
  }

  return { handleOpenLog, handleExportLog, handleCloseLog }
}
