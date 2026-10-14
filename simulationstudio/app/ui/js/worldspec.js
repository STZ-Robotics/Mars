// World templates and default values.
//
// The spec sent to the backend has to match `studio::WorldSpec` FIELD BY
// FIELD. A name that does not match is not an error anywhere until serde
// fails at run time, with the window already open and the user pressing Save
// --- the same risk the test `the_ui_and_worldspec_speak_the_same_json`
// covers, with a literal copy of `defaultSpec()` below.

/** The FRC field, the same number `protocol/topics.toml` declares. */
export const FRC_FIELD = { length: 16.54, width: 8.21 };

/** FUEL radius, from `models/fuel/model.sdf`. */
export const FUEL_RADIUS = 0.075;

/**
 * The same grid `studio::worldgen::generate_fuel` seeds, so the count can be
 * shown before saving. Returns `{cols, rows, perLayer, layers}`.
 *
 * It is a deliberate copy of the Rust formula, like `FUEL_RADIUS`: the
 * generator is the truth and this only anticipates it. If they diverge, what
 * the editor shows stops describing what goes out to the SDF --- which is why
 * the test `the_grid_is_the_one_the_editor_shows` pins numbers that came
 * from running both.
 */
export function fuelGrid(n, area) {
  if (!n || n < 1) return { cols: 0, rows: 0, perLayer: 0, layers: 0 };

  const minPitch = 2 * FUEL_RADIUS + 0.02;
  const usableX = Math.max(area[0] - 2 * FUEL_RADIUS, 0);
  const usableY = Math.max(area[1] - 2 * FUEL_RADIUS, 0);
  const maxCols = Math.floor(usableX / minPitch) + 1;
  const maxRows = Math.floor(usableY / minPitch) + 1;

  const aspect = area[1] > 0 ? area[0] / area[1] : 1;
  const cols = Math.min(Math.max(Math.round(Math.sqrt(n * aspect)), 1), maxCols);
  const rows = Math.min(Math.max(Math.ceil(n / cols), 1), maxRows);
  const perLayer = cols * rows;
  return { cols, rows, perLayer, layers: Math.ceil(n / perLayer) };
}

export function defaultSpec(file = "new-world") {
  return {
    file,
    description: "",

    // 250 Hz: five physics steps per 20 ms WPILib cycle.
    step: 0.004,
    rtf: 1.0,
    physics_engine: "dart",
    gravity: -9.8,

    ground: true,
    friction: 0.9,
    friction2: 0.9,
    field_length: FRC_FIELD.length,
    field_width: FRC_FIELD.width,
    ground_color: [0.32, 0.33, 0.36, 1],

    // No field by default: one has to be installed first (Field Library).
    field_mesh: "",
    // The glTF comes Y-up and Gazebo is Z-up: 90 degrees of roll.
    field_pose: [0, 0, 0, Math.PI / 2, 0, 0],
    field_scale: 1,

    // FUEL with physics. The 456 the field mesh carries are scenery baked
    // into the glTF: no collision and no mass, so this number has nothing to
    // do with them. 0 = none.
    fuel: 0,
    // The NEUTRAL ZONE from the REBUILT manual (6.3.4.1): 206.0 x 72.0 in.
    fuel_area: [5.23, 1.83],
    fuel_center: [0, 0],
    fuel_height: 0,

    walls: true,
    wall_height: 0.5,
    wall_thickness: 0.1,

    sun: true,
    shadows: true,
    sun_direction: [-0.5, 0.1, -0.9],
    sun_intensity: 0.8,
    ambient: 0.4,
    background: [0.7, 0.75, 0.8],

    user_commands: true,
    sensors: false,
    imu_system: false,
    extra_plugins: [],

    robot_uri: "",
    robot_pose: [0, 0, 0.1, 0, 0, 0],

    props: [],
  };
}

/**
 * The templates of the "New world" dialog. Each one is a delta over the
 * default spec, not a whole spec: that way a new field does not have to be
 * added in four places.
 */
export const TEMPLATES = [
  {
    id: "frc",
    name: "FRC field",
    svg: "scene.svg",
    summary: "Carpet-sized ground with perimeter walls. The normal starting point.",
    delta: {},
  },
  {
    id: "frc-3d",
    name: "FRC field with 3D model",
    svg: "field3d.svg",
    summary: "The walled field plus the real FRC mesh as a visual. Needs a field installed.",
    // More ambient because the official mesh is dark: at 0.4 it looks leaden.
    delta: { ambient: 0.75 },
    wantsField: true,
  },
  {
    id: "frc-fuel",
    name: "FRC field with FUEL",
    svg: "game-piece.svg",
    summary: "The walled field plus 24 FUEL with physics, staged across the neutral zone.",
    // 24 is what fits comfortably in a single layer of the NEUTRAL ZONE and
    // does not punish the real-time factor. Raising it is a number in the
    // editor.
    delta: { ambient: 0.75, fuel: 24 },
    wantsField: true,
  },
  {
    id: "open",
    name: "Open field",
    svg: "grid.svg",
    summary: "Same ground, no walls — the robot can drive off the edge and keep going.",
    delta: { walls: false },
  },
  {
    id: "bench",
    name: "Test bench",
    svg: "measure.svg",
    summary: "Small 6 × 6 m floor for testing a single mechanism, with the IMU system on.",
    delta: { field_length: 6, field_width: 6, walls: true, wall_height: 0.3, imu_system: true },
  },
  {
    id: "zerog",
    name: "Zero gravity",
    svg: "axes.svg",
    summary: "No gravity. Isolates a mechanism's own dynamics from its weight while debugging.",
    delta: { gravity: 0, walls: false },
  },
  {
    id: "empty",
    name: "Empty world",
    svg: "model-file.svg",
    summary: "Physics, lighting and nothing else. For a world you will build up by hand.",
    delta: { ground: false, walls: false, user_commands: false },
  },
];

/**
 * `defaultField` is the path of the first installed field, if there is one;
 * only the templates that ask for it use it.
 */
export function specFromTemplate(id, file, defaultField = "") {
  const p = TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[0];
  const spec = { ...defaultSpec(file), ...p.delta, file };
  if (p.wantsField && defaultField) spec.field_mesh = defaultField;
  return spec;
}

/** The props the "Add prop" button offers, already sized. */
export const PRESET_PROPS = [
  { label: "Box", shape: "box", size: [0.3, 0.3, 0.3], mass: 2, color: [0.8, 0.5, 0.2, 1] },
  { label: "Crate (0.5 m)", shape: "box", size: [0.5, 0.5, 0.5], mass: 6, color: [0.62, 0.45, 0.25, 1] },
  { label: "Cylinder", shape: "cylinder", size: [0.15, 0.4, 0], mass: 1.5, color: [0.25, 0.45, 0.8, 1] },
  { label: "Ball", shape: "sphere", size: [0.12, 0, 0], mass: 0.27, color: [0.85, 0.35, 0.2, 1] },
  { label: "Wall segment", shape: "box", size: [2, 0.1, 0.6], mass: 0, color: [0.3, 0.3, 0.34, 1], static: true },
  { label: "Mesh (.dae/.stl)", shape: "mesh", size: [1, 1, 1], mass: 1, color: [0.6, 0.6, 0.65, 1] },
];

export function newProp(base, n) {
  return {
    name: `${base.shape}_${n}`,
    shape: base.shape,
    size: [...base.size],
    mass: base.mass,
    static: Boolean(base.static),
    pose: [1, 0, base.shape === "sphere" ? base.size[0] : (base.size[2] || base.size[1]) / 2, 0, 0, 0],
    color: [...base.color],
    mesh: "",
  };
}
