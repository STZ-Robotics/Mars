// The file picker.
//
// The app does not carry `tauri-plugin-dialog`: one more dependency to open
// a "pick an .sdf" box, which is its only use of the disk. It is done with
// `std::fs` on the Rust side (`studio::browse`) and this dialog on the UI
// side, which also fits the rest of the chrome --- a native Windows 11 picker,
// with its rounded corners, would look like a window from another program.

import { bytes, el, fill, icon, invoke } from "./core.js";
import { button, emptyState, modal, notice } from "./ui.js";

/**
 * Opens the picker. `filter` is extensions without the dot, lowercase
 * (`["sdf"]`); empty shows every file.
 *
 * Calls `onPick(absolutePath)` and closes.
 */
export function pickFile({ title = "Open file", filter = [], start = null, onPick }) {
  let dir = start;
  let selection = null;

  const pathText = el("span.p");
  const list = el("div.browser-list");
  const side = el("div.browser-side");
  const error = el("div", { style: { padding: "0 12px" } });
  const upButton = button("Up", { svg: "open-folder.svg", sm: true, onclick: () => goUp() });

  const body = el(
    "div.modal-body",
    { style: { padding: "0", display: "flex", flexDirection: "column", minHeight: "0", flex: "1" } },
    el("div.browser-path", upButton, pathText),
    error,
    el("div.browser-body", side, list)
  );

  let parent = null;
  const dialog = modal({
    title,
    svg: "open-folder.svg",
    className: "browser",
    body,
    footer: (close) => [
      el("span.left", el("span.mono.dim", { id: "browser-sel" }, "No file selected")),
      button("Cancel", { onclick: close }),
      button("Open", {
        variant: "primary",
        onclick: () => {
          if (!selection) return;
          close();
          onPick(selection);
        },
      }),
    ],
  });

  const selectionLabel = dialog.box.querySelector("#browser-sel");
  const openButton = dialog.box.querySelector(".modal-footer .btn-primary");
  openButton.disabled = true;

  function goUp() {
    if (parent) load(parent);
  }

  async function load(target) {
    try {
      const r = await invoke("sim_browse", { dir: target, filter });
      dir = r.dir;
      parent = r.parent;
      selection = null;
      selectionLabel.textContent = "No file selected";
      openButton.disabled = true;
      upButton.disabled = !parent;
      pathText.textContent = r.dir;
      fill(error);

      fill(
        side,
        ...r.shortcuts.map((a) =>
          el("div.tree-row", { onclick: () => load(a.path), title: a.path }, icon("open-folder.svg"), a.name)
        )
      );

      if (!r.entries.length) {
        fill(list, emptyState("This folder is empty", filter.length ? `filter: *.${filter.join(", *.")}` : null));
        return;
      }

      fill(
        list,
        ...r.entries.map((e) => {
          const row = el(
            "div.list-row",
            {
              title: e.path,
              // Double click enters the folder or confirms the file: it is
              // what any picker does and what the hand expects.
              ondblclick: () => {
                if (e.is_dir) load(e.path);
                else {
                  dialog.close();
                  onPick(e.path);
                }
              },
              onclick: () => {
                if (e.is_dir) return load(e.path);
                selection = e.path;
                selectionLabel.textContent = e.name;
                openButton.disabled = false;
                list.querySelectorAll(".list-row").forEach((f) => f.removeAttribute("data-active"));
                row.dataset.active = "true";
              },
            },
            icon(e.is_dir ? "open-folder.svg" : "model-file.svg"),
            el("span", e.name),
            !e.is_dir && el("span.desc", bytes(e.bytes))
          );
          return row;
        })
      );
    } catch (e) {
      fill(error, notice(e.message));
    }
  }

  load(dir);
}
