// A row of the NT Session: the value MARS publishes, its editor, and the
// buttons that copy it as Java.
//
// The card is collapsed by default and only shows what is touched often
// (name, type, value). What is configured once — the Java variable's name, the
// slider's range, the note — lives behind the gear.

import { useState } from "react"
import { NTSessionCopyMode, NTSessionEntry, NTSessionKind } from "../../../store/appStore"
import {
  NT_SESSION_KIND_ORDER, changeKind, isListKind, javaSnippet, kindSpec, suggestJavaName,
} from "../../../utils/nt/ntSession"
import { Num, Text, Check, Select, Row, PanelButton, Hint, FieldLabel, inputStyle } from "../three/PanelFields"
import SidebarIcon from "../../common/SidebarIcon"

export type PublishState = "idle" | "ok" | "error"

interface Props {
  entry: NTSessionEntry
  /** The topic's full path, already resolved with the session's root. */
  fullName: string
  /** The topic exists on NetworkTables right now. */
  live: boolean
  /** It was published at least once with the current name and type. */
  published: boolean
  /** The value was edited after the last publish. */
  pending: boolean
  publishState: PublishState
  publishError: string | null
  copyMode: NTSessionCopyMode
  root: string
  onUpdate: (updates: Partial<NTSessionEntry>) => void
  onRemove: () => void
  onPublish: () => void
  onCopy: (text: string, what: string) => void
}

const KIND_LABELS: Record<NTSessionKind, string> = {
  double: "double",
  int: "int",
  boolean: "boolean",
  string: "String",
  "double[]": "double[]",
  "boolean[]": "boolean[]",
  "string[]": "String[]",
  Rotation2d: "Rotation2d",
  Translation2d: "Translation2d",
  Pose2d: "Pose2d",
  Translation3d: "Translation3d",
  Pose3d: "Pose3d",
  ChassisSpeeds: "ChassisSpeeds",
}

const HELP = {
  key: "The topic name under the session's root table. Slashes make sub-tables: “Arm/kP” publishes to MarsDesktop/Arm/kP.",
  kind: "How the value is published. The geometry types go out as real WPILib structs, so the robot reads them with getStructTopic(name, Pose2d.struct) — no unpacking by hand. Their schema is announced too, so AdvantageScope and the rest of MARS can decode them as well.",
  javaName: "The variable name used in the Java that gets copied. It defaults to the last part of the key.",
  slider: "Shows a slider next to the number. The range below only affects the slider — you can always type a value outside it.",
  note: "A free comment. It is copied as a // line above the declaration.",
  angles: "Angles are edited in DEGREES here and published in RADIANS, which is what WPILib uses on the wire. A Rotation3d is serialised as a quaternion, exactly like WPILib does it.",
}

