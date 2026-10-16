import React, { useMemo, useState } from "react"
import { InlineMath, BlockMath } from "react-katex"
import "katex/dist/katex.min.css"
import { TopicAnnounce, EquationVariable, EquationConfig } from "../store/appStore"
import { useSelectionStore } from "../store/selectionStore"
import { classifyTopic } from "../utils/dashboard/topicClassification"
import { useLiveSeriesBuffers } from "../utils/functions/useLiveSeriesBuffers"
import { parseExpression, ParseError, collectVariables, Node } from "../utils/equations/parser"
import {
  evaluateLatest, EvalContext, EqValue, CONSTANTS,
  PURE_FUNCTIONS, TIME_FUNCTIONS, MATRIX_FUNCTIONS, SYMBOLIC_FUNCTIONS, isKnownFunction,
} from "../utils/equations/evaluate"
import { isMatrix } from "../utils/equations/matrix"
import { preprocess } from "../utils/equations/preprocess"
import { toLatex } from "../utils/equations/latex"
import { EQUATION_LIBRARY, EquationPreset } from "../utils/equations/library"
import DataDirectoryPanel from "../components/dashboard/DataDirectoryPanel"
import PanelHeader from "../components/layout/PanelHeader"
import StatusBadge from "../components/common/StatusBadge"

interface Props {
  topics: Map<string, TopicAnnounce>
  variables: EquationVariable[]
  equations: EquationConfig[]
  onAddVariable: (v: Omit<EquationVariable, "id">) => void
  onRemoveVariable: (id: string) => void
  onUpdateVariable: (id: string, updates: Partial<EquationVariable>) => void
  onAddEquation: (e: Omit<EquationConfig, "id">) => void
  onRemoveEquation: (id: string) => void
  onUpdateEquation: (id: string, updates: Partial<EquationConfig>) => void
}

const WINDOW_SECONDS = 30

