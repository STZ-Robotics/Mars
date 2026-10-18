import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { FIELDS, FieldConfig } from "@desktop/utils/field/fieldImages"
import type { ProjectSettings } from "../vars/writeJava"

// The field the project plays on (Settings → Project → Field): its picture
// and size everywhere in the app, and its size and symmetry for the robot
// (they go in ares-index.json). Rebuilt (2026) when the project says nothing.

export const DEFAULT_FIELD = "2026-rebuilt"

export type Symmetry = "rotational" | "mirrored"

/** How each game's field is laid out for the other alliance. */
export function symmetryOf(field: FieldConfig): Symmetry {
  return /^(Charged Up|Crescendo|Rapid React|Infinite Recharge|Deep Space|Power Up)/.test(field.game) ? "mirrored" : "rotational"
}

/** What project.json keeps about the field. */
export interface FieldChoice { key: string; lengthM: number; widthM: number; symmetry: Symmetry }

interface FieldState {
  field: FieldConfig
  /** Its playing area, in meters. */
  size: { lengthM: number; widthM: number }
  symmetry: Symmetry
  choose: (key: string) => Promise<void>
}

export function fieldByKey(key: string | undefined): FieldConfig {
  return FIELDS.find(f => f.key === key) ?? FIELDS.find(f => f.key === DEFAULT_FIELD) ?? FIELDS[0]
}

function stateOf(field: FieldConfig, choose: FieldState["choose"]): FieldState {
  return { field, size: { lengthM: field.sizeMeters[0], widthM: field.sizeMeters[1] }, symmetry: symmetryOf(field), choose }
}

const Ctx = createContext<FieldState>(stateOf(fieldByKey(undefined), async () => {}))

export function useField(): FieldState {
  return useContext(Ctx)
}

export function FieldProvider({ robotPath, children }: { robotPath: string | null; children: ReactNode }) {
  const [key, setKey] = useState<string | undefined>(undefined)
  useEffect(() => {
    setKey(undefined)
    if (!robotPath) return
    invoke<ProjectSettings>("project_settings_open", { robotPath }).then(s => setKey(s.field?.key)).catch(() => {})
  }, [robotPath])
  const choose = useCallback(async (k: string) => {
    if (!robotPath) return
    const f = fieldByKey(k)
    const s = await invoke<ProjectSettings>("project_settings_open", { robotPath }).catch(() => null)
    const field: FieldChoice = { key: f.key, lengthM: f.sizeMeters[0], widthM: f.sizeMeters[1], symmetry: symmetryOf(f) }
    await invoke("project_settings_save", { robotPath, settings: { ...(s ?? { varsJava: { enabled: false, file: "" } }), field } })
    // The robot reads the field from the index.
    await invoke("index_write", { robotPath }).catch(() => {})
    setKey(f.key)
  }, [robotPath])
  return <Ctx.Provider value={stateOf(fieldByKey(key), choose)}>{children}</Ctx.Provider>
}
