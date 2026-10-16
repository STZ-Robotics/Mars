import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { ConnectionState, LogSource } from "../../store/appStore"
import { MARS_VERSION_LABEL } from "../../constants/version"
import { MARS_PRODUCT_NAME } from "../../constants/edition"
import { MARS_ENABLED } from "@mars"

interface NTLinkStatus {
  address: string
  port: number
  connected: boolean
  latency_us: number
  server_time_us: number | null
}

interface Props {
  connection: ConnectionState
  projectName: string | null
  logSource: LogSource | null
}

// A bottom bar in the style of RViz's "Time" panel: "Label: [boxed value]"
// fields in a row, flat, without solid color blocks — color is reserved for the
// connection status dot, everything else is text + a neutral box.
export default function StatusBar({ connection, projectName, logSource }: Props) {
  // A loaded log replaces the connection: they share the backend's buffer.
  const connLabel = logSource
    ? "Log file"
    : connection === "sim" ? "Sim running" : connection === "real" ? "Real robot" : "Not connected"
  const connDotColor = logSource
    ? "var(--mars-accent)"
    : connection === "sim" ? "var(--status-sim)" : connection === "real" ? "var(--status-real)" : "var(--text-light)"
  const link = useNTLinkStatus(connection)

  return (
    <div style={{
      background: "var(--bg-dark)",
      height: 26,
      display: "flex",
      alignItems: "center",
      padding: "0 10px",
      gap: 14,
      flexShrink: 0,
      borderTop: "1px solid var(--border-main)",
    }}>
      <StatusField label="Connection">
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: connDotColor, flexShrink: 0 }} />
        {connLabel}
      </StatusField>

      {/* The session's real host and port: the target is no longer always
          localhost:5810 (it can be the robot, the DS on 6767 or Systemcore). */}
      <StatusField label={logSource ? "Source" : "NT4"}>
        {logSource
          ? `${logSource.name} · ${logSource.topic_count} topics`
          : link ? `${link.address}:${link.port}` : "—"}
      </StatusField>

      {/* Half the round trip measured with the RTT ping. "sync…" = no
          response has come back yet, so the clocks are not aligned. */}
      {!logSource && (
        <StatusField label="Latency">
          {link === null
            ? "—"
            : link.server_time_us === null
              ? "sync…"
              : `${(link.latency_us / 1000).toFixed(1)} ms`}
        </StatusField>
      )}

      {MARS_ENABLED && (
        <StatusField label="Project">
          {projectName ?? "none"}
        </StatusField>
      )}

      {/* A hand-written version here had been lying for several releases. It
          comes from the same constant as the splash screen and the installer. */}
      <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-light)" }}>
        {MARS_PRODUCT_NAME} {MARS_VERSION_LABEL}
      </div>
    </div>
  )
}

// The link's state is measured by the backend with the RTT ping; it is reread
// at 1Hz because it only feeds the bar's text, nothing that animates.
function useNTLinkStatus(connection: ConnectionState): NTLinkStatus | null {
  const [status, setStatus] = useState<NTLinkStatus | null>(null)

  useEffect(() => {
    if (connection === "disconnected") {
      setStatus(null)
      return
    }

    let cancelled = false
    const poll = () => {
      invoke<NTLinkStatus>("get_nt_link_status")
        .then(s => { if (!cancelled) setStatus(s.connected ? s : null) })
        .catch(() => { /* silencioso: puede pasar mientras reconecta */ })
    }

    poll()
    const interval = setInterval(poll, 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [connection])

  return status
}

function StatusField({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{label}:</span>
      <span style={{
        display: "flex", alignItems: "center", gap: 4,
        fontSize: 10.5, color: "var(--text-primary)", fontFamily: "ui-monospace, monospace",
        background: "var(--bg-input)", border: "1px solid var(--border-main)", borderRadius: 2,
        padding: "1px 6px", height: 16,
      }}>
        {children}
      </span>
    </div>
  )
}
