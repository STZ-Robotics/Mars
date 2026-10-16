import React, { useMemo, useState } from "react"
import { TopicAnnounce } from "../../store/appStore"
import { useStructSchemaStore } from "../../store/structSchemaStore"
import { useTableTypeStore } from "../../store/tableTypeStore"
import { useNTSnapshot } from "../../utils/nt/useNTSnapshot"
import { classifyTopic } from "../../utils/dashboard/topicClassification"
import { arrayLengthOf, formatArrayElement, formatTopicValue } from "../../utils/dashboard/valuePreview"

interface Props {
  topics: Map<string, TopicAnnounce>
  // Optional filter: if provided, only the topics it returns true for are
  // draggable (the rest are shown dimmed). No filter = the original behavior
  // (everything with a topic of its own is draggable).
  dragFilter?: (topic: TopicAnnounce) => boolean
  // Makes nodes WITHOUT a topic of their own (folders) draggable. If it returns
  // a string, that node can be dragged and the string travels as "topicType"
  // (e.g. "Mechanism2d", which in NT4 is a whole table and not a topic).
  folderDragType?: (fullPath: string) => string | null
}

interface TreeNode {
  name: string
  fullPath: string
  topic?: TopicAnnounce
  children: Map<string, TreeNode>
}

// Subtopics starting with "." are WPILib metadata (.type, .controllable,
// .instance) and ".schema" is the struct descriptor registry. None of it is
// dragged or read: it only clutters the tree. What is useful about ".type" is
// already shown as a label next to the table.
function isMetadataSegment(name: string): boolean {
  return name.startsWith(".")
}

// Natural order: "Module10" goes AFTER "Module9", not before. The order the
// Map carries is the announces' arrival order, which is arbitrary.
function sortNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

function sortTree(node: TreeNode): TreeNode {
  const sorted = new Map<string, TreeNode>()
  Array.from(node.children.keys())
    .sort(sortNames)
    .forEach(key => sorted.set(key, sortTree(node.children.get(key)!)))
  node.children = sorted
  return node
}

/**
 * Topics to ask the backend for NOW: only those of the rows that are
 * rendered. Before, every struct-array in the log was polled at 1Hz even
 * with the tree closed.
 */
function collectVisibleTopics(root: TreeNode, expanded: Set<string>): string[] {
  const out: string[] = []
  const walk = (node: TreeNode) => {
    node.children.forEach(child => {
      if (child.topic) out.push(child.topic.name)
      if (expanded.has(child.fullPath)) walk(child)
    })
  }
  walk(root)
  return out
}

export default function TreeDirectory({ topics, dragFilter, folderDragType }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Subscriptions to re-render when a new schema arrives (it changes which
  // structs can be expanded) or a table's ".type".
  const dynamicDefs = useStructSchemaStore(s => s.defs)
  const tableTypes = useTableTypeStore(s => s.types)

  const tree = useMemo(() => {
    const root: TreeNode = { name: "Root", fullPath: "", children: new Map() }

    topics.forEach(topic => {
      const parts = topic.name.split("/").filter(Boolean)
      if (parts.some(isMetadataSegment)) return

      let currentNode = root
      parts.forEach((part, index) => {
        if (!currentNode.children.has(part)) {
          currentNode.children.set(part, {
            name: part,
            fullPath: "/" + parts.slice(0, index + 1).join("/"),
            children: new Map(),
          })
        }
        currentNode = currentNode.children.get(part)!

        // A node can have a topic of its own AND children at once (a table that
        // also publishes a value at its root); it has to stay a draggable leaf in
        // that case.
        if (index === parts.length - 1) currentNode.topic = topic
      })
    })

    return sortTree(root)
  }, [topics])

  const visibleTopics = useMemo(() => collectVisibleTopics(tree, expanded), [tree, expanded])
  // 250ms and not 33: it is supporting text, not an animation. useNTSnapshot
  // already decides whether to ask for the live value or the scrubbed instant's.
  const values = useNTSnapshot(visibleTopics, 250)

  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div style={{ padding: "1px 0", fontFamily: "'Segoe UI', Arial, sans-serif" }}>
      {Array.from(tree.children.values()).map((node, i) => (
        <TreeRow
          key={node.fullPath}
          node={node}
          level={0}
          rowIndex={i}
          expanded={expanded}
          onToggle={toggle}
          values={values}
          tableTypes={tableTypes}
          structDefs={dynamicDefs}
          dragFilter={dragFilter}
          folderDragType={folderDragType}
        />
      ))}
    </div>
  )
}

