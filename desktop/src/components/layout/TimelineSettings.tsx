import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useMarkerStore } from "../../store/markerStore"
import { useMarsSettings } from "../../hooks/useMarsSettings"

interface Props {
  playbackSpeed: number
  speeds: readonly number[]
  onChangeSpeed: (speed: number) => void
  onClose: () => void
}

// How much history the backend's buffer keeps. With no cap, a long session
// leaves an hours-long timeline in which the useful range is an invisible
// sliver; with a cap, the start keeps moving and the zoom always lands on data.
// 0 = no limit (explicit opt-in, it eats the RAM).
const RETENTION_OPTIONS = [
  { minutes: 1, label: "1 minute" },
  { minutes: 5, label: "5 minutes" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 0, label: "Unlimited (uses RAM)" },
]

export default function TimelineSettings({ playbackSpeed, speeds, onChangeSpeed, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const { settings, save } = useMarsSettings()
  const [retention, setRetention] = useState<number | null>(null)

  const markers = useMarkerStore(s => s.markers)
  const clearMarkers = useMarkerStore(s => s.clearMarkers)
  const removeMarker = useMarkerStore(s => s.removeMarker)

  // Retention lives in the config, but the effective value is the buffer's: it
  // is synced from settings once they have finished loading.
  useEffect(() => {
    if (retention === null) setRetention(settings.nt_retention_minutes)
  }, [settings.nt_retention_minutes, retention])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [onClose])

  const applyRetention = async (minutes: number) => {
    setRetention(minutes)
    // It is applied to the ALREADY connected buffer and also saved, so the next
    // connection starts the same (the buffer is recreated on every connect).
    try {
      await invoke("set_buffer_retention_minutes", { minutes })
    } catch { /* no connection yet; it stays saved for the next connect */ }
    save({ ...settings, nt_retention_minutes: minutes }).catch(() => {})
  }

  return (
    <div
      ref={rootRef}
      style={{
        position: "absolute", bottom: "100%", right: 0, marginBottom: 4, zIndex: 400,
        width: 236, background: "var(--bg-panel)",
        borderTop: "1px solid var(--bevel-light)",
        borderLeft: "1px solid var(--bevel-light)",
        borderRight: "1px solid var(--bevel-dark)",
        borderBottom: "1px solid var(--bevel-dark)",
        boxShadow: "2px 2px 0 var(--shadow-soft)",
        padding: "4px 0",
      }}
    >
      <SectionTitle>Playback speed</SectionTitle>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, padding: "2px 8px 6px" }}>
        {speeds.map(speed => (
          <button
            key={speed}
            onClick={() => onChangeSpeed(speed)}
            style={{
              flex: "1 0 30%", height: 20, fontSize: 10.5, cursor: "pointer",
              background: speed === playbackSpeed ? "var(--tree-selection-bg)" : "var(--btn-classic-bg)",
              color: speed === playbackSpeed ? "var(--tree-selection-fg)" : "var(--text-primary)",
              border: "1px solid var(--btn-classic-border)",
            }}
          >
            {speed}×
          </button>
        ))}
      </div>

      <Divider />

      <SectionTitle>History kept</SectionTitle>
      <div style={{ padding: "2px 8px 6px" }}>
        <select
          value={retention ?? 15}
          onChange={e => applyRetention(Number(e.target.value))}
          style={{
            width: "100%", height: 20, fontSize: 10.5,
            background: "var(--bg-input)", color: "var(--text-primary)",
            border: "1px solid var(--border-main)", outline: "none",
          }}
        >
          {RETENTION_OPTIONS.map(o => (
            <option key={o.minutes} value={o.minutes}>{o.label}</option>
          ))}
        </select>
        <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.3 }}>
          Older samples are dropped, so the timeline never grows past this window.
        </div>
      </div>

      <Divider />

      <SectionTitle>
        Markers
        {markers.length > 0 && (
          <button
            onClick={() => { if (window.confirm("Delete all markers?")) clearMarkers() }}
            style={{
              marginLeft: "auto", fontSize: 9.5, background: "transparent",
              border: "none", color: "var(--status-error)", cursor: "pointer", padding: 0,
            }}
          >
            clear all
          </button>
        )}
      </SectionTitle>

      <div style={{ maxHeight: 132, overflowY: "auto" }}>
        {markers.length === 0 ? (
          <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "2px 8px 6px", fontStyle: "italic" }}>
            None yet — use the flag button to mark the cursor.
          </div>
        ) : (
          markers.map(marker => (
            <div
              key={marker.id}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                height: 19, padding: "0 8px", fontSize: 10.5,
              }}
            >
              <span style={{ width: 7, height: 7, background: marker.color, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {marker.label}
              </span>
              <button
                onClick={() => removeMarker(marker.id)}
                title="Delete marker"
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0, fontSize: 11, lineHeight: 1 }}
              >
                <i className="ti ti-x" aria-hidden />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center",
      fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase",
      color: "var(--text-muted)", padding: "4px 8px 2px",
    }}>
      {children}
    </div>
  )
}

function Divider() {
  return <div style={{ borderTop: "1px solid var(--bevel-dark)", borderBottom: "1px solid var(--bevel-light)", margin: "2px 4px" }} />
}
