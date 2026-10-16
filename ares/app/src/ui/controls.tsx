// The form controls every Ares page shares, in MARS Desktop's style:
// quantity inputs that read units, compact buttons and toggles, cards over the
// 3D or 2D views, and a panel that starts closed.

import { CSSProperties, ReactNode, useEffect, useMemo, useRef, useState } from "react"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { Dimension, formatSI, imperialHint, parseQuantity } from "../robot/units"
import { Dim, evaluate, isExpr } from "../vars/expr"
import { useVariables } from "../vars/context"

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

/**
 * A field that can hold a formula: its current one (with "="), and a setter
 * that takes the number and the formula behind it (undefined for a plain
 * number). Without these, a formula typed in only sets its value.
 */
export interface Bindable {
  expr?: string
  onSet?: (value: number | undefined, expr: string | undefined) => void
  /** The formula's dimension, when it differs from what `dim` says. */
  exprDim?: Dim
}

/** A property row with a quantity input, its unit and, for lengths and masses, the imperial reading. */
export function Q(props: {
  label: string; dim: Dimension; unit: string; value: number | undefined; onChange: (v: number) => void
  optional?: boolean; integer?: boolean; hint?: string; action?: ReactNode
} & Bindable) {
  const { label, dim, unit, value, onChange, optional, integer, hint, action, expr, onSet, exprDim } = props
  const imperial = value !== undefined && !expr ? imperialHint(value, dim) : null
  return (
    <PropertyRow label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }} title={hint}>
        <QInput dim={dim} value={value} onChange={onChange} optional={optional} integer={integer} expr={expr} onSet={onSet} exprDim={exprDim} />
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
 *
 * Onshape style: text starting with "=" is a formula over the project's
 * variables (=hub.x - 0.5). The field shows the formula and, beside it, what
 * it gives; while typing one, the variables are offered.
 */
export function QInput({ dim, value, onChange, optional, integer, expr, onSet, exprDim }: {
  dim: Dimension; value: number | undefined; onChange: (v: number) => void; optional?: boolean; integer?: boolean
} & Bindable) {
  const { scope, variables } = useVariables()
  const formulaDim: Dim = exprDim ?? (dim === "length" ? "length" : dim === "mass" ? "mass" : "plain")
  const shown = expr ?? (value === undefined ? "" : formatSI(value))
  const [text, setText] = useState(shown)
  const [focused, setFocused] = useState(false)
  const [pick, setPick] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!focused) setText(shown) }, [shown, focused])

  const formula = isExpr(text)
  const result = formula ? evaluate(text, scope, formulaDim) : null
  const parsed = text.trim() === "" ? null : formula ? (result!.ok ? result!.value : null) : parseQuantity(text, dim)
  const bad = text.trim() === "" ? !optional : parsed === null || (integer && !Number.isInteger(parsed))
  const set = (v: number | undefined, e: string | undefined) => {
    if (onSet) onSet(v, e)
    else onChange(v as number)
  }
  const commit = () => {
    if (text.trim() === "" && optional) set(undefined, undefined)
    else if (!bad && parsed !== null) set(integer ? Math.round(parsed) : parsed, formula && onSet ? text.trim() : undefined)
  }

  // Suggestions for the name being typed after "=".
  const word = formula && focused ? (text.match(/([A-Za-z_][A-Za-z0-9_]*)\.?([A-Za-z]*)$/) ?? null) : null
  const options = useMemo(() => {
    if (!word) return []
    const [, name, sub] = word
    const out: { insert: string; label: string; note: string }[] = []
    const typedDot = text.endsWith(".") || sub !== ""
    for (const v of variables) {
      if (v.kind === "pose") {
        if (typedDot && v.name === name) {
          for (const f of ["x", "y", "heading"]) if (f.startsWith(sub)) out.push({ insert: `${v.name}.${f}`, label: `${v.name}.${f}`, note: "pose" })
        } else if (!typedDot && v.name.startsWith(name)) {
          for (const f of ["x", "y", "heading"]) out.push({ insert: `${v.name}.${f}`, label: `${v.name}.${f}`, note: "pose" })
        }
      } else if (!typedDot && v.name.startsWith(name)) {
        const val = scope.get(v.name)
        out.push({ insert: v.name, label: v.name, note: typeof val === "number" ? formatSI(val) : "" })
      }
    }
    return out.slice(0, 8)
  }, [word?.[0], variables, scope, text])
  const accept = (k: number) => {
    const o = options[k]
    if (!o || !word) return
    setText(text.slice(0, text.length - word[0].length) + o.insert)
    setPick(0)
    requestAnimationFrame(() => input.current?.focus())
  }

  return (
    <span style={{ position: "relative", display: "flex", alignItems: "center", flex: 1, minWidth: 0, gap: 4 }}>
      <input
        ref={input}
        style={{
          ...propertyInputStyle,
          borderColor: bad ? "var(--status-error)" : expr || formula ? "#e95420" : undefined,
          color: expr || formula ? "#b8410f" : undefined,
          fontFamily: "Consolas, 'Cascadia Mono', monospace",
        }}
        value={text}
        placeholder={optional ? "unknown" : "number or =formula"}
        title={formula && result && !result.ok ? result.error : expr ? `${expr} → ${value !== undefined ? formatSI(value) : "?"}` : "A number (units ok: 2in, 50cm), or =formula with your variables"}
        onFocus={() => setFocused(true)}
        onChange={e => { setText(e.target.value); setPick(0) }}
        onBlur={() => { setTimeout(() => setFocused(false), 120); commit() }}
        onKeyDown={e => {
          if (options.length && (e.key === "Tab" || (e.key === "Enter" && word && options[pick]?.insert !== word[0]))) { e.preventDefault(); accept(pick); return }
          if (options.length && e.key === "ArrowDown") { e.preventDefault(); setPick(p => Math.min(options.length - 1, p + 1)); return }
          if (options.length && e.key === "ArrowUp") { e.preventDefault(); setPick(p => Math.max(0, p - 1)); return }
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") { setText(shown); (e.target as HTMLInputElement).blur() }
        }}
      />
      {(expr || formula) && (
        <span style={{ fontSize: 10, fontFamily: "Consolas, 'Cascadia Mono', monospace", color: bad ? "var(--status-error)" : "#b8410f", whiteSpace: "nowrap" }}>
          {bad ? "⚠" : `→ ${formatSI(focused ? (parsed ?? 0) : (value ?? 0))}`}
        </span>
      )}
      {options.length > 0 && (
        <div style={{ position: "absolute", top: 22, left: 0, zIndex: 40, minWidth: 180, background: "var(--bg-page)", border: "1px solid var(--border-dark)", boxShadow: "2px 2px 0 var(--shadow-soft)" }}>
          {options.map((o, k) => (
            <div key={o.insert} onMouseDown={e => { e.preventDefault(); accept(k) }}
              style={{ display: "flex", gap: 8, padding: "3px 8px", fontSize: 11, cursor: "pointer", background: k === pick ? "var(--tree-hover-bg)" : "transparent", fontFamily: "Consolas, 'Cascadia Mono', monospace" }}>
              <span>{o.label}</span><span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>{o.note}</span>
            </div>
          ))}
        </div>
      )}
    </span>
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
