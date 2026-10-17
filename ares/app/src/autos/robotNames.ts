import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import type { RobotNames } from "./CommandTree"
import type { Step } from "./types"

// The names the robot code registers (commands, conditions, ares.event
// triggers), read from its Java: what the autos and the event markers call.

export const CODE_KEY = (robotPath: string) => `ares.robotCode:${robotPath}`

export function useRobotNames(robotPath: string) {
  const [folder, setFolder] = useState<string | null>(() => { try { return localStorage.getItem(CODE_KEY(robotPath)) } catch { return null } })
  const [names, setNames] = useState<RobotNames | null>(null)
  const reload = useCallback(() => {
    invoke<RobotNames>("robot_names", { robotPath, folder }).then(setNames).catch(() => setNames(null))
  }, [robotPath, folder])
  useEffect(reload, [reload])
  const pickFolder = async () => {
    const f = await open({ directory: true, title: "The robot project (the folder with build.gradle)" })
    if (typeof f !== "string") return
    try { localStorage.setItem(CODE_KEY(robotPath), f) } catch { /* not remembered */ }
    setFolder(f)
  }
  return { names: names?.root ? names : null, reload, pickFolder }
}

/** What an event marker does on the robot, as the robot code stands. */
export type MarkerLink =
  | { kind: "built" }
  | { kind: "command" }
  | { kind: "trigger" }
  | { kind: "nothing" }
  | { kind: "unknown" }

export function markerLink(m: { name: string; command?: Step }, names: RobotNames | null): MarkerLink {
  if (m.command) return { kind: "built" }
  if (!names) return { kind: "unknown" }
  if (names.commands.includes(m.name)) return { kind: "command" }
  if (names.events.includes(m.name)) return { kind: "trigger" }
  return { kind: "nothing" }
}