export default function EquationsPage({
  topics, variables, equations,
  onAddVariable, onRemoveVariable, onUpdateVariable,
  onAddEquation, onRemoveEquation, onUpdateEquation,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const isLive = useSelectionStore(s => s.isLive)

  const seriesStubs = useMemo(
    () => variables.map(v => ({
      id: v.id, topicName: v.topicName, label: v.name,
      color: "#000000", transform: "raw" as const, axis: "left" as const,
    })),
    [variables],
  )
  const topicBuffers = useLiveSeriesBuffers(seriesStubs, WINDOW_SECONDS)

  const context: EvalContext = useMemo(() => {
    const buffers: EvalContext["buffers"] = {}
    variables.forEach(v => { buffers[v.name] = topicBuffers[v.topicName] ?? [] })
    return { buffers }
  }, [variables, topicBuffers])

  // Definitions an equation can reference by name. Only the ones that parse get
  // in: a broken equation must not break the rest.
  const definitions = useMemo(() => {
    const map = new Map<string, Node>()
    equations.forEach(equation => {
      const name = equation.name.trim()
      if (!name) return
      try {
        map.set(name, parseExpression(equation.expression))
      } catch {
        // it is ignored; the error shows on its own card
      }
    })
    return map
  }, [equations])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const topicName = e.dataTransfer.getData("topicName")
    const topicType = e.dataTransfer.getData("topicType")
    if (!topicName || !classifyTopic(topicType).isNumber) return
    if (variables.some(v => v.topicName === topicName)) return

    onAddVariable({ name: suggestName(topicName, variables), topicName })
  }

  const insertPreset = (preset: EquationPreset) => {
    onAddEquation({
      name: uniqueEquationName(preset.name, equations),
      expression: preset.expression,
      unit: preset.unit,
      decimals: 3,
    })
    setLibraryOpen(false)
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      <DataDirectoryPanel
        topics={topics}
        hint="Drag a double onto the variables panel to bind it to a symbol"
        dragFilter={(t) => classifyTopic(t.topic_type).isNumber}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <PanelHeader
          title="Equations"
          meta={`${equations.length} expressions · ${variables.length} bound variables`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <StatusBadge color={isLive ? "var(--status-sim)" : "var(--mars-red)"} label={isLive ? "LIVE" : "VIEWING HISTORY"} />
              <HeaderButton label="Library" onClick={() => setLibraryOpen(true)} />
              <HeaderButton
                label="New equation"
                onClick={() => onAddEquation({
                  name: uniqueEquationName("eq", equations),
                  expression: "", unit: "", decimals: 3,
                })}
              />
            </div>
          }
        />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {equations.length === 0 ? (
              <EmptyHint onOpenLibrary={() => setLibraryOpen(true)} />
            ) : (
              equations.map(equation => (
                <EquationCard
                  key={equation.id}
                  equation={equation}
                  context={context}
                  definitions={definitions}
                  knownVariables={variables.map(v => v.name)}
                  onUpdate={updates => onUpdateEquation(equation.id, updates)}
                  onRemove={() => onRemoveEquation(equation.id)}
                />
              ))
            )}
          </div>

          <div
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!isDragOver) setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            style={{
              width: 280, borderLeft: "1px solid var(--border-main)", flexShrink: 0, overflowY: "auto",
              background: isDragOver ? "var(--bg-page)" : "var(--bg-panel)",
              outline: isDragOver ? "1px dashed var(--mars-red)" : "none",
              outlineOffset: -3,
            }}
          >
            <VariablesPanel
              variables={variables}
              context={context}
              onUpdate={onUpdateVariable}
              onRemove={onRemoveVariable}
            />
          </div>
        </div>
      </div>

      {libraryOpen && (
        <LibraryDialog
          boundVariables={variables.map(v => v.name)}
          onPick={insertPreset}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </div>
  )
}

// --- One equation -----------------------------------------------------------

function EquationCard({
  equation, context, definitions, knownVariables, onUpdate, onRemove,
}: {
  equation: EquationConfig
  context: EvalContext
  definitions: Map<string, Node>
  knownVariables: string[]
  onUpdate: (updates: Partial<EquationConfig>) => void
  onRemove: () => void
}) {
  const analysis = useMemo(() => {
    const source = equation.expression.trim()
    if (source === "") return { state: "empty" as const }

    try {
      const raw = parseExpression(source)

      // The equation itself is excluded from the definitions: if it references
      // itself it is a cycle, not a valid recursion.
      const scoped = new Map(definitions)
      scoped.delete(equation.name.trim())

      const ast = preprocess(raw, scoped)

      const unknown = Array.from(collectVariables(ast)).filter(
        name => !knownVariables.includes(name) && !(name in CONSTANTS),
      )
      if (unknown.length > 0) {
        return { state: "error" as const, message: `Unknown symbol: ${unknown.join(", ")}` }
      }

      const latex = toLatex(ast)
      // The original form is also shown when the preprocessing changed it (an
      // expanded reference, a diff() already differentiated).
      const sourceLatex = toLatex(raw)
      const rewritten = sourceLatex !== latex ? sourceLatex : null

      try {
        return { state: "ok" as const, latex, rewritten, value: evaluateLatest(ast, context) }
      } catch (error) {
        return { state: "pending" as const, latex, rewritten, message: (error as Error).message }
      }
    } catch (error) {
      const message = error instanceof ParseError
        ? `${error.message} (at ${error.position})`
        : (error as Error).message
      return { state: "error" as const, message }
    }
  }, [equation.expression, equation.name, knownVariables, context, definitions])

  return (
    <div style={{ border: "1px solid var(--border-main)", background: "var(--bg-page)", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg-panel-header)", borderBottom: "1px solid var(--border-main)" }}>
        <input
          value={equation.name}
          onChange={e => onUpdate({ name: sanitizeName(e.target.value) })}
          placeholder="name"
          title="Other equations can reference this one by name"
          spellCheck={false}
          style={{
            width: 96, background: "var(--bg-input)", border: "1px solid var(--border-main)",
            padding: "4px 6px", fontSize: 11, fontFamily: "Consolas, monospace",
            color: "var(--mars-accent)", outline: "none",
          }}
        />
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>=</span>
        <input
          value={equation.expression}
          onChange={e => onUpdate({ expression: e.target.value })}
          placeholder="e.g.  d(velocity) / 9.81"
          spellCheck={false}
          style={{
            flex: 1, background: "var(--bg-input)", border: "1px solid var(--border-main)",
            padding: "4px 8px", fontSize: 12, fontFamily: "Consolas, monospace",
            color: "var(--text-primary)", outline: "none",
          }}
        />
        <input
          value={equation.unit}
          onChange={e => onUpdate({ unit: e.target.value })}
          placeholder="unit"
          style={{
            width: 56, background: "var(--bg-input)", border: "1px solid var(--border-main)",
            padding: "4px 6px", fontSize: 11, color: "var(--text-primary)", outline: "none",
          }}
        />
        <select
          value={equation.decimals}
          onChange={e => onUpdate({ decimals: Number(e.target.value) })}
          title="Decimals"
          style={{ background: "var(--bg-input)", border: "1px solid var(--border-main)", fontSize: 11, padding: "3px 4px" }}
        >
          {[0, 1, 2, 3, 4, 6].map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button
          onClick={onRemove}
          title="Remove equation"
          style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}
        >
          <i className="ti ti-x" aria-hidden />
        </button>
      </div>

      <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 20, minHeight: 74 }}>
        {analysis.state === "empty" && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Type an expression above.</span>
        )}

        {analysis.state === "error" && (
          <span style={{ fontSize: 11.5, color: "var(--status-error)", fontFamily: "Consolas, monospace" }}>
            {analysis.message}
          </span>
        )}

        {(analysis.state === "ok" || analysis.state === "pending") && (
          <>
            <div style={{ flex: 1, minWidth: 0, overflowX: "auto" }}>
              {analysis.rewritten && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                  <InlineMath math={analysis.rewritten} />
                  <span style={{ margin: "0 6px" }}>→</span>
                </div>
              )}
              <div style={{ fontSize: 15 }}>
                <BlockMath math={analysis.latex} />
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0, maxWidth: 300 }}>
              {analysis.state === "ok" ? (
                <ResultValue value={analysis.value} unit={equation.unit} decimals={equation.decimals} />
              ) : (
                <div style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 180 }}>{analysis.message}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// The result can be a scalar or a matrix: the matrix is rendered with KaTeX,
