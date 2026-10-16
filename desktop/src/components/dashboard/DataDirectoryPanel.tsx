import { ReactNode, useState } from "react"
import { TopicAnnounce } from "../../store/appStore"
import TreeDirectory from "./TreeDirectory"

interface Props {
  topics: Map<string, TopicAnnounce>
  /** Which types this page accepts; the rest are shown dimmed. */
  dragFilter?: (topic: TopicAnnounce) => boolean
  folderDragType?: (fullPath: string) => string | null
  /** Help line under the title (the types the page can receive). */
  hint?: ReactNode
  width?: number
}

const DEFAULT_WIDTH = 268
const COLLAPSED_WIDTH = 24

// RViz "Displays"-style dock: a title bar with icon + name + close button on
// the right, and the dense tree below. It replaces the 24px-padded PageHeader
// that spent three lines (eyebrow + title + subtitle) saying what the icon
// and one line already say.
export default function DataDirectoryPanel({
  topics, dragFilter, folderDragType, hint, width = DEFAULT_WIDTH,
}: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [hovered, setHovered] = useState(false)

  if (collapsed) {
    return (
      <div
        onClick={() => setCollapsed(false)}
        title="Show Data Directory"
        style={{
          width: COLLAPSED_WIDTH, flexShrink: 0, cursor: "pointer",
          background: "var(--bg-panel-header)",
          borderRight: "1px solid var(--border-dark)",
          display: "flex", flexDirection: "column", alignItems: "center",
          paddingTop: 5, gap: 8,
        }}
      >
        <img src="/icons/data-directory.svg" alt="" aria-hidden width={14} height={14} draggable={false} style={{ display: "block" }} />
        {/* The title, vertical: collapsed there is no width for anything else,
            but a mute rail does not say what is being hidden. */}
        <span style={{
          writingMode: "vertical-rl", fontSize: 10, letterSpacing: 0.5,
          color: "var(--text-muted)", userSelect: "none",
        }}>
          Data Directory
        </span>
      </div>
    )
  }

  return (
    <div style={{
      width, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
      background: "var(--tree-body-bg)",
      borderRight: "1px solid var(--border-dark)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 5,
        height: 22, padding: "0 4px 0 6px", flexShrink: 0,
        background: "var(--bg-panel-header)",
        borderBottom: "1px solid var(--bevel-dark)",
        borderTop: "1px solid var(--bevel-light)",
        userSelect: "none",
      }}>
        <img src="/icons/data-directory.svg" alt="" aria-hidden width={13} height={13} draggable={false} style={{ display: "block", flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", flex: 1, minWidth: 0 }}>
          Data Directory
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "ui-monospace, monospace", flexShrink: 0 }}>
          {topics.size}
        </span>
        <button
          onClick={() => setCollapsed(true)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          title="Hide Data Directory"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 15, height: 15, padding: 0, marginLeft: 2, flexShrink: 0,
            background: hovered ? "var(--status-error)" : "transparent",
            color: hovered ? "#ffffff" : "var(--text-muted)",
            border: "none", borderRadius: 2, cursor: "pointer",
          }}
        >
          <i className="ti ti-x" style={{ fontSize: 10 }} aria-hidden />
        </button>
      </div>

      {hint && (
        <div style={{
          fontSize: 9.5, color: "var(--text-muted)", lineHeight: 1.35,
          padding: "3px 7px", flexShrink: 0,
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border-light)",
        }}>
          {hint}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
        <TreeDirectory topics={topics} dragFilter={dragFilter} folderDragType={folderDragType} />
      </div>
    </div>
  )
}
