import { useState, useEffect, useMemo, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { TopicAnnounce } from "../store/appStore"
import PageHeader from "../components/layout/PageHeader"
import PanelHeader from "../components/layout/PanelHeader"
import EmptyState from "../components/common/EmptyState"
import DangerButton from "../components/common/DangerButton"
import AlertBanner from "../components/common/AlertBanner"
import Panel from "../components/common/Panel"
import PropertyRow from "../components/common/PropertyRow"
import { propertyInputStyle } from "../styles/pageForm"

interface Props {
  projectName: string | null
  projectPath: string | null
  topics: Map<string, TopicAnnounce>
}

/** A Java line that is a candidate to be the one publishing the topic. */
interface SourceMatch {
  file: string
  path: string
  line: number
  kind: string
  snippet: string
  /** 0-100. The backend scores by whether literal table and key match. */
  confidence: number
}

interface TopicSourceResult {
  topic: string
  table: string
  key: string
  matches: SourceMatch[]
  /** Filled when MARS's jar publishes the topic and not the project. */
  note: string | null
}

/** From here on it jumps straight to the editor without asking. */
const DIRECT_JUMP_CONFIDENCE = 85

type TypeFilter = "all" | "numeric" | "boolean" | "string" | "struct" | "array"

function classify(topicType: string): TypeFilter {
  if (topicType.startsWith("struct:")) return "struct"
  if (topicType.endsWith("[]")) return "array"
  if (topicType === "boolean") return "boolean"
  if (topicType === "double" || topicType === "int" || topicType === "float") return "numeric"
  if (topicType.includes("string")) return "string"
  return "array"
}

function getTypeColor(topicType: string): string {
  const c = classify(topicType)
  if (c === "numeric") return "var(--type-numeric)"
  if (c === "boolean") return "var(--type-boolean)"
  if (c === "string") return "var(--type-string)"
  if (c === "struct") return "var(--type-struct)"
  return "var(--type-array)"
}

function formatLiveValue(v: any): string {
  if (v === undefined || v === null) return "—"
  if (v.Boolean !== undefined) return v.Boolean ? "TRUE" : "FALSE"
  if (v.Number !== undefined) return v.Number.toFixed(3)
  if (v.String !== undefined) return v.String
  if (v.NumberArray !== undefined) {
    const arr = v.NumberArray as number[]
    const preview = arr.slice(0, 4).map(n => n.toFixed(2)).join(", ")
    return `[${preview}${arr.length > 4 ? ", …" : ""}] (${arr.length})`
  }
  if (v.Raw !== undefined) return `<${(v.Raw as number[]).length} bytes>`
  return "—"
}

export default function TelemetryPage({ projectName, projectPath, topics }: Props) {
  const [searchQuery, setSearchQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [liveValues, setLiveValues] = useState<Record<string, any>>({})
  const [lookup, setLookup] = useState<{
    topic: string
    loading: boolean
    result: TopicSourceResult | null
    error: string | null
  } | null>(null)

  const topicsRef = useRef(topics)
  topicsRef.current = topics

  // A poll of live values for the whole table. A more relaxed interval than the
  // Dashboard's (here there can be hundreds of topics at once).
  useEffect(() => {
    if (topics.size === 0) { setLiveValues({}); return }
    let active = true

    const poll = async () => {
      if (!active) return
      try {
        const names = Array.from(topicsRef.current.keys())
        const data: Record<string, any> = await invoke("get_live_values", { topicNames: names })
        if (active) setLiveValues(data)
      } catch (e) { /* silencioso: puede pasar mientras se reconecta */ }
      if (active) setTimeout(poll, 150)
    }
    poll()
    return () => { active = false }
  }, [topics.size])

  const openMatch = async (match: SourceMatch) => {
    try {
      await invoke("open_in_editor", { path: match.path, line: match.line })
      setLookup(null)
    } catch (e) {
      setLookup(prev => (prev ? { ...prev, error: String(e) } : prev))
    }
  }

  // A single clear candidate opens on its own; if there is a tie or doubts they
  // are all shown, because the resolver is a regex scan and can be wrong.
  const handleGoTo = async (topicName: string) => {
    if (!projectPath) return
    setLookup({ topic: topicName, loading: true, result: null, error: null })
    try {
      const result = await invoke<TopicSourceResult>("find_topic_source", {
        projectPath,
        topic: topicName,
      })
      const [best, second] = result.matches
      const unambiguous =
        best && best.confidence >= DIRECT_JUMP_CONFIDENCE &&
        (!second || second.confidence < best.confidence)

      if (unambiguous && !result.note) {
        await openMatch(best)
        return
      }
      setLookup({ topic: topicName, loading: false, result, error: null })
    } catch (e) {
      setLookup({ topic: topicName, loading: false, result: null, error: String(e) })
    }
  }

  const typeCounts = useMemo(() => {
    const counts: Record<TypeFilter, number> = { all: 0, numeric: 0, boolean: 0, string: 0, struct: 0, array: 0 }
    topics.forEach(t => { counts.all++; counts[classify(t.topic_type)]++ })
    return counts
  }, [topics])

  const groupedTopics = useMemo(() => {
    const groups = new Map<string, TopicAnnounce[]>()

    const filtered = Array.from(topics.values()).filter(t => {
      if (searchQuery.trim() !== "" && !t.name.toLowerCase().includes(searchQuery.toLowerCase())) return false
      if (typeFilter !== "all" && classify(t.topic_type) !== typeFilter) return false
      return true
    })

    filtered.forEach(topic => {
      const parts = topic.name.split("/").filter(Boolean)
      const rootFolder = parts.length > 0 ? parts[0] : "Root"
      if (!groups.has(rootFolder)) groups.set(rootFolder, [])
      groups.get(rootFolder)!.push(topic)
    })

    groups.forEach(list => list.sort((a, b) => a.name.localeCompare(b.name)))
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [topics, searchQuery, typeFilter])

  const toggleGroup = (name: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  const hasActiveFilters = searchQuery !== "" || typeFilter !== "all"

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      {/* SIDEBAR */}
      <div style={{ width: 300, background: "var(--bg-panel)", borderRight: "1px solid var(--border-main)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <PageHeader
          eyebrow="NetworkTables 4"
          title="Telemetry Tree"
          subtitle={
            <>
              Project: <span style={{ color: "var(--mars-accent)", fontWeight: 600 }}>{projectName ? projectName.toUpperCase() : "NONE"}</span><br />
              Live variable inspector
            </>
          }
        />

        <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 24, overflowY: "auto" }}>

          <Panel title="Filters" icon="ti-filter">
            <div>
              <PropertyRow label="Search topics">
                <input
                  type="text"
                  placeholder="e.g. Pose, Speed..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={propertyInputStyle}
                />
              </PropertyRow>
              <PropertyRow label="Data type">
                <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as TypeFilter)} style={propertyInputStyle}>
                  <option value="all">All Types ({typeCounts.all})</option>
                  <option value="numeric">Numeric ({typeCounts.numeric})</option>
                  <option value="boolean">Boolean ({typeCounts.boolean})</option>
                  <option value="string">String ({typeCounts.string})</option>
                  <option value="struct">Struct ({typeCounts.struct})</option>
                  <option value="array">Array ({typeCounts.array})</option>
                </select>
              </PropertyRow>
            </div>
            {hasActiveFilters && (
              <div style={{ padding: 8 }}>
                <DangerButton onClick={() => { setSearchQuery(""); setTypeFilter("all") }}>
                  CLEAR ALL FILTERS
                </DangerButton>
              </div>
            )}
          </Panel>

          <Panel title="Topic Statistics" icon="ti-chart-bar">
            <div>
              <PropertyRow label="Total variables"><span>{topics.size}</span></PropertyRow>
              <PropertyRow label="Groups detected"><span>{groupedTopics.length}</span></PropertyRow>
              <PropertyRow label="Numeric"><span style={{ color: "var(--status-sim)" }}>{typeCounts.numeric}</span></PropertyRow>
              <PropertyRow label="Boolean"><span style={{ color: "var(--mars-red)" }}>{typeCounts.boolean}</span></PropertyRow>
              <PropertyRow label="String"><span style={{ color: "var(--type-string)" }}>{typeCounts.string}</span></PropertyRow>
              <PropertyRow label="Struct"><span style={{ color: "var(--type-struct)" }}>{typeCounts.struct}</span></PropertyRow>
              <PropertyRow label="Array"><span style={{ color: "var(--type-array)" }}>{typeCounts.array}</span></PropertyRow>
            </div>
          </Panel>

        </div>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <PanelHeader
          title="Robot Data Hierarchy"
          meta={topics.size > 0 ? `${topics.size} live topics · updating` : "waiting for NetworkTables data"}
          action={topics.size > 0 && (
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--status-sim)" }} />
          )}
        />

        <div style={{ flex: 1, padding: "24px 24px 40px", overflowY: "auto" }}>
          <div style={{ width: "100%", maxWidth: 1100, margin: "0 auto" }}>

            {topics.size === 0 ? (
              <EmptyState
                icon="ti-broadcast"
                padding="80px 40px"
                message="Waiting for NetworkTables data..."
                hint="Connect to the robot or simulation to see variables."
              />
            ) : groupedTopics.length === 0 ? (
              <EmptyState message="No topics match your current filters." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {groupedTopics.map(([groupName, groupTopics]) => {
                  const isCollapsed = collapsed.has(groupName)
                  return (
                    <div key={groupName} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)", borderRadius: 4, overflow: "hidden" }}>

                      <div
                        onClick={() => toggleGroup(groupName)}
                        style={{ background: "var(--bg-input)", padding: "10px 16px", borderBottom: isCollapsed ? "none" : "1px solid var(--border-light)", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
                      >
                        <i className={`ti ${isCollapsed ? "ti-chevron-right" : "ti-chevron-down"}`} style={{ color: "var(--text-muted)", fontSize: 14 }} />
                        <i className="ti ti-folder" style={{ color: "var(--mars-accent)", fontSize: 16 }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{groupName}</span>
                        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", background: "var(--bg-page)", padding: "2px 6px", borderRadius: 3 }}>
                          {groupTopics.length} topics
                        </span>
                      </div>

                      {!isCollapsed && (
                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                          <thead>
                            <tr style={{ background: "var(--bg-page)", borderBottom: "1px solid var(--border-main)" }}>
                              <th style={theadStyle}>NAME</th>
                              <th style={{ ...theadStyle, width: 130 }}>TYPE</th>
                              <th style={{ ...theadStyle, width: 60, textAlign: "right" }}>ID</th>
                              <th style={{ ...theadStyle, width: 220, textAlign: "right" }}>LIVE VALUE</th>
                              {projectPath && <th style={{ ...theadStyle, width: 70, textAlign: "right" }}>SOURCE</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {groupTopics.map((topic, i) => (
                              <tr key={topic.id} style={{ borderBottom: "1px solid var(--border-light)", background: i % 2 === 0 ? "var(--bg-panel)" : "var(--bg-input)" }}>
                                <td style={{ ...tdStyle, fontFamily: "monospace", wordBreak: "break-all" }}>
                                  {topic.name.replace(`/${groupName}/`, "") || topic.name}
                                </td>
                                <td style={tdStyle}>
                                  <span style={{
                                    fontSize: 10, fontWeight: 600, color: getTypeColor(topic.topic_type),
                                    background: "var(--bg-page)", padding: "2px 6px", borderRadius: 3, border: "1px solid var(--border-main)"
                                  }}>
                                    {topic.topic_type}
                                  </span>
                                </td>
                                <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)", fontSize: 10 }}>{topic.id}</td>
                                <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace", color: "var(--text-primary)", fontWeight: 600 }}>
                                  {formatLiveValue(liveValues[topic.name])}
                                </td>
                                {projectPath && (
                                  <td style={{ ...tdStyle, textAlign: "right" }}>
                                    <button
                                      onClick={() => handleGoTo(topic.name)}
                                      disabled={lookup?.loading && lookup.topic === topic.name}
                                      title={`Find where ${topic.name} is published`}
                                      style={{
                                        fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 3,
                                        background: "var(--bg-input)", border: "1px solid var(--border-main)",
                                        color: "var(--mars-accent)", cursor: "pointer", whiteSpace: "nowrap",
                                      }}
                                    >
                                      {lookup?.loading && lookup.topic === topic.name ? "..." : "GO TO"}
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

          </div>
        </div>
      </div>

      {lookup && !lookup.loading && (
        <SourceLookupOverlay
          topic={lookup.topic}
          result={lookup.result}
          error={lookup.error}
          onOpen={openMatch}
          onClose={() => setLookup(null)}
        />
      )}
    </div>
  )
}

// Shown when the resolver has no clear winner: several candidates with the same
// confidence, none, or a topic the framework actually publishes. Jumping blindly
// in those cases opens the wrong file.
function SourceLookupOverlay({ topic, result, error, onOpen, onClose }: {
  topic: string
  result: TopicSourceResult | null
  error: string | null
  onOpen: (match: SourceMatch) => void
  onClose: () => void
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 720, maxHeight: "80vh", overflowY: "auto",
          background: "var(--bg-panel)", border: "1px solid var(--border-dark)",
          borderRadius: 6, boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "12px 16px",
          background: "var(--bg-panel-header)", borderBottom: "1px solid var(--border-main)",
        }}>
          <i className="ti ti-code" style={{ fontSize: 14, color: "var(--text-muted)" }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Published by</span>
          <code style={{ fontSize: 11, color: "var(--mars-accent)" }}>{topic}</code>
          <button
            onClick={onClose}
            style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 16 }}>
          {error && <AlertBanner variant="error">{error}</AlertBanner>}

          {result?.note && (
            <div style={{ marginBottom: 12 }}>
              <AlertBanner variant="neutral" icon="ti-info-circle">{result.note}</AlertBanner>
            </div>
          )}

          {result && result.matches.length === 0 && !error && (
            <EmptyState
              padding="28px 20px"
              message="No publishing line found in this project."
              hint="The resolver reads NetworkIO.set, setEntry, @Signal and @Tunable with literal strings. A key built at runtime won't be found."
            />
          )}

          {result?.matches.map(match => (
            <button
              key={`${match.path}:${match.line}`}
              onClick={() => onOpen(match)}
              style={{
                display: "block", width: "100%", textAlign: "left", marginBottom: 8,
                background: "var(--bg-input)", border: "1px solid var(--border-main)",
                borderRadius: 4, padding: "10px 12px", cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--mars-accent)", fontFamily: "monospace" }}>
                  {match.kind}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{match.confidence}% match</span>
                <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                  {match.file}:{match.line}
                </span>
              </div>
              <code style={{ fontSize: 11, color: "var(--text-primary)", wordBreak: "break-all", display: "block" }}>
                {match.snippet}
              </code>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const theadStyle: React.CSSProperties = {
  padding: "8px 16px", fontSize: 10, fontWeight: 600, letterSpacing: 0.5, color: "var(--text-muted)", textAlign: "left"
}

const tdStyle: React.CSSProperties = {
  padding: "8px 16px", fontSize: 12, color: "var(--text-primary)"
}