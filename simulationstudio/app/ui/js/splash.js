// The loading screen.
//
// The previous version was an indeterminate bar and a line of text: it said
// "doing something", which is exactly what you do not need to know. This one
// lists the REAL startup steps, marks each one when it finishes and moves the
// bar with them, so when something is slow or fails you can see exactly what.
//
// The steps are not decorative: each one is a backend call, and the one that
// fails stays marked red with its error below. Before, any failure gave the
// same generic message for all five.

const $ = (id) => document.getElementById(id);

/** The steps, in the order they happen. `Progress` uses the key. */
export const STEPS = [
  ["bridge", "Connect to the application process"],
  ["options", "Locate sim/ and the conda environment"],
  ["prefs", "Read preferences"],
  ["worlds", "Scan worlds"],
  ["robots", "Scan robot maps"],
  ["fields", "Scan field models"],
  ["checks", "Check the installation"],
  ["ui", "Build the interface"],
];

export class Progress {
  constructor() {
    this.done = 0;
    this.rows = new Map();

    const list = $("splash-steps");
    if (!list) return;
    list.replaceChildren();
    for (const [key, label] of STEPS) {
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = "·";
      const text = document.createElement("span");
      text.textContent = label;
      const note = document.createElement("em");

      const li = document.createElement("li");
      li.dataset.state = "pending";
      li.append(mark, text, note);
      list.appendChild(li);
      this.rows.set(key, { li, mark, note });
    }
  }

  /** Marks the step as in progress and puts it on the status line. */
  begin(key) {
    const r = this.rows.get(key);
    const label = STEPS.find((p) => p[0] === key)?.[1] ?? key;
    if (r) {
      r.li.dataset.state = "running";
      r.mark.textContent = "›";
    }
    const step = $("splash-step");
    if (step) step.textContent = `${label}…`;
  }

  /** Closes it green. `detail` is the short summary of what it found. */
  finish(key, detail) {
    const r = this.rows.get(key);
    if (r) {
      r.li.dataset.state = "ok";
      r.mark.textContent = "✓";
      if (detail) r.note.textContent = detail;
    }
    this.done += 1;
    const pct = Math.round((this.done / STEPS.length) * 100);
    const bar = $("splash-fill");
    if (bar) bar.style.width = `${pct}%`;
    const label = $("splash-pct");
    if (label) label.textContent = `${pct}%`;
  }

  /**
   * Closes it red and leaves the error in sight.
   *
   * It neither closes the window nor continues: if step 2 fails, the next
   * ones cannot work, and pretending otherwise only produces a second error
   * more confusing than the first.
   */
  fail(key, error) {
    const r = this.rows.get(key);
    if (r) {
      r.li.dataset.state = "fail";
      r.mark.textContent = "✕";
    }
    const step = $("splash-step");
    if (step) step.textContent = "Startup failed";
    const bar = $("splash-fill");
    if (bar) bar.style.background = "var(--status-error)";

    const box = $("splash-error");
    if (box) {
      box.textContent = error?.message ?? String(error);
      box.style.display = "block";
    }
  }

  /**
   * Runs a step: marks it, awaits, and closes it green or red.
   * Returns what `fn` returned; re-throws if it failed.
   */
  async run(key, fn, summary) {
    this.begin(key);
    try {
      const r = await fn();
      this.finish(key, summary ? summary(r) : undefined);
      return r;
    } catch (e) {
      this.fail(key, e);
      throw e;
    }
  }
}

/** Fades the loading screen out and removes it from the DOM. */
export function closeSplash() {
  const s = $("splash");
  if (!s) return;
  s.classList.add("out");
  setTimeout(() => s.remove(), 300);
}
