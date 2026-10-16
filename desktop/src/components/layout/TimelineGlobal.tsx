import { useRef, useState } from "react"
import { ConnectionState } from "../../store/appStore"
import { useSelectionStore, PLAYBACK_SPEEDS } from "../../store/selectionStore"
import { useMarkerStore, findAdjacentMarker } from "../../store/markerStore"
import { useNTLiveClock } from "../../utils/nt/useNTLiveClock"
import { usePlaybackEngine } from "../../utils/nt/usePlaybackEngine"
import TimelineCanvas, { TimelineCanvasHandle } from "./TimelineCanvas"
import ToolbarButton from "../common/ToolbarButton"
import TimelineSettings from "./TimelineSettings"

interface Props {
  connection: ConnectionState
  /** A log is loaded: there is data to go through even without an NT4 connection. */
  hasLog?: boolean
}

// The global timeline's chrome: transport (play/pause/go to the end), marks and
// settings. The drawing engine and all the scrub/pan/zoom interaction live in
// TimelineCanvas — this component only orchestrates the state.
export default function TimelineGlobal({ connection, hasLog = false }: Props) {
  const canvasRef = useRef<TimelineCanvasHandle>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const isLive = useSelectionStore((s) => s.isLive)
  const selectedTime = useSelectionStore((s) => s.selectedTime)
  const isPlaying = useSelectionStore((s) => s.isPlaying)
  const playbackSpeed = useSelectionStore((s) => s.playbackSpeed)
  const goLive = useSelectionStore((s) => s.goLive)
  const pauseAt = useSelectionStore((s) => s.pauseAt)
  const scrubTo = useSelectionStore((s) => s.scrubTo)
  const setHovered = useSelectionStore((s) => s.setHovered)
  const play = useSelectionStore((s) => s.play)
  const stop = useSelectionStore((s) => s.stop)
  const setPlaybackSpeed = useSelectionStore((s) => s.setPlaybackSpeed)

  const markers = useMarkerStore((s) => s.markers)
  const addMarker = useMarkerStore((s) => s.addMarker)
  const removeMarker = useMarkerStore((s) => s.removeMarker)

  // The real clock: startUs comes from the FIRST data point the backend
  // received (not from the component's mount), getEstimatedNowUs() from the last
  // one + a smooth interpolation so it flows between polls.
  const { startUs, endUs, getEstimatedNowUs } = useNTLiveClock(200)

  // In a log "now" is the last sample and it does not move: extrapolating with
  // performance.now() (which is right when live) would make the playhead run
  // ahead over an area with no data.
  const getNowUs = hasLog ? () => endUs : getEstimatedNowUs

  // Playing advances selectedTime; the cap is the last available data point.
  usePlaybackEngine(getNowUs)

  // "isConnected" here means "there is a data source", not literally a socket:
  // with a log open the timeline has to work the same.
  const isConnected = connection !== "disconnected" || hasLog
  const hasData = startUs !== null

  const statusColor = !isConnected || !hasData ? "var(--text-muted)"
    : isPlaying ? "var(--mars-accent)"
    : isLive ? "var(--status-sim)" : "var(--mars-red)"
  // The text went into the tooltip: the bar already says the same with the
  // color, and that block of letters was eating the time ruler's useful width.
  const statusTitle = !isConnected
    ? "Offline"
    : !hasData ? "Waiting for data"
    : isPlaying ? `Playing ${playbackSpeed}×`
    : hasLog ? "Log file"
    : isLive ? "Live" : "Paused"

  /** The instant the actions that need a concrete "now" point at. */
  const currentTime = () => selectedTime ?? getNowUs() ?? startUs ?? 0

  const handlePlayPause = () => {
    if (isPlaying) {
      stop()
      return
    }
    // With no cursor (live) it starts from the present; with a cursor, from there.
    canvasRef.current?.stopFollowingLive()
    play(currentTime())
  }

  const handleAddMarker = () => {
    const label = window.prompt("Marker label", `Mark ${markers.length + 1}`)
    if (label === null) return
    addMarker(currentTime(), label)
  }

  const jumpToMarker = (direction: "prev" | "next") => {
    const target = findAdjacentMarker(markers, currentTime(), direction)
    if (!target) return
    canvasRef.current?.stopFollowingLive()
    pauseAt(target.timeUs)
  }

  return (
    <div
      style={{
        height: 38,
        background: "linear-gradient(180deg, #f2f2f4 0%, #e2e2e6 100%)",
        borderTop: "1px solid var(--bevel-light)",
        borderBottom: "1px solid var(--bevel-dark)",
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        flexShrink: 0,
        opacity: isConnected ? 1 : 0.5,
        position: "relative",
        gap: 8,
        userSelect: "none",
        WebkitUserSelect: "none"
      }}
    >
      {/* Transport: play continues from the line, "go to the end" is what
          jumps to the last data point. Those two used to be the same button. */}
      <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
        <ToolbarButton
          size="sm"
          icon="ti-player-track-prev"
          label="Previous marker"
          disabled={!isConnected || markers.length === 0}
          onClick={() => jumpToMarker("prev")}
        />
        <ToolbarButton
          size="sm"
          icon={isPlaying ? "ti-player-pause" : "ti-player-play"}
          label={isPlaying ? "Pause" : "Play from cursor"}
          active={isPlaying}
          disabled={!isConnected || !hasData}
          onClick={handlePlayPause}
        />
        <ToolbarButton
          size="sm"
          icon="ti-player-track-next"
          label="Next marker"
          disabled={!isConnected || markers.length === 0}
          onClick={() => jumpToMarker("next")}
        />
        <ToolbarButton
          size="sm"
          icon="ti-player-skip-forward"
          label="Jump to latest"
          active={isLive}
          disabled={!isConnected}
          onClick={() => canvasRef.current?.goLive()}
        />
      </div>

      <div style={{ width: 1, height: 18, background: "var(--bevel-dark)", flexShrink: 0 }} />

      <ToolbarButton
        size="sm"
        icon="ti-flag-plus"
        label="Add marker at cursor"
        disabled={!isConnected || !hasData}
        onClick={handleAddMarker}
      />

      <span
        title={statusTitle}
        style={{
          width: 9, height: 9, borderRadius: "50%", flexShrink: 0, margin: "0 2px",
          background: statusColor,
          // A sunken recess around the LED, like a physical panel indicator.
          boxShadow: `inset 0 0 0 1px rgba(0,0,0,0.25), 0 0 0 2px var(--bg-toolbar), 0 0 0 3px var(--bevel-dark)${
            isConnected && hasData ? `, 0 0 6px ${statusColor}` : ""
          }`,
        }}
      />

      <TimelineCanvas
        ref={canvasRef}
        isConnected={isConnected}
        hasData={hasData}
        startUs={startUs}
        getEstimatedNowUs={getNowUs}
        isLive={isLive}
        selectedTime={selectedTime}
        markers={markers}
        goLive={goLive}
        pauseAt={pauseAt}
        scrubTo={scrubTo}
        setHovered={setHovered}
        onMarkerContextMenu={(id) => {
          const marker = markers.find(m => m.id === id)
          if (marker && window.confirm(`Delete marker "${marker.label}"?`)) removeMarker(id)
        }}
      />

      <div style={{ position: "relative", flexShrink: 0 }}>
        <ToolbarButton
          size="sm"
          icon="ti-adjustments-horizontal"
          label="Timeline settings"
          active={settingsOpen}
          onClick={() => setSettingsOpen(o => !o)}
        />
        {settingsOpen && (
          <TimelineSettings
            playbackSpeed={playbackSpeed}
            speeds={PLAYBACK_SPEEDS}
            onChangeSpeed={setPlaybackSpeed}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
