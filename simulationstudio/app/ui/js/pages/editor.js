// World Editor: the property tree that generates the SDF.
//
// Four tabs. **Properties** and **Props** edit the spec and regenerate the
// XML; **Source** edits the XML by hand; **Preview** shows what would come out
// of the spec without writing anything --- seeing the XML before saving it is
// the difference between trusting the generator and checking it.
//
// An EXTERNAL world (no .studio.json beside it) opens straight into Source,
// with the tree disabled. Regenerating a hand-written SDF from the little a
// regex can pull out of it would silently destroy someone else's work.

import { degrees, el, fill, invoke, noteRecent, radians, reloadLibraries, savePrefs, state } from "./../core.js";
import { navigate, refreshPage, report } from "./../shell.js";
import {
  button, checkbox, chip, colorInput, emptyState, modal, notice, numberAt, numberInput,
  prop, propGroup, propText, select, textInput,
} from "./../ui.js";
import { PRESET_PROPS, fuelGrid, newProp } from "./../worldspec.js";
import { newWorld } from "./worlds.js";

const ENGINES = [
  ["dart", "DART (default, verified)"],
  ["bullet-featherstone", "Bullet Featherstone"],
];

/**
 * What the generator will do with that number, said BEFORE saving it: the
 * grid that comes out and whether it has to stack. Without this, "60" and
 * "600" look the same in the editor, and the difference only shows up once
 * the world window is already open and crawling.
 */
function fuelNote(s) {
  if (!s.fuel) return "none";
  const { cols, rows, perLayer, layers } = fuelGrid(s.fuel, s.fuel_area);
  const grid = `${cols} × ${rows} grid`;
  return layers > 1 ? `${grid}, ${layers} layers (${perLayer} per layer)` : grid;
}

const SHAPES = [
  ["box", "Box"],
  ["cylinder", "Cylinder"],
  ["sphere", "Sphere"],
  ["mesh", "Mesh"],
];

