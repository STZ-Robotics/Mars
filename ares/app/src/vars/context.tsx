import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { writeVarsJava } from "./writeJava"
import type { Scope, Value } from "./expr"
import { evaluateAll, Variable, VariablesDoc } from "./variables"

// The project's variables, for every field in the app: their values (the
// scope formulas evaluate against), and a setter that saves them. `version`
// moves on every change, so pages know to re-evaluate their documents.

interface VariablesState {
  variables: Variable[]
  scope: Scope
  errors: ReadonlyMap<string, string>
  version: number
  /** Replace the list (saved shortly after). */
  setVariables: (vars: Variable[]) => void
  loaded: boolean
}

const empty: VariablesState = {
  variables: [], scope: new Map(), errors: new Map(), version: 0, setVariables: () => {}, loaded: false,
}

const Ctx = createContext<VariablesState>(empty)

export function useVariables(): VariablesState {
  return useContext(Ctx)
}

export function VariablesProvider({ robotPath, children }: { robotPath: string | null; children: ReactNode }) {
  const [variables, setVars] = useState<Variable[]>([])
  const [version, setVersion] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLoaded(false)
    if (!robotPath) { setVars([]); setLoaded(true); return }
    invoke<VariablesDoc>("variables_open", { robotPath })
      .then(d => setVars(Array.isArray(d?.variables) ? d.variables : []))
      .catch(() => setVars([]))
      .finally(() => { setLoaded(true); setVersion(v => v + 1) })
  }, [robotPath])

  const setVariables = useCallback((next: Variable[]) => {
    setVars(next)
    setVersion(v => v + 1)
    if (!robotPath) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      invoke("variables_save", { robotPath, doc: { variables: next } })
        // And as Java constants in the robot code, when the project says so.
        .then(() => writeVarsJava(robotPath, next))
        .catch(() => {})
    }, 300)
  }, [robotPath])

  const { scope, errors } = useMemo(() => evaluateAll(variables), [variables])
  const value = useMemo<VariablesState>(
    () => ({ variables, scope: scope as Map<string, Value>, errors, version, setVariables, loaded }),
    [variables, scope, errors, version, setVariables, loaded],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
