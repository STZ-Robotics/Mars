import { invoke } from "@tauri-apps/api/core"
import { useState, useEffect } from "react"

// Target of the NT4 server. The port is resolved by the backend (MarsSettings::nt_port),
// here only which one is chosen; "custom" is the only one that uses nt_custom_port.
export type NTTarget = "default" | "ds" | "systemcore" | "custom"

export const NT_TARGET_PORTS: Record<Exclude<NTTarget, "custom">, number> = {
  default: 5810,
  ds: 6767,
  systemcore: 6810,
}

export interface MarsSettings {
  team_number: string
  workspace_path: string
  tools_path: string
  auto_save_deploy: boolean
  nt_target: NTTarget
  nt_custom_port: number
  /** Empty = derive the address from the team number. */
  nt_custom_address: string
  /** Minutes of history the buffer keeps. 0 = no limit. */
  nt_retention_minutes: number
  /** Author written to MarsFeature.json when creating a feature. */
  feature_author: string
  /** GitHub user or organization the features are published under. */
  github_user: string
}

export const defaultSettings: MarsSettings = {
  team_number: "",
  workspace_path: "",
  tools_path: "",
  auto_save_deploy: true,
  nt_target: "default",
  nt_custom_port: 5810,
  nt_custom_address: "",
  nt_retention_minutes: 15,
  feature_author: "",
  github_user: "",
}

export function useMarsSettings() {
  const [settings, setSettings] = useState<MarsSettings>(defaultSettings)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoke<MarsSettings>("read_mars_settings")
      .then(s => { setSettings(s); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [])

  const save = async (updated: MarsSettings) => {
    await invoke("write_mars_settings", { settings: updated })
    setSettings(updated)
  }

  return { settings, setSettings, save, loading, error }
}