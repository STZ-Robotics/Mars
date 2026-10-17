// A visual harness for the Measure (characterize) tab: the real page, with
// Tauri's backend replaced. nt_read returns what AresLib's routines publish
// on a robot whose drive has kS 0.13 V and kV 0.1156 V/rps, steer kS 0.29 V
// and kV 2.483, and worn 49.5 mm wheels: the drive done, the steer halfway,
// the wheel radius done. Not part of the app.

import robot from "./fixtures/bot.robot.json"

const drivePts = [1, 1.5, 2, 3, 4, 5, 6].flatMap(v => [v, -v]).sort((a, b) => (a > 0 === b > 0 ? Math.abs(a) - Math.abs(b) : a > 0 ? -1 : 1))
const driveSpeed = drivePts.map(v => (Math.abs(v) - 0.13) / 0.1156 * (1 + 0.004 * Math.sin(v * 7)))
const steerPts = [0.3, 0.5, 0.75, 1.0, 1.5, 2.0].slice(0, 5)
const steerSpeed = steerPts.map(v => Math.max(0, v - 0.29) / 2.483 * (1 + 0.006 * Math.cos(v * 5)))
const values: Record<string, unknown> = {
  "/Ares/Characterize/Drive/State": { String: "done" },
  "/Ares/Characterize/Drive/Progress": { Number: 1 },
  "/Ares/Characterize/Drive/Volts": { NumberArray: drivePts },
  "/Ares/Characterize/Drive/Speed": { NumberArray: driveSpeed },
  "/Ares/Characterize/Drive/kS": { Number: 0.1302 },
  "/Ares/Characterize/Drive/kV": { Number: 0.11557 },
  "/Ares/Characterize/Drive/R2": { Number: 0.99993 },
  "/Ares/Characterize/Drive/kVTheory": { Number: 0.12397 },
  "/Ares/Characterize/Drive/WheelRadiusM": { Number: 0.04953 },
  "/Ares/Characterize/Steer/State": { String: "running" },
  "/Ares/Characterize/Steer/Progress": { Number: 5 / 12 },
  "/Ares/Characterize/Steer/Volts": { NumberArray: steerPts },
  "/Ares/Characterize/Steer/Speed": { NumberArray: steerSpeed },
  "/Ares/Characterize/WheelRadius/State": { String: "done" },
  "/Ares/Characterize/WheelRadius/Progress": { Number: 1 },
  "/Ares/Characterize/WheelRadius/WheelRadiusM": { Number: 0.049482 },
}
let connected = false
const commands: Record<string, (a: Record<string, unknown>) => unknown> = {
  nt_status: () => ({ connected, address: connected ? "10.34.72.2:5810" : "" }),
  nt_connect: () => { connected = true; return "10.34.72.2:5810" },
  nt_disconnect: () => { connected = false; return null },
  nt_read: () => (connected ? values : {}),
  nt_set_boolean: () => null,
  robot_tuning: () => ({ file: "TunerConstants.java", driveKp: 0.2, driveKs: 0.1295, driveKv: 0.1156, speedAt12vMps: 5.85, slipCurrentA: 70, driveFrictionV: 0.2, translation: [5, 0, 0], rotation: [5, 0, 0], steerKp: 55, steerKs: 0.29, steerKv: 2.483, wheelRadiusM: 0.0508 }),
  characterization_open: () => null,
  characterization_save: () => null,
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
const { default: CharacterizePage } = await import("../src/characterize/CharacterizePage")
const { ToastProvider } = await import("../src/ui/toasts")
ReactDOM.createRoot(document.getElementById("root")!).render(
  React.createElement(ToastProvider, null, React.createElement(CharacterizePage, { robot: robot as never, robotPath: "/robot/bot.robot.json", onRobot: () => {} })),
)
const press = () => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent?.trim() === "Connect")
  if (b) b.click()
  else setTimeout(press, 100)
}
setTimeout(press, 300)