export default function NTSessionEntryCard({
  entry, fullName, live, published, pending, publishState, publishError, copyMode, root,
  onUpdate, onRemove, onPublish, onCopy,
}: Props) {
  const [open, setOpen] = useState(false)
  const spec = kindSpec(entry.kind)
  const hasAngles = (spec.components ?? []).some(c => c.angle)

  return (
    <div style={{
      border: "1px solid var(--border-main)", borderRadius: 3, background: "var(--bg-panel)",
      display: "flex", flexDirection: "column",
    }}>
      {/* --- Cabecera: clave, tipo, estado y acciones --- */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px" }}>
        <StatusDot
          fullName={fullName}
          live={live}
          published={published}
          pending={pending}
          error={publishState === "error"}
        />

        <input
          value={entry.key}
          onChange={e => {
            const key = e.target.value
            // The Java name follows the key while it has not been touched by
            // hand: otherwise renaming the topic leaves the variable with the old
            // name and the copy comes out wrong without anyone noticing.
            const followed = entry.javaName === suggestJavaName(entry.key)
            onUpdate(followed ? { key, javaName: suggestJavaName(key) } : { key })
          }}
          placeholder="Arm/kP"
          style={{ ...inputStyle, flex: 1, minWidth: 0, fontSize: 11 }}
        />

        <select
          value={entry.kind}
          onChange={e => onUpdate(changeKind(entry, e.target.value as NTSessionKind))}
          style={{ ...inputStyle, width: 108, flexShrink: 0 }}
          title="Published type"
        >
          {NT_SESSION_KIND_ORDER.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>

        <IconButton
          svg="copy-java.svg"
          icon="ti-clipboard-text"
          title={`Copy as Java (${copyMode})`}
          onClick={() => onCopy(javaSnippet(entry, copyMode, root), `${entry.javaName} as Java`)}
        />
        <IconButton
          svg="publish.svg"
          icon="ti-cloud-upload"
          title={pending || !published ? "Publish this value now (unpublished changes)" : "Publish this value now"}
          highlight={pending || !published}
          onClick={onPublish}
        />
        <IconButton
          svg="settings.svg"
          icon="ti-settings"
          title="Variable name, slider range, note"
          active={open}
          onClick={() => setOpen(o => !o)}
        />
        <IconButton svg="delete.svg" icon="ti-trash" title="Remove" danger onClick={onRemove} />
      </div>

      {/* --- Value editor --- */}
      <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
        <ValueEditor entry={entry} onUpdate={onUpdate} />

        {publishState === "error" && publishError && (
          <span style={{ fontSize: 9.5, color: "var(--status-error)", lineHeight: 1.4 }}>{publishError}</span>
        )}
      </div>

      {/* --- One-off settings --- */}
      {open && (
        <div style={{
          borderTop: "1px solid var(--border-light)", background: "var(--bg-panel-header)",
          padding: "8px", display: "flex", flexDirection: "column", gap: 7,
        }}>
          <Hint>Publishes to <b>{fullName}</b></Hint>

          <Row>
            <Text label="Java variable" value={entry.javaName} help={HELP.javaName} onChange={v => onUpdate({ javaName: v })} />
            <Select
              label="Type"
              value={entry.kind}
              options={NT_SESSION_KIND_ORDER.map(k => ({ value: k, label: KIND_LABELS[k] }))}
              help={HELP.kind}
              onChange={v => onUpdate(changeKind(entry, v))}
            />
          </Row>

          {(entry.kind === "double" || entry.kind === "int") && (
            <>
              <Check label="Show slider" checked={entry.useSlider} onChange={v => onUpdate({ useSlider: v })} help={HELP.slider} />
              <Row>
                <Num label="Min" value={entry.min} step={entry.step} onChange={v => onUpdate({ min: v })} />
                <Num label="Max" value={entry.max} step={entry.step} onChange={v => onUpdate({ max: v })} />
                <Num label="Step" value={entry.step} step={0.001} onChange={v => v !== 0 && onUpdate({ step: Math.abs(v) })} />
              </Row>
            </>
          )}

          {hasAngles && <Hint>{HELP.angles}</Hint>}

          <Text label="Note" value={entry.note} placeholder="what this value is for" help={HELP.note} onChange={v => onUpdate({ note: v })} />

          <Row>
            <PanelButton
              label="Copy value only"
              svg="copy-value.svg"
              icon="ti-copy"
              onClick={() => onCopy(javaSnippet(entry, "value", root), `${entry.javaName} value`)}
            />
            <PanelButton
              label="Copy NT getter"
              svg="copy-java.svg"
              icon="ti-code"
              onClick={() => onCopy(javaSnippet(entry, "getter", root), `${entry.javaName} getter`)}
            />
          </Row>
        </div>
      )}
    </div>
  )
}

// --- Editores por tipo --------------------------------------------------------------

function ValueEditor({
  entry, onUpdate,
}: { entry: NTSessionEntry; onUpdate: (updates: Partial<NTSessionEntry>) => void }) {
  const spec = kindSpec(entry.kind)

  // --- Escalares ---
  if (entry.kind === "boolean") {
    const value = entry.booleans[0] ?? false
    return (
      <button
        onClick={() => onUpdate({ booleans: [!value] })}
        style={{
          alignSelf: "flex-start", cursor: "pointer", borderRadius: 3, fontSize: 11,
          padding: "4px 14px", fontWeight: 600,
          border: `1px solid ${value ? "var(--variant-green-border)" : "var(--border-main)"}`,
          background: value ? "var(--variant-green-bg-hover)" : "var(--bg-input)",
          color: value ? "var(--status-success)" : "var(--text-muted)",
        }}
      >
        {value ? "true" : "false"}
      </button>
    )
  }

  if (entry.kind === "string") {
    return (
      <input
        value={entry.strings[0] ?? ""}
        onChange={e => onUpdate({ strings: [e.target.value] })}
        placeholder="text"
        style={{ ...inputStyle, width: "100%", fontSize: 11 }}
      />
    )
  }

  if (entry.kind === "double" || entry.kind === "int") {
    const value = entry.numbers[0] ?? 0
    const set = (v: number) => onUpdate({ numbers: [entry.kind === "int" ? Math.round(v) : v] })
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="number"
          value={value}
          step={entry.step}
          onChange={e => { const v = Number(e.target.value); if (isFinite(v)) set(v) }}
          style={{ ...inputStyle, width: 96, fontSize: 12, fontVariantNumeric: "tabular-nums" }}
        />
        {entry.useSlider && (
          <input
            type="range"
            min={Math.min(entry.min, entry.max)}
            max={Math.max(entry.min, entry.max)}
            step={entry.step}
            value={Math.min(Math.max(value, Math.min(entry.min, entry.max)), Math.max(entry.min, entry.max))}
            onChange={e => set(Number(e.target.value))}
            style={{ flex: 1, minWidth: 0 }}
          />
        )}
      </div>
    )
  }

  // --- Free-length lists ---
  if (isListKind(entry.kind)) return <ListEditor entry={entry} onUpdate={onUpdate} />

  // --- Geometry: one field per component ---
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
      {(spec.components ?? []).map((component, i) => (
        <label key={component.label} style={{ flex: "1 1 74px", minWidth: 68 }}>
          <FieldLabel label={component.suffix ? `${component.label} (${component.suffix})` : component.label} />
          <input
            type="number"
            value={entry.numbers[i] ?? 0}
            step={component.angle ? 1 : 0.01}
            onChange={e => {
              const v = Number(e.target.value)
              if (!isFinite(v)) return
              const numbers = [...entry.numbers]
              while (numbers.length < (spec.components?.length ?? 0)) numbers.push(0)
              numbers[i] = v
              onUpdate({ numbers })
            }}
            style={{ ...inputStyle, width: "100%", fontVariantNumeric: "tabular-nums" }}
          />
        </label>
      ))}
    </div>
  )
}

