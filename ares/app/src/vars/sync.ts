import { useEffect, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { RobotConfig } from "../robot/types"
import type { FieldDoc, PathEntry } from "../paths/types"
import { useVariables } from "./context"
import { applyScope } from "./variables"

/**
 * When a variable changes, every formula in the project gives a new number:
 * the robot (in memory; the user saves it), every path and the field (on
 * disk). The open path's page applies the same scope to its own copy.
 */
export function useProjectSync(robotPath: string | null, setRobot: (f: (r: RobotConfig) => RobotConfig) => void) {
  const { scope, version, loaded } = useVariables()
  const first = useRef(true)
  useEffect(() => {
    if (!loaded) return
    // The first evaluation after opening a project only reconciles memory;
    // files are rewritten when something actually changes.
    setRobot(r => {
      const out = applyScope(r, scope)
      return out.changed ? out.doc : r
    })
    if (first.current) { first.current = false }
    if (!robotPath) return
    ;(async () => {
      const entries = await invoke<PathEntry[]>("paths_list", { robotPath }).catch(() => [] as PathEntry[])
      for (const e of entries) {
        if (!e.spec) continue
        const out = applyScope(e.spec, scope)
        if (out.changed) await invoke("path_save", { robotPath, spec: out.doc, previous: e.spec.name }).catch(() => {})
      }
      const field = await invoke<FieldDoc>("field_open", { robotPath }).catch(() => null)
      if (field) {
        const out = applyScope(field, scope)
        if (out.changed) await invoke("field_save", { robotPath, field: out.doc }).catch(() => {})
      }
    })()
  }, [version, loaded, robotPath])
}