// not as plain text.
function ResultValue({ value, unit, decimals }: { value: EqValue; unit: string; decimals: number }) {
  if (isMatrix(value)) {
    const body = value.data
      .map(row => row.map(entry => formatValue(entry, decimals)).join(" & "))
      .join(" \\\\ ")
    return (
      <div style={{ fontSize: 14 }}>
        <BlockMath math={`\\begin{bmatrix}${body}\\end{bmatrix}`} />
        <div style={{ fontSize: 9.5, color: "var(--text-muted)" }}>{value.rows}×{value.cols}{unit ? ` · ${unit}` : ""}</div>
      </div>
    )
  }

  return (
    <>
      <div style={{
        fontSize: 26, fontWeight: 600, fontVariantNumeric: "tabular-nums",
        color: isFinite(value) ? "var(--text-primary)" : "var(--status-warning)",
      }}>
        {formatValue(value, decimals)}
      </div>
      {unit && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{unit}</div>}
    </>
  )
}

function formatValue(value: number, decimals: number): string {
  if (Number.isNaN(value)) return "NaN"
  if (!isFinite(value)) return value > 0 ? "\\infty" : "-\\infty"
  if (value !== 0 && (Math.abs(value) >= 1e6 || Math.abs(value) < 1e-4)) {
    return value.toExponential(Math.min(decimals, 4))
  }
  return value.toFixed(decimals)
}

// --- Library ---------------------------------------------------------------

