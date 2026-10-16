import { ReactNode, useEffect, useMemo, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import type { RobotConfig } from "../robot/types"
import type { FieldDoc, PathEntry } from "../paths/types"
import { Card, MiniButton } from "../ui/controls"
import { useVariables } from "./context"
import { DIM_LABEL, DIM_UNIT, Dim, evaluate, isExpr } from "./expr"
import { NAME_RE, Variable, renameInFormulas, renameVariable, usesOf } from "./variables"

interface Props {
  robot: RobotConfig
  robotPath: string | null
  onRobot: (f: (r: RobotConfig) => RobotConfig) => void
}

// The project's variables, Onshape style: names for numbers and poses that
// any field can use as =name. A pose has .x, .y and .heading, and waypoints
// can be linked to one so moving it moves every path through it.
export default function VariablesPage({ robot, robotPath, onRobot }: Props) {
  const { variables, scope, errors, setVariables } = useVariables()
  const [docs, setDocs] = useState<unknown[]>([])
  const [note, setNote] = useState("")

  // What uses each variable: paths, field, robot.
  useEffect(() => {
    if (!robotPath) { setDocs([robot]); return }
    ;(async () => {
      const entries = await invoke<PathEntry[]>("paths_list", { robotPath }).catch(() => [] as PathEntry[])
      const field = await invoke<FieldDoc>("field_open", { robotPath }).catch(() => null)
      setDocs([robot, field, ...entries.map(e => e.spec)])
    })()
  }, [robotPath, robot, variables])

  if (!robotPath) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-page)" }}>
        <Card><div style={{ fontSize: 12 }}>Save the robot first: variables live in the project's folder, in variables.json.</div></Card>
      </div>
    )
  }

  const unique = (base: string) => {
    let name = base
    for (let i = 2; variables.some(v => v.name === name); i++) name = `${base}${i}`
    return name
  }
  const add = (v: Variable) => setVariables([...variables, v])
  const update = (i: number, v: Variable) => setVariables(variables.map((x, j) => (j === i ? v : x)))
  const remove = (i: number) => {
    const v = variables[i]
    const n = usesOf([...docs, ...variables.filter((_, j) => j !== i)], v.name)
    if (n > 0 && !window.confirm(`"${v.name}" is used in ${n} formula${n > 1 ? "s" : ""}. Those fields will keep their last value but show an error. Delete it?`)) return
    setVariables(variables.filter((_, j) => j !== i))
  }
  const rename = async (i: number, name: string) => {
    const old = variables[i].name
    if (name === old) return
    if (!NAME_RE.test(name)) { setNote(`"${name}" is not a valid name: letters, digits and _, not starting with a digit`); return }
    if (variables.some(v => v.name === name)) { setNote(`There is already a variable called "${name}"`); return }
    setVariables(renameVariable(variables, old, name))
    // Every formula in the project follows the new name.
    onRobot(r => renameInFormulas(r, old, name))
    const entries = await invoke<PathEntry[]>("paths_list", { robotPath }).catch(() => [] as PathEntry[])
    for (const e of entries) {
      if (!e.spec) continue
      const next = renameInFormulas(e.spec, old, name)
      if (JSON.stringify(next) !== JSON.stringify(e.spec)) await invoke("path_save", { robotPath, spec: next, previous: e.spec.name }).catch(() => {})
    }
    const field = await invoke<FieldDoc>("field_open", { robotPath }).catch(() => null)
    if (field) {
      const next = renameInFormulas(field, old, name)
      if (JSON.stringify(next) !== JSON.stringify(field)) await invoke("field_save", { robotPath, field: next }).catch(() => {})
    }
    setNote(`Renamed "${old}" to "${name}" everywhere`)
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg-page)" }}>
      <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 10, color: "var(--text-header-eyebrow)", letterSpacing: 1.5, textTransform: "uppercase" }}>Project</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Variables</div>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <MiniButton onClick={() => add({ name: unique("value"), kind: "number", dim: "length", value: "0" })}>+ Number</MiniButton>
            <MiniButton onClick={() => add({ name: unique("pose"), kind: "pose", x: "0", y: "0", heading: "0" })}>+ Pose</MiniButton>
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.5 }}>
          In any number field of Ares, type <Code>=name</Code> to use a variable, or a formula: <Code>=hub.x - 0.5</Code>, <Code>=vmax * 0.8</Code>, <Code>=24in + 3cm</Code>, <Code>=min(a, b)</Code>.
          A pose has <Code>.x</Code>, <Code>.y</Code> and <Code>.heading</Code>. Variables may use each other. Changing one updates every field that uses it, in every path.
          {note && <span style={{ marginLeft: 8, color: note.startsWith("Renamed") ? "var(--status-success)" : "var(--status-error)" }}>{note}</span>}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 20px 20px" }}>
        {variables.length === 0 ? (
          <div style={{ padding: 24, fontSize: 12, color: "var(--text-muted)" }}>No variables yet. Add a number (a speed, a distance) or a pose (a scoring spot, a pickup).</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-header-eyebrow)", fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>
                <Th>Name</Th><Th>Type</Th><Th>Value or =formula</Th><Th>Result</Th><Th>Used</Th><Th />
              </tr>
            </thead>
            <tbody>
              {variables.map((v, i) => {
                const val = scope.get(v.name)
                const err = errors.get(v.name)
                return (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border-light)", verticalAlign: "top" }}>
                    <Td><Text value={v.name} mono onCommit={n => rename(i, n.trim())} /></Td>
                    <Td>
                      {v.kind === "pose" ? (
                        <span style={{ fontSize: 11, color: "#0e7490", fontWeight: 600 }}>Pose</span>
                      ) : (
                        <select style={{ ...propertyInputStyle, width: 150 }} value={v.dim} onChange={e => update(i, { ...v, dim: e.target.value as Dim })}>
                          {(Object.keys(DIM_LABEL) as Dim[]).map(d => <option key={d} value={d}>{DIM_LABEL[d]}</option>)}
                        </select>
                      )}
                    </Td>
                    <Td>
                      {v.kind === "number" ? (
                        <Formula value={v.value} dim={v.dim} onCommit={value => update(i, { ...v, value })} />
                      ) : (
                        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 6px", alignItems: "center" }}>
                          <Small>x</Small><Formula value={v.x} dim="length" onCommit={x => update(i, { ...v, x })} />
                          <Small>y</Small><Formula value={v.y} dim="length" onCommit={y => update(i, { ...v, y })} />
                          <Small>heading</Small><Formula value={v.heading} dim="angle" onCommit={heading => update(i, { ...v, heading })} />
                        </div>
                      )}
                    </Td>
                    <Td>
                      {err ? (
                        <span style={{ color: "var(--status-error)", fontSize: 11 }}>⚠ {err}</span>
                      ) : typeof val === "number" ? (
                        <Mono>{fmt(val)} {v.kind === "number" ? DIM_UNIT[v.dim] : ""}</Mono>
                      ) : val ? (
                        <Mono>({fmt(val.x)}, {fmt(val.y)}) m · {fmt(val.heading)}°</Mono>
                      ) : null}
                    </Td>
                    <Td><span style={{ color: "var(--text-muted)" }}>{usesOf([...docs, ...variables], v.name) || "—"}</span></Td>
                    <Td><MiniButton onClick={() => remove(i)} title="Delete">Delete</MiniButton></Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/** A variable's value: a number (units ok) or =formula, checked as typed. */
function Formula({ value, dim, onCommit }: { value: string; dim: Dim; onCommit: (v: string) => void }) {
  const { scope } = useVariables()
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const check = useMemo(() => evaluate(isExpr(text) ? text : `=${text}`, scope, dim), [text, scope, dim])
  return (
    <input
      style={{ ...propertyInputStyle, width: 220, fontFamily: "Consolas, 'Cascadia Mono', monospace", borderColor: check.ok ? (isExpr(text) ? "#e95420" : undefined) : "var(--status-error)", color: isExpr(text) ? "#b8410f" : undefined }}
      value={text}
      title={check.ok ? `= ${fmt(check.value)}` : check.error}
      onChange={e => setText(e.target.value)}
      onBlur={() => { if (text.trim() !== value) onCommit(text.trim() || "0") }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }}
    />
  )
}

function Text({ value, onCommit, mono }: { value: string; onCommit: (v: string) => void; mono?: boolean }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      style={{ ...propertyInputStyle, width: 160, fontFamily: mono ? "Consolas, 'Cascadia Mono', monospace" : undefined, fontWeight: 600 }}
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => { if (text !== value) onCommit(text); }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }}
    />
  )
}

function Th({ children }: { children?: ReactNode }) {
  return <th style={{ padding: "8px 8px 6px", fontWeight: 700, borderBottom: "1px solid var(--border-main)" }}>{children}</th>
}
function Td({ children }: { children?: ReactNode }) {
  return <td style={{ padding: "6px 8px" }}>{children}</td>
}
function Small({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{children}</span>
}
function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11.5 }}>{children}</span>
}
function Code({ children }: { children: ReactNode }) {
  return <code style={{ fontFamily: "Consolas, 'Cascadia Mono', monospace", background: "rgba(233,84,32,0.08)", color: "#b8410f", padding: "0 4px" }}>{children}</code>
}
function fmt(v: number) {
  return String(Number(v.toPrecision(5)))
}