export function editorPage(params) {
  const path = params?.path ?? state.openWorld ?? state.prefs.selectedWorld ?? state.prefs.world;
  const info = state.worlds.find((m) => m.path === path);

  if (!path || !info) {
    return {
      title: "World Editor",
      body: emptyState(
        "No world open",
        "Pick one in World Library, or create a new one"
      ),
      actions: [
        button("New world", { svg: "add.svg", sm: true, onclick: () => newWorld() }),
        button("World Library", { svg: "scene.svg", sm: true, onclick: () => navigate("worlds") }),
      ],
    };
  }

  state.openWorld = path;
  noteRecent(path);
  const body = el("div.stack");

  let spec = null;
  let dirty = false;
  let tab = state.prefs.editorTab ?? "props";

  // The generator's manifest, if this world has one, and what the user has
  // chosen so far. `null` while it has not been asked; `false` if there is
  // none.
  let generator = null;
  let values = {};
  let generatorOutput = "";

  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    drawAll();
  };

  // --- saving ----------------------------------------------------------------

  async function save() {
    try {
      await invoke("sim_save_world", { spec });
      dirty = false;
      await reloadLibraries();
      drawAll();
    } catch (e) {
      report(e);
    }
  }

  // --- loading ---------------------------------------------------------------

  (async () => {
    try {
      spec = await invoke("sim_world_spec", { path });
    } catch (e) {
      report(e);
    }
    try {
      generator = (await invoke("sim_generator", { path })) ?? false;
      if (generator) {
        for (const o of generator.options) values[o.name] = o.default;
        // A generated world is not edited with the tree: its useful tab is
        // this one.
        if (!spec) tab = "generator";
      }
    } catch (e) {
      generator = false;
      report(e);
    }
    if (!spec && !generator) tab = "source";
    drawAll();
  })();

  fill(body, el("div.empty-state", "Loading world…"));

  // --- drawing ---------------------------------------------------------------

  function drawAll() {
    const external = !spec;
    // The chosen tab is remembered across worlds, and "generator" only exists
    // on the ones with a script: without this, opening a normal world after a
    // generated one leaves the editor on a tab that is not there.
    if (tab === "generator" && !generator) tab = external ? "source" : "props";
    const tabBar = el(
      "div.tabs",
      ...[
        ["props", "Properties", "settings.svg", !external],
        ["objects", "Props & objects", "game-piece.svg", !external],
        ["generator", "Generator", "wizard.svg", Boolean(generator)],
        ["source", "Source (SDF)", "model-file.svg", true],
        ["preview", "Preview", "visible.svg", !external],
      ]
        .filter(([, , , visible]) => visible)
        .map(([id, label, svg]) =>
          el(
            "div.tab",
            {
              data: { active: String(tab === id) },
              onclick: () => {
                tab = id;
                savePrefs({ editorTab: id });
                drawAll();
              },
            },
            el("img", { src: `icons/${svg}`, width: 13, height: 13, alt: "" }),
            label
          )
        )
    );

    const content =
      tab === "generator" && generator ? generatorView()
      : external ? sourceView(path, true)
      : tab === "props" ? propertiesView()
      : tab === "objects" ? objectsView()
      : tab === "source" ? sourceView(path, false)
      : previewView();

    fill(
      body,
      external && generator
        ? notice(
            `This world is written by ${generator.script}. Change it from the Generator tab and press Generate — editing the XML by hand works, but the next Generate overwrites it.`,
            "info"
          )
        : external
        ? notice(
            "This is an external world: there is no .studio.json beside it, so the property tree cannot rewrite it. Edit the XML directly below — everything else about it works normally.",
            "warn"
          )
        : null,
      dirty ? notice("Unsaved changes. The .sdf on disk still holds the previous version.", "warn") : null,
      ...info.notes.map((n) => notice(n, "warn")),
      el("div", { style: { border: "1px solid var(--border-main)" } }, tabBar, el("div", { style: { padding: "0" } }, content))
    );
  }

  // --- tab: properties -------------------------------------------------------

  function propertiesView() {
    const s = spec;
    const onChange = () => markDirty();

    // Angles are edited in degrees even though the SDF stores them in
    // radians: a spawn heading is something people think about in degrees.
    // The conversion happens here and nowhere else.
    const poseAngle = (arr, i) =>
      el("input", {
        type: "number",
        step: 1,
        value: Number(degrees(arr[i]).toFixed(2)),
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) {
            arr[i] = radians(v);
            markDirty();
          }
        },
      });

    // The tree is only redrawn the FIRST time it gets dirty: redrawing it on
    // every keystroke would steal focus from the field being typed in. But
    // the FUEL count has to follow the number --- otherwise it says "8 × 3"
    // next to a 200 --- so this part is refreshed by hand in its own node.
    const fuelNoteNode = el("span", fuelNote(s));
    const fuelRows = el("div");

    const fuelFields = () =>
      s.fuel > 0
        ? [
            prop(
              "Staging zone",
              el(
                "div.row",
                numberAt(s.fuel_area, 0, { onchange: onFuelChange }),
                numberAt(s.fuel_area, 1, { onchange: onFuelChange })
              ),
              { help: "world.fuel.zone", indent: 1, unit: "m  ·  x y" }
            ),
            prop(
              "Zone centre",
              el(
                "div.row",
                numberAt(s.fuel_center, 0, { onchange: onChange }),
                numberAt(s.fuel_center, 1, { onchange: onChange })
              ),
              { help: "world.fuel.zone", indent: 1, unit: "m" }
            ),
            prop("Drop height", numberInput(s, "fuel_height", { step: 0.05, min: 0, onchange: onChange }), {
              help: "world.fuel.zone",
              indent: 1,
              unit: "m above the floor",
            }),
            s.fuel > 60
              ? notice(
                  `${s.fuel} FUEL is a lot of dynamic bodies. Watch the real-time factor: below ~0.95 the loop stops being representative, and this is the cheapest thing to cut.`,
                  "warn"
                )
              : null,
          ]
        : [];

    // The zone changes the grid but not which fields there are: redrawing
    // the whole container while typing inside it would take the focus away.
    function onFuelChange() {
      fill(fuelNoteNode, fuelNote(s));
      markDirty();
    }
    function refreshFuel() {
      fill(fuelNoteNode, fuelNote(s));
      fill(fuelRows, ...fuelFields());
    }
    fill(fuelRows, ...fuelFields());

    return el(
      "div",
      propGroup("World", "worlds.managed"),
      propText("File", `worlds/${s.file}.sdf`),
      prop("World name", el("span.row", el("span.mono", "mars"), chip("fixed")), { help: "worlds.name-mars" }),
      prop("Description", textInput(s, "description", { placeholder: "What this world is for", onchange: onChange })),

      propGroup("Physics", "world.physics.step"),
      prop("Step size", numberInput(s, "step", { step: 0.001, min: 0.0001, max: 0.1, onchange: onChange }), {
        help: "world.physics.step",
        unit: `s  ·  ${s.step > 0 ? Math.round(1 / s.step) : 0} Hz`,
      }),
      prop("Real-time factor", numberInput(s, "rtf", { step: 0.05, min: 0, onchange: onChange }), { help: "world.physics.rtf" }),
      prop("Engine", select(s, "physics_engine", ENGINES, { onchange: onChange }), { help: "world.physics.engine" }),
      prop("Gravity Z", numberInput(s, "gravity", { step: 0.1, onchange: onChange }), { help: "world.gravity", unit: "m/s²" }),

      propGroup("Ground", "world.ground"),
      prop("Ground plane", checkbox(s, "ground", { onchange: onChange }), { help: "world.ground" }),
      prop("Friction μ", numberInput(s, "friction", { step: 0.05, min: 0, onchange: onChange }), { help: "world.friction", indent: 1 }),
      prop("Friction μ2", numberInput(s, "friction2", { step: 0.05, min: 0, onchange: onChange }), { help: "world.friction", indent: 1 }),
      prop("Field length (X)", numberInput(s, "field_length", { step: 0.1, min: 0.1, onchange: onChange }), {
        help: "world.field-size",
        indent: 1,
        unit: "m",
      }),
      prop("Field width (Y)", numberInput(s, "field_width", { step: 0.1, min: 0.1, onchange: onChange }), {
        help: "world.field-size",
        indent: 1,
        unit: "m",
      }),
      prop("Ground colour", colorInput(s.ground_color, { onchange: onChange }), { indent: 1 }),

      propGroup("FRC field model", "world.field"),
      prop(
        "Field mesh",
        select(
          s,
          "field_mesh",
          [
            ["", "None"],
            ...(state.fields ?? []).filter((c) => c.installed).map((c) => [c.path, c.name]),
          ],
          { onchange: onChange }
        ),
        { help: "world.field" }
      ),
      // What the user needs to know when they see the robot in the middle: it
      // is not an error, Gazebo's frame is the CENTER's and the bridge is the
      // one that translates to WPILib's corner origin.
      prop(
        "Origin",
        el(
          "span.row",
          el("span.mono", "Gazebo (0, 0)"),
          el("span.dim", "="),
          el(
            "span.mono",
            `WPILib (${(s.field_length / 2).toFixed(2)}, ${(s.field_width / 2).toFixed(2)})`
          )
        ),
        { help: "world.field.origin", indent: 1 }
      ),
      s.field_mesh
        ? prop(
            "Mesh position",
            el(
              "div.row",
              numberAt(s.field_pose, 0, { onchange: onChange }),
              numberAt(s.field_pose, 1, { onchange: onChange }),
              numberAt(s.field_pose, 2, { onchange: onChange })
            ),
            { help: "world.field.origin", indent: 1, unit: "m" }
          )
        : null,
      s.field_mesh
        ? prop(
            "Mesh rotation",
            el("div.row", poseAngle(s.field_pose, 3), poseAngle(s.field_pose, 4), poseAngle(s.field_pose, 5)),
            { help: "world.field", indent: 1, unit: "deg" }
          )
        : null,
      s.field_mesh
        ? prop("Mesh scale", numberInput(s, "field_scale", { step: 0.01, min: 0.01, onchange: onChange }), {
            help: "world.field",
            indent: 1,
          })
        : null,

      propGroup("FUEL (game pieces)", "world.fuel"),
      prop("Count", numberInput(s, "fuel", { step: 1, min: 0, max: 456, onchange: () => { refreshFuel(); onChange(); } }), {
        help: "world.fuel",
        unit: fuelNoteNode,
      }),
      fuelRows,

      propGroup("Perimeter walls", "world.walls"),
      prop("Walls", checkbox(s, "walls", { onchange: onChange }), { help: "world.walls" }),
      prop("Height", numberInput(s, "wall_height", { step: 0.05, min: 0.01, onchange: onChange }), { indent: 1, unit: "m" }),
      prop("Thickness", numberInput(s, "wall_thickness", { step: 0.01, min: 0.01, onchange: onChange }), { indent: 1, unit: "m" }),

      propGroup("Lighting and scene", "world.lighting"),
      prop("Sun", checkbox(s, "sun", { onchange: onChange }), { help: "world.lighting" }),
      prop("Cast shadows", checkbox(s, "shadows", { onchange: onChange }), { indent: 1 }),
      prop("Intensity", numberInput(s, "sun_intensity", { step: 0.05, min: 0, max: 2, onchange: onChange }), { indent: 1 }),
      prop(
        "Direction",
        el(
          "div.row",
          numberAt(s.sun_direction, 0, { step: 0.1, onchange: onChange }),
          numberAt(s.sun_direction, 1, { step: 0.1, onchange: onChange }),
          numberAt(s.sun_direction, 2, { step: 0.1, onchange: onChange })
        ),
        { indent: 1, unit: "x y z" }
      ),
      prop("Ambient light", numberInput(s, "ambient", { step: 0.05, min: 0, max: 1, onchange: onChange }), { help: "world.scene" }),
      prop("Background", colorInput(s.background, { onchange: onChange }), { help: "world.scene" }),

      propGroup("Systems", "world.plugins"),
      prop("Physics", el("span.row", chip("always on", "ok"), el("span.dim", "gz-sim-physics-system")), { help: "world.plugins" }),
      prop("Scene broadcaster", el("span.row", chip("always on", "ok"), el("span.dim", "gz-sim-scene-broadcaster-system")), {
        help: "world.plugins",
      }),
      prop("User commands", checkbox(s, "user_commands", { onchange: onChange }), { help: "world.plugins" }),
      prop("Sensors (rendering)", checkbox(s, "sensors", { onchange: onChange }), { help: "world.sensors" }),
      prop("IMU", checkbox(s, "imu_system", { onchange: onChange }), { help: "robots.imu" }),
      prop(
        "Extra plugins",
        el("textarea", {
          rows: 2,
          placeholder: "One plugin filename per line",
          value: (s.extra_plugins ?? []).join("\n"),
          oninput: (e) => {
            s.extra_plugins = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean);
            markDirty();
          },
        }),
        { help: "world.plugins" }
      ),

      propGroup("Robot", "world.robot-include"),
      prop("Include URI", textInput(s, "robot_uri", { placeholder: "model://my-robot   (empty = robot defined inside the world)", onchange: onChange }), {
        help: "world.robot-include",
      }),
      prop(
        "Spawn position",
        el(
          "div.row",
          numberAt(s.robot_pose, 0, { onchange: onChange }),
          numberAt(s.robot_pose, 1, { onchange: onChange }),
          numberAt(s.robot_pose, 2, { onchange: onChange })
        ),
        { help: "world.pose", indent: 1, unit: "m" }
      ),
      prop(
        "Spawn rotation",
        el("div.row", poseAngle(s.robot_pose, 3), poseAngle(s.robot_pose, 4), poseAngle(s.robot_pose, 5)),
        { help: "world.pose", indent: 1, unit: "deg" }
      )
    );
  }

  // --- tab: props ------------------------------------------------------------

  function objectsView() {
    const s = spec;

    const add = () => {
      // The modal is built before it exists, so the close function is
      // captured by reference: without this the chosen row would have no way
      // to close the dialog that contains it.
      const dialog = {};
      const choose = (base) => {
        s.props.push(newProp(base, s.props.length + 1));
        dirty = true;
        dialog.close?.();
        drawAll();
      };
      Object.assign(
        dialog,
        modal({
          title: "Add prop",
          svg: "game-piece.svg",
          width: 460,
          body: el(
            "div",
            el("div.doc", {
              html: `<p>Loose objects in the world: game pieces, obstacles, ramps, a wall to drive into.
                     A <strong>static</strong> one is scenery and costs the solver nothing; a dynamic
                     one takes part in the physics and needs a sensible mass.</p>`,
            }),
            el(
              "div.bevel",
              { style: { marginTop: "10px" } },
              el("div.bevel-title", el("span.label", "Shape")),
              ...PRESET_PROPS.map((base) =>
                el(
                  "div.list-row",
                  { onclick: () => choose(base) },
                  el("img", { src: "icons/game-piece.svg", width: 15, height: 15, alt: "" }),
                  el("span", base.label),
                  el("span.desc", base.shape)
                )
              )
            )
          ),
          footer: (close) => [button("Cancel", { onclick: close })],
        })
      );
    };

    if (!s.props.length) {
      return el(
        "div",
        { style: { padding: "14px" } },
        el(
          "div.row",
          { style: { marginBottom: "12px" } },
          button("Add prop", { svg: "add-part.svg", variant: "primary", onclick: add })
        ),
        emptyState("No props in this world", "Game pieces, obstacles and scenery go here")
      );
    }

    return el(
      "div",
      el(
        "div.row",
        { style: { padding: "10px 12px", borderBottom: "1px solid var(--border-main)", background: "var(--bg-panel)" } },
        button("Add prop", { svg: "add-part.svg", variant: "primary", onclick: add }),
        el("span.dim", { style: { marginLeft: "auto", fontSize: "11px" } }, `${s.props.length} object${s.props.length === 1 ? "" : "s"}`)
      ),
      ...s.props.map((p, i) => propRow(p, i, s, markDirty, drawAll))
    );
  }

  // --- tab: generator --------------------------------------------------------
  //
  // The panel knows NONE of the options: it draws them from what the script
  // declares in its `--options`. Adding an option to the generator makes it
  // appear here on its own, which is the only way the window and the
  // terminal cannot drift apart.

  function generatorView() {
    // The helpers bind the control to the object: they write into
    // `values[name]` on their own, so no onchange is needed here.
    const control = (o) =>
      o.type === "bool" ? checkbox(values, o.name)
      : o.type === "choice" ? select(values, o.name, o.choices)
      : numberInput(values, o.name, { step: 1, min: o.min, max: o.max });

    // Each option's help goes UNDER its row and not in a tooltip: it is the
    // difference between "FUEL: 408" and "408 is all of them and the world
    // runs at half real time", which is exactly what you need to know before
    // choosing.
    const row = (o) => [
      prop(o.label ?? o.name, control(o), { unit: o.unit }),
      o.help
        ? el("div", { style: { padding: "0 12px 10px 12px", marginTop: "-6px" } },
            el("span.dim", { style: { fontSize: "11px" } }, o.help))
        : null,
    ];

    const output = el("pre.log", { style: { height: "150px", border: "none", borderRadius: "0" } },
      generatorOutput || "Nothing generated yet in this session.");

    const generate = async () => {
      try {
        generatorOutput = await invoke("sim_generate_world", { path, values });
        // The .sdf on disk changed: the library rereads it and the editor
        // with it.
        await reloadLibraries();
        drawAll();
      } catch (e) {
        generatorOutput = String(e.message ?? e);
        drawAll();
        report(e);
      }
    };

    return el(
      "div",
      el(
        "div.row",
        { style: { padding: "10px 12px", borderBottom: "1px solid var(--border-main)", background: "var(--bg-panel)" } },
        button("Generate", { svg: "publish.svg", variant: "primary", onclick: generate }),
        button("Defaults", {
          svg: "republish.svg",
          onclick: () => {
            for (const o of generator.options) values[o.name] = o.default;
            drawAll();
          },
        }),
        el("span.dim", { style: { marginLeft: "auto", fontSize: "11px" } },
          `${generator.script}  ·  writes ${(generator.generates ?? []).join(", ")}`)
      ),
      el(
        "div",
        propGroup("Options", "worlds.generator"),
        ...generator.options.flatMap(row),
        el("div", { style: { padding: "10px 12px 0 12px" } },
          el("span.dim", { style: { fontSize: "11px" } }, "Output")),
        output
      )
    );
  }

  // --- tab: source -----------------------------------------------------------

  function sourceView(path, external) {
    const area = el("textarea", { rows: 26, spellcheck: "false", style: { border: "none", borderRadius: "0" } }, "Loading…");
    let original = "";

    invoke("sim_read_text", { path })
      .then((t) => {
        original = t;
        area.value = t;
      })
      .catch((e) => {
        area.value = `Could not read ${path}:\n${e.message}`;
      });

    return el(
      "div",
      el(
        "div.row",
        { style: { padding: "10px 12px", borderBottom: "1px solid var(--border-main)", background: "var(--bg-panel)" } },
        button("Save SDF", {
          svg: "publish.svg",
          variant: "primary",
          onclick: async () => {
            try {
              await invoke("sim_write_text", { path, content: area.value });
              original = area.value;
              await reloadLibraries();
              refreshPage();
            } catch (e) {
              report(e);
            }
          },
        }),
        button("Revert", { svg: "republish.svg", onclick: () => (area.value = original) }),
        el(
          "span.dim",
          { style: { marginLeft: "auto", fontSize: "11px" } },
          external ? "External world — this is the only editor for it" : "Hand edits are overwritten if you save from Properties"
        )
      ),
      area
    );
  }

  // --- tab: preview ----------------------------------------------------------

  function previewView() {
    const pre = el("pre.log", { style: { height: "520px", border: "none", borderRadius: "0" } }, "Generating…");
    invoke("sim_preview_world", { spec })
      .then((sdf) => (pre.textContent = sdf))
      .catch((e) => (pre.textContent = e.message));
    return el(
      "div",
      el(
        "div.row",
        { style: { padding: "10px 12px", borderBottom: "1px solid var(--border-main)", background: "var(--bg-panel)" } },
        el("span.dim", { style: { fontSize: "11px" } }, "What Save would write. Nothing on disk has changed."),
        button("Copy", {
          svg: "copy-value.svg",
          sm: true,
          onclick: () => navigator.clipboard?.writeText(pre.textContent).catch(report),
          title: "Copy XML",
        })
      ),
      pre
    );
  }

  return {
    title: `World Editor — ${info.file}`,
    meta: spec === null && info.managed ? "" : info.managed ? "managed" : "external",
    help: "worlds.managed",
    actions: [
      button("Save", {
        svg: "publish.svg",
        variant: "primary",
        sm: true,
        onclick: () => (spec ? save() : null),
        title: "Write the .sdf and its .studio.json",
      }),
      button("Run this world", {
        svg: "play.svg",
        sm: true,
        onclick: () => {
          savePrefs({ world: path });
          navigate("launch");
        },
      }),
      button("Library", { svg: "scene.svg", sm: true, onclick: () => navigate("worlds") }),
    ],
    body,
  };
}