function LibraryDialog({
  boundVariables, onPick, onClose,
}: {
  boundVariables: string[]
  onPick: (preset: EquationPreset) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return EQUATION_LIBRARY
    return EQUATION_LIBRARY
      .map(group => ({
        category: group.category,
        presets: group.presets.filter(preset =>
          preset.name.toLowerCase().includes(needle)
          || preset.description.toLowerCase().includes(needle)
          || preset.expression.toLowerCase().includes(needle),
        ),
      }))
      .filter(group => group.presets.length > 0)
  }, [query])

  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute", inset: 0, zIndex: 400,
        background: "var(--shadow-modal)", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 720, maxHeight: "82%", display: "flex", flexDirection: "column",
          background: "var(--bg-page)", border: "1px solid var(--border-dark)",
          boxShadow: "0 4px 16px var(--shadow-modal)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--bg-panel-header)", borderBottom: "1px solid var(--border-main)" }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>Equation library</span>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search…"
            style={{
              flex: 1, background: "var(--bg-input)", border: "1px solid var(--border-main)",
              padding: "3px 8px", fontSize: 11, outline: "none", color: "var(--text-primary)",
            }}
          />
          <button
            onClick={onClose}
            style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 }}
          >
            <i className="ti ti-x" aria-hidden />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered.map(group => (
            <div key={group.category}>
              <div style={{
                padding: "5px 12px", fontSize: 9.5, letterSpacing: 0.5, textTransform: "uppercase",
                color: "var(--text-muted)", background: "var(--bg-panel)", borderBottom: "1px solid var(--border-light)",
              }}>
                {group.category}
              </div>
              {group.presets.map(preset => (
                <PresetRow
                  key={preset.name}
                  preset={preset}
                  missing={preset.needs.filter(name => !boundVariables.includes(name))}
                  onPick={() => onPick(preset)}
                />
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: 20, fontSize: 11, color: "var(--text-muted)" }}>No presets match "{query}".</div>
          )}
        </div>
      </div>
    </div>
  )
}

function PresetRow({ preset, missing, onPick }: { preset: EquationPreset; missing: string[]; onPick: () => void }) {
  const [hovered, setHovered] = useState(false)

  const latex = useMemo(() => {
    try { return toLatex(parseExpression(preset.expression)) } catch { return null }
  }, [preset.expression])

  return (
    <div
      onClick={onPick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "8px 12px", borderBottom: "1px solid var(--border-light)", cursor: "pointer",
        background: hovered ? "var(--tree-hover-bg)" : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <code style={{ fontFamily: "Consolas, monospace", fontSize: 11, color: "var(--mars-accent)", minWidth: 150 }}>
          {preset.name}
        </code>
        {latex && <span style={{ fontSize: 12.5, flex: 1, overflowX: "auto" }}><InlineMath math={latex} /></span>}
        {preset.unit && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{preset.unit}</span>}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <span style={{ fontSize: 10, color: "var(--text-muted)", flex: 1 }}>{preset.description}</span>
        {missing.length > 0 && (
          <span style={{ fontSize: 9.5, color: "var(--status-warning)" }} title="Bind these to a topic first">
            needs: {missing.join(", ")}
          </span>
        )}
      </div>
    </div>
  )
}

// --- Panel de variables -----------------------------------------------------

function VariablesPanel({
  variables, context, onUpdate, onRemove,
}: {
  variables: EquationVariable[]
  context: EvalContext
  onUpdate: (id: string, updates: Partial<EquationVariable>) => void
  onRemove: (id: string) => void
}) {
  if (variables.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Drag a <i>double</i> from the Data Directory here to bind it to a symbol you can use in equations.
      </div>
    )
  }

  return (
    <div>
      <div style={{ padding: "8px 12px", fontSize: 9.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid var(--border-light)" }}>
        Variables
      </div>

      {variables.map(variable => {
        const buffer = context.buffers[variable.name] ?? []
        const latest = buffer.length > 0 ? buffer[buffer.length - 1].v : null

        return (
          <div key={variable.id} style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                value={variable.name}
                onChange={e => onUpdate(variable.id, { name: sanitizeName(e.target.value) })}
                spellCheck={false}
                style={{
                  width: 84, background: "var(--bg-input)", border: "1px solid var(--border-main)",
                  padding: "2px 6px", fontSize: 11, fontFamily: "Consolas, monospace",
                  color: "var(--text-primary)", outline: "none",
                }}
              />
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>=</span>
              <span style={{ flex: 1, fontSize: 12, fontVariantNumeric: "tabular-nums", textAlign: "right", color: latest === null ? "var(--text-muted)" : "var(--text-primary)" }}>
                {latest === null ? "—" : latest.toFixed(3)}
              </span>
              <button
                onClick={() => onRemove(variable.id)}
                title="Unbind variable"
                style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
              >
                <i className="ti ti-x" aria-hidden />
              </button>
            </div>
            <div style={{ fontSize: 9.5, color: "var(--text-muted)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={variable.topicName}>
              {variable.topicName}
            </div>
          </div>
        )
      })}

      <FunctionReference />
    </div>
  )
}

function FunctionReference() {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ borderTop: "1px solid var(--border-main)" }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", cursor: "pointer",
          fontSize: 9.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5,
        }}
      >
        <i className={`ti ${open ? "ti-chevron-down" : "ti-chevron-right"}`} style={{ fontSize: 10 }} aria-hidden />
        Functions
      </div>

      {open && (
        <div style={{ padding: "0 12px 12px" }}>
          <RefSection title="Time operators" entries={Object.entries(TIME_FUNCTIONS).map(([k, v]) => [k, v.help])} />
          <RefSection title="Symbolic" entries={Object.entries(SYMBOLIC_FUNCTIONS)} />
          <RefSection title="Matrices" entries={Object.entries(MATRIX_FUNCTIONS)} />
          <RefSection title="Math" entries={Object.entries(PURE_FUNCTIONS).map(([k, v]) => [k, v.help])} />
          <RefSection title="Constants" entries={Object.keys(CONSTANTS).map(k => [k, CONSTANTS[k].toFixed(5)])} />
        </div>
      )}
    </div>
  )
}

