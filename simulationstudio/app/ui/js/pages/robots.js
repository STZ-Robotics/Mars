// Robot Library: the robot-map.json files in sim/models/, read as tables.
//
// A robot map is JSON and can be opened in any editor, but there are two
// things you only see by looking at it whole: whether the ORDER of the
// actuators is the one the SDF expects (that order is the index inside
// gz.msgs.Actuators), and whether each actuator declares the control mode it
// should. Both are drawn here with their index number in sight.

import { el, fill, invoke, num, savePrefs, state } from "./../core.js";
import { navigate, refreshPage, report } from "./../shell.js";
import { button, chip, emptyState, notice, panel, prop, propText } from "./../ui.js";

export function robotsPage() {
  let selected = state.prefs.selectedRobot ?? state.prefs.robot ?? state.robots[0]?.path ?? null;
  if (!state.robots.some((r) => r.path === selected)) selected = state.robots[0]?.path ?? null;

  const detail = el("div");
  const body = el("div.stack");

  if (!state.robots.length) {
    return {
      title: "Robot Library",
      help: "robots.map",
      actions: [button("Import guide", { svg: "import-model.svg", sm: true, onclick: () => navigate("guide") })],
      body: emptyState("No robot maps in sim/models/", "Each robot is a folder with a robot-map.json inside"),
    };
  }

  function drawDetail() {
    const r = state.robots.find((x) => x.path === selected);
    if (!r) return fill(detail, emptyState("Select a robot"));

    const json = el("div", el("div.empty-state", "Reading robot-map.json…"));
    invoke("sim_read_text", { path: r.path })
      .then((t) => fill(json, tables(t)))
      .catch((e) => fill(json, notice(e.message)));

    fill(
      detail,
      panel(
        r.folder,
        {
          svg: "robot.svg",
          help: "robots.map",
          actions: chip(r.profile || "no profile", r.profile === "vendor" ? "accent" : r.profile ? "ok" : "warn"),
        },
        el(
          "div",
          propText("Path", r.path),
          propText("Robot", r.robot),
          prop("Profile", el("span.mono", r.profile || "—"), { help: "robots.profiles" }),
          propText("World / model", `${r.world || "—"} / ${r.model || "—"}`),
          prop("Implements SDF", el("span.mono", r.sdf ?? "—"), { help: "robots.actuators" }),
          prop("Actuators", el("span.mono", String(r.actuators)), { help: "robots.actuators" }),
          prop("Encoders", el("span.mono", String(r.encoders)), { help: "robots.encoders" }),
          prop("IMU", el("span.mono", r.imu ? "declared" : "none"), { help: "robots.imu" })
        ),
        el(
          "div.row-wrap",
          { style: { marginTop: "10px" } },
          button("Use for launch", {
            svg: "play.svg",
            variant: "primary",
            disabled: state.prefs.robot === r.path,
            onclick: () => {
              savePrefs({ robot: r.path });
              navigate("launch");
            },
          }),
          button("Reveal in Explorer", {
            svg: "open-folder.svg",
            onclick: () => invoke("sim_reveal", { path: r.path }).catch(report),
          }),
          button("Import guide", { svg: "import-model.svg", onclick: () => navigate("guide") })
        ),
        ...r.notes.map((n) => el("div", { style: { marginTop: "8px" } }, notice(n, "warn")))
      ),
      json
    );
  }

  fill(
    body,
    panel(
      "Robots",
      { svg: "robot.svg", help: "robots.map", flush: true },
      el(
        "div",
        ...state.robots.map((r) =>
          el(
            "div.list-row",
            {
              data: { active: String(r.path === selected) },
              onclick: () => {
                selected = r.path;
                savePrefs({ selectedRobot: r.path });
                refreshPage();
              },
            },
            el("img", { src: "icons/robot.svg", width: 15, height: 15, alt: "" }),
            el("span", r.folder),
            el("span.desc", `${r.profile || "?"} · ${r.actuators} actuators · ${r.encoders} encoders`)
          )
        )
      )
    ),
    detail
  );
  drawDetail();

  return {
    title: "Robot Library",
    meta: `${state.robots.length} robot map${state.robots.length === 1 ? "" : "s"}`,
    help: "robots.map",
    actions: [
      button("Import guide", { svg: "import-model.svg", sm: true, onclick: () => navigate("guide") }),
      button("Reload", { svg: "republish.svg", sm: true, onclick: () => refreshPage() }),
    ],
    body,
  };
}