// --- a prop card ---------------------------------------------------------------

function propRow(p, i, spec, markDirty, redraw) {
  const dims =
    p.shape === "sphere"
      ? [["Radius", 0]]
      : p.shape === "cylinder"
      ? [["Radius", 0], ["Length", 1]]
      : [["Size X", 0], ["Size Y", 1], ["Size Z", 2]];

  const angle = (idx) =>
    el("input", {
      type: "number",
      step: 5,
      value: Number(degrees(p.pose[idx]).toFixed(2)),
      oninput: (e) => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) {
          p.pose[idx] = radians(v);
          markDirty();
        }
      },
    });

  return el(
    "div",
    { style: { borderBottom: "1px solid var(--border-main)" } },
    el(
      "div.prop-group",
      { style: { background: "var(--bg-panel-header)" } },
      el("img", { src: "icons/game-piece.svg", width: 12, height: 12, alt: "" }),
      p.name || `prop ${i + 1}`,
      el(
        "span",
        { style: { marginLeft: "auto", display: "flex", gap: "5px" } },
        button("Duplicate", {
          svg: "duplicate.svg",
          sm: true,
          onclick: () => {
            spec.props.splice(i + 1, 0, { ...structuredClone(p), name: `${p.name}_copy` });
            markDirty();
            redraw();
          },
        }),
        button("Remove", {
          svg: "delete.svg",
          sm: true,
          onclick: () => {
            spec.props.splice(i, 1);
            markDirty();
            redraw();
          },
        })
      )
    ),
    prop("Name", textInput(p, "name", { onchange: markDirty }), { help: "world.props", indent: 1 }),
    prop(
      "Shape",
      select(p, "shape", SHAPES, {
        onchange: () => {
          markDirty();
          redraw();
        },
      }),
      { indent: 1 }
    ),
    p.shape === "mesh"
      ? prop("Mesh URI", textInput(p, "mesh", { placeholder: "model://my-model/meshes/part.dae", onchange: markDirty }), {
          help: "guide.sdf-model",
          indent: 1,
        })
      : null,
    ...dims.map(([label, idx]) =>
      prop(p.shape === "mesh" ? `Scale ${["X", "Y", "Z"][idx]}` : label, numberAt(p.size, idx, { onchange: markDirty }), {
        indent: 2,
        unit: p.shape === "mesh" ? "×" : "m",
      })
    ),
    prop("Static", checkbox(p, "static", { onchange: markDirty }), { help: "world.props", indent: 1 }),
    p.static ? null : prop("Mass", numberInput(p, "mass", { step: 0.1, min: 0.001, onchange: markDirty }), { help: "world.props.mass", indent: 1, unit: "kg" }),
    prop(
      "Position",
      el(
        "div.row",
        numberAt(p.pose, 0, { onchange: markDirty }),
        numberAt(p.pose, 1, { onchange: markDirty }),
        numberAt(p.pose, 2, { onchange: markDirty })
      ),
      { help: "world.pose", indent: 1, unit: "m" }
    ),
    prop("Rotation", el("div.row", angle(3), angle(4), angle(5)), { help: "world.pose", indent: 1, unit: "deg" }),
    prop("Colour", colorInput(p.color, { onchange: markDirty }), { indent: 1 })
  );
}
