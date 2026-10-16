import { create } from "zustand"

// WPILib marks each "sendable" table with a ".type" subtopic whose value says
// what it is: "Field2d", "Mechanism2d", "SendableChooser", "Subsystem"...
//
// That value does NOT come in the topic's announce, it has to be read. This
// store keeps the result so any page can ask "what is this table?" without
// asking the backend again.

interface TableTypeState {
  /** Table path (without "/.type") -> the ".type"'s value. */
  types: Record<string, string>
  registerTypes: (entries: Record<string, string>) => void
  clear: () => void
}

export const useTableTypeStore = create<TableTypeState>((set, get) => ({
  types: {},

  registerTypes: (entries) => {
    const merged = { ...get().types }
    let changed = false
    for (const [prefix, type] of Object.entries(entries)) {
      if (merged[prefix] === type) continue
      merged[prefix] = type
      changed = true
    }
    if (changed) set({ types: merged })
  },

  clear: () => set({ types: {} }),
}))

/** A hook-less version, for loose functions outside a component. */
export function getTableTypes(): Record<string, string> {
  return useTableTypeStore.getState().types
}
