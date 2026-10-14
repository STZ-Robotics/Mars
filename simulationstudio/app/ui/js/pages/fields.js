// Field Library: the 3D fields available and the ones already in the project.
//
// The format is AdvantageScope's --- a folder with `config.json` and
// `model.glb` --- which is the same one mars-desktop's 3D Field already
// consumes. Reusing it means a field downloaded there works here without
// converting anything, and that this page finds on its own whatever the
// dashboard has installed.

import { bytes, el, fill, invoke, num, state } from "./../core.js";
import { navigate, refreshPage, report } from "./../shell.js";
import { button, chip, modal, notice, panel, textInput } from "./../ui.js";

export function fieldsPage() {
  const body = el("div.stack", el("div.empty-state", "Looking for fields…"));

  async function load() {
    let fields;
    try {
      fields = await invoke("sim_fields");
    } catch (e) {
      return fill(body, notice(e.message));
    }
    state.fields = fields;

    const inProject = fields.filter((c) => c.installed);
    const available = fields.filter((c) => !c.installed);

    fill(
      body,
      inProject.length
        ? panel(
            "In this project",
            { svg: "scene.svg", help: "world.field", flush: true },
            el(
              "table.grid",
              el(
                "thead",
                el(
                  "tr",
                  el("th", "Field"),
                  el("th", "Path"),
                  el("th.num", "Play area"),
                  el("th", "Origin"),
                  el("th.num", "Size"),
                  el("th", "")
                )
              ),
              el("tbody", ...inProject.map((c) => row(c, true)))
            )
          )
        : notice(
            "No field is installed in this project yet. Install one below, then pick it in the World Editor.",
            "info"
          ),

      available.length
        ? panel(
            "Available from MARS Desktop",
            {
              svg: "packages.svg",
              help: "world.field.install",
              flush: true,
              actions: el("span.dim", { style: { fontSize: "10.5px" } }, "%APPDATA%/MARS/assets3d"),
            },
            el(
              "table.grid",
              el(
                "thead",
                el(
                  "tr",
                  el("th", "Field"),
                  el("th", "Source"),
                  el("th.num", "Play area"),
                  el("th", "Origin"),
                  el("th.num", "Size"),
                  el("th", "")
                )
              ),
              el("tbody", ...available.map((c) => row(c, false)))
            )
          )
        : null,

      panel(
        "Where fields come from",
        { svg: "help.svg", help: "world.field" },
        el("div.doc", {
          html: `
            <p>A field is an <strong>AdvantageScope field asset</strong>: a folder holding
            <code>config.json</code> and <code>model.glb</code>. MARS Desktop downloads them in its
            Field 3D tab, and this page picks up whatever it has installed.</p>
            <p>Installing copies the folder into <code>sim/fields/</code> so the world does not
            depend on a path under <code>%APPDATA%</code> — a world that did would not open on
            anybody else's machine, and worlds are part of the repository.</p>
            <p class="note">The copy is also <strong>prepared for Gazebo</strong>. The official
            models declare nearly every material as fully metallic, and a metallic surface under a
            PBR renderer with no environment map reflects nothing but black — the field loads, the
            physics runs, and the screen shows a field-shaped black blob. Installing turns the
            metallic factor off, which is the same fix AdvantageScope applies by forcing
            <code>MeshPhongMaterial</code>.</p>
            <p class="warn">The 2026 field is about 2.9 M triangles. It goes into the world as a
            <strong>visual only</strong> — collision stays on the ground plane and the walls — so
            the physics and the real-time factor are unaffected, but the 3D window takes around
            half a minute to open with it.</p>`,
        })
      )
    );
  }

  function row(c, installed) {
    return el(
      "tr",
      el("td", el("span.row", el("img", { src: "icons/scene.svg", width: 14, height: 14, alt: "" }), c.name)),
      el("td.mono.dim", { title: installed ? c.path : c.origin }, installed ? c.path : c.source),
      el(
        "td.num.mono",
        c.length_m > 0 ? `${num(c.length_m, 2)} × ${num(c.width_m, 2)} m` : "—"
      ),
      el("td", chip(c.coordinate_system)),
      el("td.num.dim", bytes(c.bytes)),
      el(
        "td",
        installed
          ? button("Use in a world", {
              sm: true,
              svg: "grid.svg",
              onclick: () => navigate("editor", { path: state.prefs.selectedWorld ?? state.prefs.world }),
            })
          : button("Install", { sm: true, variant: "primary", svg: "import-model.svg", onclick: () => install(c) })
      )
    );
  }

  function install(c) {
    const model = {
      name: c.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "field",
    };
    modal({
      title: "Install field",
      svg: "import-model.svg",
      width: 520,
      body: el(
        "div.stack",
        el("div", el("label.field-label", "Source"), el("div.mono.selectable", { style: { wordBreak: "break-all" } }, c.origin)),
        el(
          "div",
          el("label.field-label", "Copy into sim/fields/ as"),
          textInput(model, "name")
        ),
        el("div.doc", {
          html: `<p>Copies ${bytes(c.bytes)} and prepares the mesh so Gazebo can render it. Takes a
                 few seconds.</p>`,
        })
      ),
      footer: (close) => [
        button("Cancel", { onclick: close }),
        button("Install", {
          variant: "primary",
          onclick: async () => {
            try {
              await invoke("sim_install_field", { origin: c.origin, name: model.name.trim() });
              close();
              await load();
            } catch (e) {
              report(e);
            }
          },
        }),
      ],
    });
  }

  load();

  return {
    title: "Field Library",
    meta: "FRC field models for the 3D world",
    help: "world.field",
    actions: [button("Reload", { svg: "republish.svg", sm: true, onclick: () => refreshPage() })],
    body,
  };
}
