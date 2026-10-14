// Help Topics: the full index of the contextual help.
//
// The same texts the "?" buttons open all over the app, readable straight
// through. A help system that can only be consulted by touching the right
// control cannot be read whole, and there are things here (the profiles, the
// clock, reflected inertia) worth reading before you need them.

import { el, fill } from "./../core.js";
import { HELP, renderTopic, topicsByGroup } from "./../help.js";
import { button } from "./../ui.js";

export function helpTopicsPage() {
  const groups = topicsByGroup();
  let current = "app.overview";

  const index = el("div", { style: { width: "268px", flexShrink: "0" } });
  const reader = el("div.panel", { style: { flex: "1", minWidth: "0" } });

  function drawReader() {
    fill(
      reader,
      el(
        "div.panel-title",
        el("img", { src: "icons/help.svg", width: 14, height: 14, alt: "" }),
        el("span.label", HELP[current]?.title ?? current),
        el("span.right", el("span.mono.dim", current))
      ),
      el("div.panel-body", renderTopic(el("div"), current))
    );
  }

  function drawIndex() {
    fill(
      index,
      ...groups.map((g) =>
        el(
          "div.bevel",
          { style: { marginBottom: "10px" } },
          el("div.bevel-title", el("span.label", g.name)),
          el(
            "div",
            ...g.topics.map((t) =>
              el(
                "div.list-row",
                {
                  data: { active: String(t.id === current) },
                  onclick: () => {
                    current = t.id;
                    drawIndex();
                    drawReader();
                  },
                },
                el("img", { src: "icons/help.svg", width: 14, height: 14, alt: "" }),
                el("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.title)
              )
            )
          )
        )
      )
    );
  }

  drawIndex();
  drawReader();

  return {
    title: "Help Topics",
    meta: `${Object.keys(HELP).length} topics`,
    actions: [
      button("Overview", {
        svg: "help.svg",
        sm: true,
        onclick: () => {
          current = "app.overview";
          drawIndex();
          drawReader();
        },
      }),
    ],
    body: el("div", { style: { display: "flex", gap: "14px", alignItems: "flex-start" } }, index, reader),
  };
}