/** The map's three tables: actuators, encoders, IMU. */
function tables(jsonText) {
  let j;
  try {
    j = JSON.parse(jsonText);
  } catch (e) {
    return notice(`robot-map.json is not valid JSON: ${e.message}`);
  }

  const act = j.actuators ?? [];
  const enc = j.encoders ?? [];

  return el(
    "div.stack",
    panel(
      "Actuators",
      {
        svg: "joint.svg",
        help: "robots.actuators",
        flush: true,
        actions: el("span.dim", { style: { fontSize: "10.5px" } }, "index = position in gz.msgs.Actuators"),
      },
      act.length
        ? el(
            "table.grid",
            el(
              "thead",
              el(
                "tr",
                el("th.num", "#"),
                el("th", "Name"),
                el("th", "Joint"),
                el("th", "Motor"),
                el("th.num", "Gear"),
                el("th", "Control"),
                el("th", "Inverted"),
                el("th", "HAL")
              )
            ),
            el(
              "tbody",
              ...act.map((a, i) =>
                el(
                  "tr",
                  el("td.num.mono", String(i)),
                  el("td", a.name ?? "—"),
                  el("td.mono", a.joint ?? "—"),
                  el("td.mono", a.motor ?? "—"),
                  el("td.num.mono", { title: String(a.gearRatio ?? "") }, a.gearRatio == null ? "—" : num(a.gearRatio, 4)),
                  el("td", chip(a.control ?? "duty", a.control === "position" ? "accent" : null)),
                  el("td.dim", a.inverted ? "yes" : "no"),
                  el("td.mono.dim", a.hal ? `${a.hal.kind} ${a.hal.channel ?? a.hal.index ?? ""}` : "—")
                )
              )
            )
          )
        : el("div", { style: { padding: "10px" } }, notice("No actuators declared.", "warn"))
    ),

    panel(
      "Encoders",
      { svg: "measure.svg", help: "robots.encoders", flush: true },
      enc.length
        ? el(
            "table.grid",
            el("thead", el("tr", el("th.num", "#"), el("th", "Name"), el("th", "Joint"), el("th.num", "Counts/rev"), el("th", "HAL"))),
            el(
              "tbody",
              ...enc.map((e, i) =>
                el(
                  "tr",
                  el("td.num.mono", String(i)),
                  el("td", e.name ?? "—"),
                  el("td.mono", e.joint ?? "—"),
                  el("td.num.mono", e.countsPerRevolution ?? "—"),
                  el("td.mono.dim", e.hal ? `${e.hal.kind} ${e.hal.index ?? ""}` : "—")
                )
              )
            )
          )
        : el("div", { style: { padding: "10px" } }, notice("No encoders declared. The robot will report no joint state.", "warn"))
    ),

    panel(
      "IMU",
      { svg: "axes.svg", help: "robots.imu" },
      j.imu
        ? el(
            "div",
            ...Object.entries(j.imu).map(([k, v]) => propText(k, typeof v === "object" ? JSON.stringify(v) : String(v)))
          )
        : el(
            "div.doc",
            {
              html: `<p>No IMU declared. That is fine for a mechanism, but a drivetrain without a gyro
                     has no heading — and the dashboard cannot tell "no gyro" from "a robot that never
                     turns".</p>
                     <p>An IMU needs two things to line up: a <code>&lt;sensor type="imu"&gt;</code> on the
                     chassis link in the SDF, and the IMU system plugin enabled on the world.</p>`,
            }
          )
    ),

    panel(
      "Raw file",
      { svg: "model-file.svg" },
      el("pre.log", { style: { height: "260px" } }, jsonText)
    )
  );
}
