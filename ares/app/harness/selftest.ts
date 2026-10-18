// The real app driving itself through its flows (harness/selftest.sh), on a
// scratch project, and records every JS error, every failing backend
// command and every step, into <robot project>/selftest/log.java.

const log: string[] = []
const t0 = performance.now()
const stamp = () => ((performance.now() - t0) / 1000).toFixed(1).padStart(6)
const note = (s: string) => log.push(`${stamp()} ${s}`)
const robotPath = import.meta.env.VITE_ARES_SELFTEST_ROBOT as string
let step = "start"

type Internals = { invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown> }
const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__
const realInvoke = internals.invoke.bind(internals)
const watched = async (cmd: string, args?: unknown, opts?: unknown) => {
  if (cmd.startsWith("plugin:dialog|")) { note(`  [dialog stubbed: ${cmd}]`); return null }
  try {
    return await realInvoke(cmd, args, opts)
  } catch (e) {
    note(`  !! INVOKE ${cmd} failed (${step}): ${String(e).slice(0, 300)}`)
    throw e
  }
}
// Tauri may not let its internals be replaced: then dialogs are avoided instead.
let intercepting = false
try {
  Object.defineProperty(internals, "invoke", { value: watched, configurable: true, writable: true })
  intercepting = internals.invoke === watched
} catch { /* locked */ }
window.addEventListener("error", e => note(`  !! JS ERROR (${step}): ${e.message} ${(e.error?.stack ?? "").split("\n").slice(0, 5).join(" | ")}`))
window.addEventListener("unhandledrejection", e => note(`  !! REJECTION (${step}): ${String(e.reason?.stack ?? e.reason).split("\n").slice(0, 4).join(" | ")}`))
const ce = console.error
console.error = (...a: unknown[]) => {
  note(`  !! console.error (${step}): ${a.map(x => (x instanceof Error ? `${x.message} ${x.stack?.split("\n").slice(0, 4).join(" | ")}` : String(x))).join(" ").slice(0, 700)}`)
  ce(...a)
}
window.confirm = () => true
window.alert = () => {}
// Native pop-ups would wait for whoever is at the computer: answer them here.
window.prompt = (msg?: string) => { note(`  [prompt answered: ${msg}]`); return "Fast" }
// Synthetic pointer events have no live pointer to capture.
const spc = Element.prototype.setPointerCapture
Element.prototype.setPointerCapture = function (id: number) { try { spc.call(this, id) } catch { /* synthetic */ } }
const rpc = Element.prototype.releasePointerCapture
Element.prototype.releasePointerCapture = function (id: number) { try { rpc.call(this, id) } catch { /* synthetic */ } }

