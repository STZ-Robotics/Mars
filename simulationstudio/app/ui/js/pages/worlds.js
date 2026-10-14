// World Library: every .sdf in sim/worlds/, with what could be read from each
// one and the actions that operate on the selected one.
//
// The distinction that organizes the page is managed/external: a world
// created here has its .studio.json next to it and opens in the property
// tree; one written by hand can only be run and edited as XML. See the help
// topic "worlds.managed" for why the editor refuses to regenerate the latter.

import { bytes, el, fill, invoke, num, reloadLibraries, savePrefs, state } from "./../core.js";
import { navigate, refreshPage, report } from "./../shell.js";
import { button, chip, confirmDialog, emptyState, modal, notice, panel, prop, propText, textInput } from "./../ui.js";
import { pickFile } from "./../browser.js";
import { TEMPLATES, specFromTemplate } from "./../worldspec.js";

export function worldsPage() {
  let selected = state.prefs.selectedWorld ?? state.prefs.world ?? state.worlds[0]?.path ?? null;
  if (!state.worlds.some((m) => m.path === selected)) selected = state.worlds[0]?.path ?? null;

  const detail = el("div");
  const body = el("div.stack");

  function choose(path) {
    selected = path;
    savePrefs({ selectedWorld: path });
    drawTable();
    drawDetail();
  }

  const table = el("tbody");

  function drawTable() {
    fill(
      table,
      ...state.worlds.map((m) =>
        el(
          "tr",
          { data: { selectable: "true", active: String(m.path === selected) }, onclick: () => choose(m.path) },
          el("td", el("span.row", el("img", { src: "icons/scene.svg", width: 14, height: 14, alt: "" }), m.file)),
          el("td", m.managed ? chip("managed", "accent") : chip("external")),
          el("td.mono", m.world || "—"),
          el("td.num", String(m.models)),
          el("td.num", String(m.plugins)),
          el("td.num", m.step ? `${num(m.step, 4)} s` : "—"),
          el("td.num.dim", bytes(m.bytes)),
          el("td", m.notes.length ? chip(`${m.notes.length} issue${m.notes.length > 1 ? "s" : ""}`, "warn") : chip("ok", "ok"))
        )
      )
    );
  }

  function drawDetail() {
    const m = state.worlds.find((x) => x.path === selected);
    if (!m) return fill(detail, emptyState("Select a world above"));

    const isLaunchWorld = state.prefs.world === m.path;

    fill(
      detail,
      panel(
        m.file,
        {
          svg: "scene.svg",
          help: "worlds.library",
          actions: m.managed ? chip("managed", "accent") : chip("external", "warn"),
        },
        el(
          "div",
          propText("Path", m.path),
          prop("World name", el("span.row", el("span.mono", m.world || "—"), m.world !== "mars" && chip("must be \"mars\"", "fail")), {
            help: "worlds.name-mars",
          }),
          m.description ? propText("Description", m.description) : null,
          propText("Models / includes / lights", `${m.models} / ${m.includes} / ${m.lights}`),
          prop("Plugins", el("span.mono", String(m.plugins)), { help: "world.plugins" }),
          prop("Physics step", el("span.mono", m.step ? `${m.step} s  (${Math.round(1 / m.step)} Hz)` : "—"), {
            help: "world.physics.step",
          }),
          prop("Real-time factor", el("span.mono", m.rtf ?? "—"), { help: "world.physics.rtf" }),
          propText("Size on disk", bytes(m.bytes))
        ),
        el(
          "div.row-wrap",
          { style: { marginTop: "10px" } },
          button(m.managed ? "Open in editor" : "Open source", {
            svg: "grid.svg",
            variant: "primary",
            onclick: () => navigate("editor", { path: m.path }),
          }),
          button(isLaunchWorld ? "Selected for launch" : "Use for launch", {
            svg: "play.svg",
            disabled: isLaunchWorld,
            onclick: () => {
              savePrefs({ world: m.path });
              navigate("launch");
            },
          }),
          button("Duplicate", { svg: "duplicate.svg", onclick: () => duplicate(m) }),
          button("Reveal in Explorer", { svg: "open-folder.svg", onclick: () => invoke("sim_reveal", { path: m.path }).catch(report) }),
          button("Delete", { svg: "delete.svg", variant: "danger", onclick: () => remove(m) })
        ),
        ...m.notes.map((n) => el("div", { style: { marginTop: "8px" } }, notice(n, "warn")))
      )
    );
  }

  fill(
    body,
    state.worlds.length
      ? panel(
          "Worlds",
          { svg: "scene.svg", help: "worlds.library", flush: true },
          el(
            "div",
            { style: { maxHeight: "310px", overflowY: "auto" } },
            el(
              "table.grid",
              el(
                "thead",
                el(
                  "tr",
                  el("th", "File"),
                  el("th", "Kind"),
                  el("th", "World name"),
                  el("th.num", "Models"),
                  el("th.num", "Plugins"),
                  el("th.num", "Step"),
                  el("th.num", "Size"),
                  el("th", "Status")
                )
              ),
              table
            )
          )
        )
      : emptyState("No worlds in sim/worlds/", "Create one with New world, or import an existing .sdf"),
    detail
  );

  drawTable();
  drawDetail();

  return {
    title: "World Library",
    meta: `${state.worlds.length} world${state.worlds.length === 1 ? "" : "s"} in sim/worlds/`,
    help: "worlds.library",
    actions: [
      button("New world", { svg: "add.svg", sm: true, onclick: () => newWorld() }),
      button("Import", { svg: "import-model.svg", sm: true, onclick: () => importWorld() }),
      button("Reload", { svg: "republish.svg", sm: true, onclick: () => refreshPage() }),
    ],
    body,
  };
}

