import { MARS_ENABLED } from "@mars"

// Control of the loading screen that lives in index.html.
//
// The HTML paints the splash (see index.html's <style>) because it has to be
// on screen BEFORE the bundle finishes evaluating. From React all that is left
// is telling it which step it is on, how far along it is, and removing it at
// the end.
//
// The previous version was an indeterminate bar and a line of text: it said
// "it is doing something", which is exactly what there is no need to know. This
// one lists the REAL startup steps, checks each one off when it finishes and
// moves the bar with them, so when something takes long or fails it shows
// exactly what.

const SPLASH_ID = "mars-splash"
const FADE_MS = 300
/** How long 100% is held before fading, so it can be seen. */
const HOLD_MS = 240
/** If any step failed, the splash stays a moment longer so it can be read. */
const LINGER_MS = 1800

const $ = (id: string) => document.getElementById(id)

const ALL_STEPS = [
  ["prefs", "Read preferences"],
  ["project", "Locate the MARS project"],
  ["assets", "Scan 3D asset packs"],
  ["layout", "Restore the workspace"],
  ["link", "Check the NetworkTables link"],
  ["ui", "Build the interface"],
] as const

export type SplashStepKey = (typeof ALL_STEPS)[number][0]

/**
 * The steps, in the real order they happen. SplashProgress uses the key.
 *
 * The Tools edition has no project to locate, so that step is not listed:
 * leaving it in would always show grey and the percentage would jump for a step
 * that does not exist.
 */
export const SPLASH_STEPS: readonly (readonly [SplashStepKey, string])[] =
  MARS_ENABLED ? ALL_STEPS : ALL_STEPS.filter(([k]) => k !== "project")

type Row = { li: HTMLLIElement; mark: HTMLSpanElement; note: HTMLElement }

// StrictMode mounts the startup effect twice in development. The second
// instance repaints the list from scratch, and without this the first one would
// keep writing the percentage over the same bar: two sequences fighting.
let active: SplashProgress | null = null

export class SplashProgress {
  private done = 0
  private rows = new Map<string, Row>()
  /** A step in red changes how the splash closes (it stays longer). */
  private broke = false

  constructor() {
    active = this

    const list = $("mars-splash-steps")
    if (!list) return
    list.replaceChildren()

    for (const [key, label] of SPLASH_STEPS) {
      const mark = document.createElement("span")
      mark.className = "mark"
      mark.textContent = "·"
      const text = document.createElement("span")
      text.textContent = label
      const note = document.createElement("em")

      const li = document.createElement("li")
      li.dataset.state = "pending"
      li.append(mark, text, note)
      list.appendChild(li)
      this.rows.set(key, { li, mark, note })
    }
  }

  /** Marks the step as in progress and puts it in the status line. */
  start(key: SplashStepKey) {
    if (active !== this) return
    const row = this.rows.get(key)
    if (row) {
      row.li.dataset.state = "running"
      row.mark.textContent = "›"
    }
    const line = $("mars-splash-step")
    if (line) line.textContent = `${labelOf(key)}…`
  }

  /** Closes it in green. `detail` is the short summary of what it found. */
  finish(key: SplashStepKey, detail?: string) {
    this.close(key, "ok", "✓", detail)
  }

  /**
   * Closes it in grey: the step did not apply (no project configured, for
   * example). It counts towards the percentage anyway, because there is
   * nothing left to wait for from it.
   */
  skip(key: SplashStepKey, detail?: string) {
    this.close(key, "skip", "–", detail)
  }

  /**
   * Closes it in red and leaves the error in sight.
   *
   * Unlike the Simulation Studio, here no step is essential: the app opens
   * anyway without preferences, without a project and without a saved
   * layout. That is why a failure does not stop the startup, it only stays
   * written.
   */
  fail(key: SplashStepKey, error: unknown) {
    this.broke = true
    this.close(key, "fail", "✕", undefined)
    if (active !== this) return

    const box = $("mars-splash-error")
    if (box) {
      const msg = error instanceof Error ? error.message : String(error)
      box.textContent = box.textContent ? `${box.textContent}\n${labelOf(key)}: ${msg}` : `${labelOf(key)}: ${msg}`
      box.style.display = "block"
    }
  }

  /**
   * Runs a step: marks it, waits, and closes it in green or red.
   * Returns what `fn` returned, or `null` if it failed.
   */
  async run<T>(key: SplashStepKey, fn: () => Promise<T>, summary?: (result: T) => string): Promise<T | null> {
    this.start(key)
    try {
      const result = await fn()
      this.finish(key, summary?.(result))
      return result
    } catch (e) {
      console.warn(`[splash] ${key}:`, e)
      this.fail(key, e)
      return null
    }
  }

  /** Closes the last step and fades the splash. */
  end() {
    this.finish("ui")
    hideSplash(this.broke ? LINGER_MS : HOLD_MS)
  }

  private close(key: SplashStepKey, state: string, mark: string, detail?: string) {
    if (active !== this) return
    const row = this.rows.get(key)
    if (row) {
      row.li.dataset.state = state
      row.mark.textContent = mark
      if (detail) row.note.textContent = detail
    }

    this.done += 1
    const pct = Math.round((this.done / SPLASH_STEPS.length) * 100)
    const fill = $("mars-splash-fill")
    if (fill) fill.style.width = `${pct}%`
    const label = $("mars-splash-pct")
    if (label) label.textContent = `${pct}%`
  }
}

function labelOf(key: SplashStepKey): string {
  return SPLASH_STEPS.find(s => s[0] === key)?.[1] ?? key
}

/**
 * Fades the splash out and removes it from the DOM.
 *
 * It is called when the workspace finished restoring, not when React mounted:
 * otherwise an empty app frame would show before the saved tabs appear, which
 * is worse than a slightly longer splash.
 */
export function hideSplash(delayMs = 0) {
  window.setTimeout(() => {
    const splash = $(SPLASH_ID)
    if (!splash) return
    splash.classList.add("mars-splash-out")
    window.setTimeout(() => splash.remove(), FADE_MS)
  }, delayMs)
}
