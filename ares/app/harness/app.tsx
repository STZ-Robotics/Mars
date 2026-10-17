// A visual harness for the whole app (menu bar, rail, a page): every command
// answers as an empty project would, the robot is the fixture. ?page= picks
// the page. Not part of the app.

import robot from "./fixtures/bot.robot.json"

const page = new URLSearchParams(location.search).get("page")
try { if (page) localStorage.setItem("ares.lastPage", page) } catch { /* none */ }
const answers: Record<string, unknown> = {
  startup_robot: "/x/bot.robot.json",
  robot_open: robot,
  motors: [],
  autos_list: [],
  paths_list: [],
  paths_status: [],
  variables_open: { variables: [] },
  folders_open: { paths: [], autos: [] },
  field_open: { keepOut: [], zones: [] },
  robot_names: { root: null, commands: [], conditions: [], events: [], files: 0 },
  nt_status: { connected: false, address: "" },
  tune_runs: [],
  app_info: { version: "0.1.0", areslib: "0.1.0" },
  "plugin:event|listen": 1,
}
;(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd in answers ? answers[cmd] : null),
  transformCallback: () => 0,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
}
const React = await import("react")
const ReactDOM = await import("react-dom/client")
await import("@tabler/icons-webfont/dist/tabler-icons.min.css")
await import("@desktop/styles/global.css")
if (!new URLSearchParams(location.search).has("nocss")) await import("../src/styles/ares.css")
const { default: App } = await import("../src/App")
ReactDOM.createRoot(document.getElementById("root")!).render(React.createElement(App))
if (new URLSearchParams(location.search).get("menu")) {
  const open = () => {
    const b = [...document.querySelectorAll("button")].find(x => x.textContent === "File")
    if (b) b.click(); else setTimeout(open, 100)
  }
  setTimeout(open, 600)
}