function RefSection({ title, entries }: { title: string; entries: [string, string][] }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9.5, color: "var(--text-muted)", marginBottom: 3 }}>{title}</div>
      {entries.map(([name, help]) => (
        <div key={name} style={{ display: "flex", gap: 6, fontSize: 10, lineHeight: 1.5 }}>
          <span style={{ fontFamily: "Consolas, monospace", color: "var(--mars-accent)", minWidth: 62 }}>{name}</span>
          <span style={{ color: "var(--text-muted)", flex: 1 }}>{help}</span>
        </div>
      ))}
    </div>
  )
}

function HeaderButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "var(--btn-classic-bg)", border: "1px solid var(--btn-classic-border)",
        padding: "3px 12px", fontSize: 11, cursor: "pointer", color: "var(--text-primary)",
      }}
    >
      {label}
    </button>
  )
}

function EmptyHint({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  return (
    <div style={{ maxWidth: 660, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>
      <p style={{ marginBottom: 12 }}>
        Bind a few doubles as variables on the right, then write expressions over them. Equations can
        reference each other by name, so you can build a calculation in steps. Start from the{" "}
        <a onClick={onOpenLibrary} style={{ color: "var(--mars-accent)", cursor: "pointer", textDecoration: "underline" }}>library</a>{" "}
        if you want ready-made formulas.
      </p>
      <ExampleRow expression="x * -1" description="negate a motor output" />
      <ExampleRow expression="d(position)" description="velocity, by numeric differentiation" />
      <ExampleRow expression="diff(x^3 + 2*x, x)" description="symbolic derivative → 3x² + 2" />
      <ExampleRow expression="solve(x^2 - 2, x, 1)" description="Newton root → √2" />
      <ExampleRow expression="rot2(rad(heading)) * [[vx],[vy]]" description="rotate a velocity into the field frame" />
      <ExampleRow expression="inv(T(A) * A) * T(A)" description="pseudo-inverse, written out" />
    </div>
  )
}

function ExampleRow({ expression, description }: { expression: string; description: string }) {
  const latex = useMemo(() => {
    try { return toLatex(parseExpression(expression)) } catch { return null }
  }, [expression])

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
      <code style={{ fontFamily: "Consolas, monospace", fontSize: 11, color: "var(--mars-accent)", minWidth: 210 }}>
        {expression}
      </code>
      {latex && <span style={{ fontSize: 13 }}><InlineMath math={latex} /></span>}
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{description}</span>
    </div>
  )
}

// --- Nombres ----------------------------------------------------------------

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "")
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

function suggestName(topicName: string, existing: EquationVariable[]): string {
  const parts = topicName.split("/").filter(Boolean)
  const base = sanitizeName(parts[parts.length - 1] ?? "x") || "x"

  const taken = new Set(existing.map(v => v.name))
  const isTaken = (name: string) => taken.has(name) || name in CONSTANTS || isKnownFunction(name)

  if (!isTaken(base)) return base
  let index = 2
  while (isTaken(`${base}${index}`)) index++
  return `${base}${index}`
}

function uniqueEquationName(base: string, existing: EquationConfig[]): string {
  const taken = new Set(existing.map(e => e.name))
  if (!taken.has(base)) return base
  let index = 2
  while (taken.has(`${base}${index}`)) index++
  return `${base}${index}`
}
