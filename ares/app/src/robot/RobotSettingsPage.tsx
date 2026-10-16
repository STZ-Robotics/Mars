import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import PageHeader from "@desktop/components/layout/PageHeader"
import PanelHeader from "@desktop/components/layout/PanelHeader"
import Panel from "@desktop/components/common/Panel"
import PropertyRow from "@desktop/components/common/PropertyRow"
import { propertyInputStyle } from "@desktop/styles/pageForm"
import { fileNameOf, loadModel, pickModelFile } from "@desktop/utils/field/robotModel"
import RobotTurntable, { autoPlaceOffset } from "./RobotTurntable"
import {
  Check, GEAR_PRESETS, MOTOR_LABELS, MotorId, MotorInfo, ModelRef, RobotConfig, SwerveConfig,
  rectangleOf, squareModules,
} from "./types"
import { Card, Collapsible, MiniButton, Q, QInput, Toggle } from "../ui/controls"

interface Props {
  robot: RobotConfig
  onChange: (robot: RobotConfig) => void
  robotPath: string | null
}

const SIDEBAR_WIDTH = 380

// What each scale means, for the model's units select.
const MODEL_UNITS: { label: string; scale: number }[] = [
  { label: "millimeters", scale: 0.001 },
  { label: "centimeters", scale: 0.01 },
  { label: "inches", scale: 0.0254 },
  { label: "meters", scale: 1 },
]

