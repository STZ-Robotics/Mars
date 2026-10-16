import { useEffect, useMemo, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { ConnectionState, LogSource } from "../store/appStore"
import PanelHeader from "../components/layout/PanelHeader"
import EmptyState from "../components/common/EmptyState"

interface TopicBandwidth {
  name: string
  topic_type: string
  sample_count: number
  total_bytes: number
  bytes_per_second: number
  samples_per_second: number
  share: number
}

interface BandwidthReport {
  window_seconds: number
  total_bytes: number
  total_bytes_per_second: number
  total_bits_per_second: number
  percent_of_fms_limit: number
  topic_count: number
  topics: TopicBandwidth[]
}

interface Props {
  connection: ConnectionState
  logSource: LogSource | null
}

const WINDOW_OPTIONS = [5, 10, 30, 60]
const REFRESH_MS = 1500

function formatRate(bytesPerSecond: number): string {
  const bits = bytesPerSecond * 8
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mbps`
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} kbps`
  return `${Math.round(bits)} bps`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`
  return `${bytes} B`
}

// Green/amber/red according to how close it is to the FMS cutoff. The low
// threshold is 50% because the cap is per ROBOT and there is more traffic than
// NT's (cameras, Driver Station), so reaching 80% is already a problem.
function limitColor(percent: number): string {
  if (percent >= 80) return "var(--status-error)"
  if (percent >= 50) return "var(--status-warning)"
  return "var(--status-sim)"
}

/** Groups by the parent table: it is what says WHICH SUBSYSTEM is logging too much. */
function groupByTable(topics: TopicBandwidth[]) {
  const groups = new Map<string, { bytes: number; rate: number; count: number }>()
  for (const t of topics) {
    const parts = t.name.split("/").filter(Boolean)
    // Two levels: "/AdvantageKit/RealOutputs" says more than "/AdvantageKit".
    const key = "/" + parts.slice(0, Math.min(2, parts.length - 1) || 1).join("/")
    const g = groups.get(key) ?? { bytes: 0, rate: 0, count: 0 }
    g.bytes += t.total_bytes
    g.rate += t.bytes_per_second
    g.count++
    groups.set(key, g)
  }
  const total = topics.reduce((sum, t) => sum + t.total_bytes, 0)
  return Array.from(groups.entries())
    .map(([name, g]) => ({ name, ...g, share: total > 0 ? g.bytes / total : 0 }))
    .sort((a, b) => b.bytes - a.bytes)
}

export default function BandwidthPage({ connection, logSource }: Props) {
  const [report, setReport] = useState<BandwidthReport | null>(null)
  const [windowSeconds, setWindowSeconds] = useState(10)
  const [groupMode, setGroupMode] = useState<"topic" | "table">("topic")

  const hasSource = connection !== "disconnected" || logSource !== null

  useEffect(() => {
    if (!hasSource) {
      setReport(null)
      return
    }
    let cancelled = false

    const poll = () => {
      invoke<BandwidthReport>("get_bandwidth_report", { windowSeconds })
        .then(r => { if (!cancelled) setReport(r) })
        .catch(() => { /* no data yet; it retries */ })
    }

    poll()
    const interval = setInterval(poll, REFRESH_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [hasSource, windowSeconds])

  const tableRows = useMemo(
    () => (report ? groupByTable(report.topics) : []),
    [report],
  )

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg-page)", overflow: "hidden" }}>
      <PanelHeader
        title="Network Bandwidth"
        meta={report ? `${report.topic_count} topics · ${report.window_seconds.toFixed(1)}s measured` : ""}
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 9.5, color: "var(--text-header-eyebrow)" }}>GROUP BY</span>
              <select
                value={groupMode}
                onChange={e => setGroupMode(e.target.value as "topic" | "table")}
                style={selectStyle}
              >
                <option value="topic">Topic</option>
                <option value="table">Table</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 9.5, color: "var(--text-header-eyebrow)" }}>WINDOW</span>
              <select
                value={windowSeconds}
                onChange={e => setWindowSeconds(Number(e.target.value))}
                style={selectStyle}
              >
                {WINDOW_OPTIONS.map(w => <option key={w} value={w}>{w}s</option>)}
              </select>
            </div>
          </div>
        }
      />

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>

          {!hasSource ? (
            <EmptyState
              icon="ti-antenna-bars-off"
              message="No data source"
              hint="Connect to the robot or open a log to measure bandwidth"
            />
          ) : report === null || report.topics.length === 0 ? (
            <EmptyState icon="ti-activity" message="Waiting for data…" />
          ) : (
            <>
              <TotalGauge report={report} />

              {groupMode === "topic" ? (
                <TopicTable topics={report.topics} />
              ) : (
                <TableGroupTable rows={tableRows} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function TotalGauge({ report }: { report: BandwidthReport }) {
  const percent = report.percent_of_fms_limit
  const color = limitColor(percent)

  return (
    <div style={{
      background: "var(--bg-panel)",
      borderTop: "1px solid var(--bevel-light)",
      borderLeft: "1px solid var(--bevel-light)",
      borderRight: "1px solid var(--bevel-dark)",
      borderBottom: "1px solid var(--bevel-dark)",
      padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 26, fontWeight: 700, color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
          {formatRate(report.total_bytes_per_second)}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          of 4 Mbps FMS limit · {percent.toFixed(1)}% · {formatBytes(report.total_bytes)} in {report.window_seconds.toFixed(1)}s
        </span>
      </div>

      <div style={{
        height: 12, background: "var(--bg-input)",
        border: "1px solid var(--border-main)", position: "relative", overflow: "hidden",
      }}>
        <div style={{ height: "100%", width: `${Math.min(100, percent)}%`, background: color }} />
        {/* The 50% mark: past that it is worth trimming, because the cap is the
            whole robot's and NT is not the only thing using it. */}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 1, background: "var(--bevel-dark)" }} />
      </div>

      {percent >= 50 && (
        <div style={{ fontSize: 11, color, lineHeight: 1.4 }}>
          {percent >= 80
            ? "Over 80% of the limit — trim the top topics before a match. Cameras and the Driver Station share this budget too."
            : "Past half the limit, and NetworkTables is not the only thing sharing it."}
        </div>
      )}
    </div>
  )
}

function TopicTable({ topics }: { topics: TopicBandwidth[] }) {
  return (
    <BevelTable head={["TOPIC", "TYPE", "RATE", "HZ", "SHARE"]}>
      {topics.map(t => (
        <tr key={t.name}>
          <td style={{ ...cell, maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <ShareBar share={t.share}>
              <span style={{ fontFamily: "ui-monospace, monospace" }} title={t.name}>{t.name}</span>
            </ShareBar>
          </td>
          <td style={{ ...cell, color: "var(--text-muted)", width: 130, whiteSpace: "nowrap" }}>{t.topic_type}</td>
          <td style={numCell}>{formatRate(t.bytes_per_second)}</td>
          <td style={numCell}>{t.samples_per_second.toFixed(0)}</td>
          <td style={{ ...numCell, color: "var(--text-muted)" }}>{(t.share * 100).toFixed(1)}%</td>
        </tr>
      ))}
    </BevelTable>
  )
}

function TableGroupTable({ rows }: { rows: ReturnType<typeof groupByTable> }) {
  return (
    <BevelTable head={["TABLE", "TOPICS", "RATE", "SHARE"]}>
      {rows.map(r => (
        <tr key={r.name}>
          <td style={{ ...cell, maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <ShareBar share={r.share}>
              <span style={{ fontFamily: "ui-monospace, monospace" }} title={r.name}>{r.name}</span>
            </ShareBar>
          </td>
          <td style={{ ...numCell, width: 70, color: "var(--text-muted)" }}>{r.count}</td>
          <td style={numCell}>{formatRate(r.rate)}</td>
          <td style={{ ...numCell, color: "var(--text-muted)" }}>{(r.share * 100).toFixed(1)}%</td>
        </tr>
      ))}
    </BevelTable>
  )
}

// A background bar proportional to the usage: the ranking reads at a glance
// without having to compare numbers.
function ShareBar({ share, children }: { share: number; children: React.ReactNode }) {
  return (
    <div style={{ position: "relative" }}>
      <div style={{
        position: "absolute", inset: 0, width: `${Math.min(100, share * 100)}%`,
        background: "var(--mars-accent)", opacity: 0.16,
      }} />
      <span style={{ position: "relative" }}>{children}</span>
    </div>
  )
}

function BevelTable({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--bg-page)",
      borderTop: "1px solid var(--bevel-light)",
      borderLeft: "1px solid var(--bevel-light)",
      borderRight: "1px solid var(--bevel-dark)",
      borderBottom: "1px solid var(--bevel-dark)",
      overflow: "hidden",
    }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr style={{
            background: "linear-gradient(180deg, #e6e6ea 0%, #d4d4da 100%)",
            borderBottom: "1px solid var(--bevel-dark)", color: "var(--text-muted)",
          }}>
            {head.map((h, i) => (
              <th key={h} style={{
                fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: "3px 8px",
                textAlign: i === 0 || (i === 1 && h === "TYPE") ? "left" : "right",
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

const cell: React.CSSProperties = { padding: "2px 8px", borderBottom: "1px solid var(--border-light)" }
const numCell: React.CSSProperties = { ...cell, textAlign: "right", whiteSpace: "nowrap" }

const selectStyle: React.CSSProperties = {
  background: "var(--bg-input)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", padding: "2px 5px",
  borderRadius: 2, fontSize: 10.5, outline: "none", height: 22,
}
