// A visual harness for the Logs tab: the real page, with a log holding one
// run of Main (from tune's simulator, a heavier and later robot than the
// robot.json) and the calibration the search really found on it. Not part of
// the app.

import robot from "./fixtures/bot.robot.json"
import fixture from "./fixtures/logrun.json"

const callbacks = new Map<number, (e: unknown) => void>()
const listeners: { event: string; id: number }[] = []
let next = 1
const emit = (event: string, payload: unknown) => {
  for (const l of listeners) if (l.event === event) callbacks.get(l.id)?.({ event, id: 0, payload })
}
const light = { ...fixture.run, samples: [], pathPoses: [] }
const commands: Record<string, (a: Record<string, unknown>) => unknown> = {
  "plugin:dialog|open": () => "/home/lvuser/logs/FRC_20261017_181502_Q42.wpilog",
  log_open: () => ({ name: "FRC_20261017_181502_Q42.wpilog", durationS: 158, topics: ["NT:/Ares/Robot"], runs: [light, { ...light, index: 1, path: "Alt", startS: 21.1, durationS: 2.4, maxErrM: 0.071 }] }),
  log_run: () => fixture.run,
  log_calibrate: async () => {
    const h = fixture.calibration.history
    for (let g = 1; g < h.length; g++) { emit("log-calibrate-progress", [g, h[g]]); await new Promise(r => setTimeout(r, 15)) }
    return fixture.calibration
  },
  robot_tuning: () => null,
  characterization_open: () => null,
  calibration_open: () => null,
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
}
const React = await import("react")
const ReactDOM = await import("react-dom/client")
await import("@tabler/icons-webfont/dist/tabler-icons.min.css")
await import("@desktop/styles/global.css")
const { default: LogsPage } = await import("../src/logs/LogsPage")
const { ToastProvider } = await import("../src/ui/toasts")
ReactDOM.createRoot(document.getElementById("root")!).render(
  React.createElement(ToastProvider, null, React.createElement(LogsPage, { robot: robot as never, robotPath: "/x/bot.robot.json" })),
)
const click = (text: string, then?: () => void) => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent?.includes(text))
  if (b && !(b as HTMLButtonElement).disabled) { b.click(); then?.() } else setTimeout(() => click(text, then), 100)
}
click("Open .wpilog", () => setTimeout(() => click("Calibrate on this run", () => setTimeout(() => {
  // Place the robot two seconds in, as a click on a chart would.
  const svg = document.querySelectorAll("svg")[1] as SVGSVGElement | undefined
  if (!svg) return
  const r = svg.getBoundingClientRect()
  svg.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 40 + (r.width - 50) * 0.55, clientY: r.top + 50 }))
}, 900)), 400))
