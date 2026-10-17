import { useSyncExternalStore } from "react"

// This computer's preferences for the app (localStorage): what the Settings
// tab edits. What the team shares lives in the project instead.

export interface AppSettings {
  /** Open the robot used last when the app starts. */
  openLastRobot: boolean
  /** Menus, pages and panels move in; off, everything just appears. */
  motion: boolean
  /** Send each path generated and each auto saved to a connected robot (AresLib's hot reload). */
  hotReload: boolean
}

const KEY = "ares.settings"
const DEFAULTS: AppSettings = { openLastRobot: true, motion: true, hotReload: true }

function load(): AppSettings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") } } catch { return DEFAULTS }
}

let current = load()
const listeners = new Set<() => void>()

export function getSettings(): AppSettings {
  return current
}

export function setSettings(patch: Partial<AppSettings>) {
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* not remembered */ }
  applyMotion()
  listeners.forEach(l => l())
}

export function useSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const s = useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, getSettings)
  return [s, setSettings]
}

/** Motion off: a class on the document that stops every animation and transition. */
export function applyMotion() {
  document.documentElement.classList.toggle("ares-no-motion", !current.motion)
}
