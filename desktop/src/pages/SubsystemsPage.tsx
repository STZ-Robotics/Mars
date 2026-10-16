import { useEffect, useMemo, useRef, useState } from "react"
import { ConnectionState, LogSource, TopicAnnounce } from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { useNTSnapshot } from "../utils/nt/useNTSnapshot"
import PageHeader from "../components/layout/PageHeader"
import PanelHeader from "../components/layout/PanelHeader"
import Panel from "../components/common/Panel"
import PropertyRow from "../components/common/PropertyRow"
import EmptyState from "../components/common/EmptyState"
import DangerButton from "../components/common/DangerButton"
import SidebarIcon from "../components/common/SidebarIcon"
import { propertyInputStyle } from "../styles/pageForm"
import {
  SubsystemStatus, StatusChange, Severity,
  SEVERITY_ICONS, SEVERITY_LABELS, SEVERITY_ORDER,
  findStatusSubsystems, statusTopicNames, readSubsystemStatus,
  sortBySeverity, countBySeverity, hasCriticalAlerts, pushStatusChange, hexToHsl,
} from "../utils/mars/subsystemStatus"

interface Props {
  projectName: string | null
  topics: Map<string, TopicAnnounce>
  connection: ConnectionState
  logSource: LogSource | null
}

const POLL_MS = 250
const HISTORY_LIMIT = 12

/** A tabler fallback icon until the severity SVGs exist. */
const SEVERITY_FALLBACK: Record<Severity, string> = {
  critical: "ti-alert-octagon",
  error: "ti-alert-triangle",
  warning: "ti-clock-play",
  ok: "ti-circle-check",
  unknown: "ti-help-circle",
}

/** The app's color for each severity (the tiles use the ROBOT's hex). */
const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "var(--status-error)",
  // An orange of its own: the framework separates TIMEOUT (orange) from
  // HARDWARE_FAULT (red), and in the breakdown the two rows have to be told
  // apart. Darkened like --status-warning to read on the light background.
  error: "#c0561a",
  warning: "var(--status-warning)",
  ok: "var(--status-sim)",
  unknown: "var(--text-muted)",
}

type SortMode = "severity" | "name"

