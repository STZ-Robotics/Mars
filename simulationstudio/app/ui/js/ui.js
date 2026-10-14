// The chrome's components, as functions that return nodes.
//
// They are the same ones mars-desktop has in React (Panel, PropertyRow,
// AlertBanner, EmptyState, StatusBadge, ToolbarButton) with the same look,
// but without a framework: this app carries no node toolchain, so a
// "component" is a function and the "props" are arguments.

import { el, icon } from "./core.js";
import { helpButton } from "./help.js";

// --- panels ----------------------------------------------------------------

/**
 * QDockWidget-style dockable panel (RViz's "Displays"/"Views"): a solid title
 * bar and the content below, all inside a thin border.
 *
 * `options.help` puts the "?" in the title bar; `options.actions` goes to its
 * right; `flush` removes the body's padding (lists and tables want it flush
 * with the border).
 */
export function panel(title, { svg, help, actions, flush } = {}, ...children) {
  return el(
    "div.panel",
    el(
      "div.panel-title",
      svg && icon(svg),
      el("span.label", title),
      el("span.right", help && helpButton(help), actions)
    ),
    el(flush ? "div.panel-body.flush" : "div.panel-body", ...children)
  );
}

/** Raised panel (classic QGroupBox), for the portal and the guides. */
export function bevel(title, { svg, help, actions } = {}, ...children) {
  return el(
    "div.bevel",
    el(
      "div.bevel-title",
      svg && icon(svg),
      el("span.label", title),
      el("span.right", help && helpButton(help), actions)
    ),
    ...children
  );
}

// --- property rows -----------------------------------------------------------

/** A 24 px `name | control` row, like RViz's property tree. */
export function prop(name, control, { help, indent = 0, unit } = {}) {
  return el(
    "div.prop",
    { data: { indent } },
    el("div.name", name, help && helpButton(help)),
    el("div.value", control, unit && el("span.unit", unit))
  );
}

/** Header of a group of property rows. */
export function propGroup(name, help) {
  return el("div.prop-group", name, help && helpButton(help));
}

/** Read-only row: value in monospace, no control. */
export function propText(name, value, options) {
  return prop(name, el("span.mono", value ?? "—"), options);
}

// --- bound controls ----------------------------------------------------------

/**
 * `<input type=number>` bound to `object[key]`.
 *
 * It never writes NaN: an empty or half-typed field leaves the model as it
 * was, instead of putting a NaN into it that goes out to the SDF and makes
 * the engine die while parsing.
 */
export function numberInput(object, key, { step = 0.01, min, max, onchange } = {}) {
  return el("input", {
    type: "number",
    value: object[key],
    step,
    min,
    max,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) {
        object[key] = v;
        onchange?.(v);
      }
    },
  });
}

/** Same, but on `array[i]` (poses, directions, sizes). */
export function numberAt(array, i, { step = 0.01, onchange } = {}) {
  return el("input", {
    type: "number",
    value: array[i],
    step,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) {
        array[i] = v;
        onchange?.(v);
      }
    },
  });
}

export function textInput(object, key, { placeholder, onchange } = {}) {
  return el("input", {
    type: "text",
    value: object[key] ?? "",
    placeholder,
    spellcheck: "false",
    oninput: (e) => {
      object[key] = e.target.value;
      onchange?.(e.target.value);
    },
  });
}

