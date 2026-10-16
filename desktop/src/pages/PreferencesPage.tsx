// The robot's /Preferences table.
//
// It is the NT Session's persistent sibling: what is written here survives a
// robot restart, because WPILib marks those topics with the `persistent`
// property and the server saves them in the roboRIO's `networktables.json`.
//
// The difference that drives this page's whole design: preferences are DECLARED
// by the robot code, not the dashboard. From here values are changed and keys
// added, but who really creates them — and who really deletes them — is the
// robot. That is why each row knows how to give you its matching Java line.

import React, { useEffect, useMemo, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { TopicAnnounce, ConnectionState } from "../store/appStore"
import { useNTSnapshot } from "../utils/nt/useNTSnapshot"
import { unpackLiveValue } from "../utils/dashboard/valueDecoding"
import {
  PREFERENCE_KINDS, PREFERENCES_TABLE, PreferenceKind, PreferenceValue, collectPreferences,
  defaultValueFor, formatPreferenceValue, javaGet, javaGetBlock, javaInit, javaInitBlock,
  javaRemove, parsePreferenceValue, preferenceTopicName,
} from "../utils/nt/preferences"
import SidebarIcon from "../components/common/SidebarIcon"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"
import {
  Section, Row, Select, PanelButton, Hint, ErrorNote, FieldLabel, inputStyle,
} from "../components/dashboard/three/PanelFields"

interface Props {
  topics: Map<string, TopicAnnounce>
  connection: ConnectionState
}

const HELP = {
  what: "The one NetworkTables table that survives a reboot. When robot code calls Preferences.initDouble(...), WPILib marks that topic persistent and the server writes it into networktables.json on the roboRIO. It is where the constants you calibrate once and never want to lose belong — encoder offsets, gains, limits.",
  edit: "Changing a value here writes straight to the robot and is saved by the server, because the topic is already marked persistent. There is no compile and no redeploy.",
  create: "Publishes a new key under /Preferences. Careful: a key created from a dashboard is NOT marked persistent — only robot code does that. Copy the init line below and paste it into your robot so the entry sticks around after a reboot.",
  remove: "This only stops MARS from publishing a key that MARS itself created. A preference the robot declared belongs to the robot: the only thing that really removes it is Preferences.remove(\"key\") in robot code, which is what the copy button next to it gives you.",
  init: "The line that DECLARES the preference. It is what makes the entry exist and be persistent — paste it into robotInit.",
  get: "The line that READS it, using the current value as the fallback for when the key is missing.",
  stage: "Values are staged while you type and only sent when you apply them, so a half-typed number never reaches the robot.",
}

export default function PreferencesPage({ topics, connection }: Props) {
  const connected = connection !== "disconnected"

  const rows = useMemo(() => collectPreferences(topics), [topics])
  const topicNames = useMemo(() => rows.map(row => row.topicName), [rows])
  const values = useNTSnapshot(topicNames, 250)

  // What was written but not sent yet, per key. Same as in the NT Session:
  // publishing on every keystroke sends garbage, and here the garbage persists.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<{ kind: "ok" | "error"; message: string } | null>(null)
  const [showJava, setShowJava] = useState(false)

  useEffect(() => {
    if (toast === null) return
    const id = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(id)
  }, [toast])

  const currentValue = (topicName: string): PreferenceValue | undefined => {
    const raw = unpackLiveValue(values[topicName])
    return raw === null || raw === undefined ? undefined : (raw as PreferenceValue)
  }

  const snapshots = rows.map(row => ({
    key: row.key,
    kind: row.kind,
    value: currentValue(row.topicName) ?? defaultValueFor(row.kind),
  }))

  const write = async (key: string, kind: PreferenceKind, value: PreferenceValue) => {
    try {
      await invoke("set_value", {
        topicName: preferenceTopicName(key),
        topicType: kind,
        value,
      })
      setToast({ kind: "ok", message: `Wrote ${key}` })
      return true
    } catch (error) {
      setToast({ kind: "error", message: String(error) })
      return false
    }
  }

  const applyDraft = async (key: string, kind: PreferenceKind) => {
    const draft = drafts[key]
    if (draft === undefined) return
    const parsed = parsePreferenceValue(kind, draft)
    if (parsed === null) {
      setToast({ kind: "error", message: `“${draft}” is not a valid ${kind}` })
      return
    }
    if (await write(key, kind, parsed)) {
      setDrafts(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const applyAll = async () => {
    for (const row of rows) {
      if (drafts[row.key] !== undefined) await applyDraft(row.key, row.kind)
    }
  }

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => setToast({ kind: "ok", message: `Copied ${what}` }),
      () => setToast({ kind: "error", message: "Could not reach the clipboard" }),
    )
  }

  const pendingCount = rows.filter(row => drafts[row.key] !== undefined).length

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="Preferences"
          meta={`/${PREFERENCES_TABLE}/ · ${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <StatusBadge
                color={connected ? "var(--status-sim)" : "var(--mars-red)"}
                label={connected ? "PERSISTENT" : "NOT CONNECTED"}
              />
              <HeaderButton
                svg="publish.svg"
                icon="ti-cloud-upload"
                label={pendingCount > 0 ? `Apply ${pendingCount}` : "Apply"}
                title="Send every staged change to the robot"
                disabled={!connected || pendingCount === 0}
                highlight={pendingCount > 0}
                onClick={applyAll}
              />
              <HeaderButton
                svg="copy-java.svg"
                icon="ti-clipboard-text"
                label="Java"
                title="Show the robot-side code for this table"
                onClick={() => setShowJava(v => !v)}
              />
            </div>
          }
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {!connected && (
              <Notice>
                Not connected. Preferences live on the robot, so there is nothing to show or change until
                you connect.
              </Notice>
            )}

            {connected && rows.length === 0 && (
              <Notice>
                <b>The robot has no preferences yet.</b> They are created by robot code, not by a
                dashboard — add a line like <code>Preferences.initDouble("kP", 0.3);</code> in{" "}
                <code>robotInit()</code> and the key shows up here. You can also create one below to try
                it out, but only the robot's declaration makes it survive a reboot.
              </Notice>
            )}

            {rows.map(row => {
              const live = currentValue(row.topicName)
              const draft = drafts[row.key]
              const dirty = draft !== undefined
              const invalid = dirty && parsePreferenceValue(row.kind, draft) === null

              return (
                <div
                  key={row.topicName}
                  style={{
                    border: `1px solid ${invalid ? "var(--status-error)" : "var(--border-main)"}`,
                    borderRadius: 3, background: "var(--bg-panel)", padding: "7px 9px",
                    display: "flex", alignItems: "center", gap: 8,
                  }}
                >
                  <span
                    title={dirty ? "Edited — not sent yet" : "Matches the robot"}
                    style={{
                      width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                      background: dirty ? "var(--status-warning)" : "var(--status-sim)",
                    }}
                  />

                  <span
                    title={row.topicName}
                    style={{ width: 190, flexShrink: 0, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {row.key}
                  </span>

                  <span style={{ width: 52, flexShrink: 0, fontSize: 9.5, color: "var(--text-muted)" }}>
                    {row.kind}
                  </span>

                  {row.kind === "boolean" ? (
                    <button
                      onClick={() => write(row.key, row.kind, !(live === true))}
                      disabled={!connected}
                      style={{
                        cursor: connected ? "pointer" : "default", borderRadius: 3, fontSize: 11,
                        padding: "3px 14px", fontWeight: 600, flexShrink: 0,
                        border: `1px solid ${live === true ? "var(--variant-green-border)" : "var(--border-main)"}`,
                        background: live === true ? "var(--variant-green-bg-hover)" : "var(--bg-input)",
                        color: live === true ? "var(--status-success)" : "var(--text-muted)",
                      }}
                    >
                      {live === true ? "true" : "false"}
                    </button>
                  ) : (
                    <input
                      value={dirty ? draft : formatPreferenceValue(live)}
                      onChange={e => setDrafts(prev => ({ ...prev, [row.key]: e.target.value }))}
                      onKeyDown={e => { if (e.key === "Enter") applyDraft(row.key, row.kind) }}
                      placeholder={formatPreferenceValue(live)}
                      style={{ ...inputStyle, flex: 1, minWidth: 60, fontSize: 11, fontVariantNumeric: "tabular-nums" }}
                    />
                  )}

                  {dirty && (
                    <button
                      onClick={() => applyDraft(row.key, row.kind)}
                      disabled={!connected || invalid}
                      title="Send this value to the robot"
                      style={{
                        ...miniButtonStyle,
                        borderColor: "var(--mars-accent)",
                        opacity: invalid ? 0.5 : 1,
                      }}
                    >
                      Apply
                    </button>
                  )}

                  <IconButton
                    svg="copy-java.svg"
                    icon="ti-clipboard-text"
                    title="Copy the Preferences.get… line"
                    onClick={() => copy(
                      javaGet(row.key, row.kind, live ?? defaultValueFor(row.kind)),
                      `${row.key} getter`,
                    )}
                  />
                  <IconButton
                    svg="add-entry.svg"
                    icon="ti-code-plus"
                    title="Copy the Preferences.init… line that declares it"
                    onClick={() => copy(
                      javaInit(row.key, row.kind, live ?? defaultValueFor(row.kind)),
                      `${row.key} declaration`,
                    )}
                  />
                  <IconButton
                    svg="delete.svg"
                    icon="ti-trash"
                    danger
                    title="Copy the Preferences.remove line — only robot code can really delete it"
                    onClick={() => copy(javaRemove(row.key), `remove ${row.key}`)}
                  />
                </div>
              )
            })}
          </div>

          <div style={{
            width: 300, borderLeft: "1px solid var(--border-main)", background: "var(--bg-panel)",
            flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
          }}>
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              <Section title="What this is" defaultOpen svg="preferences.svg" icon="ti-adjustments-alt" help={HELP.what}>
                <Hint>
                  The only NetworkTables table that survives a robot reboot. Values you change here are
                  written by the server into <b>networktables.json</b> on the roboRIO.
                </Hint>
                <Hint>{HELP.stage}</Hint>
              </Section>

              <NewPreference connected={connected} onCreate={write} onCopy={copy} />

              <Section title="Robot code" defaultOpen svg="copy-java.svg" icon="ti-clipboard-text">
                <PanelButton
                  label="Copy every init line"
                  svg="copy-java.svg"
                  icon="ti-clipboard-text"
                  disabled={snapshots.length === 0}
                  onClick={() => copy(javaInitBlock(snapshots), `${snapshots.length} declarations`)}
                />
                <Hint>{HELP.init}</Hint>
                <PanelButton
                  label="Copy every get line"
                  svg="copy-value.svg"
                  icon="ti-code"
                  disabled={snapshots.length === 0}
                  onClick={() => copy(javaGetBlock(snapshots), `${snapshots.length} reads`)}
                />
                <Hint>{HELP.get}</Hint>
              </Section>

              <Section title="Removing an entry" svg="delete.svg" icon="ti-trash" help={HELP.remove}>
                <Hint>
                  A dashboard cannot delete a preference the robot owns. The trash button on each row
                  copies the line that does it:
                </Hint>
                <pre style={preStyle}>Preferences.remove("kP");</pre>
                <Hint>Or, to wipe the whole table from robot code:</Hint>
                <pre style={preStyle}>Preferences.removeAll();</pre>
                <PanelButton
                  label="Copy removeAll()"
                  svg="copy-value.svg"
                  icon="ti-copy"
                  onClick={() => copy("Preferences.removeAll();", "removeAll")}
                />
              </Section>
            </div>

            {toast && (
              <div style={{
                flexShrink: 0, borderTop: "1px solid var(--border-main)",
                background: "var(--bg-panel-header)", padding: "7px 10px",
                fontSize: 10.5, lineHeight: 1.45,
                color: toast.kind === "error" ? "var(--status-error)" : "var(--text-primary)",
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <SidebarIcon
                  svg={toast.kind === "error" ? "status-error.svg" : "status-ok.svg"}
                  fallback={toast.kind === "error" ? "ti-alert-triangle" : "ti-check"}
                  size={13}
                />
                {toast.message}
              </div>
            )}
          </div>
        </div>

        {showJava && (
          <div style={{
            flexShrink: 0, maxHeight: 220, overflow: "auto",
            borderTop: "1px solid var(--border-main)", background: "var(--bg-panel-header)",
            padding: "8px 12px",
          }}>
            <div style={{ fontSize: 9.5, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Paste into robotInit()
            </div>
            <pre style={{ ...preStyle, margin: 0 }}>
              {snapshots.length === 0 ? "// no preferences yet" : javaInitBlock(snapshots)}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

// --- Creating a new preference ---------------------------------------------------

function NewPreference({
  connected, onCreate, onCopy,
}: {
  connected: boolean
  onCreate: (key: string, kind: PreferenceKind, value: PreferenceValue) => Promise<boolean>
  onCopy: (text: string, what: string) => void
}) {
  const [key, setKey] = useState("")
  const [kind, setKind] = useState<PreferenceKind>("double")
  const [text, setText] = useState("0")

  const parsed = parsePreferenceValue(kind, text)
  const ready = key.trim().length > 0 && parsed !== null

  return (
    <Section title="New preference" defaultOpen svg="add-entry.svg" icon="ti-plus" help={HELP.create}>
      <div>
        <FieldLabel label="Key" help="What robot code passes to Preferences.getDouble(…). Slashes make sub-tables." />
        <input
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="Arm/kP"
          style={{ ...inputStyle, width: "100%" }}
        />
      </div>

      <Row>
        <Select<PreferenceKind>
          label="Type"
          value={kind}
          options={PREFERENCE_KINDS.map(k => ({ value: k, label: k }))}
          onChange={v => {
            setKind(v)
            setText(formatPreferenceValue(defaultValueFor(v)))
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <FieldLabel label="Value" />
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            style={{
              ...inputStyle, width: "100%",
              borderColor: parsed === null ? "var(--status-error)" : "var(--border-main)",
            }}
          />
        </div>
      </Row>

      <PanelButton
        label="Create on the robot"
        svg="publish.svg"
        icon="ti-cloud-upload"
        disabled={!connected || !ready}
        onClick={async () => {
          if (parsed === null) return
          if (await onCreate(key.trim(), kind, parsed)) setKey("")
        }}
      />

      {ready && (
        <>
          <ErrorNote>
            A key created from here is not persistent yet — only robot code marks it. Paste this into{" "}
            <code>robotInit()</code> so it survives a reboot:
          </ErrorNote>
          <pre style={preStyle}>{javaInit(key.trim(), kind, parsed)}</pre>
          <PanelButton
            label="Copy the init line"
            svg="copy-java.svg"
            icon="ti-clipboard-text"
            onClick={() => onCopy(javaInit(key.trim(), kind, parsed), "the declaration")}
          />
        </>
      )}
    </Section>
  )
}

// --- UI menor ------------------------------------------------------------------------

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
  svg, icon, label, title, onClick, disabled, highlight,
}: {
  svg: string
  icon: string
  label?: string
  title: string
  onClick: () => void
  disabled?: boolean
  highlight?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        background: "var(--bg-input)", color: "var(--text-primary)",
        border: `1px solid ${highlight && !disabled ? "var(--mars-accent)" : "var(--border-main)"}`,
        borderRadius: 2, padding: "3px 8px", fontSize: 10.5,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <SidebarIcon svg={svg} fallback={icon} size={13} />
      {label}
    </button>
  )
}

function IconButton({
  svg, icon, title, onClick, danger,
}: { svg: string; icon: string; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        border: "1px solid transparent", borderRadius: 2, cursor: "pointer", padding: "2px 3px",
        background: "transparent", display: "flex", alignItems: "center", flexShrink: 0, lineHeight: 0,
      }}
    >
      <SidebarIcon svg={svg} fallback={icon} size={14} color={danger ? "var(--status-error)" : undefined} />
    </button>
  )
}

const miniButtonStyle: React.CSSProperties = {
  background: "var(--bg-panel)", color: "var(--text-primary)",
  border: "1px solid var(--border-main)", borderRadius: 2,
  padding: "2px 8px", fontSize: 10, cursor: "pointer", flexShrink: 0,
}

const preStyle: React.CSSProperties = {
  margin: 0, background: "var(--bg-input)", border: "1px solid var(--border-main)",
  borderRadius: 2, padding: "6px 7px", fontSize: 9.5, lineHeight: 1.55,
  whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-primary)",
}