const flush = () => realInvoke("vars_java_write", { robotPath, folder: null, file: "selftest/log.java", code: log.join("\n") + "\n" }).catch(() => {})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
function buttons(): HTMLButtonElement[] { return [...document.querySelectorAll("button")].filter(visible) as HTMLButtonElement[] }
function btn(m: string | RegExp): HTMLButtonElement {
  const ok = (s: string) => (typeof m === "string" ? s === m : m.test(s))
  const b = buttons().find(x => ok(x.title) || ok((x.textContent ?? "").trim()))
  if (!b) throw new Error(`no button ${m}`)
  return b
}
function byText(text: string | RegExp, sel = "*"): HTMLElement {
  const ok = (s: string) => (typeof text === "string" ? s === text || s.startsWith(text + " ") || s.startsWith(text + "·") : text.test(s))
  const all = [...document.querySelectorAll(sel)].filter(e => visible(e) && ok((e.textContent ?? "").trim())) as HTMLElement[]
  // The innermost.
  const el = all.find(e => !all.some(o => o !== e && e.contains(o)))
  if (!el) throw new Error(`nothing reads ${text}`)
  return el
}
async function click(el: HTMLElement, opts: MouseEventInit = {}) {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ...opts }))
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, ...opts }))
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...opts }))
  await sleep(300)
}
async function dbl(el: HTMLElement) { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await sleep(300) }
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
async function type(input: HTMLInputElement, value: string) {
  input.focus()
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await sleep(80)
  input.blur()
  await sleep(300)
}
async function key(k: string, opts: KeyboardEventInit = {}) {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }))
  await sleep(300)
}
function field(): HTMLCanvasElement {
  const cs = [...document.querySelectorAll("canvas")].filter(visible) as HTMLCanvasElement[]
  return cs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
}
async function canvasAt(fx: number, fy: number, kind: "click" | "move" = "click") {
  const c = field(), r = c.getBoundingClientRect()
  const o = { bubbles: true, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height, pointerId: 1, button: 0, buttons: 1, isPrimary: true }
  c.dispatchEvent(new PointerEvent("pointermove", { ...o, buttons: 0 }))
  if (kind === "click") {
    c.dispatchEvent(new PointerEvent("pointerdown", o))
    c.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }))
  }
  await sleep(250)
}
async function dragTo(src: HTMLElement, dst: HTMLElement) {
  const dt = new DataTransfer()
  src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }))
  await sleep(100)
  dst.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }))
  dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
  dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }))
  src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }))
  await sleep(400)
}
async function waitFor(pred: () => boolean, ms: number, what: string) {
  const end = performance.now() + ms
  while (performance.now() < end) { if (pred()) return; await sleep(200) }
  throw new Error(`timed out waiting for ${what}`)
}
const bodyText = () => document.body.innerText
const tab = async (name: string) => { await click(btn(name)); await sleep(700) }
const inputWith = (v: string) => ([...document.querySelectorAll("input")].filter(visible) as HTMLInputElement[]).find(i => i.value === v)

async function run(name: string, f: () => Promise<void>) {
  step = name
  try {
    await f()
    note(`ok   ${name}`)
  } catch (e) {
    note(`FAIL ${name}: ${String(e).slice(0, 300)}`)
  }
  if (/The \w+ tab hit an error/.test(bodyText())) {
    note(`  !! ERROR BOUNDARY showing after ${name}`)
    try { await click(btn(/Try again/)) } catch { /* none */ }
  }
  await flush()
}

