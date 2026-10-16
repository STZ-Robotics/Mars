// Mechanism 3D: a modeler of articulated mechanisms.
//
// A tree of parts is built (each one with its STL/GLB or a primitive), each one
// is given a joint — that rotates, that slides, or that takes a whole pose —
// and it is driven with an NT topic, by hand, or with an animation routine. The
// whole assembly exports to a JSON that can be imported back.
//
// The view does NOT follow the robot's pose on the field: the mechanism is
// looked at still, which is what verifying reductions, limits, directions of
// rotation and encoder offsets needs.

import React, { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import {
  TopicAnnounce, Mechanism3dPart, Mechanism3dSettings, Mechanism3dGizmo,
  Mechanism3dRoutine, Mechanism3dRoutineStep, makeMechanism3dPart,
} from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { useNTSnapshot } from "../utils/nt/useNTSnapshot"
import {
  descendantIds, duplicatePart, isJointTopic, parseMechanism3d, routineDuration,
  serializeMechanism3d, sweepStep,
} from "../utils/mechanism/mechanism3d"
import {
  LoadedModel, loadModel, pickModelFile, pickModelFiles, readFileBytes, fileNameOf,
} from "../utils/field/robotModel"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import SidebarIcon from "../components/common/SidebarIcon"
import Mechanism3dScene from "../components/dashboard/mechanism/Mechanism3dScene"
import Mechanism3dPartsPanel from "../components/dashboard/mechanism/Mechanism3dPartsPanel"
import Mechanism3dScenePanel from "../components/dashboard/mechanism/Mechanism3dScenePanel"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"

interface Props {
  topics: Map<string, TopicAnnounce>
  parts: Mechanism3dPart[]
  settings: Mechanism3dSettings
  onSetParts: (parts: Mechanism3dPart[]) => void
  onUpdateSettings: (updates: Partial<Mechanism3dSettings>) => void
}

// A counter of its own: creating three parts from a multi-file pick happens
// within the same millisecond and they would share the id, which is the key of
// the whole tree.
let idCounter = 0
const nextId = (prefix = "p") => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`

const SPEEDS = [0.25, 0.5, 1, 2, 4]

export default function Mechanism3dPage({
  topics, parts, settings, onSetParts, onUpdateSettings,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [panel, setPanel] = useState<"parts" | "scene">("parts")
  const [resetToken, setResetToken] = useState(0)
  const [status, setStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null)
  const isLive = useSelectionStore(s => s.isLive)

  // --- Datos en vivo -----------------------------------------------------------
  const topicNames = useMemo(() => {
    const names = new Set<string>()
    parts.forEach(part => { if (part.joint.topicName) names.add(part.joint.topicName) })
    return [...names]
  }, [parts])
  const values = useNTSnapshot(topicNames, 33)

  // --- Modelos -----------------------------------------------------------------
  const [models, setModels] = useState<Map<string, LoadedModel>>(new Map())
  const [modelErrors, setModelErrors] = useState<Map<string, string>>(new Map())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  // Paths already requested, so the load is not launched again on every render.
  const requested = useRef<Set<string>>(new Set())

  const modelPaths = useMemo(() => {
    const paths = new Set<string>()
    parts.forEach(part => { if (part.modelPath) paths.add(part.modelPath) })
    return [...paths]
  }, [parts])

  useEffect(() => {
    modelPaths.forEach(path => {
      if (requested.current.has(path)) return
      requested.current.add(path)
      setLoadingPaths(prev => new Set(prev).add(path))

      loadModel(path)
        .then(model => setModels(prev => new Map(prev).set(path, model)))
        .catch(error => setModelErrors(prev => new Map(prev).set(path, String(error?.message ?? error))))
        .finally(() => setLoadingPaths(prev => {
          const next = new Set(prev)
          next.delete(path)
          return next
        }))
    })
  }, [modelPaths])

  // --- Part editing ---------------------------------------------------------
  const updatePart = (id: string, updates: Partial<Mechanism3dPart>) => {
    onSetParts(parts.map(part => part.id === id ? { ...part, ...updates } : part))
  }

  const addPart = (parentId: string | null) => {
    const part = makeMechanism3dPart(nextId(), `Part ${parts.length + 1}`, parentId)
    onSetParts([...parts, part])
    setSelectedId(part.id)
  }

  const addFromFiles = async (parentId: string | null) => {
    try {
      const paths = await pickModelFiles("Add models as parts")
      if (paths.length === 0) return

      const added = paths.map(path => ({
        ...makeMechanism3dPart(nextId(), fileNameOf(path).replace(/\.[^.]+$/, ""), parentId),
        modelPath: path,
        modelName: fileNameOf(path),
        // With a file the primitive is not drawn: it would be a box floating
        // inside the freshly imported model.
        shape: "none" as const,
      }))
      onSetParts([...parts, ...added])
      setSelectedId(added[added.length - 1].id)
    } catch (error) {
      setStatus({ kind: "error", message: String(error) })
    }
  }

  const pickModelFor = async (id: string) => {
    try {
      const path = await pickModelFile("Select the model for this part")
      if (!path) return
      updatePart(id, { modelPath: path, modelName: fileNameOf(path), shape: "none" })
    } catch (error) {
      setStatus({ kind: "error", message: String(error) })
    }
  }

  const removePart = (id: string) => {
    // Deleting a part takes its branch with it: leaving the children loose would
    // send them straight to the world's origin, which is worse than losing them.
    const doomed = new Set(descendantIds(parts, id))
    onSetParts(parts.filter(part => !doomed.has(part.id)))
    if (selectedId !== null && doomed.has(selectedId)) setSelectedId(null)

    // A step pointing at a deleted part does nothing, but it leaves garbage in
    // the routine editor and confuses.
    onUpdateSettings({
      routines: settings.routines.map(routine => ({
        ...routine,
        steps: routine.steps.filter(step => !doomed.has(step.partId)),
      })),
    })
  }

  const duplicate = (id: string) => {
    const original = parts.find(part => part.id === id)
    if (!original) return
    const copy = duplicatePart(original, nextId())
    onSetParts([...parts, copy])
    setSelectedId(copy.id)
  }

  // The gizmo returns only the fields it touched (placement or pivot).
  const commitTransform = (id: string, updates: Partial<Mechanism3dPart>) => updatePart(id, updates)

  // --- Rutinas ---------------------------------------------------------------------
  const [playState, setPlayState] = useState<"stopped" | "playing" | "paused">("stopped")
  const [speed, setSpeed] = useState(1)
  const [seekToken, setSeekToken] = useState(0)
  // The progress bar is written straight into the DOM: the clock runs at 60 fps
  // and passing it through React state would re-render the panels on every frame.
  const progressRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)

  const activeRoutine = settings.routines.find(r => r.id === settings.activeRoutineId) ?? null

  const handleTick = (timeMs: number, fraction: number) => {
    if (progressRef.current) progressRef.current.style.width = `${Math.min(fraction, 1) * 100}%`
    if (timeRef.current) timeRef.current.textContent = `${(timeMs / 1000).toFixed(1)}s`
  }

  const stop = () => {
    setPlayState("stopped")
    setSeekToken(t => t + 1)
    handleTick(0, 0)
  }

  const updateRoutine = (id: string, updates: Partial<Mechanism3dRoutine>) => {
    onUpdateSettings({
      routines: settings.routines.map(r => r.id === id ? { ...r, ...updates } : r),
    })
  }

  const addRoutine = () => {
    const routine: Mechanism3dRoutine = {
      id: nextId("r"),
      name: `Routine ${settings.routines.length + 1}`,
      loop: true,
      steps: [],
    }
    onUpdateSettings({ routines: [...settings.routines, routine], activeRoutineId: routine.id })
  }

  const removeRoutine = (id: string) => {
    const routines = settings.routines.filter(r => r.id !== id)
    onUpdateSettings({
      routines,
      activeRoutineId: settings.activeRoutineId === id ? (routines[0]?.id ?? null) : settings.activeRoutineId,
    })
    if (settings.activeRoutineId === id) stop()
  }

  const addStep = (routineId: string, partId: string) => {
    const part = parts.find(p => p.id === partId)
    const routine = settings.routines.find(r => r.id === routineId)
    if (!part || !routine) return

    const step = sweepStep(part, nextId("s"))
    if (!step) {
      setStatus({ kind: "error", message: `“${part.name}” has no joint to animate — set its joint type first.` })
      return
    }
    updateRoutine(routineId, { steps: [...routine.steps, step] })
  }

  const updateStep = (routineId: string, stepId: string, updates: Partial<Mechanism3dRoutineStep>) => {
    const routine = settings.routines.find(r => r.id === routineId)
    if (!routine) return
    updateRoutine(routineId, { steps: routine.steps.map(s => s.id === stepId ? { ...s, ...updates } : s) })
  }

  const removeStep = (routineId: string, stepId: string) => {
    const routine = settings.routines.find(r => r.id === routineId)
    if (!routine) return
    updateRoutine(routineId, { steps: routine.steps.filter(s => s.id !== stepId) })
  }

  /**
   * "Animate": sets up a back-and-forth routine for the selected part and
   * starts it. It is the one-click path to the showcase, without going through
   * the editor.
   */
  const animateSelected = () => {
    const part = parts.find(p => p.id === selectedId)
    if (!part) {
      setStatus({ kind: "error", message: "Select a part first — Animate sweeps the selected joint." })
      return
    }
    const step = sweepStep(part, nextId("s"))
    if (!step) {
      setStatus({ kind: "error", message: `“${part.name}” is a fixed joint. Give it a revolute or prismatic joint first.` })
      return
    }

    const routine: Mechanism3dRoutine = {
      id: nextId("r"),
      name: `${part.name} sweep`,
      loop: true,
      steps: [step],
    }
    onUpdateSettings({ routines: [...settings.routines, routine], activeRoutineId: routine.id })
    setSeekToken(t => t + 1)
    setPlayState("playing")
    setStatus({ kind: "ok", message: `Animating “${part.name}”.` })
  }

  // --- Config ---------------------------------------------------------------------
  const configText = useMemo(() => serializeMechanism3d(parts, settings), [parts, settings])

  const handleExport = async () => {
    try {
      const suggested = `${(settings.name || "mechanism").replace(/[^\w.-]+/g, "-").toLowerCase()}.json`
      const path = await save({
        title: "Export mechanism",
        defaultPath: suggested,
        filters: [{ name: "MARS mechanism", extensions: ["json"] }],
      })
      if (!path) return
      await invoke("write_text_file", { path, contents: configText })
      setStatus({ kind: "ok", message: `Saved ${fileNameOf(path)}` })
    } catch (error) {
      setStatus({ kind: "error", message: String(error) })
    }
  }

  const applyConfig = (text: string, source: string): string | null => {
    try {
      const config = parseMechanism3d(text)
      onSetParts(config.parts)
      onUpdateSettings(config.settings)
      setSelectedId(null)
      stop()
      // The imported file's paths have not been requested yet in this session.
      requested.current = new Set()
      setModelErrors(new Map())
      setStatus({ kind: "ok", message: `Loaded ${config.parts.length} parts from ${source}` })
      return null
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      setStatus({ kind: "error", message })
      return message
    }
  }

  const handleImport = async () => {
    try {
      const path = await open({
        multiple: false,
        title: "Import mechanism",
        filters: [{ name: "MARS mechanism", extensions: ["json"] }],
      })
      if (!path || typeof path !== "string") return
      const bytes = await readFileBytes(path)
      applyConfig(new TextDecoder().decode(bytes), fileNameOf(path))
    } catch (error) {
      setStatus({ kind: "error", message: String(error) })
    }
  }

  // Dropping a topic on the canvas creates nothing by itself: the binding is
  // done on the joint, in the inspector. A notice says so, so it does not look broken.
  const [dropHint, setDropHint] = useState(false)

  const selected = parts.find(part => part.id === selectedId) ?? null

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>
      <DataDirectoryPanel
        topics={topics}
        hint="Drag a topic onto a joint's DRIVEN BY box"
        dragFilter={(t) => isJointTopic(t.topic_type)}
      />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="Mechanism 3D"
          meta={`${settings.name} · ${parts.length} ${parts.length === 1 ? "part" : "parts"}`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, overflow: "hidden" }}>
              <StatusBadge
                color={isLive ? "var(--status-sim)" : "var(--mars-red)"}
                label={isLive ? "LIVE" : "VIEWING HISTORY"}
              />

              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-header-eyebrow)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.manualOverride}
                  onChange={e => onUpdateSettings({ manualOverride: e.target.checked })}
                />
                MANUAL
              </label>

              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontSize: 10, color: "var(--text-header-eyebrow)" }}>GIZMO</span>
                <select
                  value={settings.gizmo}
                  onChange={e => onUpdateSettings({ gizmo: e.target.value as Mechanism3dGizmo })}
                  style={headerInputStyle}
                  title="What the drag handles do on the selected part"
                >
                  <option value="off">Off</option>
                  <option value="translate">Move</option>
                  <option value="rotate">Rotate</option>
                  <option value="pivot">Pivot</option>
                </select>
              </div>

              <HeaderButton
                icon={settings.background === "light" ? "ti-moon" : "ti-sun"}
                title="Switch the scene background"
                onClick={() => onUpdateSettings({ background: settings.background === "light" ? "dark" : "light" })}
              />
              <HeaderButton
                icon="ti-focus-centered"
                label="View"
                title="Back to the default camera"
                onClick={() => setResetToken(t => t + 1)}
              />
            </div>
          }
        />

        <TransportBar
          routines={settings.routines}
          activeRoutine={activeRoutine}
          playState={playState}
          speed={speed}
          progressRef={progressRef}
          timeRef={timeRef}
          selectedName={selected?.name ?? null}
          onSelectRoutine={id => { onUpdateSettings({ activeRoutineId: id }); stop() }}
          onPlayPause={() => setPlayState(s => s === "playing" ? "paused" : "playing")}
          onStop={stop}
          onToggleLoop={() => activeRoutine && updateRoutine(activeRoutine.id, { loop: !activeRoutine.loop })}
          onSpeed={setSpeed}
          onAnimate={animateSelected}
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "none"; if (!dropHint) setDropHint(true) }}
            onDragLeave={() => setDropHint(false)}
            onDrop={(e) => { e.preventDefault(); setDropHint(false) }}
            style={{ flex: 1, minWidth: 0, position: "relative", overflow: "hidden" }}
          >
            <Mechanism3dScene
              parts={parts}
              settings={settings}
              models={models}
              values={values}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCommit={commitTransform}
              resetCameraToken={resetToken}
              routine={activeRoutine}
              routineActive={playState !== "stopped"}
              routinePlaying={playState === "playing"}
              routineSpeed={speed}
              routineSeekToken={seekToken}
              onRoutineTick={handleTick}
            />

            {parts.length === 0 && (
              <Overlay>
                <b>Empty mechanism.</b> Use <i>Import STL</i> in the Parts panel to bring in one or more
                models, or <i>Add</i> for a primitive. Then set each part's parent, its joint axis, and drag
                a topic onto <i>Driven by</i>.
              </Overlay>
            )}

            {dropHint && (
              <Overlay>
                Drop the topic on the joint's <i>Driven by</i> box in the Parts panel, not on the scene.
              </Overlay>
            )}

            {selected && (
              <div style={{ ...overlayStyle, top: "auto", bottom: 10, left: 10, maxWidth: "none" }}>
                <span style={{ fontSize: 11, color: "var(--text-primary)" }}>{selected.name}</span>
                <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 8, fontVariantNumeric: "tabular-nums" }}>
                  {selected.origin.map(v => v.toFixed(3)).join(", ")} m ·{" "}
                  {selected.originRotation.map(v => v.toFixed(1)).join(", ")}°
                </span>
              </div>
            )}

            <div style={{
              position: "absolute", right: 10, bottom: 8, fontSize: 9.5,
              color: settings.background === "dark" ? "rgba(255,255,255,0.5)" : "var(--text-muted)",
              pointerEvents: "none", userSelect: "none",
            }}>
              click to select · drag to orbit · scroll to zoom
            </div>
          </div>

          <div style={{
            width: 300, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)",
            flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
          }}>
            <div style={{ display: "flex", borderBottom: "1px solid var(--border-main)", flexShrink: 0 }}>
              <TabButton label="Parts" svg="part.svg" icon="ti-box" active={panel === "parts"} onClick={() => setPanel("parts")} />
              <TabButton label="Scene & config" svg="scene.svg" icon="ti-adjustments" active={panel === "scene"} onClick={() => setPanel("scene")} />
            </div>

            <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {panel === "parts" ? (
                <Mechanism3dPartsPanel
                  parts={parts}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onAdd={addPart}
                  onAddFromFiles={addFromFiles}
                  onDuplicate={duplicate}
                  onRemove={removePart}
                  onUpdate={updatePart}
                  onPickModel={pickModelFor}
                  onAnimate={animateSelected}
                  models={models}
                  modelErrors={modelErrors}
                  loadingPaths={loadingPaths}
                  values={values}
                  manualOverride={settings.manualOverride}
                />
              ) : (
                <Mechanism3dScenePanel
                  settings={settings}
                  parts={parts}
                  onUpdate={onUpdateSettings}
                  onExport={handleExport}
                  onImport={handleImport}
                  onImportText={text => applyConfig(text, "the pasted text")}
                  configText={configText}
                  status={status}
                  selectedPartId={selectedId}
                  onAddRoutine={addRoutine}
                  onRemoveRoutine={removeRoutine}
                  onUpdateRoutine={updateRoutine}
                  onAddStep={addStep}
                  onUpdateStep={updateStep}
                  onRemoveStep={removeStep}
                />
              )}
            </div>

            {/* The export lives outside the panel's tabs: saving the mechanism
                is the last thing done after arranging it, and it has no reason
                to force switching tabs to find it. */}
            <div style={{
              flexShrink: 0, borderTop: "1px solid var(--border-main)",
              background: "var(--bg-panel-header)", padding: "8px 10px",
              display: "flex", flexDirection: "column", gap: 5,
            }}>
              <div style={{ display: "flex", gap: 5 }}>
                <button onClick={handleExport} style={footerButtonStyle} title="Save this mechanism as a JSON file">
                  <SidebarIcon fallback="ti-download" size={14} />
                  Export configuration
                </button>
                <button
                  onClick={handleImport}
                  style={{ ...footerButtonStyle, flex: "0 0 auto" }}
                  title="Load a mechanism JSON (replaces every part in this tab)"
                >
                  <SidebarIcon fallback="ti-upload" size={14} />
                </button>
              </div>
              {status && (
                <span style={{
                  fontSize: 9.5, lineHeight: 1.45,
                  color: status.kind === "error" ? "var(--status-error)" : "var(--text-muted)",
                }}>
                  {status.message}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Playback bar -------------------------------------------------------

function TransportBar({
  routines, activeRoutine, playState, speed, progressRef, timeRef, selectedName,
  onSelectRoutine, onPlayPause, onStop, onToggleLoop, onSpeed, onAnimate,
}: {
  routines: Mechanism3dRoutine[]
  activeRoutine: Mechanism3dRoutine | null
  playState: "stopped" | "playing" | "paused"
  speed: number
  progressRef: React.RefObject<HTMLDivElement | null>
  timeRef: React.RefObject<HTMLSpanElement | null>
  selectedName: string | null
  onSelectRoutine: (id: string) => void
  onPlayPause: () => void
  onStop: () => void
  onToggleLoop: () => void
  onSpeed: (v: number) => void
  onAnimate: () => void
}) {
  const duration = activeRoutine ? routineDuration(activeRoutine) : 0

  return (
    <div style={{
      height: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 8,
      padding: "0 12px", background: "var(--bg-toolbar)",
      borderBottom: "1px solid var(--border-main)",
    }}>
      <SidebarIcon svg="animate.svg" fallback="ti-movie" size={14} />

      {routines.length === 0 ? (
        <>
          <button onClick={onAnimate} style={transportButtonStyle} title="Sweep the selected joint back and forth">
            <SidebarIcon svg="sweep.svg" fallback="ti-arrows-left-right" size={13} />
            Animate {selectedName ? `“${selectedName}”` : "selected part"}
          </button>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
            builds a back-and-forth routine you can then edit under Scene &amp; config.
          </span>
        </>
      ) : (
        <>
          <select
            value={activeRoutine?.id ?? ""}
            onChange={e => onSelectRoutine(e.target.value)}
            style={{ ...headerInputStyle, maxWidth: 140 }}
            title="Routine to play"
          >
            {routines.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>

          <button
            onClick={onPlayPause}
            style={transportButtonStyle}
            disabled={!activeRoutine || duration === 0}
            title={playState === "playing" ? "Pause" : "Play"}
          >
            <SidebarIcon
              svg={playState === "playing" ? "pause.svg" : "play.svg"}
              fallback={playState === "playing" ? "ti-player-pause" : "ti-player-play"}
              size={13}
            />
          </button>
          <button onClick={onStop} style={transportButtonStyle} title="Stop and hand control back to the topics">
            <SidebarIcon svg="stop.svg" fallback="ti-player-stop" size={13} />
          </button>

          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--text-header-eyebrow)", cursor: "pointer" }}>
            <input type="checkbox" checked={activeRoutine?.loop ?? false} onChange={onToggleLoop} />
            LOOP
          </label>

          <select value={speed} onChange={e => onSpeed(Number(e.target.value))} style={headerInputStyle} title="Playback speed">
            {SPEEDS.map(v => <option key={v} value={v}>{v}×</option>)}
          </select>

          {/* Progress bar: the scene writes its width directly, without
              going through React. */}
          <div style={{ flex: 1, minWidth: 40, height: 4, borderRadius: 2, background: "var(--border-main)", overflow: "hidden" }}>
            <div ref={progressRef} style={{ width: 0, height: "100%", background: "var(--mars-accent)" }} />
          </div>
          <span
            ref={timeRef}
            style={{ fontSize: 10, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", minWidth: 32, textAlign: "right" }}
          >
            0.0s
          </span>
          <span style={{ fontSize: 9.5, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
            / {(duration / 1000).toFixed(1)}s
          </span>

          <button onClick={onAnimate} style={transportButtonStyle} title="New back-and-forth routine for the selected joint">
            <SidebarIcon svg="sweep.svg" fallback="ti-arrows-left-right" size={13} />
          </button>
        </>
      )}
    </div>
  )
}

// --- Piezas de UI ----------------------------------------------------------------

function Overlay({ children }: { children: React.ReactNode }) {
  return <div style={overlayStyle}>{children}</div>
}

function HeaderButton({
  svg, icon, label, title, onClick,
}: { svg?: string; icon: string; label?: string; title: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={headerButtonStyle} title={title}>
      <SidebarIcon svg={svg} fallback={icon} size={13} />
      {label}
    </button>
  )
}

function TabButton({
  label, svg, icon, active, onClick,
}: { label: string; svg: string; icon: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: "7px 0", fontSize: 10.5, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        background: active ? "var(--bg-panel)" : "var(--bg-panel-header)",
        color: active ? "var(--text-primary)" : "var(--text-muted)",
        border: "none",
        borderBottom: active ? "2px solid var(--mars-accent)" : "2px solid transparent",
        fontWeight: active ? 600 : 400,
      }}
    >
      <SidebarIcon svg={svg} fallback={icon} size={13} />
      {label}
    </button>
  )
}

const overlayStyle: React.CSSProperties = {
  position: "absolute", left: 10, top: 10, maxWidth: 320,
  background: "rgba(255, 255, 255, 0.88)",
  border: "1px solid var(--border-main)",
  borderRadius: 3,
  padding: "7px 10px",
  fontSize: 11,
  lineHeight: 1.55,
  color: "var(--text-primary)",
  pointerEvents: "none",
  userSelect: "none",
}

const headerInputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-main)",
  padding: "3px 6px",
  borderRadius: 2,
  fontSize: 11,
  outline: "none",
}

const headerButtonStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5,
  background: "var(--bg-input)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", borderRadius: 2,
  padding: "3px 8px", fontSize: 10.5, cursor: "pointer",
}

const transportButtonStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5,
  background: "var(--bg-input)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", borderRadius: 2,
  padding: "3px 7px", fontSize: 10.5, cursor: "pointer",
}

const footerButtonStyle: React.CSSProperties = {
  flex: 1,
  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  background: "var(--bg-input)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", borderRadius: 2,
  padding: "6px 8px", fontSize: 11, cursor: "pointer",
}
