// The welcome portal.
//
// A startup dialog like the ones in desktop suites from twenty years ago: a
// brand band on the left, dense lists of shortcuts on the right, and a "Show
// this window at startup" at the very bottom that is actually remembered. No
// full-screen hero and no big cards --- this is a tool's index, not a
// product's landing page, and the rest of the app (like mars-desktop) already
// speaks that language.

import { MSS_PROTOCOL_VERSION, MSS_VERSION } from "./constants.js";
import { el, icon, savePrefs, state } from "./core.js";
import { navigate } from "./shell.js";
import { button, modal } from "./ui.js";
import { importWorld, newWorld } from "./pages/worlds.js";

let isOpen = false;

/**
 * Opens the portal. `force` opens it even if the user unticked the box ---
 * it is how you get here from the Help menu.
 */
export function openWelcome({ force = false } = {}) {
  if (isOpen) return;
  if (!force && state.prefs.showWelcome === false) return;
  isOpen = true;

  const closeThen = (action) => () => {
    dialog.close?.();
    action();
  };

  const recent = (state.prefs.recent ?? [])
    .map((path) => state.worlds.find((m) => m.path === path))
    .filter(Boolean)
    .slice(0, 5);

  const lists = el(
    "div.welcome-lists",

    section("Start", "play.svg", [
      ["add.svg", "New world", "Create one from a template", closeThen(() => newWorld())],
      ["import-model.svg", "Import world", "Copy an existing .sdf into the project", closeThen(() => importWorld())],
      ["scene.svg", "World Library", `${state.worlds.length} world${state.worlds.length === 1 ? "" : "s"} in this project`, closeThen(() => navigate("worlds"))],
      ["robot.svg", "Robot Library", `${state.robots.length} robot map${state.robots.length === 1 ? "" : "s"}`, closeThen(() => navigate("robots"))],
      ["play.svg", "Launch simulation", "Pick a world and a robot, then start", closeThen(() => navigate("launch"))],
    ]),

    recent.length
      ? section(
          "Recent worlds",
          "open-folder.svg",
          recent.map((m) => [
            "scene.svg",
            m.file,
            m.managed ? "managed" : "external",
            closeThen(() => navigate("editor", { path: m.path })),
          ])
        )
      : null,

    section("Learn", "help.svg", [
      ["import-model.svg", "Model import guide", "Bring your own SDF model into the simulation", closeThen(() => navigate("guide"))],
      ["network.svg", "Protocol reference", "How engine, bridge and robot code talk", closeThen(() => navigate("protocol"))],
      ["help.svg", "Help topics", "Every explanation in the app, in one place", closeThen(() => navigate("help"))],
      ["watchdog.svg", "Diagnostics", "Check that everything needed to run is installed", closeThen(() => navigate("diagnostics"))],
      ["samples.svg", "About", "Versions, credits and what runs underneath", closeThen(() => navigate("about"))],
    ])
  );

  const showAtStartup = el("input", {
    type: "checkbox",
    checked: state.prefs.showWelcome !== false,
    onchange: (e) => savePrefs({ showWelcome: e.target.checked }),
  });

  const body = el(
    "div.modal-body",
    { style: { padding: "0", display: "flex", flexDirection: "column", minHeight: "0" } },
    el(
      "div.welcome-split",
      el(
        "div.welcome-brand",
        el(
          "div.brand-mark",
          el("img", { src: "mss.png", alt: "", "aria-hidden": true, draggable: "false" }),
          el("div", el("b", "MARS"), el("span", "Simulation Studio"))
        ),
        el("div.tagline", "Physics simulation and world authoring for the MARS robot framework."),
        el("div.build", `STUDIO ${MSS_VERSION} · PROTOCOL ${MSS_PROTOCOL_VERSION}`),
        // Three lines on what is inside. The brand band had a big gap between
        // the version and the Gazebo credit, and an empty space on a welcome
        // screen reads as an unfinished screen.
        el(
          "div.brand-facts",
          ...[
            ["scene.svg", "Author worlds", "Physics, ground, walls, lighting and props — no XML required."],
            ["import-model.svg", "Import anything", "Bring in an existing .sdf, meshes and all."],
            ["robot.svg", "Run and watch", "Supervises the engine, the 3D window and the NT4 bridge."],
          ].map(([svg, title, text]) =>
            el("div.fact", icon(svg, 15), el("div", el("b", title), el("span", text)))
          )
        ),
        el(
          "div.gz",
          el("div.powered", "Powered by"),
          el("img", { src: "icons/gazebo-logo.svg", alt: "Gazebo", draggable: "false" }),
          el(
            "div",
            { style: { fontSize: "9.5px", color: "var(--text-menubar-dim)", lineHeight: "1.5" } },
            "Gazebo Jetty, by Open Robotics. All physics and the 3D world window come from it."
          )
        )
      ),
      el(
        "div.welcome-main",
        el(
          "div.intro",
          el("h2", "Welcome to MARS Simulation Studio"),
          el(
            "p",
            "Run your robot against real physics before it exists, and build the worlds you run it in. " +
              "If you are here for the first time, start with the model import guide — it covers the things " +
              "that are not obvious and that cost a day each when you find them yourself."
          )
        ),
        lists
      )
    ),
    el(
      "div.welcome-foot",
      el("label", showAtStartup, "Show this window at startup"),
      button("Get started", { variant: "primary", svg: "play.svg", onclick: () => dialog.close() })
    )
  );

  const dialog = modal({
    title: "Welcome — MARS Simulation Studio",
    svg: "home.svg",
    className: "welcome",
    body,
    onClose: () => {
      isOpen = false;
    },
  });
}

function section(title, svg, rows) {
  return el(
    "div.bevel",
    el("div.bevel-title", icon(svg), el("span.label", title)),
    el(
      "div",
      ...rows.map(([rowIcon, name, desc, action]) =>
        el("div.list-row", { onclick: action }, icon(rowIcon, 15), el("span", name), el("span.desc", desc))
      )
    )
  );
}