// --- actions -----------------------------------------------------------------

function duplicate(m) {
  const model = { name: `${m.file.replace(/\.sdf$/, "")}-copy` };
  modal({
    title: "Duplicate world",
    svg: "duplicate.svg",
    width: 430,
    body: el(
      "div",
      el("label.field-label", "New file name"),
      el("div.row", textInput(model, "name", { placeholder: "my-world" }), el("span.unit", ".sdf")),
      el("p.dim", { style: { marginTop: "8px", fontSize: "11px" } }, "Letters, digits, dash and underscore only.")
    ),
    footer: (close) => [
      button("Cancel", { onclick: close }),
      button("Duplicate", {
        variant: "primary",
        onclick: async () => {
          try {
            const path = await invoke("sim_duplicate_world", { path: m.path, name: model.name.trim() });
            close();
            await reloadLibraries();
            savePrefs({ selectedWorld: path });
            refreshPage();
          } catch (e) {
            report(e);
          }
        },
      }),
    ],
  });
}

function remove(m) {
  confirmDialog({
    title: "Delete world",
    message: `Delete ${m.file} from sim/worlds/? ${
      m.managed ? "Its .studio.json goes with it. " : ""
    }This cannot be undone from inside the app.`,
    onAccept: async () => {
      try {
        await invoke("sim_delete_world", { path: m.path });
        await reloadLibraries();
        if (state.prefs.world === m.path) savePrefs({ world: state.worlds[0]?.path ?? "" });
        refreshPage();
      } catch (e) {
        report(e);
      }
    },
  });
}

/** The "New world" dialog: name, description and template. */
export function newWorld() {
  const model = { name: "new-world", description: "" };
  let template = "frc";

  const list = el("div.bevel");
  const drawList = () =>
    fill(
      list,
      el("div.bevel-title", el("span.label", "Template")),
      ...TEMPLATES.map((p) =>
        el(
          "div.list-row",
          {
            data: { active: String(template === p.id) },
            onclick: () => {
              template = p.id;
              drawList();
            },
          },
          el("img", { src: `icons/${p.svg}`, width: 15, height: 15, alt: "" }),
          el("span", p.name),
          el(
            "span.desc",
            p.wantsField && !(state.fields ?? []).some((c) => c.installed)
              ? "No field installed — install one in Field Library first"
              : p.summary
          )
        )
      )
    );
  drawList();

  modal({
    title: "New world",
    svg: "add.svg",
    width: 620,
    body: el(
      "div.stack",
      el(
        "div",
        el("label.field-label", "File name"),
        el("div.row", textInput(model, "name", { placeholder: "my-world" }), el("span.unit", ".sdf"))
      ),
      el(
        "div",
        el("label.field-label", "Description (optional)"),
        textInput(model, "description", { placeholder: "What this world is for" })
      ),
      list,
      el("div.doc", {
        html: `<p class="note">Every world generated here declares <code>&lt;world name="mars"&gt;</code>,
               the physics system and the scene broadcaster. Those three are what the rest of the
               simulation assumes exists.</p>`,
      })
    ),
    footer: (close) => [
      button("Cancel", { onclick: close }),
      button("Create and edit", {
        variant: "primary",
        svg: "add.svg",
        onclick: async () => {
          const name = model.name.trim();
          const spec = specFromTemplate(template, name, (state.fields ?? []).find((c) => c.installed)?.path ?? "");
          spec.description = model.description.trim();
          try {
            const path = await invoke("sim_save_world", { spec });
            close();
            await reloadLibraries();
            savePrefs({ selectedWorld: path });
            navigate("editor", { path });
          } catch (e) {
            report(e);
          }
        },
      }),
    ],
  });
}

/** Imports an .sdf from anywhere on disk: pick the file, then the name. */
export function importWorld() {
  pickFile({
    title: "Import world — pick an .sdf",
    filter: ["sdf", "world"],
    onPick: (origin) => {
      const suggested = (origin.split(/[\\/]/).pop() ?? "world")
        .replace(/\.(sdf|world)$/i, "")
        .replace(/[^A-Za-z0-9_-]/g, "-");
      const model = { name: suggested };

      modal({
        title: "Import world",
        svg: "import-model.svg",
        width: 520,
        body: el(
          "div.stack",
          el("div", el("label.field-label", "Source"), el("div.mono.selectable", { style: { wordBreak: "break-all" } }, origin)),
          el(
            "div",
            el("label.field-label", "Copy into sim/worlds/ as"),
            el("div.row", textInput(model, "name"), el("span.unit", ".sdf"))
          ),
          el("div.doc", {
            html: `<p>Any <code>meshes/</code>, <code>materials/</code> or <code>models/</code> folder
                   sitting next to the source is copied too — a world whose meshes arrive without
                   their files opens grey, and the only trace is in stderr.</p>
                   <p class="warn">After importing, check that the world declares
                   <code>&lt;world name="mars"&gt;</code> and carries the physics and scene-broadcaster
                   plugins. The library flags both for you.</p>`,
        })
        ),
        footer: (close) => [
          button("Cancel", { onclick: close }),
          button("Import", {
            variant: "primary",
            svg: "import-model.svg",
            onclick: async () => {
              try {
                const path = await invoke("sim_import_world", { origin, name: model.name.trim() });
                close();
                await reloadLibraries();
                savePrefs({ selectedWorld: path });
                navigate("worlds");
              } catch (e) {
                report(e);
              }
            },
          }),
        ],
      });
    },
  });
}
