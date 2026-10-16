// Dense controls for the 3D configuration panels (Swerve 3D, Mechanism 3D).
// They are the same widgets the swerve's panel already used, shared so the two
// views look and behave the same.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import SidebarIcon from "../../common/SidebarIcon"

export const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-main)",
  padding: "3px 6px",
  borderRadius: 2,
  fontSize: 10.5,
  outline: "none",
  boxSizing: "border-box",
}

export const buttonStyle: React.CSSProperties = {
  flex: 1,
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-main)",
  padding: "4px 8px",
  borderRadius: 2,
  fontSize: 10.5,
  cursor: "pointer",
}

export const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 2,
}

const HELP_WIDTH = 268
const HELP_MARGIN = 8

/**
 * A "?" button with a control's real explanation.
 *
 * The bubble is drawn with a PORTAL to <body> and position: fixed, not inside
 * the panel: the panel has overflow for its scroll, and anything positioned
 * inside is clipped against its edge. With the portal, the bubble is measured
 * against the WINDOW and adjusts on its own — it shifts so it does not go off
 * the sides and moves above the button if it does not fit below.
 */
export function Help({ text }: { text: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState({ top: 0, left: 0 })

  // useLayoutEffect and not useEffect: the bubble is already in the DOM (needed
  // to be able to measure it) but not painted yet, so correcting the position
  // here produces no visible jump.
  useLayoutEffect(() => {
    if (!open) return

    const place = () => {
      const button = buttonRef.current
      if (!button) return
      const anchor = button.getBoundingClientRect()
      const height = bubbleRef.current?.offsetHeight ?? 120

      // Aligned to the button's right edge, but without leaving the window.
      const left = Math.min(
        Math.max(anchor.right - HELP_WIDTH, HELP_MARGIN),
        window.innerWidth - HELP_WIDTH - HELP_MARGIN,
      )
      const below = anchor.bottom + 6
      const fitsBelow = below + height <= window.innerHeight - HELP_MARGIN
      const top = fitsBelow ? below : Math.max(HELP_MARGIN, anchor.top - height - 6)

      setPlacement({ top, left })
    }

    place()
    // `true` to also capture the panel's scroll, which does not bubble.
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open, text])

  // Close with a click outside or with Escape, like any popover.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target)) return
      if (bubbleRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false) }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="What does this do?"
        aria-expanded={open}
        // Several of these buttons live inside a <label>: without stopping the
        // event, opening the help would also focus the input or tick the
        // checkbox the label wraps.
        onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o) }}
        style={{
          border: "none", background: "transparent", cursor: "pointer",
          padding: 0, lineHeight: 0, display: "flex", alignItems: "center",
          flexShrink: 0, opacity: open ? 1 : 0.55,
        }}
      >
        <SidebarIcon svg="help.svg" fallback="ti-help-circle" size={12} color="var(--mars-accent)" />
      </button>

      {open && createPortal(
        <div
          ref={bubbleRef}
          role="tooltip"
          style={{
            position: "fixed", top: placement.top, left: placement.left, zIndex: 4000,
            width: HELP_WIDTH, boxSizing: "border-box",
            background: "var(--bg-input)", color: "var(--text-primary)",
            border: "1px solid var(--border-dark)", borderRadius: 4,
            boxShadow: "0 6px 20px rgba(0,0,0,0.22)",
            padding: "9px 11px", fontSize: 11, lineHeight: 1.55,
            textTransform: "none", letterSpacing: 0, fontWeight: 400,
            whiteSpace: "normal", textAlign: "left",
          }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  )
}

/** A field's label, with its help button if it has one. */
export function FieldLabel({ label, help }: { label: React.ReactNode; help?: React.ReactNode }) {
  return (
    <div style={{ ...fieldLabelStyle, display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {help !== undefined && <Help text={help} />}
    </div>
  )
}

export function Section({
  title, children, defaultOpen = false, badge, help, svg, svgFallback, icon,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  badge?: React.ReactNode
  help?: React.ReactNode
  /** File in public/icons; if it is missing `svgFallback` is tried and then `icon`. */
  svg?: string
  /** A sibling SVG to debut the section with until it has its own. */
  svgFallback?: string
  icon?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderBottom: "1px solid var(--border-light)" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 6,
          background: "var(--bg-panel-header)", border: "none", cursor: "pointer",
          padding: "6px 12px", textAlign: "left",
        }}
      >
        <i
          className={`ti ${open ? "ti-chevron-down" : "ti-chevron-right"}`}
          style={{ fontSize: 11, color: "var(--text-muted)" }}
          aria-hidden
        />
        {(svg || svgFallback || icon) && (
          <SidebarIcon svg={svg} svgFallback={svgFallback} fallback={icon ?? "ti-square"} size={13} />
        )}
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--text-muted)" }}>
          {title}
        </span>
        {help !== undefined && (
          // The span stops the click so opening the help does not collapse the section.
          <span onClick={e => e.stopPropagation()} style={{ display: "flex" }}><Help text={help} /></span>
        )}
        {badge !== undefined && <span style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--text-muted)" }}>{badge}</span>}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: "10px 12px" }}>
          {children}
        </div>
      )}
    </div>
  )
}

export function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 5 }}>{children}</div>
}