export function checkbox(object, key, { label, onchange } = {}) {
  const input = el("input", {
    type: "checkbox",
    checked: Boolean(object[key]),
    onchange: (e) => {
      object[key] = e.target.checked;
      onchange?.(e.target.checked);
    },
  });
  return label
    ? el("label", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", cursor: "pointer" } }, input, label)
    : input;
}

export function select(object, key, list, { onchange } = {}) {
  return el(
    "select",
    {
      onchange: (e) => {
        object[key] = e.target.value;
        onchange?.(e.target.value);
      },
    },
    ...list.map(([value, label]) =>
      el("option", { value, selected: String(object[key]) === String(value) }, label ?? value)
    )
  );
}

/** Color picker that speaks in 0..1 floats, like SDF. */
export function colorInput(array, { onchange } = {}) {
  const hex = (c) => {
    const b = (x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, "0");
    return `#${b(c[0])}${b(c[1])}${b(c[2])}`;
  };
  return el("input", {
    type: "color",
    value: hex(array),
    oninput: (e) => {
      const n = parseInt(e.target.value.slice(1), 16);
      array[0] = ((n >> 16) & 255) / 255;
      array[1] = ((n >> 8) & 255) / 255;
      array[2] = (n & 255) / 255;
      onchange?.();
    },
  });
}

// --- buttons -----------------------------------------------------------------

export function button(label, { svg, onclick, variant, disabled, title, sm } = {}) {
  const classes = ["btn", variant && `btn-${variant}`, sm && "btn-sm"].filter(Boolean).join(".");
  return el(`button.${classes}`, { type: "button", onclick, disabled, title: title ?? label }, svg && icon(svg), label);
}

// --- notices and empty states ------------------------------------------------

export function notice(message, variant = "error") {
  const svg = { ok: "status-ok.svg", warn: "status-warning.svg", info: "status-unknown.svg" }[variant] ?? "status-error.svg";
  return el("div.alert", { data: { variant } }, icon(svg), el("span", message));
}

export function emptyState(message, hint) {
  return el("div.empty-state", el("div", message), hint && el("div.hint", hint));
}

export function chip(label, tone) {
  return el("span.chip", { data: tone ? { tone } : {} }, label);
}

export function dot(tone) {
  return el("span.dot", { data: tone ? { tone } : {} });
}

// --- tabs --------------------------------------------------------------------

/**
 * Tab bar. `onChange(id)` is called with the chosen id; the caller decides
 * what to redraw.
 */
export function tabs(items, active, onChange) {
  return el(
    "div.tabs",
    ...items.map(([id, label, svg]) =>
      el(
        "div.tab",
        { data: { active: String(id === active) }, onclick: () => onChange(id) },
        svg && icon(svg, 13),
        label
      )
    )
  );
}

// --- modal -------------------------------------------------------------------

/**
 * Modal dialog. Returns `{ close, box }`.
 *
 * `footer` receives the close function so its buttons can close it, and
 * Escape always closes: a modal you cannot leave with Escape is a broken
 * modal.
 */
export function modal({ title, svg, width, className, body, footer, onClose }) {
  const box = el(`div.modal${className ? "." + className : ""}`, width ? { style: { width: `${width}px` } } : {});
  const layer = el("div.overlay", { onmousedown: (e) => { if (e.target === layer) close(); } }, box);

  function close() {
    layer.remove();
    document.removeEventListener("keydown", key);
    onClose?.();
  }
  function key(e) {
    if (e.key === "Escape") close();
  }

  box.append(
    el(
      "div.modal-title",
      svg && icon(svg),
      el("span", title),
      el("button.close", { type: "button", onclick: close, title: "Close" }, "✕")
    ),
    body instanceof HTMLElement && body.classList.contains("modal-body") ? body : el("div.modal-body", body)
  );
  if (footer) box.append(el("div.modal-footer", footer(close)));

  document.addEventListener("keydown", key);
  document.body.appendChild(layer);
  return { close, box };
}

/** Destructive confirmation. Never uses `window.confirm`: it breaks the look. */
export function confirmDialog({ title, message, okLabel = "Delete", onAccept }) {
  modal({
    title,
    svg: "status-warning.svg",
    width: 420,
    body: el("div.doc", el("p", message)),
    footer: (close) => [
      button("Cancel", { onclick: close }),
      button(okLabel, {
        variant: "stop",
        onclick: () => {
          close();
          onAccept();
        },
      }),
    ],
  });
}
