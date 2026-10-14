// The window's frame: menu bar, sidebar, page header and status bar. It is
// the equivalent of mars-desktop's App.tsx + MenuBar + Sidebar + StatusBar,
// with the same split of responsibilities.

import { MSS_VERSION } from "./constants.js";
import { el, fill, icon, invoke, reloadLibraries, savePrefs, state } from "./core.js";
import { closeHelp, openHelp } from "./help.js";
import { button, notice } from "./ui.js";

import { launchPage } from "./pages/launch.js";
import { consolePage } from "./pages/console.js";
import { diagnosticsPage } from "./pages/diagnostics.js";
import { worldsPage } from "./pages/worlds.js";
import { editorPage } from "./pages/editor.js";
import { fieldsPage } from "./pages/fields.js";
import { robotsPage } from "./pages/robots.js";
import { guidePage } from "./pages/guide.js";
import { protocolPage } from "./pages/protocol.js";
import { helpTopicsPage } from "./pages/helptopics.js";
import { aboutPage } from "./pages/about.js";
import { openWelcome } from "./welcome.js";
import { importWorld, newWorld } from "./pages/worlds.js";

// --- page registry ---------------------------------------------------------

// The order of this object IS the order of the sidebar. Groups are drawn in
// the order they first appear.
export const PAGES = {
  launch: { group: "Simulation", title: "Launch", svg: "play.svg", page: launchPage },
  console: { group: "Simulation", title: "Console", svg: "console.svg", page: consolePage },
  diagnostics: { group: "Simulation", title: "Diagnostics", svg: "watchdog.svg", page: diagnosticsPage },

  worlds: { group: "World", title: "World Library", svg: "scene.svg", page: worldsPage },
  editor: { group: "World", title: "World Editor", svg: "grid.svg", page: editorPage },
  fields: { group: "World", title: "Field Library", svg: "field3d.svg", page: fieldsPage },

  robots: { group: "Robot", title: "Robot Library", svg: "robot.svg", page: robotsPage },
  guide: { group: "Robot", title: "Import Guide", svg: "import-model.svg", page: guidePage },

  protocol: { group: "Reference", title: "Protocol", svg: "network.svg", page: protocolPage },
  help: { group: "Reference", title: "Help Topics", svg: "help.svg", page: helpTopicsPage },
  about: { group: "Reference", title: "About", svg: "samples.svg", page: aboutPage },
};

const GROUP_ICON = { Simulation: "play.svg", World: "scene.svg", Robot: "robot.svg", Reference: "packages.svg" };

// --- live nodes --------------------------------------------------------------

const nodes = {};

/** Redraws the current page. Called after any change on disk. */
export function refreshPage() {
  navigate(state.page, state.params, true);
}

/**
 * Changes page. `params` travels to the page's render (the editor uses it to
 * know which world to open).
 */
export function navigate(id, params = null, silent = false) {
  if (!PAGES[id]) return;
  closeHelp();
  state.page = id;
  state.params = params;
  if (!silent) savePrefs({ lastPage: id });

  drawSidebar();

  let view;
  try {
    view = PAGES[id].page(params);
  } catch (e) {
    console.error(e);
    view = { title: PAGES[id].title, body: notice(`This page failed to render: ${e.message}`) };
  }

  fill(
    nodes.header,
    el("span.title", view.title ?? PAGES[id].title),
    view.meta ? el("span.meta", view.meta) : null,
    el("span.actions", ...(view.actions ?? []), view.help ? bigHelpButton(view.help) : null)
  );
  fill(nodes.page, view.body);
  // Pages that show live data (process status, logs) return a `tick`. The
  // poll loop only calls the mounted page's: polling for a page that is no
  // longer visible is wasted work.
  state.tick = view.tick ?? null;
  nodes.page.scrollTop = 0;
  nodes.page.className = view.width === "narrow" ? "page page-narrow" : "page";
}

function bigHelpButton(id) {
  return button("Help", { svg: "help.svg", sm: true, onclick: (e) => openHelp(id, e.currentTarget ?? e.target) });
}

// --- menu bar ----------------------------------------------------------------

const MENUS = () => [
  [
    "File",
    [
      ["New world…", () => newWorld()],
      ["Import world…", () => importWorld()],
      ["separator"],
      ["Reveal sim folder", () => invoke("sim_reveal", { path: "worlds" }).catch(report)],
      ["Reload libraries", async () => { await reloadLibraries(); refreshPage(); }],
      ["separator"],
      ["Exit", () => window.close()],
    ],
  ],
  [
    "Simulation",
    [
      ["Launch panel", () => navigate("launch")],
      ["Console", () => navigate("console")],
      ["Diagnostics", () => navigate("diagnostics")],
      ["separator"],
      ["Stop simulation", () => invoke("sim_stop").catch(report), () => !state.sim?.running],
    ],
  ],
  [
    "World",
    [
      ["World Library", () => navigate("worlds")],
      ["World Editor", () => navigate("editor", { path: state.openWorld })],
      ["Field Library", () => navigate("fields")],
      ["separator"],
      ["New world…", () => newWorld()],
      ["Import world…", () => importWorld()],
    ],
  ],
  [
    "Robot",
    [
      ["Robot Library", () => navigate("robots")],
      ["Model import guide", () => navigate("guide")],
    ],
  ],
  [
    "Help",
    [
      ["Welcome screen", () => openWelcome({ force: true })],
      ["Help topics", () => navigate("help")],
      ["Protocol reference", () => navigate("protocol")],
      ["separator"],
      ["About MARS Simulation Studio", () => navigate("about")],
    ],
  ],
];

