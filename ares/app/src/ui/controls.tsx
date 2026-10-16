// The form controls every Ares page shares, in MARS Desktop's style:
// quantity inputs that read units, compact buttons and toggles, cards over the
// 3D or 2D views, and a panel that starts closed.

import { CSSProperties, ReactNode, useEffect, useState } from "react"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { Dimension, formatSI, imperialHint, parseQuantity } from "../robot/units"

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.92)", border: "1px solid var(--border-main)", padding: "8px 12px", pointerEvents: "auto", ...style }}>
      {children}
    </div>
  )
}

export function Toggle({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: string; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 4, fontSize: 11, padding: "3px 8px", cursor: "pointer",
        border: "1px solid var(--btn-classic-border)", borderRadius: 2,
        background: on ? "var(--toolbar-active-bg)" : "var(--btn-classic-bg)", color: "var(--text-primary)",
      }}
    >
      <i className={`ti ${icon}`} aria-hidden /> {label}
    </button>
  )
}

export function MiniButton({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontSize: 10.5, padding: "1px 7px", marginLeft: 4, height: 20, cursor: "pointer", flexShrink: 0,
        border: "1px solid var(--btn-classic-border)", borderRadius: 2, background: "var(--btn-classic-bg)", color: "var(--text-primary)",
      }}
    >
      {children}
    </button>
  )
}

/** A property row with a quantity input, its unit and, for lengths and masses, the imperial reading. */
export function Q(props: {
  label: string; dim: Dimension; unit: string; value: number | undefined; onChange: (v: number) => void
  optional?: boolean; integer?: boolean; hint?: string; action?: ReactNode
}) {
  const { label, dim, unit, value, onChange, optional, integer, hint, action } = props
  const imperial = value !== undefined ? imperialHint(value, dim) : null
  return (
    <PropertyRow label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }} title={hint}>
        <QInput dim={dim} value={value} onChange={onChange} optional={optional} integer={integer} />
        {unit && <span style={{ fontSize: 10, color: "var(--text-muted)", minWidth: 26 }}>{unit}</span>}
        {imperial && <span style={{ fontSize: 10, color: "var(--text-light)", minWidth: 52, textAlign: "right" }}>{imperial}</span>}
        {action}
      </div>
    </PropertyRow>
  )
}

/**
 * Commits on Enter or blur, so typing "2in" does not fight the field. What it
 * cannot read stays red and is not committed.
 */
export function QInput({ dim, value, onChange, optional, integer }: {
  dim: Dimension; value: number | undefined; onChange: (v: number) => void; optional?: boolean; integer?: boolean
}) {
  const shown = value === undefined ? "" : formatSI(value)
  const [text, setText] = useState(shown)
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setText(shown) }, [shown, focused])

  const parsed = text.trim() === "" ? null : parseQuantity(text, dim)
  const bad = text.trim() === "" ? !optional : parsed === null || (integer && !Number.isInteger(parsed))
  const commit = () => {
    if (text.trim() === "" && optional) onChange(undefined as unknown as number)
    else if (!bad && parsed !== null) onChange(parsed)
  }
  return (
    <input
      style={{ ...propertyInputStyle, borderColor: bad ? "var(--status-error)" : undefined, fontFamily: "Consolas, 'Cascadia Mono', monospace" }}
      value={text}
      placeholder={optional ? "unknown" : undefined}
      onFocus={() => setFocused(true)}
      onChange={e => setText(e.target.value)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }}
    />
  )
}

/** A Panel that starts closed: for the values most teams never touch. */
export function Collapsible({ title, icon, hint, children }: { title: string; icon: string; hint?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ border: "1px solid var(--border-main)", overflow: "hidden", background: "var(--bg-page)" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={hint}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", cursor: "pointer", border: "none",
          background: "var(--bg-panel-header)", borderBottom: open ? "1px solid var(--border-main)" : "none", textAlign: "left",
        }}
      >
        <i className={`ti ${icon}`} style={{ fontSize: 12, color: "var(--text-muted)" }} aria-hidden />
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3, color: "var(--text-primary)" }}>{title}</span>
        <i className={`ti ${open ? "ti-chevron-up" : "ti-chevron-down"}`} style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)" }} aria-hidden />
      </button>
      {open && children}
    </div>
  )
}
