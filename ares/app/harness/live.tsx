// A visual harness for the Live tab: the real page, with nt_read returning
// what AresLib publishes while a robot drives the Main fixture trajectory a
// little late and a little wide. Not part of the app.

import robot from "./fixtures/bot.robot.json"
import main from "./fixtures/Main.traj.json"

type S = { t: number; x: number; y: number; heading: number; vx: number; vy: number; omega: number }
const samples = main.samples as S[]
const at = (t: number): S => {
  const c = Math.min(Math.max(t, 0), main.durationS)
  return samples.reduce((a, b) => (Math.abs(b.t - c) < Math.abs(a.t - c) ? b : a))
}
const raw = (...poses: { x: number; y: number; heading: number }[]) => {
  const buf = new ArrayBuffer(24 * poses.length)
  const v = new DataView(buf)
  poses.forEach((p, i) => { v.setFloat64(24 * i, p.x, true); v.setFloat64(24 * i + 8, p.y, true); v.setFloat64(24 * i + 16, p.heading, true) })
  return { Raw: [...new Uint8Array(buf)] }
}
const start = performance.now()
let connected = false
const values = () => {
  // Loops: the path, then a second at rest.
  const t = ((performance.now() - start) / 1000) % (main.durationS + 1)
  const target = at(t), lag = at(t - 0.07)
  const wide = 0.06 * Math.sin(t * 3)
  const r = { x: lag.x + wide * -Math.sin(lag.heading + 1), y: lag.y + wide * Math.cos(lag.heading + 1), heading: lag.heading - 0.03 }
  const running = t <= main.durationS
  return {
    "/Ares/Active": { String: running ? "Main" : "" },
    "/Ares/Path": running ? raw(...samples) : raw(),
    "/Ares/Target": raw(target),
    "/Ares/Robot": raw(r),
    "/Ares/ErrorM": { Number: Math.hypot(target.x - r.x, target.y - r.y) },
    "/Ares/TimeS": { Number: Math.min(t, main.durationS) },
    "/Ares/Events": { StringArray: t > 0.7 && t < 0.9 ? ["intake"] : t > 0.1 && t < 0.6 ? ["spin"] : [] },
    "/Ares/Replans": { Number: 0 },
    "/Ares/CommandedSpeeds": { NumberArray: running ? [target.vx * 1.02, target.vy * 1.02, target.omega] : [0, 0, 0] },
    "/Ares/MeasuredSpeeds": { NumberArray: running ? [lag.vx, lag.vy, lag.omega * 0.95] : [0, 0, 0] },
    "/Ares/Gains/Source": { String: "gains.json (Tune, 17/10/2026)" },
    "/Ares/Gains/Translation": { NumberArray: [3.69, 0, 0.025] },
    "/Ares/Gains/Rotation": { NumberArray: [2.4, 0, 0.082] },
  }
}
const commands: Record<string, () => unknown> = {
  nt_status: () => ({ connected, address: connected ? "10.34.72.2:5810" : "" }),
  nt_connect: () => { connected = true; return "10.34.72.2:5810" },
  nt_disconnect: () => { connected = false; return null },
  nt_read: () => (connected ? values() : {}),
}
;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    const f = commands[cmd]
    if (!f) throw new Error(`harness: no mock for ${cmd}`)
    return f()
  },
  transformCallback: () => 0,
}
const React = await import("react")
const ReactDOM = await import("react-dom/client")
await import("@tabler/icons-webfont/dist/tabler-icons.min.css")
await import("@desktop/styles/global.css")
const { default: LivePage } = await import("../src/live/LivePage")
const { ToastProvider } = await import("../src/ui/toasts")
ReactDOM.createRoot(document.getElementById("root")!).render(
  React.createElement(ToastProvider, null, React.createElement(LivePage, { robot: robot as never })),
)
const press = () => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent?.trim() === "Connect")
  if (b) b.click()
  else setTimeout(press, 100)
}
setTimeout(press, 300)
