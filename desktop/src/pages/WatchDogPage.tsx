import { useState, useEffect, useMemo, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { TopicAnnounce } from "../store/appStore"
import PageHeader from "../components/layout/PageHeader"
import PanelHeader from "../components/layout/PanelHeader"
import EmptyState from "../components/common/EmptyState"
import DangerButton from "../components/common/DangerButton"
import Panel from "../components/common/Panel"
import PropertyRow from "../components/common/PropertyRow"
import { propertyInputStyle } from "../styles/pageForm"

interface Props {
  projectName: string | null
  topics: Map<string, TopicAnnounce>
}

// Has to match the path NetworkIO.set("WatchDog/ElapsedSeconds", subsystemName, ...)
// builds in MARSWatchdog.java. If your NetworkIO builds the topic differently (e.g.
// without the trailing slash, with different capitalization, etc.) adjust this
// constant.
const WATCHDOG_PREFIX = "WatchDog/ElapsedSeconds/"
const HISTORY_LENGTH = 60
const POLL_MS = 100

function isWatchdogTopic(t: TopicAnnounce) {
  return t.topic_type === "double" && t.name.includes(WATCHDOG_PREFIX)
}

function subsystemNameFromTopic(t: TopicAnnounce) {
  const idx = t.name.indexOf(WATCHDOG_PREFIX)
  const rest = t.name.slice(idx + WATCHDOG_PREFIX.length)
  return rest.replace(/^\/+|\/+$/g, "") || t.name
}

interface SubsystemRow {
  topicName: string
  name: string
  current: number | null // ms
  history: number[]      // ms, oldest -> newest
  max: number
  overruns: number
}

type SortMode = "current" | "name" | "overruns"

export default function WatchdogPage({ projectName, topics }: Props) {
  const [thresholdMs, setThresholdMs] = useState(5)
  const [searchQuery, setSearchQuery] = useState("")
  const [sortMode, setSortMode] = useState<SortMode>("current")
  const [tick, setTick] = useState(0)

  const thresholdRef = useRef(thresholdMs)
  thresholdRef.current = thresholdMs

  // History accumulated on the client per topic. It is not persistent: it
  // resets when the page opens or when "Reset session stats" is pressed.
  const statsRef = useRef<Map<string, { history: number[]; max: number; overruns: number }>>(new Map())

  const watchdogTopics = useMemo(
    () => Array.from(topics.values()).filter(isWatchdogTopic),
    [topics]
  )

  const handleReset = () => {
    statsRef.current.clear()
    setTick(n => n + 1)
  }

  useEffect(() => {
    if (watchdogTopics.length === 0) return
    let active = true

    const poll = async () => {
      if (!active) return
      try {
        const names = watchdogTopics.map(t => t.name)
        const data: Record<string, any> = await invoke("get_live_values", { topicNames: names })

        watchdogTopics.forEach(t => {
          const v = data[t.name]
          if (!v || v.Number === undefined) return
          const ms = v.Number * 1000

          let entry = statsRef.current.get(t.name)
          if (!entry) {
            entry = { history: [], max: 0, overruns: 0 }
            statsRef.current.set(t.name, entry)
          }
          entry.history.push(ms)
          if (entry.history.length > HISTORY_LENGTH) entry.history.shift()
          if (ms > entry.max) entry.max = ms
          if (ms > thresholdRef.current) entry.overruns++
        })

        if (active) setTick(n => n + 1)
      } catch (e) { /* silencioso: puede pasar mientras se reconecta */ }
      if (active) setTimeout(poll, POLL_MS)
    }
    poll()
    return () => { active = false }
  }, [watchdogTopics])

  const rows: SubsystemRow[] = useMemo(() => {
    return watchdogTopics
      .map(t => {
        const entry = statsRef.current.get(t.name)
        const history = entry?.history ?? []
        return {
          topicName: t.name,
          name: subsystemNameFromTopic(t),
          current: history.length > 0 ? history[history.length - 1] : null,
          history,
          max: entry?.max ?? 0,
          overruns: entry?.overruns ?? 0,
        }
      })
      .filter(s => searchQuery.trim() === "" || s.name.toLowerCase().includes(searchQuery.toLowerCase()))
      .sort((a, b) => {
        if (sortMode === "name") return a.name.localeCompare(b.name)
        if (sortMode === "overruns") return b.overruns - a.overruns
        return (b.current ?? -1) - (a.current ?? -1)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchdogTopics, searchQuery, sortMode, tick])

  const overCount = rows.filter(s => s.current !== null && s.current > thresholdMs).length
  const totalOverruns = rows.reduce((sum, s) => sum + s.overruns, 0)

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      {/* SIDEBAR */}
      <div style={{ width: 300, background: "var(--bg-panel)", borderRight: "1px solid var(--border-main)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <PageHeader
          eyebrow="Diagnostics"
          title="Loop Watchdog"
          subtitle={
            <>
              Project: <span style={{ color: "var(--mars-accent)", fontWeight: 600 }}>{projectName ? projectName.toUpperCase() : "NONE"}</span><br />
              MARSWatchdog · per-subsystem loop timing
            </>
          }
        />

        <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 24, overflowY: "auto" }}>

          <Panel title="Filters" icon="ti-filter">
            <div>
              <PropertyRow label="Overrun threshold (ms)">
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={thresholdMs}
                  onChange={e => setThresholdMs(parseFloat(e.target.value) || 0.1)}
                  style={propertyInputStyle}
                />
              </PropertyRow>
              <PropertyRow label="Search subsystem">
                <input
                  type="text"
                  placeholder="e.g. Drivetrain..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={propertyInputStyle}
                />
              </PropertyRow>
              <PropertyRow label="Sort by">
                <select value={sortMode} onChange={e => setSortMode(e.target.value as SortMode)} style={propertyInputStyle}>
                  <option value="current">Current elapsed (worst first)</option>
                  <option value="overruns">Overrun count</option>
                  <option value="name">Name</option>
                </select>
              </PropertyRow>
            </div>
            <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.4, padding: "8px" }}>
              Threshold is local to this view only — the real value lives in MARSWatchdog.setThresholdSeconds() on the robot.
            </div>
            <div style={{ padding: 8, paddingTop: 0 }}>
              <DangerButton onClick={handleReset}>RESET SESSION STATS</DangerButton>
            </div>
          </Panel>

          <Panel title="Session Summary" icon="ti-chart-bar">
            <div>
              <PropertyRow label="Subsystems monitored"><span>{watchdogTopics.length}</span></PropertyRow>
              <PropertyRow label="Currently over threshold"><span style={{ color: overCount > 0 ? "var(--status-error)" : "var(--status-sim)" }}>{overCount}</span></PropertyRow>
              <PropertyRow label="Total overruns (session)"><span style={{ color: totalOverruns > 0 ? "var(--status-error)" : "var(--text-primary)" }}>{totalOverruns}</span></PropertyRow>
            </div>
          </Panel>

        </div>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <PanelHeader
          title="Per-Subsystem Loop Timing"
          meta={watchdogTopics.length > 0 ? `${rows.length} of ${watchdogTopics.length} shown · threshold ${thresholdMs}ms` : "waiting for WatchDog telemetry"}
          action={overCount > 0 && (
            <span style={{ fontSize: 11, color: "var(--status-error)", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
              <i className="ti ti-alert-triangle" />
              {overCount} subsystem{overCount !== 1 ? "s" : ""} over threshold
            </span>
          )}
        />

        <div style={{ flex: 1, padding: "24px 24px 40px", overflowY: "auto" }}>
          <div style={{ width: "100%", maxWidth: 1100, margin: "0 auto" }}>

            {watchdogTopics.length === 0 ? (
              <EmptyState
                icon="ti-heart-rate-monitor"
                padding="80px 40px"
                message="No watchdog topics found."
                hint={<>Expecting double topics under <strong>{WATCHDOG_PREFIX}&lt;Subsystem&gt;</strong></>}
              />
            ) : rows.length === 0 ? (
              <EmptyState message="No subsystems match your search." />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {rows.map(row => (
                  <SubsystemCard key={row.topicName} row={row} thresholdMs={thresholdMs} />
                ))}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}

function SubsystemCard({ row, thresholdMs }: { row: SubsystemRow, thresholdMs: number }) {
  const isOver = row.current !== null && row.current > thresholdMs
  const barPct = row.current !== null ? Math.min(100, (row.current / thresholdMs) * 100) : 0

  return (
    <div style={{
      background: "var(--bg-panel)", border: `1px solid ${isOver ? "var(--status-error)" : "var(--border-main)"}`,
      borderRadius: 4, padding: 16, display: "flex", flexDirection: "column", gap: 10
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.name}
        </span>
        <span style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: isOver ? "var(--status-error)" : "var(--status-sim)", flexShrink: 0 }}>
          {row.current !== null ? row.current.toFixed(2) : "--"}
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}> ms</span>
        </span>
      </div>

      <div style={{ width: "100%", height: 6, background: "var(--grid-line)", border: "1px solid var(--border-main)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${barPct}%`, height: "100%", background: isOver ? "var(--status-error)" : "var(--status-sim)" }} />
      </div>

      <Sparkline history={row.history} thresholdMs={thresholdMs} />

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace" }}>
        <span>MAX {row.max.toFixed(2)}ms</span>
        <span style={{ color: row.overruns > 0 ? "var(--status-error)" : "var(--text-muted)" }}>
          {row.overruns} overrun{row.overruns !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  )
}

function Sparkline({ history, thresholdMs }: { history: number[], thresholdMs: number }) {
  const width = 280
  const height = 44

  if (history.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 10, fontFamily: "monospace" }}>
        collecting samples…
      </div>
    )
  }

  const maxScale = Math.max(thresholdMs * 2, ...history, 0.001)
  const points = history.map((v, i) => {
    const x = (i / (history.length - 1)) * width
    const y = height - (Math.min(v, maxScale) / maxScale) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(" ")
  const threshY = height - (Math.min(thresholdMs, maxScale) / maxScale) * height

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <line x1={0} y1={threshY} x2={width} y2={threshY} stroke="var(--status-error)" strokeWidth={1} strokeDasharray="3,3" opacity={0.5} />
      <polyline points={points} fill="none" stroke="var(--status-sim)" strokeWidth={1.5} />
    </svg>
  )
}

