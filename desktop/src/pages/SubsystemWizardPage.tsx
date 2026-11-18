import { useEffect, useMemo, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import 'katex/dist/katex.min.css'
import { InlineMath } from 'react-katex'
import {
  SubsystemWizardConfig,
  defaultWizardConfig,
  IOInputField,
  ColorCodeEntry,
  JavaFieldType,
  Severity,
} from "../store/appStore"
import { WPI_COLORS, SEVERITIES, SEVERITY_COLORS } from "../utils/wpiColors"
import { LATEX_UNIT_MAP, toLatex } from "../utils/latexUnits"

interface Props {
  projectPath: string | null
}

const JAVA_TYPES: JavaFieldType[] = ["double", "boolean", "int", "String", "Rotation2d", "Translation2d", "Pose2d"]

function newId() {
  return Math.random().toString(36).slice(2, 10)
}

function sectionStyle(): React.CSSProperties {
  return {
    background: "var(--bg-panel)",
    border: "1px solid var(--border-main)",
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  }
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border-main)",
  borderRadius: 4,
  color: "var(--text-primary)",
  padding: "6px 8px",
  fontSize: 13,
  outline: "none",
}

const labelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 4,
  display: "block",
}

const UNIT_NAMES = Object.keys(LATEX_UNIT_MAP)

function UnitPicker({
  value,
  isOpen,
  onToggle,
  onSelect,
}: {
  value: string
  isOpen: boolean
  onToggle: () => void
  onSelect: (name: string) => void
}) {
  const [search, setSearch] = useState("")
  const options = useMemo(
    () => UNIT_NAMES.filter((u) => u.toLowerCase().includes(search.toLowerCase())),
    [search]
  )

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 8, background: "var(--bg-input)",
          border: "1px solid var(--border-main)", borderRadius: 4, padding: "6px 10px", cursor: "pointer",
          color: "var(--text-primary)", fontSize: 13, minWidth: 150, justifyContent: "space-between",
        }}
      >
        {value ? (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{value}</span>
            <InlineMath math={toLatex(value)} />
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Select unit...</span>
        )}
        <span style={{ fontSize: 9, color: "var(--text-muted)" }}>▾</span>
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute", top: "110%", left: 0, zIndex: 30, width: 260,
            background: "var(--bg-panel)", border: "1px solid var(--border-main)", borderRadius: 6,
            padding: 8, maxHeight: 280, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}
        >
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search unit..."
            style={{ ...inputStyle, width: "100%", marginBottom: 6, boxSizing: "border-box" }}
          />
          {options.length === 0 && (
            <p style={{ fontSize: 11, color: "var(--text-muted)", padding: 6 }}>No matches.</p>
          )}
          {options.map((name) => (
            <button
              key={name}
              onClick={() => { onSelect(name); setSearch("") }}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%",
                background: name === value ? "var(--bg-input)" : "transparent",
                border: "none", borderRadius: 4, padding: "6px 8px", cursor: "pointer",
                color: "var(--text-secondary)", fontSize: 12, textAlign: "left", marginBottom: 2,
              }}
            >
              <span>{name}</span>
              <InlineMath math={toLatex(name)} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function UnitSystemWarning() {
  return (
    <div
      style={{
        display: "flex", gap: 8, alignItems: "flex-start", background: "rgba(207, 150, 27, 0.1)",
        border: "1px solid var(--status-warning)", borderRadius: 6, padding: "8px 12px", marginBottom: 12,
      }}
    >
      <span style={{ color: "var(--status-warning)", fontSize: 14 }}>⚠</span>
      <p style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5, margin: 0 }}>
        You're responsible for picking a unit that actually matches the field. The wizard won't stop you
        from tagging an encoder count with <code>Volts</code> or a voltage output with <code>Degrees</code> —
        make sure the unit reflects what's physically being measured or applied.
      </p>
    </div>
  )
}