export default function SubsystemsPage({ projectName, topics, connection, logSource }: Props) {
  const [search, setSearch] = useState("")
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>("severity")
  const [selected, setSelected] = useState<string | null>(null)
  const [historyTick, setHistoryTick] = useState(0)

  const isLive = useSelectionStore(s => s.isLive)

  const prefixes = useMemo(() => findStatusSubsystems(topics), [topics])
  const topicNames = useMemo(() => statusTopicNames(prefixes), [prefixes])
  const values = useNTSnapshot(topicNames, POLL_MS)

  const statuses = useMemo(
    () => prefixes.map(p => readSubsystemStatus(values, p)),
    [prefixes, values]
  )

  // The history accumulates in a ref and not in state: a sample arrives every
  // 250ms per subsystem and almost none changes anything. pushStatusChange
  // returns the same array when nothing changed, so here we only re-render if
  // something was really added.
  const historyRef = useRef<Map<string, StatusChange[]>>(new Map())

  useEffect(() => {
    // Moving the timeline's cursor means looking at the past: stacking that as
    // if they were new changes would pollute the real history.
    if (!isLive) return
    const now = Date.now()
    let changed = false
    for (const status of statuses) {
      const prev = historyRef.current.get(status.prefix) ?? []
      const next = pushStatusChange(prev, status, now, HISTORY_LIMIT)
      if (next !== prev) {
        historyRef.current.set(status.prefix, next)
        changed = true
      }
    }
    if (changed) setHistoryTick(n => n + 1)
  }, [statuses, isLive])

  const handleClearHistory = () => {
    historyRef.current.clear()
    setHistoryTick(n => n + 1)
  }

  const counts = countBySeverity(statuses)
  const critical = hasCriticalAlerts(statuses)

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = statuses.filter(s => {
      if (problemsOnly && (s.severity === "ok" || s.severity === "unknown")) return false
      if (query === "") return true
      return s.name.toLowerCase().includes(query)
        || (s.code ?? "").toLowerCase().includes(query)
        || (s.message ?? "").toLowerCase().includes(query)
    })
    return sortMode === "severity"
      ? sortBySeverity(filtered)
      : [...filtered].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }, [statuses, search, problemsOnly, sortMode])

  const selectedStatus = statuses.find(s => s.prefix === selected) ?? null
  const hasSource = connection !== "disconnected" || logSource !== null

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      {/* SIDEBAR */}
      <div style={{ width: 300, background: "var(--bg-panel)", borderRight: "1px solid var(--border-main)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <PageHeader
          eyebrow="Diagnostics"
          title="Subsystem Status"
          subtitle={
            <>
              Project: <span style={{ color: "var(--mars-accent)", fontWeight: 600 }}>{projectName ? projectName.toUpperCase() : "NONE"}</span><br />
              ModularSubsystem · Status/Name · Hex · Message
            </>
          }
        />

        <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 24, overflowY: "auto" }}>

          {/* AlertRegistry.hasCriticalAlerts()'s gate: the question asked in the
              queue before a match. */}
          <PreMatchGate critical={critical} total={statuses.length} live={isLive} />

          <Panel title="Filters" icon="ti-filter">
            <div>
              <PropertyRow label="Search">
                <input
                  type="text"
                  placeholder="name, code or message…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={propertyInputStyle}
                />
              </PropertyRow>
              <PropertyRow label="Problems only">
                <input
                  type="checkbox"
                  checked={problemsOnly}
                  onChange={e => setProblemsOnly(e.target.checked)}
                  style={{ accentColor: "var(--mars-accent)" }}
                />
              </PropertyRow>
              <PropertyRow label="Sort by">
                <select value={sortMode} onChange={e => setSortMode(e.target.value as SortMode)} style={propertyInputStyle}>
                  <option value="severity">Severity (worst first)</option>
                  <option value="name">Name</option>
                </select>
              </PropertyRow>
            </div>
            <div style={{ padding: 8, paddingTop: 6 }}>
              <DangerButton onClick={handleClearHistory}>CLEAR CHANGE HISTORY</DangerButton>
            </div>
          </Panel>

          <Panel title="Severity Breakdown" icon="ti-chart-pie">
            <div>
              {SEVERITY_ORDER.map(sev => (
                <PropertyRow key={sev} label={SEVERITY_LABELS[sev]}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <SidebarIcon svg={SEVERITY_ICONS[sev]} fallback={SEVERITY_FALLBACK[sev]} size={13} color={SEVERITY_COLORS[sev]} />
                    <span style={{ fontFamily: "monospace", fontWeight: 600, color: counts[sev] > 0 ? SEVERITY_COLORS[sev] : "var(--text-muted)" }}>
                      {counts[sev]}
                    </span>
                  </span>
                </PropertyRow>
              ))}
            </div>
            <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.45, padding: 8 }}>
              The framework only publishes Name, Hex and Message — the severity does not travel
              over NetworkTables. It is inferred from the name when it is a GlobalColorCode
              (NOMINAL / WORKING / TIMEOUT / HARDWARE_FAULT) and, if not, from the color's
              hue. The color you see on each tile is always the robot's raw hex.
            </div>
          </Panel>

          {selectedStatus && (
            <Panel title="Selected" icon="ti-focus-2">
              <div>
                <PropertyRow label="Table">
                  <span style={{ fontFamily: "monospace", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis" }}>{selectedStatus.prefix}</span>
                </PropertyRow>
                <PropertyRow label="Code">
                  <span style={{ fontFamily: "monospace", fontSize: 10 }}>{selectedStatus.code ?? "—"}</span>
                </PropertyRow>
                <PropertyRow label="Hex">
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "monospace", fontSize: 10 }}>
                    <span style={{ width: 11, height: 11, border: "1px solid var(--border-main)", background: selectedStatus.hex ?? "transparent", flexShrink: 0 }} />
                    {selectedStatus.hex ?? "—"}
                  </span>
                </PropertyRow>
                <PropertyRow label="Severity">
                  <span style={{ color: SEVERITY_COLORS[selectedStatus.severity], fontWeight: 600, fontSize: 10.5 }}>
                    {SEVERITY_LABELS[selectedStatus.severity]}
                  </span>
                </PropertyRow>
              </div>
              <HistoryList
                key={historyTick}
                changes={historyRef.current.get(selectedStatus.prefix) ?? []}
              />
            </Panel>
          )}

        </div>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <PanelHeader
          title="Subsystem Board"
          meta={
            prefixes.length > 0
              ? `${visible.length} of ${prefixes.length} shown · ${isLive ? "live" : "timeline cursor"}`
              : hasSource ? "no subsystem status topics" : "not connected"
          }
          action={critical && (
            <span style={{ fontSize: 11, color: "var(--status-error)", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
              <i className="ti ti-alert-octagon" />
              {counts.critical} critical
            </span>
          )}
        />

        <div style={{ flex: 1, padding: "24px 24px 40px", overflowY: "auto" }}>
          <div style={{ width: "100%", maxWidth: 1200, margin: "0 auto" }}>
            {prefixes.length === 0 ? (
              <EmptyState
                icon="ti-layout-grid"
                padding="80px 40px"
                message={hasSource ? "No subsystem status topics found." : "Connect to the robot or open a log."}
                hint={<>Expecting string topics at <strong>&lt;Subsystem&gt;/Status/Hex</strong>, published by ModularSubsystem</>}
              />
            ) : visible.length === 0 ? (
              <EmptyState message={problemsOnly ? "Every subsystem is nominal." : "No subsystems match your search."} />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
                {visible.map(status => (
                  <StatusTile
                    key={status.prefix}
                    status={status}
                    history={historyRef.current.get(status.prefix) ?? []}
                    selected={status.prefix === selected}
                    onSelect={() => setSelected(status.prefix === selected ? null : status.prefix)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function PreMatchGate({ critical, total, live }: { critical: boolean; total: number; live: boolean }) {
  const ready = total > 0 && !critical
  const color = total === 0 ? "var(--text-muted)" : ready ? "var(--status-sim)" : "var(--status-error)"

  return (
    <div style={{
      border: `1px solid ${color}`, padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: 4, background: "var(--bg-page)",
    }}>
      <div style={{ fontSize: 9.5, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-muted)" }}>
        Pre-match gate
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color, display: "flex", alignItems: "center", gap: 8 }}>
        <i className={`ti ${total === 0 ? "ti-help-circle" : ready ? "ti-circle-check" : "ti-alert-octagon"}`} />
        {total === 0 ? "NO DATA" : ready ? "CLEAR" : "HOLD"}
      </div>
      <div style={{ fontSize: 9.5, color: "var(--text-muted)", lineHeight: 1.4 }}>
        {total === 0
          ? "Waiting for subsystem status."
          : ready
            ? `${total} subsystem${total !== 1 ? "s" : ""} reporting, none critical.`
            : "At least one subsystem reports a critical state."}
        {!live && " Showing the timeline cursor, not live."}
      </div>
    </div>
  )
}

/**
 * One tile per subsystem. The dominant color is the hex the robot sent — the
 * same one that goes to the LEDs — because it changes with the action it is
 * running, not only with its health. The severity goes separately, in the icon.
 */
function StatusTile({ status, history, selected, onSelect }: {
  status: SubsystemStatus
  history: StatusChange[]
  selected: boolean
  onSelect: () => void
}) {
  const hsl = status.hex ? hexToHsl(status.hex) : null
  const band = status.hex && hsl ? status.hex : "var(--bg-panel-header)"
  // Dark text on light colors (yellow, cyan) — otherwise the state's code is
  // unreadable on exactly the ones you look at most.
  const onBand = hsl && hsl.l > 0.62 ? "#1a1a1e" : "#ffffff"

  return (
    <div
      onClick={onSelect}
      style={{
        background: "var(--bg-panel)",
        border: `1px solid ${selected ? "var(--mars-accent)" : "var(--border-main)"}`,
        boxShadow: selected ? "0 0 0 1px var(--mars-accent)" : "none",
        borderRadius: 4, overflow: "hidden", cursor: "pointer",
        display: "flex", flexDirection: "column",
      }}
    >
      {/* A band with the robot's raw color */}
      <div style={{
        background: band, padding: "8px 10px",
        display: "flex", alignItems: "center", gap: 8, minHeight: 34,
      }}>
        <SidebarIcon
          svg={SEVERITY_ICONS[status.severity]}
          fallback={SEVERITY_FALLBACK[status.severity]}
          size={15}
          color={onBand}
        />
        <span style={{
          fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: onBand,
          letterSpacing: 0.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {status.code ?? "—"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 8.5, fontFamily: "monospace", color: onBand, opacity: 0.75, flexShrink: 0 }}>
          {status.hex ?? ""}
        </span>
      </div>

      <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{
            fontSize: 13, fontWeight: 600, color: "var(--text-primary)", fontFamily: "monospace",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {status.name}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 600, color: SEVERITY_COLORS[status.severity], flexShrink: 0 }}>
            {SEVERITY_LABELS[status.severity].toUpperCase()}
          </span>
        </div>

        <div style={{
          fontSize: 10.5, color: status.message ? "var(--text-primary)" : "var(--text-muted)",
          lineHeight: 1.45, minHeight: 30, fontFamily: "monospace",
          // The framework's message can be long ("Holding at 45.00 deg,
          // error 0.12"): two lines and cut, so the grid does not jump around.
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>
          {status.message ?? "no message"}
        </div>

        <ChangeStrip history={history} />
      </div>
    </div>
  )
}

/** A strip of the last colors the subsystem went through. */
function ChangeStrip({ history }: { history: StatusChange[] }) {
  if (history.length === 0) {
    return <div style={{ height: 8, fontSize: 8.5, color: "var(--text-muted)", fontFamily: "monospace" }}>—</div>
  }
  return (
    <div style={{ display: "flex", gap: 2, height: 8 }}>
      {history.map((change, i) => (
        <div
          key={i}
          title={`${change.code ?? "—"} · ${new Date(change.atMs).toLocaleTimeString()}`}
          style={{
            flex: 1,
            background: change.hex ?? "var(--grid-line)",
            border: "1px solid var(--border-light)",
            // The most recent is the last one, at full opacity; the old ones fade
            // so the direction of the change reads at a glance.
            opacity: 0.35 + 0.65 * ((i + 1) / history.length),
          }}
        />
      ))}
    </div>
  )
}

function HistoryList({ changes }: { changes: StatusChange[] }) {
  if (changes.length === 0) {
    return (
      <div style={{ padding: 10, fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace" }}>
        No changes recorded yet.
      </div>
    )
  }
  return (
    <div style={{ maxHeight: 190, overflowY: "auto" }}>
      {[...changes].reverse().map((change, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "flex-start", gap: 6, padding: "5px 8px",
          borderBottom: "1px solid var(--border-light)", fontSize: 9.5, fontFamily: "monospace",
        }}>
          <span style={{
            width: 9, height: 9, marginTop: 2, flexShrink: 0,
            border: "1px solid var(--border-main)", background: change.hex ?? "transparent",
          }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ color: "var(--text-primary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {change.code ?? "—"}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--text-muted)", flexShrink: 0 }}>
                {new Date(change.atMs).toLocaleTimeString()}
              </span>
            </div>
            {change.message && (
              <div style={{ color: "var(--text-muted)", lineHeight: 1.35, wordBreak: "break-word" }}>
                {change.message}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
