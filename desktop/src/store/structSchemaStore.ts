import { create } from "zustand"
import { STRUCT_DEFS, StructDef } from "../utils/dashboard/valueDecoding"
import { compileAll } from "../utils/dashboard/structSchema"

interface StructSchemaState {
  /** The schema's raw text, by struct name (e.g. "Pose2d"). */
  texts: Record<string, string>
  /** The result of compiling `texts`. Only the ones that could be resolved show up. */
  defs: Record<string, StructDef>
  registerSchemas: (entries: Record<string, string>) => void
  clear: () => void
}

export const useStructSchemaStore = create<StructSchemaState>((set, get) => ({
  texts: {},
  defs: {},

  registerSchemas: (entries) => {
    const merged = { ...get().texts }
    let changed = false
    for (const [name, text] of Object.entries(entries)) {
      if (merged[name] === text) continue
      merged[name] = text
      changed = true
    }
    if (!changed) return

    // EVERYTHING is recompiled and not just the new one: a schema that just
    // arrived may be the dependency another one that was left uncompiled needed.
    set({ texts: merged, defs: compileAll(merged) })
  },

  clear: () => set({ texts: {}, defs: {} }),
}))

/**
 * The hand-written table wins over the published schema, on purpose: for the
 * WPILib types it carries labels ("θ" instead of "value"), unit suffixes and
 * the radians-to-degrees conversion, things the schema cannot express (it only
 * says "double value"). The dynamic schema covers the rest — which is every
 * struct the team defined on its own.
 */
export function getStructDef(name: string | null | undefined): StructDef | undefined {
  if (!name) return undefined
  return STRUCT_DEFS[name] ?? useStructSchemaStore.getState().defs[name]
}

/** Version for components: re-renders when a new schema arrives. */
export function useStructDef(name: string | null | undefined): StructDef | undefined {
  const defs = useStructSchemaStore(s => s.defs)
  if (!name) return undefined
  return STRUCT_DEFS[name] ?? defs[name]
}