export default function SubsystemWizardPage({ projectPath }: Props) {
  const [step, setStep] = useState(0)
  const [config, setConfig] = useState<SubsystemWizardConfig>(defaultWizardConfig)
  const [busy, setBusy] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null)
  const [unitPickerFor, setUnitPickerFor] = useState<string | null>(null)

  useEffect(() => {
    if (!projectPath) return
    invoke<boolean>("check_unit_processor", { projectPath })
      .then((has) => setConfig((c) => ({ ...c, useProjectUnits: has })))
      .catch(() => setConfig((c) => ({ ...c, useProjectUnits: false })))
  }, [projectPath])

  const update = (patch: Partial<SubsystemWizardConfig>) => setConfig((c) => ({ ...c, ...patch }))

  const handlePickFolder = async () => {
    const selected = await open({ directory: true, multiple: false })
    if (selected && typeof selected === "string") {
      const pkg = await invoke<string>("derive_java_package", { targetDir: selected }).catch(() => "")
      update({ targetDir: selected, javaPackage: pkg })
    }
  }

  // --- IO inputs ---
  const addInput = () =>
    update({
      inputs: [
        ...config.inputs,
        { id: newId(), name: "newField", type: "double", hasUnit: false } as IOInputField,
      ],
    })

  const updateInput = (id: string, patch: Partial<IOInputField>) =>
    update({ inputs: config.inputs.map((f) => (f.id === id ? { ...f, ...patch } : f)) })

  const removeInput = (id: string) => update({ inputs: config.inputs.filter((f) => f.id !== id) })

  // --- Color codes ---
  const addColor = () =>
    update({
      colorCodes: [
        ...config.colorCodes,
        { id: newId(), name: "NEW_STATE", severity: "OK", color: "DarkGreen", description: "" } as ColorCodeEntry,
      ],
    })

  const updateColor = (id: string, patch: Partial<ColorCodeEntry>) =>
    update({ colorCodes: config.colorCodes.map((c) => (c.id === id ? { ...c, ...patch } : c)) })

  const removeColor = (id: string) => update({ colorCodes: config.colorCodes.filter((c) => c.id !== id) })

  const canGoStep1 = config.targetDir !== "" && config.moduleName.trim() !== ""
  const canGenerate = canGoStep1 && config.colorCodes.length > 0

  const handleGenerate = async () => {
    setBusy(true)
    setErrorMsg(null)
    setResultMsg(null)
    try {
      const finalConfig: SubsystemWizardConfig = {
        ...config,
        outputUnitGroup: config.outputUnitGroup || config.moduleName,
      }
      const msg = await invoke<string>("generate_mars_subsystem", { config: finalConfig })
      setResultMsg(msg)
    } catch (e) {
      setErrorMsg(String(e))
    } finally {
      setBusy(false)
    }
  }

  const steps = ["Location", "IO", "Diagnostics", "Generate"]

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", background: "var(--bg-page)", padding: 24 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {steps.map((label, i) => (
          <button
            key={label}
            onClick={() => setStep(i)}
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: 6,
              border: `1px solid ${i === step ? "var(--mars-accent)" : "var(--border-main)"}`,
              background: i === step ? "var(--mars-accent)" : "var(--bg-panel)",
              color: i === step ? "#fff" : "var(--text-secondary)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>

      {step === 0 && (
        <div style={sectionStyle()}>
          <h3 style={{ fontSize: 14, marginBottom: 12, color: "var(--text-primary)" }}>Location and module name</h3>

          <label style={labelStyle}>Target folder (inside src/main/java/...)</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input style={{ ...inputStyle, flex: 1 }} value={config.targetDir} readOnly placeholder="Select a folder..." />
            <button
              onClick={handlePickFolder}
              style={{ background: "var(--mars-accent)", border: "none", borderRadius: 4, color: "#fff", padding: "6px 14px", cursor: "pointer", fontSize: 12 }}
            >
              Choose folder
            </button>
          </div>

          <label style={labelStyle}>Module name (e.g. Arm, Intake, Climber)</label>
          <input
            style={{ ...inputStyle, width: "100%", marginBottom: 12 }}
            value={config.moduleName}
            onChange={(e) => update({ moduleName: e.target.value.replace(/[^a-zA-Z0-9]/g, "").replace(/^[0-9]+/, "") })}
            placeholder="Arm"
          />

          <label style={labelStyle}>Java package (auto-detected, editable)</label>
          <input
            style={{ ...inputStyle, width: "100%", marginBottom: 12 }}
            value={config.javaPackage}
            onChange={(e) => update({ javaPackage: e.target.value })}
          />

          <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={config.separateFolder}
              onChange={(e) => update({ separateFolder: e.target.checked })}
            />
            Create a separate folder for the module ({config.separateFolder
              ? `.../${config.moduleName.toLowerCase() || "module"}/${config.moduleName || "Module"}.java`
              : `.../${config.moduleName || "Module"}.java`})
          </label>

          {!projectPath && (
            <p style={{ color: "var(--status-warning)", fontSize: 12, marginTop: 12 }}>
              No project is open — couldn't check whether UnitProcessor is installed.
            </p>
          )}
        </div>
      )}

      {step === 1 && (
        <div style={sectionStyle()}>
          <h3 style={{ fontSize: 14, marginBottom: 4, color: "var(--text-primary)" }}>IO inputs</h3>
          <p style={{ fontSize: 12, color: config.useProjectUnits ? "var(--status-success)" : "var(--text-muted)", marginBottom: 12 }}>
            {config.useProjectUnits
              ? "UnitProcessor detected — you can annotate fields with @Unit."
              : "UnitProcessor is not installed in this project — fields will be generated without @Unit."}
          </p>

          {config.useProjectUnits && <UnitSystemWarning />}

          {config.inputs.map((f) => (
            <div key={f.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: 10, background: "var(--bg-input)", borderRadius: 6, marginBottom: 8 }}>
              <input
                style={{ ...inputStyle, width: 140 }}
                value={f.name}
                onChange={(e) => updateInput(f.id, { name: e.target.value })}
              />
              <select
                style={{ ...inputStyle, width: 130 }}
                value={f.type}
                onChange={(e) => updateInput(f.id, { type: e.target.value as JavaFieldType })}
              >
                {JAVA_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>

              {config.useProjectUnits && (f.type === "double" || f.type === "Rotation2d") && (
                <>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={f.hasUnit} onChange={(e) => updateInput(f.id, { hasUnit: e.target.checked })} />
                    @Unit
                  </label>
                  {f.hasUnit && (
                    <>
                      <UnitPicker
                        value={f.unitValue ?? ""}
                        isOpen={unitPickerFor === f.id}
                        onToggle={() => setUnitPickerFor(unitPickerFor === f.id ? null : f.id)}
                        onSelect={(name) => { updateInput(f.id, { unitValue: name }); setUnitPickerFor(null) }}
                      />
                      <input
                        style={{ ...inputStyle, width: 100 }}
                        placeholder="group (Intake)"
                        value={f.unitGroup ?? ""}
                        onChange={(e) => updateInput(f.id, { unitGroup: e.target.value })}
                      />
                    </>
                  )}
                </>
              )}

              <button onClick={() => removeInput(f.id)} style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--status-error)", color: "var(--status-error)", borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontSize: 11 }}>
                Remove
              </button>
            </div>
          ))}

          <button onClick={addInput} style={{ background: "var(--bg-panel)", border: "1px dashed var(--border-dark)", borderRadius: 6, color: "var(--text-secondary)", padding: "8px 12px", cursor: "pointer", fontSize: 12, width: "100%" }}>
            + Add input
          </button>

          <h4 style={{ fontSize: 13, marginTop: 20, marginBottom: 8, color: "var(--text-primary)" }}>applyOutput(double volts)</h4>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
            Every IO must have this method. If the project has units, it gets annotated with @Unit — this is
            almost always an electrical unit like Volts, not an angle/position unit.
          </p>
          {config.useProjectUnits && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <UnitPicker
                value={config.outputUnitValue}
                isOpen={unitPickerFor === "output"}
                onToggle={() => setUnitPickerFor(unitPickerFor === "output" ? null : "output")}
                onSelect={(name) => { update({ outputUnitValue: name }); setUnitPickerFor(null) }}
              />
              <input
                style={{ ...inputStyle, width: 140 }}
                value={config.outputUnitGroup}
                onChange={(e) => update({ outputUnitGroup: e.target.value })}
                placeholder={config.moduleName || "group"}
              />
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div style={sectionStyle()}>
          <h3 style={{ fontSize: 14, marginBottom: 12, color: "var(--text-primary)" }}>Diagnostics — ModuleColorCode</h3>

          {config.colorCodes.map((c) => (
            <div key={c.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: 10, background: "var(--bg-input)", borderRadius: 6, marginBottom: 8 }}>
              <input
                style={{ ...inputStyle, width: 140 }}
                value={c.name}
                onChange={(e) => updateColor(c.id, { name: e.target.value.toUpperCase().replace(/\s+/g, "_") })}
              />
              <select
                style={{ ...inputStyle, width: 110 }}
                value={c.severity}
                onChange={(e) => updateColor(c.id, { severity: e.target.value as Severity })}
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>

              <button
                onClick={() => setColorPickerFor(colorPickerFor === c.id ? null : c.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, background: "var(--bg-panel)",
                  border: "1px solid var(--border-main)", borderRadius: 4, padding: "4px 8px", cursor: "pointer", color: "var(--text-secondary)", fontSize: 12,
                }}
              >
                <span style={{ width: 14, height: 14, borderRadius: 3, display: "inline-block", background: WPI_COLORS.find((w) => w.name === c.color)?.hex ?? "#000", border: "1px solid var(--border-dark)" }} />
                k{c.color}
              </button>

              <input
                style={{ ...inputStyle, flex: 1, minWidth: 160 }}
                value={c.description}
                onChange={(e) => updateColor(c.id, { description: e.target.value })}
                placeholder="Description (supports %.2f)"
              />

              <span style={{ width: 12, height: 12, borderRadius: "50%", background: SEVERITY_COLORS[c.severity] }} />

              <button onClick={() => removeColor(c.id)} style={{ background: "transparent", border: "1px solid var(--status-error)", color: "var(--status-error)", borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontSize: 11 }}>
                Remove
              </button>

              {colorPickerFor === c.id && (
                <div style={{ width: "100%", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 6, padding: 10, background: "var(--bg-panel)", borderRadius: 6, marginTop: 4 }}>
                  {WPI_COLORS.map((w) => (
                    <button
                      key={w.name}
                      onClick={() => { updateColor(c.id, { color: w.name }); setColorPickerFor(null) }}
                      title={`Color.k${w.name}`}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                        background: "var(--bg-input)", border: c.color === w.name ? "1px solid var(--bg-menubar)" : "1px solid var(--border-light)",
                        borderRadius: 4, padding: 4, cursor: "pointer",
                      }}
                    >
                      <span style={{ width: "100%", height: 20, borderRadius: 3, background: w.hex, border: "1px solid var(--border-dark)" }} />
                      <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{w.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          <button onClick={addColor} style={{ background: "var(--bg-panel)", border: "1px dashed var(--border-dark)", borderRadius: 6, color: "var(--text-secondary)", padding: "8px 12px", cursor: "pointer", fontSize: 12, width: "100%" }}>
            + Add color state
          </button>
        </div>
      )}

      {step === 3 && (
        <div style={sectionStyle()}>
          <h3 style={{ fontSize: 14, marginBottom: 12, color: "var(--text-primary)" }}>Review</h3>
          <ul style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.9, marginBottom: 16, paddingLeft: 20, listStyle: "disc" }}>
            <li>Module: <strong style={{ color: "var(--text-primary)" }}>{config.moduleName || "—"}</strong></li>
            <li>Package: <code>{config.javaPackage || "—"}</code></li>
            <li>Folder: <code>{config.separateFolder ? `${config.targetDir}/${config.moduleName.toLowerCase()}` : config.targetDir}</code></li>
            <li>Inputs: {config.inputs.length}</li>
            <li>Color states: {config.colorCodes.length}</li>
            <li>Project units: {config.useProjectUnits ? "yes" : "no"}</li>
          </ul>

          {!canGenerate && (
            <p style={{ color: "var(--status-warning)", fontSize: 12, marginBottom: 12 }}>
              Missing folder/module name or at least one color state (see steps 1 and 3).
            </p>
          )}

          <button
            disabled={!canGenerate || busy}
            onClick={handleGenerate}
            style={{
              background: canGenerate ? "var(--mars-red)" : "var(--mars-grey)",
              border: "none", borderRadius: 6, color: "#fff", padding: "10px 20px",
              cursor: canGenerate ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600,
            }}
          >
            {busy ? "Generating..." : "Generate Subsystem + IO"}
          </button>

          {resultMsg && <pre style={{ marginTop: 12, color: "var(--status-success)", fontSize: 12, whiteSpace: "pre-wrap" }}>{resultMsg}</pre>}
          {errorMsg && <pre style={{ marginTop: 12, color: "var(--status-error)", fontSize: 12, whiteSpace: "pre-wrap" }}>{errorMsg}</pre>}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "auto" }}>
        <button
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          style={{ background: "transparent", border: "1px solid var(--border-main)", color: "var(--text-secondary)", borderRadius: 6, padding: "8px 16px", cursor: step === 0 ? "not-allowed" : "pointer", fontSize: 12 }}
        >
          Back
        </button>
        <button
          disabled={step === 3 || (step === 0 && !canGoStep1)}
          onClick={() => setStep((s) => Math.min(3, s + 1))}
          style={{ background: "var(--mars-accent)", border: "none", color: "#fff", borderRadius: 6, padding: "8px 16px", cursor: "pointer", fontSize: 12 }}
        >
          Next
        </button>
      </div>
    </div>
  )
}