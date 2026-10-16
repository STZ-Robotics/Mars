// NT Session: MARS as a NetworkTables PUBLISHER.
//
// The reverse of the rest of the app: here what the robot sends is not read;
// topics of our own are created under a root table ("MarsDesktop" by default)
// and the robot reads them. Tuning gains is the obvious case, but the tab is not
// tied to that — any value you want to send the robot live lives here, and each
// one knows how to copy itself as Java code ready to paste.

import React, { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import {
  TopicAnnounce, ConnectionState, NTSessionEntry, NTSessionSettings,
  NTSessionCopyMode, NTSessionKind,
} from "../store/appStore"
import { unpackLiveValue } from "../utils/dashboard/valueDecoding"
import { classifyTopic } from "../utils/dashboard/topicClassification"
import {
  NT_SESSION_ROOT, fullTopicName, javaBlock, keyFromTopicName, kindSpec, makeEntry,
  publishPayload, schemaPublications, suggestJavaName,
} from "../utils/nt/ntSession"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import NTSessionEntryCard, { PublishState } from "../components/dashboard/nt/NTSessionEntryCard"
import SidebarIcon from "../components/common/SidebarIcon"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"
import { Section, Row, Check, Select, PanelButton, Hint } from "../components/dashboard/three/PanelFields"

interface Props {
  topics: Map<string, TopicAnnounce>
  connection: ConnectionState
  entries: NTSessionEntry[]
  settings: NTSessionSettings
  onSetEntries: (entries: NTSessionEntry[]) => void
  onUpdateSettings: (updates: Partial<NTSessionSettings>) => void
}

let idCounter = 0
const nextId = () => `n${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** Publishing on every slider keystroke saturates the socket with no visible gain. */
const PUBLISH_DEBOUNCE_MS = 60

const COPY_MODES: { value: NTSessionCopyMode; label: string }[] = [
  { value: "declaration", label: "Declaration — double kA = 0.3;" },
  { value: "value", label: "Value only — 0.3" },
  { value: "getter", label: "NT getter — reads it back" },
]

export default function NTSessionPage({
  topics, connection, entries, settings, onSetEntries, onUpdateSettings,
}: Props) {
  const [states, setStates] = useState<Record<string, { state: PublishState; error: string | null }>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const timers = useRef<Map<string, number>>(new Map())
  // What was last sent for each value. Comparing against this is what lets a row
  // be marked "edited but not published".
  const [publishedSignatures, setPublishedSignatures] = useState<Record<string, string>>({})
  // Schemas already announced on this connection; no need to repeat them.
  const sentSchemas = useRef<Set<string>>(new Set())

  const connected = connection !== "disconnected"

  // --- Publishing ---------------------------------------------------------------

  /**
   * A struct without its schema reads fine on the robot (its Java class
   * already knows the layout) but it is opaque to any dynamic consumer. It is
   * published once per connection, together with the nested structs.
   */
  const publishSchemas = async (entry: NTSessionEntry) => {
    const structName = kindSpec(entry.kind).structName
    if (!structName) return

    for (const schema of schemaPublications(structName)) {
      if (sentSchemas.current.has(schema.topicName)) continue
      sentSchemas.current.add(schema.topicName)
      try {
        await invoke("set_value", {
          topicName: schema.topicName,
          topicType: schema.topicType,
          value: schema.value,
        })
      } catch {
        // If the schema fails the value is still useful: it retries next time.
        sentSchemas.current.delete(schema.topicName)
      }
    }
  }

  const publish = async (entry: NTSessionEntry) => {
    if (!connected) return
    const payload = publishPayload(entry)
    try {
      await publishSchemas(entry)
      await invoke("set_value", {
        topicName: fullTopicName(NT_SESSION_ROOT, entry.key),
        topicType: payload.topicType,
        value: payload.value,
      })
      setStates(prev => ({ ...prev, [entry.id]: { state: "ok", error: null } }))
      setPublishedSignatures(prev => ({ ...prev, [entry.id]: signatureOf(entry, NT_SESSION_ROOT) }))
    } catch (error) {
      setStates(prev => ({ ...prev, [entry.id]: { state: "error", error: String(error) } }))
    }
  }

  /**
   * Withdraws a topic from the network. Renaming without this leaves the old
   * name published until the app closes, and republishing the same name with
   * another type NT does not allow at all.
   */
  const unpublish = async (topicName: string) => {
    if (!connected) return
    try {
      await invoke("unpublish_value", { topicName })
    } catch {
      // Withdrawing something that was never published is not an error worth reporting.
    }
  }

  const schedulePublish = (entry: NTSessionEntry) => {
    if (!settings.autoPublish || !connected) return
    const existing = timers.current.get(entry.id)
    if (existing !== undefined) window.clearTimeout(existing)
    timers.current.set(entry.id, window.setTimeout(() => {
      timers.current.delete(entry.id)
      publish(entry)
    }, PUBLISH_DEBOUNCE_MS))
  }

  useEffect(() => () => {
    timers.current.forEach(id => window.clearTimeout(id))
    timers.current.clear()
  }, [])

  const publishAll = async () => {
    for (const entry of entries) await publish(entry)
    setToast(`Published ${entries.length} ${entries.length === 1 ? "value" : "values"}`)
  }

  // On reconnecting, the server knows nothing about our topics: the client
  // clears its published table, so they all have to be announced again.
  const wasConnected = useRef(connected)
  useEffect(() => {
    if (connected && !wasConnected.current && entries.length > 0) {
      // The server keeps nothing we published, schemas included.
      sentSchemas.current.clear()
      entries.forEach(entry => publish(entry))
      setToast("Reconnected — republished every value")
    }
    if (!connected) {
      sentSchemas.current.clear()
      setPublishedSignatures({})
    }
    wasConnected.current = connected
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  // --- Editing -------------------------------------------------------------------
  const updateEntry = (id: string, updates: Partial<NTSessionEntry>) => {
    const before = entries.find(entry => entry.id === id)
    const next = entries.map(entry => entry.id === id ? { ...entry, ...updates } : entry)
    onSetEntries(next)

    const after = next.find(entry => entry.id === id)
    if (!before || !after) return

    // Changing the name or the type withdraws the previous topic, if it got
    // published: otherwise typing "test" letter by letter leaves /t, /te and /tes
    // hanging on the network.
    const renamed = updates.key !== undefined && updates.key !== before.key
    const retyped = updates.kind !== undefined && updates.kind !== before.kind
    if (renamed || retyped) {
      if (publishedSignatures[id] !== undefined) unpublish(fullTopicName(NT_SESSION_ROOT, before.key))
      setPublishedSignatures(prev => {
        const clean = { ...prev }
        delete clean[id]
        return clean
      })
      setStates(prev => ({ ...prev, [id]: { state: "idle", error: null } }))
      return
    }

    // Only the VALUE triggers automatic publishing. Renaming, changing the
    // slider's range or writing a note sends nothing.
    const valueChanged = updates.numbers !== undefined
      || updates.booleans !== undefined
      || updates.strings !== undefined
    if (valueChanged) schedulePublish(after)
  }

  const addEntry = (kind: NTSessionKind = "double") => {
    const entry = makeEntry(nextId(), `value${entries.length + 1}`, kind)
    onSetEntries([...entries, entry])
  }

  const removeEntry = (id: string) => {
    const entry = entries.find(e => e.id === id)
    if (entry && publishedSignatures[id] !== undefined) {
      unpublish(fullTopicName(NT_SESSION_ROOT, entry.key))
    }

    onSetEntries(entries.filter(e => e.id !== id))
    setStates(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setPublishedSignatures(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  /**
   * Creates a value from a topic that already exists, copying what it is worth
   * right now. Used by the drop from the tree and the "adopt" button of the
   * published topics list.
   *
   * The value is requested on the spot and not with a live subscription: this
   * tab shows no robot data, so polling the whole tree several times a second
   * would be wasted work.
   */
  const captureTopic = async (topicName: string, topicType: string, keyOverride?: string) => {
    const kind = kindForTopic(topicType)
    if (!kind) {
      setToast(`“${topicType}” cannot be captured as a publishable value yet.`)
      return
    }

    const key = keyOverride ?? topicName.split("/").filter(Boolean).pop() ?? "value"
    const entry = makeEntry(nextId(), key, kind)
    entry.javaName = suggestJavaName(key)
    if (keyOverride === undefined) entry.note = `from ${topicName}`

    let captured = entry
    try {
      const values = await invoke<Record<string, unknown>>("get_live_values", { topicNames: [topicName] })
      captured = applyLiveValue(entry, kind, values[topicName])
    } catch {
      // With no connection there is no value to copy, but the field is created
      // anyway: it is filled by hand and serves the same for generating the Java.
    }

    onSetEntries([...entries, captured])
    setToast(`Captured ${key}`)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const topicName = e.dataTransfer.getData("topicName")
    const topicType = e.dataTransfer.getData("topicType")
    if (topicName) captureTopic(topicName, topicType)
  }

  // --- Orphan topics ------------------------------------------------------------
  // What is on the network under the root but no longer has a card here: it is
  // left like that when a value was renamed before automatic withdrawal existed,
  // or when the tab was deleted without deleting the values.
  const orphans = useMemo(() => {
    const owned = new Set(entries.map(entry => fullTopicName(NT_SESSION_ROOT, entry.key)))
    return [...topics.values()]
      .filter(topic => keyFromTopicName(topic.name) !== null && !owned.has(topic.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [topics, entries])

  const removeOrphan = async (topicName: string) => {
    await unpublish(topicName)
    setToast(`Removed ${topicName}`)
  }

  const removeAllOrphans = async () => {
    for (const topic of orphans) await unpublish(topic.name)
    setToast(`Removed ${orphans.length} leftover ${orphans.length === 1 ? "topic" : "topics"}`)
  }

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => setToast(`Copied ${what}`),
      () => setToast("Could not reach the clipboard"),
    )
  }

  useEffect(() => {
    if (toast === null) return
    const id = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(id)
  }, [toast])

  const block = useMemo(
    () => javaBlock(entries, settings.copyMode, NT_SESSION_ROOT),
    [entries, settings.copyMode, NT_SESSION_ROOT],
  )

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>
      <DataDirectoryPanel
        topics={topics}
        hint="Drag a topic here to copy its current value as Java"
      />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="NT Session"
          meta={`/${NT_SESSION_ROOT}/ · ${entries.length} ${entries.length === 1 ? "value" : "values"}`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, overflow: "hidden" }}>
              <StatusBadge
                color={connected ? "var(--status-sim)" : "var(--mars-red)"}
                label={connected ? "PUBLISHING" : "NOT CONNECTED"}
              />
              <HeaderButton
                svg="add-entry.svg"
                icon="ti-plus"
                label="Add value"
                title="New published value"
                onClick={() => addEntry()}
              />
              <HeaderButton
                svg="republish.svg"
                icon="ti-refresh"
                label="Publish all"
                title="Announce and send every value again"
                onClick={publishAll}
                disabled={!connected || entries.length === 0}
              />
            </div>
          }
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!isDragOver) setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            style={{
              flex: 1, minWidth: 0, overflowY: "auto", padding: 12,
              display: "flex", flexDirection: "column", gap: 8,
              background: isDragOver ? "var(--bg-panel)" : "var(--bg-page)",
              border: isDragOver ? "1px dashed var(--mars-red)" : "1px solid transparent",
            }}
          >
            {!connected && (
              <Notice>
                Not connected. You can still build values and copy the Java — nothing reaches the robot
                until you connect, and everything gets published automatically when you do.
              </Notice>
            )}

            {entries.length === 0 ? (
              <Notice>
                <b>Nothing published yet.</b> <i>Add value</i> creates a topic under{" "}
                <b>{NT_SESSION_ROOT}/</b> that the robot can read. You can also drag a topic from the left to
                capture whatever the robot is publishing right now and copy it as Java.
              </Notice>
            ) : (
              entries.map(entry => (
                <NTSessionEntryCard
                  key={entry.id}
                  entry={entry}
                  fullName={fullTopicName(NT_SESSION_ROOT, entry.key)}
                  live={topics.has(fullTopicName(NT_SESSION_ROOT, entry.key))}
                  publishState={states[entry.id]?.state ?? "idle"}
                  publishError={states[entry.id]?.error ?? null}
                  published={publishedSignatures[entry.id] !== undefined}
                  pending={
                    publishedSignatures[entry.id] !== undefined
                    && publishedSignatures[entry.id] !== signatureOf(entry, NT_SESSION_ROOT)
                  }
                  copyMode={settings.copyMode}
                  root={NT_SESSION_ROOT}
                  onUpdate={updates => updateEntry(entry.id, updates)}
                  onRemove={() => removeEntry(entry.id)}
                  onPublish={() => publish(entry)}
                  onCopy={copy}
                />
              ))
            )}
          </div>

          <div style={{
            width: 300, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)",
            flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
          }}>
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              <Section title="Session" defaultOpen svg="nt-session.svg" icon="ti-broadcast">
                <Hint>
                  Everything here is published under <b>/{NT_SESSION_ROOT}/</b>. On the robot:{" "}
                  <code>NetworkTableInstance.getDefault().getTable("{NT_SESSION_ROOT}")</code>.
                </Hint>
                <Check
                  label="Publish while editing"
                  checked={settings.autoPublish}
                  onChange={v => onUpdateSettings({ autoPublish: v })}
                  help="Sends the VALUE as you type or drag the slider — handy for tuning with a slider. It never fires when you rename a value or change its type; those only go out with the publish button. Off by default so nothing reaches the robot until you say so."
                />
                <Hint>
                  A topic is announced the first time it is published, so a value only shows up on the
                  robot after it has been sent once. Nothing here is persistent: the server drops
                  every one of these topics when MARS disconnects.
                </Hint>
              </Section>

              <Section
                title="Published topics"
                defaultOpen={orphans.length > 0}
                svg="network.svg"
                icon="ti-affiliate"
                badge={`${entries.length + orphans.length}`}
              >
                <Hint>
                  What is on the network under <b>/{NT_SESSION_ROOT}/</b> right now. Anything without a
                  card below is left over — from a rename, or from a value that was deleted elsewhere.
                </Hint>

                {orphans.length === 0 ? (
                  <Hint>No leftover topics. Every published value has its card.</Hint>
                ) : (
                  <>
                    {orphans.map(topic => (
                      <div
                        key={topic.name}
                        style={{
                          display: "flex", alignItems: "center", gap: 5, fontSize: 10,
                          background: "var(--bg-input)", border: "1px solid var(--border-main)",
                          borderRadius: 2, padding: "4px 6px",
                        }}
                      >
                        <span
                          title={`${topic.name} · ${topic.topic_type}`}
                          style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {keyFromTopicName(topic.name)}
                        </span>
                        <button
                          onClick={() => captureTopic(topic.name, topic.topic_type, keyFromTopicName(topic.name) ?? undefined)}
                          title="Take it over: make a card for it with its current value"
                          style={miniButtonStyle}
                        >
                          Adopt
                        </button>
                        <button
                          onClick={() => removeOrphan(topic.name)}
                          title="Remove it from the network"
                          style={{ ...miniButtonStyle, color: "var(--status-error)" }}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <PanelButton
                      label={`Remove all ${orphans.length} leftover`}
                      svg="delete.svg"
                      icon="ti-trash"
                      danger
                      disabled={!connected}
                      onClick={removeAllOrphans}
                    />
                    <Hint>
                      Removing only works on topics this MARS session published. One left by a previous
                      run is already gone from the server — it just needs a reconnect to disappear here.
                    </Hint>
                  </>
                )}
              </Section>

              <Section title="Copy format" defaultOpen svg="copy-java.svg" icon="ti-clipboard-text">
                <Select<NTSessionCopyMode>
                  label="What the copy button gives you"
                  value={settings.copyMode}
                  options={COPY_MODES}
                  help="Declaration is the constant ready to paste. Value only is just the expression, for pasting into a call. NT getter reads it back from NetworkTables using the current value as the default."
                  onChange={v => onUpdateSettings({ copyMode: v })}
                />
                <PanelButton
                  label="Copy all as a Java block"
                  svg="copy-java.svg"
                  icon="ti-clipboard-text"
                  disabled={entries.length === 0}
                  onClick={() => copy(block, `${entries.length} values`)}
                />
                <Hint>Includes the imports each type needs, sorted and without repeats.</Hint>

                {entries.length > 0 && (
                  <pre style={{
                    margin: 0, maxHeight: 180, overflow: "auto", background: "var(--bg-input)",
                    border: "1px solid var(--border-main)", borderRadius: 2, padding: "6px 7px",
                    fontSize: 9.5, lineHeight: 1.5, whiteSpace: "pre", color: "var(--text-primary)",
                  }}>
                    {block}
                  </pre>
                )}
              </Section>

              <Section title="Quick add" svg="add-entry.svg" icon="ti-plus">
                <Hint>Creates a value already set to that type.</Hint>
                <Row>
                  <PanelButton label="double" onClick={() => addEntry("double")} />
                  <PanelButton label="boolean" onClick={() => addEntry("boolean")} />
                  <PanelButton label="String" onClick={() => addEntry("string")} />
                </Row>
                <Row>
                  <PanelButton label="Pose2d" onClick={() => addEntry("Pose2d")} />
                  <PanelButton label="Rotation2d" onClick={() => addEntry("Rotation2d")} />
                </Row>
                <Row>
                  <PanelButton label="double[]" onClick={() => addEntry("double[]")} />
                  <PanelButton label="ChassisSpeeds" onClick={() => addEntry("ChassisSpeeds")} />
                </Row>
              </Section>
            </div>

            {toast && (
              <div style={{
                flexShrink: 0, borderTop: "1px solid var(--border-main)",
                background: "var(--bg-panel-header)", padding: "7px 10px",
                fontSize: 10.5, color: "var(--text-primary)",
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <SidebarIcon svg="status-ok.svg" fallback="ti-check" size={13} />
                {toast}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Fingerprint of what would be published right now. If it does not match the
 * last thing sent, the row has unpublished changes.
 */
function signatureOf(entry: NTSessionEntry, root: string): string {
  const payload = publishPayload(entry)
  return JSON.stringify([fullTopicName(root, entry.key), payload.topicType, payload.value])
}

// --- Captura de topics existentes ------------------------------------------------

/** Which session type a robot topic can be recreated as. */
function kindForTopic(topicType: string): NTSessionKind | null {
  const c = classifyTopic(topicType)
  if (c.structName === "Pose2d" || c.structName === "Transform2d") return "Pose2d"
  if (c.structName === "Pose3d" || c.structName === "Transform3d") return "Pose3d"
  if (c.structName === "Rotation2d") return "Rotation2d"
  if (c.structName === "Translation2d") return "Translation2d"
  if (c.structName === "Translation3d") return "Translation3d"
  if (c.structName === "ChassisSpeeds") return "ChassisSpeeds"
  if (c.isStructType) return null

  if (c.isBoolean) return "boolean"
  if (c.isNumber) return topicType === "int" ? "int" : "double"
  if (c.isString) return "string"
  if (c.isNumericArray) return "double[]"
  if (topicType === "boolean[]") return "boolean[]"
  if (topicType === "string[]") return "string[]"
  return null
}

/**
 * Copies the topic's current value into the freshly created entry. Structs are
 * not unpacked here: `unpackLiveValue` returns the raw bytes, so captured
 * geometry starts at zero and is adjusted by hand.
 */
function applyLiveValue(entry: NTSessionEntry, kind: NTSessionKind, liveValue: unknown): NTSessionEntry {
  const value = unpackLiveValue(liveValue)
  if (value === null || value === undefined) return entry

  if (kind === "boolean" && typeof value === "boolean") return { ...entry, booleans: [value] }
  if ((kind === "double" || kind === "int") && typeof value === "number") return { ...entry, numbers: [value] }
  if (kind === "string" && typeof value === "string") return { ...entry, strings: [value] }

  if (Array.isArray(value)) {
    if (kind === "double[]" && value.every(v => typeof v === "number")) return { ...entry, numbers: value as number[] }
    if (kind === "boolean[]" && value.every(v => typeof v === "boolean")) return { ...entry, booleans: value as boolean[] }
    if (kind === "string[]" && value.every(v => typeof v === "string")) return { ...entry, strings: value as string[] }
  }

  return entry
}

// --- UI menor ----------------------------------------------------------------------

const miniButtonStyle: React.CSSProperties = {
  background: "var(--bg-panel)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", borderRadius: 2,
  padding: "1px 6px", fontSize: 9.5, cursor: "pointer", flexShrink: 0,
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border: "1px solid var(--border-main)", background: "var(--bg-panel)",
      borderRadius: 3, padding: "10px 12px", fontSize: 11, lineHeight: 1.6,
      color: "var(--text-secondary)",
    }}>
      {children}
    </div>
  )
}

function HeaderButton({
  svg, icon, label, title, onClick, disabled,
}: {
  svg: string
  icon: string
  label?: string
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        background: "var(--bg-input)", color: "var(--text-primary)",
        border: "1px solid var(--border-main)", borderRadius: 2,
        padding: "3px 8px", fontSize: 10.5,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <SidebarIcon svg={svg} fallback={icon} size={13} />
      {label}
    </button>
  )
}
