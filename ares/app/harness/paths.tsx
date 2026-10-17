// A visual harness for the Paths tab: the real page on the fixture paths,
// with the "load" event marker picked (it carries its own command) and robot
// code names. Not part of the app.

import robot from "./fixtures/bot.robot.json"
import mainPath from "./fixtures/Main.path.json"
import altPath from "./fixtures/Alt.path.json"
import findPath from "./fixtures/Find.path.json"
import main from "./fixtures/Main.traj.json"
import alt from "./fixtures/Alt.traj.json"
import find from "./fixtures/Find.traj.json"

const specs = [mainPath, altPath, findPath] as { name: string }[]
const trajs: Record<string, unknown> = { Main: main, Alt: alt, Find: find }
const commands: Record<string, (a: Record<string, unknown>) => unknown> = {
  paths_list: () => specs.map(s => ({ name: s.name, spec: s })),
  field_open: () => ({ keepOut: [], zones: [] }),
  paths_status: () => specs.map(s => ({ name: s.name, generated: true, outdated: false })),
  trajectory_open: a => trajs[a.name as string] ?? null,
  robot_names: () => ({ root: "/home/team/robot", commands: ["intake", "shoot", "feed", "kick"], conditions: ["hasNote"], events: ["spin"], files: 14 }),
  variables_open: () => ({ variables: [] }),
  folders_open: () => ({ paths: ["Amp side", "Source side"], autos: ["Qualifiers", "Playoffs"] }),
  folders_save: () => null,
  resolve_model_path: () => null,
  path_time: () => null,
  path_save: () => null,
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
await import("../src/styles/ares.css")
const { default: PathsPage } = await import("../src/paths/PathsPage")
const { ToastProvider } = await import("../src/ui/toasts")
const { VariablesProvider } = await import("../src/vars/context")
ReactDOM.createRoot(document.getElementById("root")!).render(
  React.createElement(ToastProvider, null, React.createElement(VariablesProvider as never, { robotPath: "/x/bot.robot.json" } as never,
    React.createElement(PathsPage as never, { robot, robotPath: "/x/bot.robot.json", onSaveRobot: () => {} }))),
)
const pick = () => {
  const q = new URLSearchParams(location.search)
  const name = q.get("marker") ?? "load"
  const want = q.get("constraint") ?? name
  const rows = [...document.querySelectorAll("div")].filter(d => d.children.length > 1 && d.textContent?.trim().startsWith(want) && d.textContent!.length < 60 && d.querySelector(".ti-trash"))
  const row = rows[rows.length - 1]
  if (!row) return setTimeout(pick, 150)
  row.click()
}
setTimeout(pick, 900)