interface RowProps {
  node: TreeNode
  level: number
  /** Only for the striping; it does not have to be global, alternating among siblings is enough. */
  rowIndex: number
  expanded: Set<string>
  onToggle: (path: string) => void
  values: Record<string, any>
  tableTypes: Record<string, string>
  structDefs: Record<string, unknown>
  dragFilter?: (topic: TopicAnnounce) => boolean
  folderDragType?: (fullPath: string) => string | null
}

const ROW_HEIGHT = 18
const INDENT_PX = 13

function TreeRow(props: RowProps) {
  const { node, level, rowIndex, expanded, onToggle, values, tableTypes, dragFilter, folderDragType } = props
  const [hovered, setHovered] = useState(false)

  const isOpen = expanded.has(node.fullPath)
  const topic = node.topic
  const liveValue = topic ? values[topic.name] : undefined

  const classification = topic ? classifyTopic(topic.topic_type) : null
  const arrayLength = topic && classification?.isArrayType
    ? arrayLengthOf(topic.topic_type, liveValue)
    : null

  const hasRealChildren = node.children.size > 0
  const canExpandArray = arrayLength !== null && arrayLength > 0
  const isExpandable = hasRealChildren || canExpandArray

  const passesFilter = !!topic && (!dragFilter || dragFilter(topic))

  // A folder can represent something consumable even if it is not a topic: a
  // Field2d or Mechanism2d table. `folderDragType` says whether THIS page
  // accepts it; `tableTypes` says what it is, so it is always labeled.
  const folderType = !topic && folderDragType ? folderDragType(node.fullPath) : null
  const tableType = !topic ? tableTypes[node.fullPath] : undefined
  const isDraggable = passesFilter || folderType !== null

  const valueText = topic ? formatTopicValue(topic.topic_type, liveValue) : null

  const handleDragStart = (e: React.DragEvent) => {
    if (topic) {
      e.dataTransfer.setData("topicName", topic.name)
      e.dataTransfer.setData("topicType", topic.topic_type)
    } else if (folderType) {
      e.dataTransfer.setData("topicName", node.fullPath)
      e.dataTransfer.setData("topicType", folderType)
    } else {
      return
    }
    e.dataTransfer.effectAllowed = "copy"
  }

  return (
    <div>
      <div
        onClick={() => isExpandable && onToggle(node.fullPath)}
        draggable={isDraggable}
        onDragStart={isDraggable ? handleDragStart : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex", alignItems: "center", gap: 3,
          height: ROW_HEIGHT, paddingRight: 6, paddingLeft: 3 + level * INDENT_PX,
          cursor: isDraggable ? "grab" : isExpandable ? "pointer" : "default",
          userSelect: "none", whiteSpace: "nowrap",
          background: hovered ? "var(--tree-hover-bg)" : rowIndex % 2 === 1 ? "var(--bg-panel)" : "transparent",
          opacity: topic && !passesFilter ? 0.45 : 1,
        }}
      >
        {/* The arrow is the only thing that tells a folder from a leaf in
            18px rows, so it goes in the text color and not light grey:
            before, it was barely visible over the striping. */}
        <span style={{
          width: 12, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
          color: isExpandable ? "var(--text-primary)" : "transparent", fontSize: 11,
        }}>
          {isExpandable && <i className={`ti ${isOpen ? "ti-caret-down-filled" : "ti-caret-right-filled"}`} />}
        </span>

        <span
          style={{
            fontSize: 11,
            fontWeight: topic ? 400 : 600,
            color: "var(--text-primary)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            flexShrink: 1, minWidth: 0,
          }}
        >
          {node.name}
          {topic && (
            <span style={{ fontStyle: "normal", color: "var(--text-muted)" }}>
              {" – "}{topic.topic_type}
              {arrayLength !== null && `[${arrayLength}]`}
            </span>
          )}
          {/* A sendable table (Field2d, Mechanism2d, chooser...) no longer
              looks like any other folder: it says what it is even if this
              page cannot consume it. */}
          {!topic && (folderType ?? tableType) && (
            <span style={{ fontStyle: "normal", color: "var(--mars-accent)" }}> – {folderType ?? tableType}</span>
          )}
        </span>

        {valueText !== null && (
          <span
            title={valueText}
            style={{
              marginLeft: "auto", flexShrink: 0, maxWidth: "50%", paddingLeft: 8,
              fontSize: 10, fontFamily: "ui-monospace, monospace",
              color: "var(--text-muted)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {valueText}
          </span>
        )}
      </div>

      {isOpen && (
        <div>
          {Array.from(node.children.values()).map((child, i) => (
            <TreeRow {...props} key={child.fullPath} node={child} level={level + 1} rowIndex={i} />
          ))}

          {canExpandArray && topic && (
            <ArrayIndexRows
              topic={topic}
              liveValue={liveValue}
              length={arrayLength!}
              level={level + 1}
              // Indices are draggable only where the page can receive them.
              // With a dragFilter set (Field, Swerve, Functions) the drop
              // ignores arrayIndex and would add the whole array.
              draggable={!dragFilter}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** How many indices are listed before cutting off; an array of 500 poses would hang the tree. */
const MAX_INDEX_ROWS = 128

// Synthetic rows 0..length-1 of any array (numeric, boolean, string or of
// structs), each one draggable on its own.
function ArrayIndexRows({ topic, liveValue, length, level, draggable }: {
  topic: TopicAnnounce
  liveValue: any
  length: number
  level: number
  draggable: boolean
}) {
  const shown = Math.min(length, MAX_INDEX_ROWS)

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData("topicName", topic.name)
    e.dataTransfer.setData("topicType", topic.topic_type)
    e.dataTransfer.setData("arrayIndex", String(index))
    e.dataTransfer.effectAllowed = "copy"
  }

  return (
    <>
      {Array.from({ length: shown }, (_, i) => {
        const text = formatArrayElement(topic.topic_type, liveValue, i)
        return (
          <div
            key={i}
            draggable={draggable}
            onDragStart={draggable ? e => handleDragStart(e, i) : undefined}
            style={{
              display: "flex", alignItems: "center", gap: 3,
              height: ROW_HEIGHT, paddingRight: 6, paddingLeft: 3 + level * INDENT_PX,
              cursor: draggable ? "grab" : "default", userSelect: "none", whiteSpace: "nowrap",
              background: i % 2 === 1 ? "var(--bg-panel)" : "transparent",
              opacity: draggable ? 1 : 0.45,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--tree-hover-bg)")}
            onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 1 ? "var(--bg-panel)" : "transparent")}
          >
            <span style={{ width: 12, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0, fontFamily: "ui-monospace, monospace" }}>
              [{i}]
            </span>
            {text !== null && (
              <span
                title={text}
                style={{
                  marginLeft: "auto", flexShrink: 1, minWidth: 0, maxWidth: "72%", paddingLeft: 8,
                  fontSize: 10, fontFamily: "ui-monospace, monospace",
                  color: "var(--text-muted)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
              >
                {text}
              </span>
            )}
          </div>
        )
      })}

      {length > shown && (
        <div style={{ height: ROW_HEIGHT, display: "flex", alignItems: "center", paddingLeft: 17 + level * INDENT_PX, fontSize: 10, color: "var(--text-muted)", fontStyle: "italic" }}>
          … {length - shown} more
        </div>
      )}
    </>
  )
}
