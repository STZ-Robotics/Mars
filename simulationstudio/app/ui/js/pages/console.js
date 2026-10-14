// Console: the three logs, full size.
//
// The old app had two log panels cut to 40 lines. Here there are three (the
// world window's was missing, and it is where the OGRE failure that leaves
// the scene grey shows up), with a filter, a control for how many lines are
// fetched and the option to freeze the view so it can be read.

import { el, fill, invoke, state } from "./../core.js";
import { report } from "./../shell.js";
import { button, checkbox, panel } from "./../ui.js";

const SOURCES = [
  ["engine", "Engine", "mars-sim-server — physics"],
  ["window", "World window", "mars-sim-gui — the 3D view"],
  ["bridge", "Bridge", "mars-bridge — gz-transport ⇄ NT4"],
];

export function consolePage() {
  const cfg = state.prefs.console ?? (state.prefs.console = { lines: 120, filter: "", frozen: false });

  const panes = {};
  const body = el("div.stack");

  const filterInput = el("input", {
    type: "text",
    value: cfg.filter,
    placeholder: "Filter lines (plain text, case-insensitive)",
    spellcheck: "false",
    oninput: (e) => {
      cfg.filter = e.target.value;
      redraw();
    },
  });

  const linesSelect = el(
    "select",
    {
      style: { width: "90px" },
      onchange: (e) => {
        cfg.lines = parseInt(e.target.value, 10);
      },
    },
    ...[60, 120, 250, 500].map((n) => el("option", { value: n, selected: cfg.lines === n }, `${n} lines`))
  );

  let last = { engine: "", window: "", bridge: "" };

  function redraw() {
    for (const [key] of SOURCES) write(panes[key], last[key] ?? "");
  }

  function write(pre, text) {
    const lines = text.split("\n");
    const f = cfg.filter.trim().toLowerCase();
    const shown = f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
    const clean = shown.join("\n").replace(/^\s+|\s+$/g, "");
    if (pre.textContent === clean) return;

    // Follow the tail only if the user was already at the bottom: if they are
    // reading further up, yanking the scroll is one of the most annoying
    // things a log panel can do.
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = clean || (f ? "(no lines match the filter)" : "(empty)");
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  fill(
    body,
    panel(
      "View",
      { svg: "console.svg", help: "console.logs" },
      el(
        "div.row",
        el("span", { style: { flex: "1" } }, filterInput),
        linesSelect,
        checkbox(cfg, "frozen", { label: "Freeze" }),
        button("Copy all", {
          svg: "copy-value.svg",
          sm: true,
          onclick: () => {
            const all = SOURCES.map(([k, n]) => `=== ${n} ===\n${last[k] ?? ""}`).join("\n\n");
            navigator.clipboard?.writeText(all).catch(report);
          },
        }),
        button("Reveal log folder", {
          svg: "open-folder.svg",
          sm: true,
          onclick: () => invoke("sim_reveal", { path: "build" }).catch(report),
        })
      )
    ),
    ...SOURCES.map(([key, title, sub]) => {
      const pre = el("pre.log", { style: { height: "220px" } }, "(empty)");
      panes[key] = pre;
      return panel(title, { svg: "console.svg", actions: el("span.mono.dim", sub) }, pre);
    })
  );

  const tick = async () => {
    if (cfg.frozen) return;
    try {
      const l = await invoke("sim_logs", { lines: cfg.lines });
      last = l;
      redraw();
    } catch (e) {
      // A failure reading logs must not wallpaper the page every 700 ms.
      console.warn(e);
    }
  };

  return {
    title: "Console",
    meta: "Engine, world window and bridge output",
    help: "console.logs",
    body,
    tick,
  };
}