export default function RobotSettingsPage({ robot, onChange, robotPath }: Props) {
  const check = useRobotCheck(robot)
  const motors = useMotors()
  const [spinning, setSpinning] = useState(true)
  const [showAnnotations, setShowAnnotations] = useState(true)
  const [modelError, setModelError] = useState<string | null>(null)
  const [modelPath, setModelPath] = useState<string | null>(null)

  const dt = robot.drivetrain
  const set = (patch: Partial<RobotConfig>) => onChange({ ...robot, ...patch })
  const setDrive = (patch: Partial<SwerveConfig>) => onChange({ ...robot, drivetrain: { ...dt, ...patch } })
  const setModel = (patch: Partial<ModelRef>) => robot.model && onChange({ ...robot, model: { ...robot.model, ...patch } })

  // robot.json keeps the model path relative to itself; the viewer needs the
  // real one.
  useEffect(() => {
    if (!robot.model) { setModelPath(null); return }
    invoke<string>("resolve_model_path", { robotPath, modelPath: robot.model.path }).then(setModelPath)
  }, [robotPath, robot.model?.path])

  const rect = rectangleOf(dt.modules)
  const derived = check.derived

  const loadStl = async () => {
    const path = await pickModelFile("Robot model (STL / glTF)")
    if (!path) return
    try {
      // Guess the CAD units from the size: a robot is about a meter across,
      // so hundreds of units is millimeters and tens is inches.
      const loaded = await loadModel(path)
      const span = Math.max(loaded.size.x, loaded.size.y, loaded.size.z)
      const scale = span > 100 ? 0.001 : span > 10 ? 0.0254 : 1
      const model: ModelRef = { path, scale, offsetM: [0, 0, 0], rotationDeg: [0, 0, 0] }
      model.offsetM = await autoPlaceOffset(path, model)
      onChange({ ...robot, model })
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e))
    }
  }

  const autoPlace = async () => {
    if (!robot.model || !modelPath) return
    setModel({ offsetM: await autoPlaceOffset(modelPath, robot.model) })
  }

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ width: SIDEBAR_WIDTH, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-main)", background: "var(--bg-panel)" }}>
        <PageHeader
          eyebrow="Robot"
          title={robot.name || "Unnamed robot"}
          subtitle={robotPath ? fileNameOf(robotPath) : "Not saved yet"}
        />
        <div className="ares-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <Panel title="Chassis" icon="ti-box">
            <PropertyRow label="Name">
              <input style={propertyInputStyle} value={robot.name} onChange={e => set({ name: e.target.value })} />
            </PropertyRow>
            <Q label="Mass (with battery, bumpers)" dim="mass" unit="kg" value={robot.massKg} onChange={v => set({ massKg: v })} />
            <Q label="Bumper length (X)" dim="length" unit="m" value={robot.bumper.lengthM} onChange={v => set({ bumper: { ...robot.bumper, lengthM: v } })} />
            <Q label="Bumper width (Y)" dim="length" unit="m" value={robot.bumper.widthM} onChange={v => set({ bumper: { ...robot.bumper, widthM: v } })} />
          </Panel>

          <Panel title="Swerve modules" icon="ti-steering-wheel">
            {rect ? (
              <>
                <Q label="Wheelbase (front–back)" dim="length" unit="m" value={rect.wheelbaseM} onChange={v => setDrive({ modules: squareModules(v, rect.trackwidthM) })} />
                <Q label="Trackwidth (left–right)" dim="length" unit="m" value={rect.trackwidthM} onChange={v => setDrive({ modules: squareModules(rect.wheelbaseM, v) })} />
              </>
            ) : (
              dt.modules.map((m, i) => (
                <PropertyRow key={i} label={`${m.name} (x, y)`}>
                  <div style={{ display: "flex", gap: 4, width: "100%" }}>
                    <QInput dim="length" value={m.xM} onChange={v => setDrive({ modules: dt.modules.map((q, j) => j === i ? { ...q, xM: v } : q) })} />
                    <QInput dim="length" value={m.yM} onChange={v => setDrive({ modules: dt.modules.map((q, j) => j === i ? { ...q, yM: v } : q) })} />
                  </div>
                </PropertyRow>
              ))
            )}
            <Q label="Wheel radius" dim="length" unit="m" value={dt.wheelRadiusM} onChange={v => setDrive({ wheelRadiusM: v })} />
            <Q label="Wheel grip (μ)" dim="plain" unit="" value={dt.wheelCof} onChange={v => setDrive({ wheelCof: v })} hint="Tread on carpet: about 1.0 for new, less when worn." />
          </Panel>

          <Panel title="Drive" icon="ti-engine">
            <PropertyRow label="Motor">
              <select style={propertyInputStyle} value={dt.driveMotor} onChange={e => setDrive({ driveMotor: e.target.value as MotorId })}>
                {(motors.length ? motors.map(m => m.id) : Object.keys(MOTOR_LABELS) as MotorId[]).map(id => (
                  <option key={id} value={id}>{MOTOR_LABELS[id]}</option>
                ))}
              </select>
            </PropertyRow>
            <PropertyRow label="Gear ratio">
              <div style={{ display: "flex", gap: 4, width: "100%" }}>
                <QInput dim="plain" value={dt.driveGearRatio} onChange={v => setDrive({ driveGearRatio: v })} />
                <select
                  style={{ ...propertyInputStyle, width: 120 }}
                  value={GEAR_PRESETS.find(p => p.ratio === dt.driveGearRatio)?.label ?? ""}
                  onChange={e => {
                    const p = GEAR_PRESETS.find(q => q.label === e.target.value)
                    if (p) setDrive({ driveGearRatio: p.ratio })
                  }}
                >
                  <option value="">Custom</option>
                  {GEAR_PRESETS.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
                </select>
              </div>
            </PropertyRow>
            <Q label="Stator current limit" dim="plain" unit="A" value={dt.driveCurrentLimitA} onChange={v => setDrive({ driveCurrentLimitA: v })} hint="0 = no limit" />
          </Panel>

          <Collapsible title="Advanced (optional)" icon="ti-adjustments" hint="Good defaults; change them only if you know the value.">
            <Q
              label="Moment of inertia" dim="plain" unit="kg·m²" value={robot.moiKgM2}
              onChange={v => set({ moiKgM2: v })}
              action={derived && (
                <MiniButton title="A box of the bumper's size and the robot's mass" onClick={() => set({ moiKgM2: Number(derived.moiEstimateKgM2.toFixed(2)) })}>
                  estimate
                </MiniButton>
              )}
            />
            <Q
              label="Center of mass height" dim="length" unit="m" optional value={robot.cogHeightM}
              onChange={v => set({ cogHeightM: v })}
              hint="Load transfer and tipping. Leave empty if unknown."
            />
            <Q label="Motors per module" dim="plain" unit="" value={dt.driveMotorsPerModule} integer onChange={v => setDrive({ driveMotorsPerModule: v })} />
            <Q label="Battery under load" dim="plain" unit="V" value={dt.batteryVoltage} onChange={v => setDrive({ batteryVoltage: v })} />
          </Collapsible>

          <Panel title="3D model" icon="ti-cube">
            {robot.model ? (
              <>
                <PropertyRow label="File">
                  <span style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={robot.model.path}>
                    {fileNameOf(robot.model.path)}
                  </span>
                  <MiniButton onClick={loadStl}>change</MiniButton>
                  <MiniButton onClick={() => set({ model: undefined })}>remove</MiniButton>
                </PropertyRow>
                <PropertyRow label="File units">
                  <select
                    style={propertyInputStyle}
                    value={MODEL_UNITS.find(u => u.scale === robot.model!.scale)?.label ?? "custom"}
                    onChange={e => {
                      const u = MODEL_UNITS.find(q => q.label === e.target.value)
                      if (u) setModel({ scale: u.scale })
                    }}
                  >
                    {MODEL_UNITS.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
                    {!MODEL_UNITS.some(u => u.scale === robot.model!.scale) && <option value="custom">custom ({robot.model.scale})</option>}
                  </select>
                </PropertyRow>
                {(["Roll", "Pitch", "Yaw"] as const).map((axis, i) => (
                  <PropertyRow key={axis} label={`${axis} (deg)`}>
                    <QInput dim="plain" value={robot.model!.rotationDeg[i]} onChange={v => {
                      const r = [...robot.model!.rotationDeg] as [number, number, number]
                      r[i] = v
                      setModel({ rotationDeg: r })
                    }} />
                    <MiniButton title="Turn 90°" onClick={() => {
                      const r = [...robot.model!.rotationDeg] as [number, number, number]
                      r[i] = ((r[i] + 90 + 180) % 360) - 180
                      setModel({ rotationDeg: r })
                    }}>+90</MiniButton>
                  </PropertyRow>
                ))}
                {(["X", "Y", "Z"] as const).map((axis, i) => (
                  <PropertyRow key={axis} label={`Offset ${axis}`}>
                    <QInput dim="length" value={robot.model!.offsetM[i]} onChange={v => {
                      const o = [...robot.model!.offsetM] as [number, number, number]
                      o[i] = v
                      setModel({ offsetM: o })
                    }} />
                  </PropertyRow>
                ))}
                <PropertyRow label="">
                  <MiniButton onClick={autoPlace} title="Center the model on the robot and set it on the floor">Auto place</MiniButton>
                </PropertyRow>
              </>
            ) : (
              <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  The robot's CAD as .stl, .glb or .gltf. Only for the view: the physics uses the numbers above.
                </span>
                <MiniButton onClick={loadStl}>Load model…</MiniButton>
              </div>
            )}
            {modelError && <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--status-error)" }}>{modelError}</div>}
          </Panel>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <PanelHeader
          title="Preview"
          meta={check.problems.length ? `${check.problems.length} problem${check.problems.length > 1 ? "s" : ""}` : "valid"}
          action={
            <span style={{ display: "flex", gap: 6 }}>
              <Toggle on={spinning} onClick={() => setSpinning(s => !s)} icon="ti-rotate-360" label="Spin" />
              <Toggle on={showAnnotations} onClick={() => setShowAnnotations(s => !s)} icon="ti-ruler-measure" label="Annotations" />
            </span>
          }
        />
        <div style={{ flex: 1, position: "relative", background: "var(--bg-page)", minHeight: 0 }}>
          <RobotTurntable robot={robot} derived={derived} modelPath={modelPath} spinning={spinning} showAnnotations={showAnnotations} onModelError={setModelError} />
          <div style={{ position: "absolute", left: 16, bottom: 16, right: 16, display: "flex", gap: 12, alignItems: "flex-end", pointerEvents: "none", flexWrap: "wrap" }}>
            {check.problems.length > 0 && (
              <Card style={{ borderColor: "var(--status-error-border)", background: "var(--status-error-bg)" }}>
                {check.problems.map((p, i) => <div key={i} style={{ fontSize: 11, color: "var(--status-error)" }}>{p}</div>)}
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The backend's verdict on the config as it is being edited. */
function useRobotCheck(robot: RobotConfig): Check {
  const [check, setCheck] = useState<Check>({ problems: [], derived: null })
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      invoke<Check>("robot_check", { config: robot })
        .then(c => { if (alive) setCheck(c) })
        .catch(e => { if (alive) setCheck({ problems: [String(e)], derived: null }) })
    }, 120)
    return () => { alive = false; clearTimeout(t) }
  }, [JSON.stringify(robot)])
  return check
}

function useMotors(): MotorInfo[] {
  const [motors, setMotors] = useState<MotorInfo[]>([])
  useEffect(() => { invoke<MotorInfo[]>("motors").then(setMotors).catch(() => {}) }, [])
  return motors
}