export function Num({
  label, value, onChange, step = 0.01, min, max, suffix, hint, help,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  hint?: string
  help?: React.ReactNode
}) {
  return (
    <label style={{ flex: 1, minWidth: 0 }} title={hint}>
      <FieldLabel label={suffix ? `${label} (${suffix})` : label} help={help} />
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        // An empty or half-typed field ("-", "0.") gives NaN: the change is
        // ignored instead of sending NaN to the scene, which would leave the mesh
        // with an invalid matrix and the whole part invisible.
        onChange={e => {
          const next = Number(e.target.value)
          if (isFinite(next)) onChange(next)
        }}
        style={{ ...inputStyle, width: "100%" }}
      />
    </label>
  )
}

export function Text({
  label, value, onChange, placeholder, help,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  help?: React.ReactNode
}) {
  return (
    <label style={{ flex: 1, minWidth: 0 }}>
      <FieldLabel label={label} help={help} />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle, width: "100%" }}
      />
    </label>
  )
}

export function Check({
  label, checked, onChange, hint, help,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
  help?: React.ReactNode
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, position: "relative" }}>
      <label
        title={hint}
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--text-primary)", cursor: "pointer", minWidth: 0 }}
      >
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        {label}
      </label>
      {help !== undefined && <Help text={help} />}
    </div>
  )
}

export function Select<T extends string>({
  label, value, options, onChange, hint, help,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  hint?: string
  help?: React.ReactNode
}) {
  return (
    <label style={{ flex: 1, minWidth: 0 }} title={hint}>
      <FieldLabel label={label} help={help} />
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        style={{ ...inputStyle, width: "100%" }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

export function Slider({
  label, value, min, max, step, onChange, format, help,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format: (v: number) => string
  help?: React.ReactNode
}) {
  return (
    <div>
      <div style={{ ...fieldLabelStyle, display: "flex", alignItems: "center", gap: 4 }}>
        <span>{label}</span>
        {help !== undefined && <Help text={help} />}
        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  )
}

/** An X/Y/Z triple with a shared label; it is the most repeated control. */
export function Vector3Field({
  label, value, onChange, step = 0.01, suffix, help, axisLabels = ["X", "Y", "Z"],
}: {
  label: string
  value: [number, number, number]
  onChange: (v: [number, number, number]) => void
  step?: number
  suffix?: string
  help?: React.ReactNode
  /** For when the three boxes are not X/Y/Z (radius, height...). */
  axisLabels?: [string, string, string]
}) {
  return (
    <div>
      <FieldLabel label={suffix ? `${label} (${suffix})` : label} help={help} />
      <Row>
        {axisLabels.map((axis, i) => (
          <label key={`${axis}-${i}`} style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: 9, color: "var(--text-muted)", flexShrink: 0 }}>{axis}</span>
            <input
              type="number"
              value={value[i]}
              step={step}
              onChange={e => {
                const next = Number(e.target.value)
                if (!isFinite(next)) return
                const out: [number, number, number] = [...value]
                out[i] = next
                onChange(out)
              }}
              style={{ ...inputStyle, width: "100%" }}
            />
          </label>
        ))}
      </Row>
    </div>
  )
}

export function PanelButton({
  label, onClick, disabled, icon, svg, svgFallback, title, danger, active,
}: {
  label?: string
  onClick: () => void
  disabled?: boolean
  /** Clase tabler de respaldo. */
  icon?: string
  /** File in public/icons; wins over `icon` if it exists. */
  svg?: string
  /** A sibling SVG to try before falling back to tabler. */
  svgFallback?: string
  title?: string
  danger?: boolean
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...buttonStyle,
        flex: label ? 1 : "0 0 auto",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
        color: danger ? "var(--status-error)" : "var(--text-primary)",
        background: active ? "var(--toolbar-active-bg)" : buttonStyle.background,
        borderColor: active ? "var(--mars-accent)" : "var(--border-main)",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
      }}
    >
      {svg || svgFallback
        ? <SidebarIcon svg={svg} svgFallback={svgFallback} fallback={icon ?? "ti-square"} size={13} />
        : icon && <i className={`ti ${icon}`} aria-hidden />}
      {label}
    </button>
  )
}

export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 9.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{children}</div>
  )
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, lineHeight: 1.4, color: "var(--status-error)",
      background: "var(--status-error-bg)", border: "1px solid var(--status-error-border)",
      borderRadius: 2, padding: "5px 6px", wordBreak: "break-word",
    }}>
      {children}
    </div>
  )
}

/** A small icon for the dense panels' rows and buttons. */
export function PanelIcon({
  svg, svgFallback, fallback, size = 13, color,
}: { svg?: string; svgFallback?: string; fallback: string; size?: number; color?: string }) {
  return <SidebarIcon svg={svg} svgFallback={svgFallback} fallback={fallback} size={size} color={color} />
}

/**
 * A single-icon button for a list's rows (eye, lock, delete).
 *
 * It lives here and not in the Mechanism 3D panel because the 2D Visualizer
 * has the same kind of list: one row per object with its switches at the end.
 */
export function IconToggle({
  svg, svgFallback, icon, active, title, onClick, activeColor = "var(--mars-red)",
}: {
  svg?: string
  svgFallback?: string
  icon: string
  active: boolean
  title: string
  onClick: () => void
  activeColor?: string
}) {
  return (
    <button
      title={title}
      // stopPropagation because these rows are usually clickable as a whole to
      // select: without it, touching the eye would also change the selection.
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{
        border: "none", background: "transparent", cursor: "pointer", padding: 0, lineHeight: 1,
        display: "flex", alignItems: "center", flexShrink: 0,
      }}
    >
      <PanelIcon
        svg={svg}
        svgFallback={svgFallback}
        fallback={icon}
        size={13}
        color={active ? activeColor : "var(--text-muted)"}
      />
    </button>
  )
}
