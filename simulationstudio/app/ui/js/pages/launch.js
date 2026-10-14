// Launch: pick what to run and run it.
//
// It is the page that inherits the whole of the old app, and it is still the
// first one that opens. What was added to it is context: which world is
// selected and what is wrong with it, which robot, and a glance at the logs
// without having to go to Console.

import { el, fill, invoke, savePrefs, state } from "./../core.js";
import { navigate, refreshPage, report } from "./../shell.js";
import { button, chip, emptyState, notice, panel, prop, propText } from "./../ui.js";

export function launchPage() {
  const prefs = state.prefs;
  prefs.ntHost ??= "127.0.0.1";
  prefs.ntPort ??= 5810;

  // Preselection: the swerve is the team's robot, so if it is there,
  // starting is a single click in the normal case.
  if (!prefs.robot || !state.robots.some((r) => r.path === prefs.robot)) {
    const swerve = state.robots.find((r) => r.path.includes("swerve")) ?? state.robots[0];
    prefs.robot = swerve?.path ?? "";
  }
  if (!prefs.world || !state.worlds.some((m) => m.path === prefs.world)) {
    const its = state.worlds.find((m) => prefs.robot && m.path.includes(shortName(prefs.robot)));
    prefs.world = (its ?? state.worlds[0])?.path ?? "";
  }

  const nodes = {
    light: el("span.dot"),
    text: el("span", "Stopped"),
    detail: el("span.mono.dim"),
    enginePid: el("span.mono", "—"),
    windowPid: el("span.mono", "—"),
    bridgePid: el("span.mono", "—"),
    crash: el("div"),
    engineLog: el("pre.log", { style: { height: "150px" } }),
    bridgeLog: el("pre.log", { style: { height: "150px" } }),
  };

  const startButton = button("Start simulation", { svg: "play.svg", variant: "go", onclick: start });
  const stopButton = button("Stop", { svg: "stop.svg", variant: "stop", onclick: stop, disabled: true });

  const inputs = [];
  const worldSelect = selector(state.worlds.map((m) => [m.path, m.file]), prefs.world, (v) => {
    savePrefs({ world: v });
    refreshPage();
  });
  const robotSelect = selector(
    state.robots.map((r) => [r.path, `${r.folder} — ${r.actuators} actuators, ${r.profile || "?"} profile`]),
    prefs.robot,
    (v) => {
      savePrefs({ robot: v });
      refreshPage();
    }
  );
  const hostInput = el("input", {
    type: "text",
    value: prefs.ntHost,
    spellcheck: "false",
    oninput: (e) => savePrefs({ ntHost: e.target.value }),
  });
  const portInput = el("input", {
    type: "number",
    value: prefs.ntPort,
    min: 1,
    max: 65535,
    oninput: (e) => {
      const v = parseInt(e.target.value, 10);
      if (Number.isFinite(v)) savePrefs({ ntPort: v });
    },
  });
  inputs.push(worldSelect, robotSelect, hostInput, portInput);

  const world = state.worlds.find((m) => m.path === prefs.world) ?? null;
  const robot = state.robots.find((r) => r.path === prefs.robot) ?? null;

  function lock(active) {
    for (const s of inputs) s.disabled = active;
    startButton.disabled = active;
    stopButton.disabled = !active;
  }

  async function start() {
    fill(nodes.crash);
    lock(true);
    try {
      await invoke("sim_start", {
        cfg: {
          world: prefs.world,
          robot_map: prefs.robot,
          nt_host: (prefs.ntHost || "127.0.0.1").trim(),
          nt_port: prefs.ntPort || 5810,
        },
      });
    } catch (e) {
      fill(nodes.crash, notice(e.message));
      lock(false);
    }
  }

  async function stop() {
    try {
      await invoke("sim_stop");
    } catch (e) {
      report(e);
    }
    lock(false);
  }

  const nothing = !state.worlds.length || !state.robots.length;

  const body = el(
    "div.stack",
    nothing
      ? notice(
          !state.worlds.length
            ? "No worlds found in sim/worlds/. Create one from World Library, or import an existing .sdf."
            : "No robot maps found in sim/models/. See the Import Guide for how to add one.",
          "warn"
        )
      : null,

    panel(
      "Run configuration",
      { svg: "settings.svg", help: "launch.world" },
      el(
        "div",
        prop("World", worldSelect, { help: "launch.world" }),
        prop("Robot map", robotSelect, { help: "launch.robot" }),
        prop("NT4 host", hostInput, { help: "launch.nt" }),
        prop("NT4 port", portInput, { help: "launch.nt" })
      ),
      el(
        "div.row",
        { style: { marginTop: "10px" } },
        startButton,
        stopButton,
        el("span", { style: { marginLeft: "auto" } }),
        button("Edit world", {
          svg: "grid.svg",
          sm: true,
          disabled: !world,
          onclick: () => navigate("editor", { path: prefs.world }),
        }),
        button("Diagnostics", { svg: "watchdog.svg", sm: true, onclick: () => navigate("diagnostics") })
      ),
      nodes.crash
    ),

    el(
      "div.grid-2",
      panel(
        "Selected world",
        { svg: "scene.svg", help: "worlds.library" },
        world
          ? el(
              "div",
              propText("File", world.file),
              prop(
                "World name",
                el(
                  "span.row",
                  el("span.mono", world.world || "—"),
                  world.world === "mars" ? chip("ok", "ok") : chip("wrong", "fail")
                ),
                { help: "worlds.name-mars" }
              ),
              propText("Models / includes", `${world.models} / ${world.includes}`),
              propText("Plugins / lights", `${world.plugins} / ${world.lights}`),
              prop(
                "Physics step",
                el("span.mono", world.step ? `${world.step} s  (${Math.round(1 / world.step)} Hz)` : "—"),
                { help: "world.physics.step" }
              ),
              prop("Real-time factor", el("span.mono", world.rtf ?? "—"), { help: "world.physics.rtf" }),
              prop(
                "Editable",
                world.managed ? chip("managed", "accent") : chip("external", "warn"),
                { help: "worlds.managed" }
              ),
              ...world.notes.map((n) => el("div", { style: { padding: "8px 0 0" } }, notice(n, "warn")))
            )
          : emptyState("No world selected")
      ),

      panel(
        "Selected robot",
        { svg: "robot.svg", help: "robots.map" },
        robot
          ? el(
              "div",
              propText("Folder", robot.folder),
              propText("Robot", robot.robot),
              prop("Profile", chip(robot.profile || "unknown", robot.profile === "vendor" ? "accent" : null), {
                help: "robots.profiles",
              }),
              propText("Implements", robot.sdf ?? "—"),
              prop("Actuators", el("span.mono", String(robot.actuators)), { help: "robots.actuators" }),
              prop("Encoders", el("span.mono", String(robot.encoders)), { help: "robots.encoders" }),
              prop("IMU", el("span.mono", robot.imu ? "declared" : "none"), { help: "robots.imu" }),
              ...robot.notes.map((n) => el("div", { style: { padding: "8px 0 0" } }, notice(n, "warn")))
            )
          : emptyState("No robot map selected")
      )
    ),

    panel(
      "Status",
      { svg: "watchdog.svg", help: "launch.status" },
      el(
        "div",
        prop("State", el("span.row", nodes.light, nodes.text, nodes.detail), { help: "launch.status" }),
        prop("Engine (mars-sim-server)", nodes.enginePid, { help: "app.processes" }),
        prop("World window (mars-sim-gui)", nodes.windowPid, { help: "app.world-window" }),
        prop("Bridge (mars-bridge)", nodes.bridgePid, { help: "app.processes" })
      )
    ),

    panel(
      "Recent output",
      {
        svg: "console.svg",
        help: "console.logs",
        actions: button("Open console", { sm: true, onclick: () => navigate("console") }),
      },
      el(
        "div.grid-2",
        el("div", el("div.field-label", "Engine"), nodes.engineLog),
        el("div", el("div.field-label", "Bridge"), nodes.bridgeLog)
      )
    )
  );

  // The poll loop calls the tick while this page is mounted.
  const tick = async (s) => {
    const running = Boolean(s?.running);
    nodes.light.dataset.tone = running ? "ok" : s?.crashed ? "fail" : "";
    nodes.text.textContent = running ? "Running" : s?.crashed ? "Crashed" : "Stopped";
    nodes.detail.textContent = running ? `${s.seconds}s` : "";
    nodes.enginePid.textContent = s?.engine_pid ? `pid ${s.engine_pid}` : "—";
    nodes.windowPid.textContent = s?.window_pid ? `pid ${s.window_pid}` : "—";
    nodes.bridgePid.textContent = s?.bridge_pid ? `pid ${s.bridge_pid}` : "—";

    // A process that dies on its own has to show up here, not only in the
    // log: without this the UI would say "Running" forever after a crash.
    if (s?.crashed && !nodes.crash.firstChild) {
      fill(nodes.crash, el("div", { style: { paddingTop: "10px" } }, notice(s.crashed)));
      lock(false);
    }
    if (stopButton.disabled === running) lock(running);

    try {
      const l = await invoke("sim_logs", { lines: 14 });
      tailLog(nodes.engineLog, l.engine);
      tailLog(nodes.bridgeLog, l.bridge);
    } catch {
      // The log is an extra on this page; Console is where it matters.
    }
  };

  return {
    title: "Launch",
    meta: `${state.worlds.length} worlds · ${state.robots.length} robot maps`,
    help: "app.overview",
    actions: [button("Reload", { svg: "republish.svg", sm: true, onclick: () => refreshPage() })],
    body,
    tick,
  };
}

function shortName(robotPath) {
  return robotPath.replace(/^models\//, "").replace(/\/robot-map\.json$/, "");
}

function selector(items, value, onChange) {
  return el(
    "select",
    { onchange: (e) => onChange(e.target.value) },
    ...items.map(([v, label]) => el("option", { value: v, selected: v === value }, label))
  );
}

/** Writes the log only if it changed, and follows the tail without stealing the scroll. */
export function tailLog(pre, text) {
  const clean = (text ?? "").replace(/^\s+|\s+$/g, "");
  if (pre.textContent === clean) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
  pre.textContent = clean;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