function drawMenubar() {
  const bar = nodes.menubar;
  let open = null;

  const closeAll = () => {
    bar.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
    open = null;
  };

  const menus = MENUS().map(([title, items]) => {
    const popup = el(
      "div.menu-popup",
      ...items.map(([label, action, disabled]) =>
        label === "separator"
          ? el("div.menu-divider")
          : el(
              "div.menu-item",
              {
                data: { disabled: String(Boolean(disabled?.())) },
                onclick: () => {
                  closeAll();
                  action();
                },
              },
              label
            )
      )
    );

    const node = el(
      "div.menu",
      el("div.menu-label", {
        onclick: (e) => {
          e.stopPropagation();
          const wasOpen = node.classList.contains("open");
          closeAll();
          if (!wasOpen) {
            // Disabled states are recomputed on open: the simulation's
            // status changes while the menu is closed.
            popup.querySelectorAll(".menu-item").forEach((item, i) => {
              const d = items.filter((x) => x[0] !== "separator")[i]?.[2];
              if (d) item.dataset.disabled = String(Boolean(d()));
            });
            node.classList.add("open");
            open = node;
          }
        },
        // With a menu already open, hovering switches menus without clicking
        // again: the classic behavior of a menu bar.
        onmouseenter: () => {
          if (open && open !== node) {
            closeAll();
            node.classList.add("open");
            open = node;
          }
        },
      }, title),
      popup
    );
    return node;
  });

  fill(
    bar,
    el(
      "div.menubar-logo",
      el("img", { src: "mss.png", alt: "", "aria-hidden": true, draggable: "false" }),
      el("span", "MARS Simulation Studio")
    ),
    el("div.menubar-sep"),
    ...menus,
    // Drag zone: takes the leftover space so the window can be moved by
    // grabbing the bar, without stealing clicks from the menus.
    el("div.menubar-drag", { "data-tauri-drag-region": true }),
    el(
      "div.menubar-right",
      nodes.simPath,
      nodes.connectionDot
    )
  );

  document.addEventListener("click", closeAll);
}

// --- sidebar -----------------------------------------------------------------

function drawSidebar() {
  const children = [];
  let currentGroup = null;
  for (const [id, p] of Object.entries(PAGES)) {
    if (p.group !== currentGroup) {
      currentGroup = p.group;
      children.push(el("div.sidebar-group", icon(GROUP_ICON[currentGroup] ?? "packages.svg", 12), currentGroup));
    }
    children.push(
      el(
        "div.tree-row",
        { data: { active: String(state.page === id) }, onclick: () => navigate(id), title: p.title },
        icon(p.svg),
        el("span", p.title),
        badge(id)
      )
    );
  }
  fill(nodes.sidebar, ...children);
}

/** The counter some rows carry (worlds, robots). */
function badge(id) {
  if (id === "worlds" && state.worlds.length) return el("span.badge", String(state.worlds.length));
  if (id === "robots" && state.robots.length) return el("span.badge", String(state.robots.length));
  return null;
}

// --- status bar --------------------------------------------------------------

function field(key, ...value) {
  return el("div.status-field", el("span.k", `${key}:`), el("span.v", ...value));
}

function drawStatusbar() {
  const s = state.sim;
  const running = Boolean(s?.running);
  const tone = running ? "ok" : s?.crashed ? "fail" : null;
  const label = running ? "Running" : s?.crashed ? "Crashed" : "Stopped";

  fill(
    nodes.statusbar,
    field("Simulation", el("span.dot", { data: tone ? { tone } : {} }), label),
    field("World", (state.prefs.world ?? "—").replace(/^worlds\//, "")),
    field("Robot", (state.prefs.robot ?? "—").replace(/^models\//, "").replace(/\/robot-map\.json$/, "")),
    field("NT4", `${state.prefs.ntHost ?? "127.0.0.1"}:5810`),
    field("Uptime", running ? `${s.seconds}s` : "—"),
    el("span.spacer"),
    el(
      "span.powered",
      { title: "This simulation runs on Gazebo (Jetty), from conda-forge" },
      "POWERED BY",
      icon("gazebo-logo.svg", 42)
    ),
    el("span.version", `Studio ${MSS_VERSION}`)
  );
}

// --- mounting ----------------------------------------------------------------

export function mount() {
  nodes.simPath = el("span.path");
  nodes.connectionDot = el("span.dot");
  nodes.menubar = el("div.menubar");
  nodes.sidebar = el("div.sidebar");
  nodes.header = el("div.panel-header");
  nodes.page = el("div.page");
  nodes.statusbar = el("div.statusbar");

  const root = el(
    "div.app-root",
    nodes.menubar,
    el("div.body", nodes.sidebar, el("div.content", nodes.header, nodes.page)),
    nodes.statusbar
  );
  document.body.appendChild(root);

  drawMenubar();
  drawSidebar();
  drawStatusbar();
  return nodes;
}

/** Refreshes what depends on the supervisor's status (the bar and the dot). */
export function refreshStatus(s) {
  state.sim = s;
  drawStatusbar();
  const tone = s?.running ? "var(--status-sim)" : s?.crashed ? "var(--status-error)" : "var(--text-menubar-dim)";
  nodes.connectionDot.style.background = tone;
  nodes.connectionDot.style.boxShadow = s?.running ? `0 0 5px ${tone}` : "none";
  nodes.connectionDot.title = s?.running ? "Simulation running" : s?.crashed ? s.crashed : "Simulation stopped";
}

export function setSimPath(text) {
  nodes.simPath.textContent = text;
  nodes.simPath.title = text;
}

/** An error with nowhere to live. It is shown on top of the current page. */
export function report(e) {
  const message = e?.message ?? String(e);
  console.error(e);
  const band = el("div", { style: { marginBottom: "12px" } }, notice(message));
  nodes.page?.prepend(band);
  setTimeout(() => band.remove(), 9000);
}
