// A visual harness for the Tune tab: the real page, with Tauri's backend
// replaced by fixtures. tune_start replays progress events recorded from a
// real ares-tune run (tune/tests/probe.rs, `record`; it writes fixtures/, and
// copy the robot and the Main and Alt trajectories from
// areslib/src/test/resources/project next to it), so what renders is what
// the app would show. Open /harness/tune.html?step=N to stop the replay at
// event N (default: all of it). Not part of the app.

import progress from "./fixtures/progress.json"
import robot from "./fixtures/bot.robot.json"
import main from "./fixtures/Main.traj.json"
import alt from "./fixtures/Alt.traj.json"

const params = new URLSearchParams(location.search)
const stopAt = Number(params.get("step") ?? progress.length)
const callbacks = new Map<number, (e: unknown) => void>()
const listeners: { event: string; id: number }[] = []
let next = 1
let gains: unknown = null
const emit = (event: string, payload: unknown) => {
  for (const l of listeners) if (l.event === event) callbacks.get(l.id)?.({ event, id: 0, payload })
}

const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
  paths_list: () => [{ name: "Alt", spec: { name: "Alt" }, error: null }, { name: "Main", spec: { name: "Main" }, error: null }],
  trajectory_open: a => (a.name === "Main" ? main : a.name === "Alt" ? alt : null),
  robot_tuning: () => ({ file: "/robot/src/main/java/frc/robot/TunerConstants.java", driveKp: 0.1, driveKs: 0, driveKv: 0.124, speedAt12vMps: 5.85, slipCurrentA: 120, driveFrictionV: 0.2, translation: [5, 0, 0], rotation: [5, 0, 0] }),
  gains_open: () => gains,
  gains_save: a => { gains = a.gains; return null },
  tune_runs: () => [],
  tune_cancel: () => null,
  tune_start: () => {
    progress.slice(0, stopAt).forEach((p, i) => setTimeout(() => emit("tune-progress", p), 80 * (i + 1)))
    return null
  },
  "plugin:event|listen": a => { listeners.push({ event: a.event as string, id: a.handler as number }); return next++ },
  "plugin:event|unlisten": () => null,
}

;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const f = commands[cmd]
    if (!f) throw new Error(`harness: no mock for ${cmd}`)
    return f(args ?? {})
  },
  transformCallback: (cb: (e: unknown) => void) => { const id = next++; callbacks.set(id, cb); return id },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
}

const React = await import("react")
const ReactDOM = await import("react-dom/client")
await import("@tabler/icons-webfont/dist/tabler-icons.min.css")
await import("@desktop/styles/global.css")
const { default: TunePage } = await import("../src/tune/TunePage")
const { ToastProvider } = await import("../src/ui/toasts")

ReactDOM.createRoot(document.getElementById("root")!).render(
  React.createElement(ToastProvider, null, React.createElement(TunePage, { robot: robot as never, robotPath: "/robot/src/main/deploy/ares/bot.robot.json" })),
)

// Press Tune once the page has its paths.
const press = () => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent?.trim() === "Tune")
  if (b && !(b as HTMLButtonElement).disabled) b.click()
  else setTimeout(press, 100)
}
if (params.get("run") !== "0") setTimeout(press, 300)
