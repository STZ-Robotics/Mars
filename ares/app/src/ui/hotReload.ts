import { invoke } from "@tauri-apps/api/core"
import type { NtValue } from "../characterize/model"
import { getSettings } from "../settings/settings"

// Hot reload: what was just generated or saved goes to the connected robot,
// where AresLib swaps it in without a deploy (src-tauri/src/nt.rs and
// Ares.hotReload). Nothing happens when not connected or turned off in Settings.

type Toast = (t: { kind: "info" | "error" | "success"; title: string; body?: string }) => void

/**
 * Sends trajectories (by key, "path" or "path@variant") and, with `index`,
 * the autos. Returns how many went. With a toast, says what the robot
 * answered.
 */
export async function hotReload(robotPath: string, keys: string[], index: boolean, toast?: Toast): Promise<number> {
  if (!getSettings().hotReload) return 0
  const sent = await invoke<number>("nt_hot_reload", { robotPath, keys, index }).catch(() => 0)
  if (!sent || !toast) return sent
  // The robot answers within a loop or two.
  setTimeout(async () => {
    const v = await invoke<Record<string, NtValue>>("nt_read", { prefix: "/Ares/HotReload/" }).catch(() => ({} as Record<string, NtValue>))
    const last = v["/Ares/HotReload/Last"]
    const said = last && "String" in last ? last.String : null
    if (said?.startsWith("refused") || said?.startsWith("failed")) toast({ kind: "error", title: "The robot did not take it", body: said })
    else toast({ kind: "info", title: "On the robot, without a deploy", body: `${keys.join(", ")}${index ? (keys.length ? " and the autos" : "the autos") : ""}. Deploy to keep it after a restart.` })
  }, 700)
  return sent
}
