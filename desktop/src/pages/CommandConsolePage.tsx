import React, { useState, useEffect, useMemo, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { TopicAnnounce, ConnectionState } from "../store/appStore"
import PageHeader from "../components/layout/PageHeader"
import PanelHeader from "../components/layout/PanelHeader"
import EmptyState from "../components/common/EmptyState"
import AlertBanner from "../components/common/AlertBanner"
import Panel from "../components/common/Panel"
import PropertyRow from "../components/common/PropertyRow"
import { inputStyle, propertyInputStyle } from "../styles/pageForm"

interface Props {
  connection: ConnectionState
  topics: Map<string, TopicAnnounce>
}

type WritableType = "boolean" | "double" | "int" | "float" | "string"

function writableType(topicType: string): WritableType | null {
  if (topicType === "boolean") return "boolean"
  if (topicType === "double") return "double"
  if (topicType === "int") return "int"
  if (topicType === "float") return "float"
  if (topicType === "string") return "string"
  return null // arrays, structs and raw are not writable yet (see commands.rs)
}

interface CommandLogEntry {
  id: number
  time: number
  topicName: string
  value: string
  status: "ok" | "error"
  error?: string
}

function formatLiveValue(v: any): string {
  if (v === undefined || v === null) return "—"
  if (v.Boolean !== undefined) return v.Boolean ? "TRUE" : "FALSE"
  if (v.Number !== undefined) return String(v.Number)
  if (v.String !== undefined) return v.String
  return "—"
}

export default function CommandConsolePage({ connection, topics }: Props) {
  const [searchQuery, setSearchQuery] = useState("")
  const [liveValues, setLiveValues] = useState<Record<string, any>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [log, setLog] = useState<CommandLogEntry[]>([])
  const logIdRef = useRef(0)

  const isRealRobot = connection === "real"
  const isConnected = connection !== "disconnected"

  const writableTopics = useMemo(() => {
    return Array.from(topics.values())
      .filter(t => writableType(t.topic_type) !== null)
      .filter(t => searchQuery.trim() === "" || t.name.toLowerCase().includes(searchQuery.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [topics, searchQuery])

  const topicNamesKey = writableTopics.map(t => t.name).join("|")

  // Live readback, the same pattern as TelemetryPage: that way the operator sees
  // right away whether what they sent really took on the robot, not just that the
  // invoke did not throw.
  useEffect(() => {
    if (writableTopics.length === 0) { setLiveValues({}); return }
    let active = true
    const names = writableTopics.map(t => t.name)

    const poll = async () => {
      if (!active) return
      try {
        const data: Record<string, any> = await invoke("get_live_values", { topicNames: names })
        if (active) setLiveValues(data)
      } catch { /* silencioso: puede pasar mientras se reconecta */ }
      if (active) setTimeout(poll, 150)
    }
    poll()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicNamesKey])

  const pushLog = (entry: Omit<CommandLogEntry, "id" | "time">) => {
    logIdRef.current += 1
    setLog(prev => [{ id: logIdRef.current, time: Date.now(), ...entry }, ...prev].slice(0, 200))
  }

  const sendValue = async (topic: TopicAnnounce, rawValue: string | boolean) => {
    const type = writableType(topic.topic_type)
    if (!type) return

    let value: boolean | number | string
    if (type === "boolean") {
      value = rawValue as boolean
    } else if (type === "string") {
      value = String(rawValue)
    } else {
      const n = parseFloat(String(rawValue))
      if (isNaN(n)) {
        pushLog({ topicName: topic.name, value: String(rawValue), status: "error", error: "Invalid numeric value" })
        return
      }
      value = type === "int" ? Math.round(n) : n
    }

    try {
      await invoke("set_value", { topicName: topic.name, topicType: topic.topic_type, value })
      pushLog({ topicName: topic.name, value: String(value), status: "ok" })
      if (type !== "boolean") setDrafts(prev => ({ ...prev, [topic.name]: "" }))
    } catch (e) {
      pushLog({ topicName: topic.name, value: String(value), status: "error", error: String(e) })
    }
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      {/* SIDEBAR: SEARCH + SAFETY NOTICE */}
      <div style={{ width: 300, background: "var(--bg-panel)", borderRight: "1px solid var(--border-main)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <PageHeader
          eyebrow="NetworkTables 4"
          title="Command Console"
          subtitle="Write values directly to NT topics"
        />

        <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel title="Filters" icon="ti-filter">
            <div>
              <PropertyRow label="Search writable">
                <input
                  type="text"
                  placeholder="e.g. Preferences, kP..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={propertyInputStyle}
                />
              </PropertyRow>
            </div>
          </Panel>

          {isRealRobot && (
            <AlertBanner>
              Connected to a REAL robot. Every value sent here goes straight to the field — double-check before hitting Send.
            </AlertBanner>
          )}

          <Panel title="Writable Types" icon="ti-list-details">
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6, padding: 10 }}>
              boolean · double · int · float · string<br />
              <span style={{ opacity: 0.7 }}>Arrays, structs and raw topics aren't writable from here yet.</span>
            </div>
          </Panel>
        </div>
      </div>

      {/* MAIN: WRITABLE TOPICS LIST + COMMAND LOG */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <PanelHeader
          title="Writable Topics"
          meta={isConnected ? `${writableTopics.length} writable of ${topics.size} total` : "not connected"}
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* TABLA DE ESCRITURA */}
          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {!isConnected ? (
              <EmptyState icon="ti-plug-connected-x" padding="80px 40px" message="Connect to the robot or simulation to write values." />
            ) : writableTopics.length === 0 ? (
              <EmptyState icon="ti-search-off" padding="80px 40px" message="No writable topics match your search." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--border-light)", border: "1px solid var(--border-main)", borderRadius: 4, overflow: "hidden" }}>
                {writableTopics.map(topic => (
                  <CommandRow
                    key={topic.id}
                    topic={topic}
                    liveValue={liveValues[topic.name]}
                    draft={drafts[topic.name] ?? ""}
                    onDraftChange={(v) => setDrafts(prev => ({ ...prev, [topic.name]: v }))}
                    onSend={(v) => sendValue(topic, v)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* LOG DE COMANDOS ENVIADOS */}
          <div style={{ width: 320, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", letterSpacing: 0.3 }}>COMMAND LOG</span>
              {log.length > 0 && (
                <button onClick={() => setLog([])} style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 10, cursor: "pointer" }}>
                  clear
                </button>
              )}
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {log.length === 0 ? (
                <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)" }}>
                  Nothing sent yet.
                </div>
              ) : (
                log.map(entry => (
                  <div key={entry.id} style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-light)", display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: entry.status === "ok" ? "var(--status-sim)" : "var(--mars-red)", flexShrink: 0
                      }} />
                      <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace" }}>
                        {new Date(entry.time).toLocaleTimeString()}
                      </span>
                    </div>
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-primary)", wordBreak: "break-all" }}>
                      {entry.topicName}
                    </span>
                    <span style={{ fontSize: 11, color: entry.status === "ok" ? "var(--text-primary)" : "var(--mars-red)", fontWeight: 600 }}>
                      {entry.status === "ok" ? `→ ${entry.value}` : entry.error ?? "failed"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function CommandRow({ topic, liveValue, draft, onDraftChange, onSend }: {
  topic: TopicAnnounce
  liveValue: any
  draft: string
  onDraftChange: (v: string) => void
  onSend: (v: string | boolean) => void
}) {
  const type = writableType(topic.topic_type)!
  const current = formatLiveValue(liveValue)

  if (type === "boolean") {
    const isTrue = liveValue?.Boolean === true
    const hasValue = liveValue !== undefined
    return (
      <div style={rowStyle}>
        <RowLabel topic={topic} current={current} />
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <button
            onClick={() => onSend(true)}
            style={{ ...toggleBtnStyle, background: isTrue ? "var(--status-sim)" : "var(--bg-input)", color: isTrue ? "#04140c" : "var(--text-muted)" }}
          >
            TRUE
          </button>
          <button
            onClick={() => onSend(false)}
            style={{ ...toggleBtnStyle, background: hasValue && !isTrue ? "var(--mars-red)" : "var(--bg-input)", color: hasValue && !isTrue ? "#fff" : "var(--text-muted)" }}
          >
            FALSE
          </button>
        </div>
      </div>
    )
  }

  const isNumeric = type === "double" || type === "int" || type === "float"

  return (
    <div style={rowStyle}>
      <RowLabel topic={topic} current={current} />
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <input
          type={isNumeric ? "number" : "text"}
          value={draft}
          placeholder={current !== "—" ? current : "value"}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim() !== "") onSend(draft) }}
          style={{ ...inputStyle, width: 120 }}
        />
        <button
          onClick={() => draft.trim() !== "" && onSend(draft)}
          disabled={draft.trim() === ""}
          style={{ ...sendBtnStyle, opacity: draft.trim() === "" ? 0.4 : 1, cursor: draft.trim() === "" ? "default" : "pointer" }}
        >
          Send
        </button>
      </div>
    </div>
  )
}

function RowLabel({ topic, current }: { topic: TopicAnnounce, current: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
      <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {topic.name}
      </span>
      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
        {topic.topic_type} · current: <span style={{ color: "var(--text-primary)" }}>{current}</span>
      </span>
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
  padding: "10px 16px", background: "var(--bg-panel)"
}

const toggleBtnStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: 0.3, padding: "6px 10px", border: "1px solid var(--border-main)", borderRadius: 3, cursor: "pointer"
}

const sendBtnStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, padding: "6px 14px", border: "1px solid var(--border-main)", borderRadius: 3,
  background: "var(--mars-accent)", color: "#fff", cursor: "pointer"
}