function ListEditor({
  entry, onUpdate,
}: { entry: NTSessionEntry; onUpdate: (updates: Partial<NTSessionEntry>) => void }) {
  const spec = kindSpec(entry.kind)

  const items: (number | boolean | string)[] =
    spec.store === "numbers" ? entry.numbers : spec.store === "booleans" ? entry.booleans : entry.strings

  const commit = (next: (number | boolean | string)[]) => {
    if (spec.store === "numbers") onUpdate({ numbers: next as number[] })
    else if (spec.store === "booleans") onUpdate({ booleans: next as boolean[] })
    else onUpdate({ strings: next as string[] })
  }

  const blank = spec.store === "numbers" ? 0 : spec.store === "booleans" ? false : ""

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {items.length === 0 && <Hint>Empty array. Add an element below.</Hint>}

      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 9, color: "var(--text-muted)", width: 14, flexShrink: 0 }}>{i}</span>

          {spec.store === "booleans" ? (
            <label style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={item as boolean}
                onChange={e => commit(items.map((v, j) => j === i ? e.target.checked : v))}
              />
              {String(item)}
            </label>
          ) : (
            <input
              type={spec.store === "numbers" ? "number" : "text"}
              value={item as number | string}
              step={0.01}
              onChange={e => {
                const raw = spec.store === "numbers" ? Number(e.target.value) : e.target.value
                if (spec.store === "numbers" && !isFinite(raw as number)) return
                commit(items.map((v, j) => j === i ? raw : v))
              }}
              style={{ ...inputStyle, flex: 1, minWidth: 0, fontVariantNumeric: "tabular-nums" }}
            />
          )}

          <button
            onClick={() => commit(items.filter((_, j) => j !== i))}
            title="Remove this element"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, padding: 0, lineHeight: 1 }}
          >
            <i className="ti ti-x" aria-hidden />
          </button>
        </div>
      ))}

      <PanelButton label="Add element" svg="add-entry.svg" icon="ti-plus" onClick={() => commit([...items, blank])} />
    </div>
  )
}

/**
 * Grey = never published · amber = edited without publishing · green = what
 * is on the network matches what is shown here.
 */
function StatusDot({
  fullName, live, published, pending, error,
}: { fullName: string; live: boolean; published: boolean; pending: boolean; error: boolean }) {
  const { color, label } = error
    ? { color: "var(--status-error)", label: "Failed to publish" }
    : pending ? { color: "var(--status-warning)", label: "Edited — not published yet" }
    : published && live ? { color: "var(--status-sim)", label: "Published and live" }
    : published ? { color: "var(--status-warning)", label: "Published, but not seen on the network" }
    : { color: "var(--border-dark)", label: "Not published yet" }

  return (
    <span
      title={`${label} · ${fullName}`}
      style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: color }}
    />
  )
}

function IconButton({
  svg, icon, title, onClick, danger, active, highlight,
}: {
  svg: string
  icon: string
  title: string
  onClick: () => void
  danger?: boolean
  active?: boolean
  highlight?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        borderRadius: 2, cursor: "pointer", padding: "2px 3px",
        border: `1px solid ${highlight ? "var(--mars-accent)" : "transparent"}`,
        background: active ? "var(--toolbar-active-bg)" : "transparent",
        display: "flex", alignItems: "center", flexShrink: 0, lineHeight: 0,
      }}
    >
      <SidebarIcon svg={svg} fallback={icon} size={14} color={danger ? "var(--status-error)" : undefined} />
    </button>
  )
}
