import React, { useState, useEffect, useMemo, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { TopicAnnounce, ConnectionState } from "../store/appStore"
import PageHeader from "../components/layout/PageHeader"
import PanelHeader from "../components/layout/PanelHeader"
import EmptyState from "../components/common/EmptyState"
import { propertyInputStyle } from "../styles/pageForm"
import Panel from "../components/common/Panel"
import PropertyRow from "../components/common/PropertyRow"

interface Props {
  connection: ConnectionState
  topics: Map<string, TopicAnnounce>
}

interface JitterStats {
  mean_dt_ms: number
  stddev_dt_ms: number
  min_dt_ms: number
  max_dt_ms: number
  sample_count: number
  expected_hz: number
}

const WINDOW_OPTIONS_S = [1, 3, 5, 10, 30]
const POLL_MS = 500 // no need for faster, it is a diagnostic view

// Coefficient of variation (stddev/mean): the metric that really matters here.
// A topic at 50Hz with a 2ms stddev is normal; the same stddev on a 500Hz topic
// would be very costly. Normalizing by the mean is what makes the "health" of
// topics with very different frequencies comparable.
function severity(s: JitterStats): "good" | "warn" | "bad" {
  const cv = s.mean_dt_ms > 0 ? s.stddev_dt_ms / s.mean_dt_ms : 0
  const spike = s.mean_dt_ms > 0 ? s.max_dt_ms / s.mean_dt_ms : 0
  if (cv > 0.3 || spike > 4) return "bad"
  if (cv > 0.1 || spike > 2) return "warn"
  return "good"
}

function severityColor(sev: "good" | "warn" | "bad"): string {
  if (sev === "bad") return "var(--mars-red)"
  if (sev === "warn") return "var(--status-warning)"
  return "var(--status-sim)"
}

function fmtMs(v: number): string {
  return v < 10 ? v.toFixed(2) : v.toFixed(1)
}

export default function JitterAnalyzerPage({ connection, topics }: Props) {
  const [windowS, setWindowS] = useState(5)
  const [searchQuery, setSearchQuery] = useState("")
  const [stats, setStats] = useState<Record<string, JitterStats>>({})
  const [paused, setPaused] = useState(false)

  const topicsRef = useRef(topics)
  topicsRef.current = topics
  const isConnected = connection !== "disconnected"

  useEffect(() => {
    if (!isConnected || paused) return
    let active = true

    const poll = async () => {
      if (!active) return
      try {
        const names = Array.from(topicsRef.current.keys())
        const data: Record<string, JitterStats> = await invoke("get_jitter_stats", {
          topicNames: names,
          windowUs: windowS * 1_000_000,
        })
        if (active) setStats(data)
      } catch { /* silencioso: puede pasar mientras se reconecta */ }
      if (active) setTimeout(poll, POLL_MS)
    }
    poll()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, paused, windowS, topics.size])

  const rows = useMemo(() => {
    const list = Object.entries(stats)
      .filter(([name]) => searchQuery.trim() === "" || name.toLowerCase().includes(searchQuery.toLowerCase()))
      .map(([name, s]) => ({ name, stats: s, sev: severity(s) }))

    // Worst first: whatever needs attention the most at the very top.
    const rank = { bad: 0, warn: 1, good: 2 }
    list.sort((a, b) => rank[a.sev] - rank[b.sev] || b.stats.stddev_dt_ms - a.stats.stddev_dt_ms)
    return list
  }, [stats, searchQuery])

  const counts = useMemo(() => {
    const c = { bad: 0, warn: 0, good: 0 }
    rows.forEach(r => c[r.sev]++)
    return c
  }, [rows])

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      {/* SIDEBAR */}
      <div style={{ width: 300, background: "var(--bg-panel)", borderRight: "1px solid var(--border-main)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <PageHeader
          eyebrow="NetworkTables 4"
          title="Loop Timing"
          subtitle="Jitter analysis per topic — detects drops, overruns and irregular publish timing."
        />

        <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 24 }}>
          <Panel title="Filters" icon="ti-filter">
            <div>
              <PropertyRow label="Search topics">
                <input
                  type="text"
                  placeholder="e.g. Drive, Pose..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={propertyInputStyle}
                />
              </PropertyRow>
              <PropertyRow label="Analysis window">
                <select value={windowS} onChange={e => setWindowS(parseInt(e.target.value))} style={propertyInputStyle}>
                  {WINDOW_OPTIONS_S.map(w => <option key={w} value={w}>{w}s</option>)}
                </select>
              </PropertyRow>
            </div>
            <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.4, padding: 8 }}>
              Short windows react quickly to new problems; long windows smooth out one-off noise.
            </div>
            <div style={{ padding: 8, paddingTop: 0 }}>
              <button
                onClick={() => setPaused(p => !p)}
                style={{
                  width: "100%", padding: "8px 0", background: paused ? "var(--border-main)" : "var(--bg-input)",
                  border: "1px solid var(--border-main)", borderRadius: 3,
                  color: "var(--text-primary)", fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}
              >
                {paused ? "▶ RESUME POLLING" : "⏸ PAUSE POLLING"}
              </button>
            </div>
          </Panel>

          <Panel title="Severity Legend" icon="ti-palette">
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10 }}>
              <LegendRow color={severityColor("good")} text="Stable — low jitter relative to rate" />
              <LegendRow color={severityColor("warn")} text="Some irregularity — worth a look" />
              <LegendRow color={severityColor("bad")} text="High jitter or spikes — likely drops" />
            </div>
          </Panel>

          <Panel title="Summary" icon="ti-chart-bar">
            <div>
              <PropertyRow label="Topics analyzed"><span>{rows.length}</span></PropertyRow>
              <PropertyRow label="Stable"><span style={{ color: severityColor("good") }}>{counts.good}</span></PropertyRow>
              <PropertyRow label="Warning"><span style={{ color: severityColor("warn") }}>{counts.warn}</span></PropertyRow>
              <PropertyRow label="Bad"><span style={{ color: severityColor("bad") }}>{counts.bad}</span></PropertyRow>
            </div>
          </Panel>
        </div>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <PanelHeader
          title="Publish Timing per Topic"
          meta={isConnected ? `window: last ${windowS}s${paused ? " · paused" : ""}` : "not connected"}
        />

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {!isConnected ? (
            <EmptyState icon="ti-plug-connected-x" padding="80px 40px" message="Connect to the robot or simulation to analyze timing." />
          ) : rows.length === 0 ? (
            <EmptyState icon="ti-clock-pause" padding="80px 40px" message="Not enough samples yet in this window — waiting for more data." />
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-panel)", borderBottom: "1px solid var(--border-main)" }}>
                  <th style={{ ...theadStyle, width: 20 }}></th>
                  <th style={theadStyle}>TOPIC</th>
                  <th style={{ ...theadStyle, textAlign: "right" }}>RATE</th>
                  <th style={{ ...theadStyle, textAlign: "right" }}>MEAN Δt</th>
                  <th style={{ ...theadStyle, textAlign: "right" }}>STDDEV</th>
                  <th style={{ ...theadStyle, textAlign: "right" }}>MIN Δt</th>
                  <th style={{ ...theadStyle, textAlign: "right" }}>MAX Δt</th>
                  <th style={{ ...theadStyle, textAlign: "right" }}>SAMPLES</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.name} style={{ borderBottom: "1px solid var(--border-light)", background: i % 2 === 0 ? "var(--bg-panel)" : "var(--bg-input)" }}>
                    <td style={tdStyle}>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: severityColor(r.sev) }} />
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "monospace" }}>{r.name}</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace" }}>{r.stats.expected_hz.toFixed(1)} Hz</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace" }}>{fmtMs(r.stats.mean_dt_ms)} ms</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace", color: severityColor(r.sev), fontWeight: 600 }}>
                      ±{fmtMs(r.stats.stddev_dt_ms)} ms
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)" }}>{fmtMs(r.stats.min_dt_ms)} ms</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)" }}>{fmtMs(r.stats.max_dt_ms)} ms</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)", fontSize: 10 }}>{r.stats.sample_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function LegendRow({ color, text }: { color: string, text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.4 }}>{text}</span>
    </div>
  )
}

const theadStyle: React.CSSProperties = {
  padding: "8px 16px", fontSize: 10, fontWeight: 600, letterSpacing: 0.5, color: "var(--text-muted)", textAlign: "left"
}

const tdStyle: React.CSSProperties = {
  padding: "8px 16px", fontSize: 12, color: "var(--text-primary)"
}