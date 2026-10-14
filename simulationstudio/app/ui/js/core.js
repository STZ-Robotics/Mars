// What everything else uses: talking to the backend, building nodes and
// keeping the session state.
//
// The app carries no bundler and no framework on purpose (see app/README.md),
// so a "component" here is a function that returns an HTMLElement. That is
// enough: pages are redrawn whole when their model changes, and the only
// things refreshed every 700 ms are three status fields and the logs, which
// are updated per node and not per page.

// --- bridge to the app process -------------------------------------------

// `withGlobalTauri: true` in tauri.conf.json is what injects this. Without a
// bundler there is no other way to reach the commands.
export const tauriReady = Boolean(window.__TAURI__);
const rawInvoke = tauriReady ? window.__TAURI__.core.invoke : null;

/**
 * Calls a backend command.
 *
 * Commands return `Err(String)` and Tauri turns it into a reject with a
 * string: it is re-thrown as an Error so a normal `catch` finds `.message`
 * where it expects it.
 */
export async function invoke(cmd, args) {
  if (!rawInvoke) throw new Error("The app process is not reachable (withGlobalTauri is off).");
  try {
    return await rawInvoke(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e?.message ?? String(e));
  }
}

// --- session state -------------------------------------------------------

export const state = {
  options: null,        // { worlds, robots, sim_dir, conda_dir, version }
  worlds: [],           // WorldInfo[]
  robots: [],           // RobotInfo[]
  fields: [],           // FieldInfo[]
  prefs: {},            // what is saved in build/studio-prefs.json
  sim: null,            // the supervisor's last Status
  page: "launch",
  openWorld: null,      // relative path of the world open in the editor
};

/** Reloads the world and robot libraries from disk. */
export async function reloadLibraries() {
  const [worlds, robots, fields] = await Promise.all([
    invoke("sim_worlds"),
    invoke("sim_robots"),
    invoke("sim_fields"),
  ]);
  state.worlds = worlds;
  state.robots = robots;
  state.fields = fields;
}

/**
 * Saves the preferences. It is called on every change (they are four fields
 * and a tiny file), but calls are batched in case something fires several in
 * a row.
 */
let pending = null;
export function savePrefs(changes) {
  Object.assign(state.prefs, changes);
  clearTimeout(pending);
  pending = setTimeout(() => {
    invoke("sim_save_prefs", { prefs: state.prefs }).catch(() => {
      // Losing a preference does not justify interrupting the user.
    });
  }, 180);
}

/**
 * The keys `studio-prefs.json` used before they were renamed into English,
 * mapped to the new ones. The file lives on each user's disk, so without this
 * an update would silently forget their recent worlds and their last
 * selection. The old key is dropped once it has been carried over.
 */
const OLD_PREF_KEYS = {
  ultimaPagina: "lastPage",
  mundo: "world",
  mundoSeleccionado: "selectedWorld",
  robotSeleccionado: "selectedRobot",
  recientes: "recent",
  mostrarBienvenida: "showWelcome",
  consola: "console",
};

export function migratePrefs(prefs) {
  const out = { ...prefs };
  for (const [old, current] of Object.entries(OLD_PREF_KEYS)) {
    if (old in out) {
      if (!(current in out)) out[current] = out[old];
      delete out[old];
    }
  }
  // The Console page's settings are an object of their own, with keys that
  // were renamed too.
  const c = out.console;
  if (c && typeof c === "object") {
    out.console = {
      lines: c.lines ?? c.lineas ?? 120,
      filter: c.filter ?? c.filtro ?? "",
      frozen: c.frozen ?? c.congelado ?? false,
    };
  }
  return out;
}

/**
 * Marks a world as recently used, for the welcome portal's list. The path is
 * stored, not the object: the world may have been deleted between sessions
 * and the list checks it when drawn.
 */
export function noteRecent(path) {
  if (!path) return;
  const previous = (state.prefs.recent ?? []).filter((r) => r !== path);
  savePrefs({ recent: [path, ...previous].slice(0, 6) });
}

// --- building nodes --------------------------------------------------------

/**
 * `el("div.panel", { onclick }, child, "text")`.
 *
 * The selector accepts `tag.class.class#id`. Object keys starting with `on`
 * are listeners, `data` and `style` are objects, and the rest are
 * attributes. A `null`/`undefined`/`false` value omits the attribute, which
 * is what allows writing `disabled: cond` without branches.
 */
export function el(selector, props, ...children) {
  const [tagAndClasses, id] = selector.split("#");
  const parts = tagAndClasses.split(".");
  const node = document.createElement(parts[0] || "div");
  for (const c of parts.slice(1)) node.classList.add(c);
  if (id) node.id = id;

  // The second argument is props only if it is a plain object. Without this
  // check, `el("span", 1)` treats the 1 as props, `Object.entries(1)` yields
  // nothing and the number disappears: a row that says "Real-time factor"
  // with the value blank, without any error.
  const isProps =
    props !== null && props !== undefined &&
    typeof props === "object" && !props.nodeType && !Array.isArray(props);
  if (!isProps) {
    children.unshift(props);
    props = null;
  }

  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "data") for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else if (k === "style") Object.assign(node.style, v);
    else if (k === "html") node.innerHTML = v;
    else if (k === "value") node.value = v;
    else if (k === "checked") node.checked = Boolean(v);
    else node.setAttribute(k, v === true ? "" : v);
  }

  append(node, children);
  return node;
}

function append(node, children) {
  for (const h of children.flat(4)) {
    if (h === null || h === undefined || h === false || h === true) continue;
    node.appendChild(h.nodeType ? h : document.createTextNode(String(h)));
  }
}

/** Empties a node and gives it new children. */
export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

/** `<img>` from `ui/icons/`. The icons are the same SVGs as mars-desktop. */
export function icon(name, size = 14) {
  return el("img", { src: `icons/${name}`, alt: "", "aria-hidden": true, width: size, height: size, draggable: "false" });
}

// --- formatting ------------------------------------------------------------

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function num(v, decimals = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toFixed(decimals).replace(/\.?0+$/, "") || "0";
}

export const degrees = (rad) => (rad * 180) / Math.PI;
export const radians = (deg) => (deg * Math.PI) / 180;

/** `[0.35, 0.35, 0.38]` (0..1, as in SDF) <-> `#5a5a61`. */
export function rgbToHex(c) {
  const b = (x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, "0");
  return `#${b(c[0])}${b(c[1])}${b(c[2])}`;
}
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Escapes text that goes into `innerHTML`. Logs and SDFs carry `<` and `&`. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
