// Diagnostics: everything "Start" needs in order to work, checked one thing
// at a time.
//
// It exists because almost every failure of this app is an installation one
// and none of them explains itself: the engine dies with a Windows error that
// does not name the missing DLL, and the 3D window opens grey, leaving the
// reason in a stderr nobody looks at.

import { MSS_VERSION_LABEL } from "./../constants.js";
import { el, fill, invoke, state } from "./../core.js";
import { navigate } from "./../shell.js";
import { button, chip, notice, panel, prop, propText } from "./../ui.js";

export function diagnosticsPage() {
  const body = el("div.stack", el("div.empty-state", "Running checks…"));

  const environment = panel(
    "Environment",
    { svg: "settings.svg", help: "app.processes" },
    el(
      "div",
      propText("sim/ directory", state.options?.sim_dir ?? "—"),
      propText("Conda environment", state.options?.conda_dir ?? "—"),
      propText("Studio version", MSS_VERSION_LABEL),
      propText("Worlds / robot maps", `${state.worlds.length} / ${state.robots.length}`)
    )
  );

  async function load() {
    try {
      const checks = await invoke("sim_diagnostics");
      const failures = checks.filter((c) => c.status === "fail").length;
      const warnings = checks.filter((c) => c.status === "warn").length;

      fill(
        body,
        failures
          ? notice(
              `${failures} check${failures > 1 ? "s" : ""} failed. The simulation will not start until ${
                failures > 1 ? "they are" : "it is"
              } fixed.`
            )
          : warnings
          ? notice(`All required checks pass. ${warnings} optional item${warnings > 1 ? "s are" : " is"} missing.`, "warn")
          : notice("Everything checks out. The simulation is ready to run.", "ok"),

        panel(
          "Checks",
          {
            svg: "watchdog.svg",
            help: "diagnostics",
            flush: true,
            actions: button("Re-run", { svg: "republish.svg", sm: true, onclick: load }),
          },
          el(
            "div",
            ...checks.map((c) =>
              el(
                "div",
                { style: { borderBottom: "1px solid var(--border-light)" } },
                prop(
                  c.name,
                  el(
                    "span.row",
                    { style: { minWidth: "0" } },
                    chip(c.status, c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "fail"),
                    el("span.mono.dim", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: c.detail }, c.detail)
                  )
                ),
                c.fix
                  ? el(
                      "div",
                      {
                        style: {
                          padding: "5px 10px 8px 46px",
                          fontSize: "11px",
                          color: c.status === "warn" ? "var(--status-warning)" : "var(--status-error)",
                        },
                      },
                      `→ ${c.fix}`
                    )
                  : null
              )
            )
          )
        ),

        environment,

        panel(
          "If something still fails",
          { svg: "help.svg", help: "console.logs" },
          el("div.doc", {
            html: `
              <p>Build everything from the repository root:</p>
              <pre><code>conda env create -f simulationstudio/environment.yml   # once
conda activate mars-sim
simulationstudio\\build.ps1                # engine, world window, MarsLink
cargo build --manifest-path simulationstudio/bridge/Cargo.toml
cargo build --manifest-path simulationstudio/app/Cargo.toml</code></pre>
              <p><code>simulationstudio\\verify.ps1</code> runs all seven verification layers end
              to end: contract, engine, bridge, physics, NT4, the hardware loop, and swerve under position
              control. If that passes and this page still complains, the app is looking at the
              wrong <code>sim/</code> — set <code>MARS_SIM_DIR</code>.</p>`,
          })
        )
      );
    } catch (e) {
      fill(body, notice(e.message));
    }
  }

  load();

  return {
    title: "Diagnostics",
    meta: "Prerequisites for running a simulation",
    help: "diagnostics",
    actions: [button("Console", { svg: "console.svg", sm: true, onclick: () => navigate("console") })],
    body,
  };
}
