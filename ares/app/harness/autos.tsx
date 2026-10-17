// A visual harness for the Autos tab: the real page, with an auto over the
// fixture trajectories (Main carries event markers, one with its own
// command) and robot code names. Not part of the app.

import robot from "./fixtures/bot.robot.json"
import main from "./fixtures/Main.traj.json"
import alt from "./fixtures/Alt.traj.json"
import find from "./fixtures/Find.traj.json"

const spec = (name: string) => ({ name, waypoints: [{ x: 1, y: 1 }, { x: 3, y: 2 }], constraints: {}, scoped: [] })
const autos = [{
  name: "Two pieces", budgetS: 15, folder: "Qualifiers", resetOdometry: false, steps: [
    { type: "path", path: "Main" },
    { type: "deadline", steps: [{ type: "path", path: "Alt" }, { type: "command", name: "intake" }] },
    { type: "command", name: "shoot", estimateS: 0.6 },
    { type: "wait", seconds: 0.3 },
    { type: "path", path: "Find" },
    { type: "command", name: "climb", estimateS: 1 },
  ],
}]
autos.push({ name: "Taxi", budgetS: 15, folder: "Qualifiers", steps: [{ type: "path", path: "Find" }] } as never, { name: "Do nothing", budgetS: 15, steps: [] } as never)
const trajs: Record<string, unknown> = { Main: main, Alt: alt, Find: find }
const commands: Record<string, (a: Record<string, unknown>) => unknown> = {
  autos_list: () => autos,
  paths_list: () => ["Main", "Alt", "Find"].map(n => ({ name: n, spec: spec(n) })),
  field_open: () => ({ keepOut: [], zones: [] }),
  paths_status: () => ["Main", "Alt", "Find"].map(n => ({ name: n, generated: true, outdated: false })),
  trajectory_open: a => trajs[a.name as string] ?? null,
  robot_names: () => ({ root: "/home/team/robot", commands: ["intake", "shoot", "feed", "kick"], conditions: ["hasNote"], events: ["spin"], files: 14 }),
  auto_save: () => null,
  variables_open: () => ({ variables: [] }),
  folders_open: () => ({ paths: ["Amp side", "Source side"], autos: ["Qualifiers", "Playoffs"] }),
  folders_save: () => null,
}
;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const f = commands[cmd]
    if (!f) throw new Error(`harness: no mock for ${cmd}`)
    return f(args ?? {})
  },
  transformCallback: () => 0,
}
const React = await import("react")
const ReactDOM = await import("react-dom/client")
await import("@tabler/icons-webfont/dist/tabler-icons.min.css")
await import("@desktop/styles/global.css")
if (!new URLSearchParams(location.search).has("nocss")) await import("../src/styles/ares.css")
const { default: AutosPage } = await import("../src/autos/AutosPage")
const { ToastProvider } = await import("../src/ui/toasts")
const { VariablesProvider } = await import("../src/vars/context")
const strict = (el: React.ReactElement) => (new URLSearchParams(location.search).has("strict") ? React.createElement(React.StrictMode, null, el) : el)
ReactDOM.createRoot(document.getElementById("root")!).render(strict(
  React.createElement(ToastProvider, null, React.createElement(VariablesProvider as never, { robotPath: "/x/bot.robot.json" } as never,
    React.createElement(AutosPage, { robot: robot as never, robotPath: "/x/bot.robot.json" })))),
)
// Seek to 3.2 s and pick the deadline group's card.
const seek = () => {
  const lanes = [...document.querySelectorAll("div")].filter(d => d.style.cursor === "pointer" && d.style.position === "relative")
  const lane = lanes[0]
  if (!lane) return setTimeout(seek, 150)
  const r = lane.getBoundingClientRect()
  const span = Number(new URLSearchParams(location.search).get("t") ?? "3.2")
  lane.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width * span / (15 * 1.04), clientY: r.top + 5 }))
  const card = [...document.querySelectorAll("select")].find(s => (s as HTMLSelectElement).value === "deadline")?.closest("div[draggable]") as HTMLElement | undefined
  card?.click()
}
setTimeout(seek, 800)