async function main() {
  note(`robot ${robotPath} · intercepting invoke: ${intercepting}`)
  await flush()
  await sleep(3500)

  // --- Paths -------------------------------------------------------------------
  await run("paths: open tab", () => tab("Paths"))
  await run("paths: new path", async () => { await click(btn("New path")); await sleep(500) })
  await run("paths: pose tool, three waypoints", async () => {
    await click(btn(/^Pose/))
    await canvasAt(0.22, 0.6); await canvasAt(0.45, 0.35); await canvasAt(0.7, 0.62)
    await click(btn(/^Select/))
  })
  await run("paths: rename", async () => {
    const i = inputWith("New path") ?? inputWith("New path 2")
    if (!i) throw new Error("no name input")
    await type(i, "Test A")
  })
  await run("paths: generate", async () => {
    await key("g", { ctrlKey: true })
    await waitFor(() => /Generated "Test A"|Could not generate/.test(bodyText()), 60000, "the generation")
    if (/Could not generate/.test(bodyText())) throw new Error("generation failed: " + bodyText().match(/Could not generate[^\n]*\n[^\n]*/)?.[0])
  })
  await run("paths: event marker with a built command", async () => {
    await click(btn(/^Event/))
    await canvasAt(0.45, 0.35)
    await click(btn(/^Select/))
    await click(btn("Build a command"))
    await click(btn(/Add/))
    await click(byText("Wait"))
  })
  await run("paths: point-at constraint", async () => {
    await click(btn(/^Constraint/))
    await click(byText(/^Point At/))
    // From one waypoint to another.
    await canvasAt(0.45, 0.35); await canvasAt(0.7, 0.62)
    await click(btn(/^Select/))
  })
  await run("paths: variant (the in-app box)", async () => {
    await click(btn("+ Variant")); await sleep(400)
    const box = document.activeElement as HTMLInputElement
    if (!box || box.tagName !== "INPUT") throw new Error("no name box focused")
    setter.call(box, "Fast"); box.dispatchEvent(new Event("input", { bubbles: true })); await sleep(100)
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(500)
  })
  await run("paths: undo, redo", async () => { await key("z", { ctrlKey: true }); await key("z", { ctrlKey: true, shiftKey: true }) })
  await run("paths: duplicate, rename, delete", async () => {
    await click(btn("Duplicate path")); await sleep(600)
    const i = inputWith("Test A copy") ?? ([...document.querySelectorAll("input")].filter(visible) as HTMLInputElement[]).find(x => /copy/.test(x.value))
    if (i) await type(i, "Test B")
    await sleep(600)
    await click(btn("Delete path")); await sleep(800)
  })
  await run("paths: folder, rename it, drag a path in", async () => {
    await click(btn(/New folder/)); await sleep(500)
    await dbl(byText("New folder"))
    const i = inputWith("New folder")
    if (i) await type(i, "Amp")
    await dragTo(byText("Test A"), byText("Amp"))
  })
  await run("paths: mirror menu", async () => {
    await click(btn(/^Mirror/))
    const items = [...document.querySelectorAll("div, button")].filter(e => visible(e) && /mirror|flip/i.test(e.textContent ?? "") && (e.textContent ?? "").length < 60) as HTMLElement[]
    if (items.length > 1) await click(items[items.length - 1])
    await key("Escape")
  })
  await run("paths: new path from scratch and delete it unsaved", async () => {
    await click(btn("New path")); await sleep(400)
    await click(btn("Delete path")); await sleep(600)
  })

  // --- Autos -------------------------------------------------------------------
  await run("autos: open tab", () => tab("Autos"))
  await run("autos: new auto", async () => { await click(btn("New auto")); await sleep(700) })
  await run("autos: add path, command, wait, deadline", async () => {
    for (const what of ["Follow Path", "Named Command", "Wait", "Deadline Group"]) {
      // The menu may take a moment in the real app (a save just re-rendered it): open it until it shows.
      for (let k = 0; k < 4 && !document.querySelector(".ares-pop"); k++) { await click(btn(/^\+?\s*Add$/)); await sleep(300) }
      await waitFor(() => { try { return !!byText(what) } catch { return false } }, 3000, `"${what}" in the menu`)
      await click(byText(what))
      note(`  [added ${what}]`)
    }
  })
  await run("autos: add a path by clicking its chip", async () => { await click(byText(/^Test A\d/, "span")) })
  await run("autos: pick a card, copy, paste, delete", async () => {
    const card = [...document.querySelectorAll("div[draggable]")].filter(visible)[0] as HTMLElement
    await click(card)
    await key("c", { ctrlKey: true }); await key("v", { ctrlKey: true }); await key("Delete")
  })
  await run("autos: rename by double-click", async () => {
    await dbl(byText("New auto"))
    const i = inputWith("New auto")
    if (i) await type(i, "Auto X")
  })
  await run("autos: reset odometry setting", async () => {
    const s = ([...document.querySelectorAll("select")].filter(visible) as HTMLSelectElement[]).find(x => [...x.options].some(o => o.value === "no"))
    if (!s) throw new Error("no reset select")
    s.value = "no"; s.dispatchEvent(new Event("change", { bubbles: true })); await sleep(400)
  })
  await run("autos: play the timeline", async () => { await click(btn("Play the auto (this preview's conditions)")); await sleep(1500) })
  await run("autos: generate paths", async () => {
    await click(btn(/Generate/)); await sleep(3000)
  })
  await run("autos: mirror", async () => { await click(btn(/^Mirror/)); await sleep(1500) })
  await run("autos: folder and drag", async () => {
    await click(btn(/New folder/)); await sleep(500)
    await dragTo(byText("Auto X"), byText("New folder"))
  })
  await run("autos: duplicate and delete", async () => {
    await click(btn("Duplicate auto")); await sleep(700)
    await click(btn("Delete auto")); await sleep(700)
  })

  // --- Variables, Field, Robot, Tune, others -----------------------------------
  await run("variables: add number and pose, rename, delete", async () => {
    await tab("Variables")
    await click(btn("+ Number")); await click(btn("+ Pose"))
    const i = inputWith("value")
    if (i) await type(i, "reach")
    await click(btn("Delete"))
  })
  await run("field: create, paint, from keep-outs, delete navgrid", async () => {
    await tab("Field")
    try { await click(btn(/Create a navgrid/)) } catch { /* it has one */ }
    await canvasAt(0.5, 0.5); await canvasAt(0.52, 0.5)
    try { await click(btn("From keep-outs")) } catch { /* none */ }
    const box = ([...document.querySelectorAll("input[type=checkbox]")].filter(visible) as HTMLInputElement[])[0]
    if (box) await click(box)
  })
  await run("robot: edit a number and save", async () => {
    await tab("Robot")
    const n = ([...document.querySelectorAll("input")].filter(visible) as HTMLInputElement[]).find(i => /^\d+(\.\d+)?$/.test(i.value))
    if (n) await type(n, String(Number(n.value) + 1))
    await key("s", { ctrlKey: true })
  })
  await run("tune: pick a path, start, stop", async () => {
    await tab("Tune")
    // The path's own box: the one beside "Test A".
    const box = ([...document.querySelectorAll("input[type=checkbox]")].filter(visible) as HTMLInputElement[])
      .find(b => /Test A/.test(b.closest("div,label")?.textContent ?? ""))
    if (!box) throw new Error("no box for Test A")
    if (!box.checked) await click(box)
    // The run button, not the rail's Tune.
    const run = buttons().find(b => (b.textContent ?? "").trim() === "Tune" && b.title !== "Tune")
    if (!run) throw new Error("no Tune button")
    await click(run); await sleep(4000)
    await click(btn(/^Stop$/))
  })
  for (const t of ["Live", "Logs", "Measure"]) await run(`${t.toLowerCase()}: open, connect to nothing`, async () => {
    await tab(t)
    try { await click(btn("Connect")); await sleep(1500) } catch { /* no connect here */ }
  })
  await run("settings: toggles and the Java constants", async () => {
    await tab("Settings")
    for (const s of [...document.querySelectorAll("button[role=switch]")].filter(visible) as HTMLElement[]) { await click(s); await click(s) }
    const javaSwitch = [...document.querySelectorAll("button[role=switch]")].filter(visible)[3] as HTMLElement | undefined
    if (javaSwitch) await click(javaSwitch)
    await sleep(1000)
  })

  // --- Monkey: random buttons and field clicks on every tab --------------------
  if (import.meta.env.VITE_ARES_SELFTEST_FLOWS === "1") { note("DONE"); await flush(); return }
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  for (const t of ["Robot", "Paths", "Autos", "Live", "Logs", "Tune", "Measure", "Field", "Variables", "Settings"]) {
    await run(`monkey: ${t}`, async () => {
      await tab(t)
      for (let k = 0; k < 35; k++) {
        const bs = buttons().filter(b => !b.disabled && !["File"].includes((b.textContent ?? "").trim())
          && (intercepting || !/open|import|export|pick|…/i.test(`${b.title} ${b.textContent}`)))
        const b = bs[Math.floor(rnd() * bs.length)]
        if (!b) break
        step = `monkey: ${t} → "${(b.title || b.textContent || "").trim().slice(0, 40)}"`
        await click(b)
        if (rnd() < 0.3 && field()) await canvasAt(0.15 + 0.7 * rnd(), 0.15 + 0.7 * rnd())
        if (rnd() < 0.2) await key("Escape")
        // Back to this tab if a button took us elsewhere.
        if (!buttons().some(x => x.title === t)) break
      }
    })
  }
  note("DONE")
  await flush()
}

main().catch(e => { note(`!! SELFTEST CRASHED: ${e?.stack ?? e}`); flush() })
