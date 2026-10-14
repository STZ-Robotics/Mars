// --- Function Page (AdvantageScope-style line plots) ---
export type FunctionTransform = "raw" | "integral" | "derivative" | "derivative2" | "movingAvg"
export type FunctionAxis = "left" | "right"
export type FunctionLineStyle = "line" | "stepped" | "points"

export type SeriesOperator = "add" | "subtract" | "multiply" | "divide"

export interface SeriesCombine {
  operator: SeriesOperator
  withSeriesId: string   // id of another series inside the same `series[]` array
}

export interface FunctionSeriesConfig {
  id: string
  topicName: string   // numeric topics only (double/int/float)
  label: string        // editable name, default = last segment of the path
  color: string         // line color in hex
  transform: FunctionTransform
  axis: FunctionAxis
  combine?: SeriesCombine | null    // algebra between series
  errorTargetId?: string | null     // id of the "target/setpoint" series

  visible?: boolean              // default true
  lineStyle?: FunctionLineStyle  // default "line"
  lineWidth?: number             // px, default 1.6
  /** Moving-average samples when transform === "movingAvg". */
  smoothWindow?: number
  /** Factor and offset applied after the transform (sensor units/offset). */
  scale?: number
  offset?: number
}

// Settings of the whole plot (not of a single series).
export interface FunctionSettings {
  /** The plot's title; travels to the exported PNG and the suggested file name. */
  title: string
  /** "time" = signal against time. "phase" = one signal against ANOTHER (X-Y). */
  xMode: "time" | "phase"
  /** Series that drives the X axis when xMode === "phase". */
  xSeriesId: string | null
  windowSeconds: number
  showGrid: boolean
  showLegend: boolean
  showStats: boolean
  /** null = autoscale; otherwise, the axis' fixed range. */
  leftRange: [number, number] | null
  rightRange: [number, number] | null
}

export const defaultFunctionSettings: FunctionSettings = {
  title: "Function Plot",
  xMode: "time",
  xSeriesId: null,
  windowSeconds: 10,
  showGrid: true,
  showLegend: true,
  showStats: false,
  leftRange: null,
  rightRange: null,
}

// --- Equations ---

// Binds a short name usable in formulas (x, theta, v_max) to the double topic
// its value comes from.
export interface EquationVariable {
  id: string
  name: string
  topicName: string
}

export interface EquationConfig {
  id: string
  /** Name OTHER equations can reference this one by. */
  name: string
  expression: string
  /** Optional unit shown next to the result (it takes no part in the calculation). */
  unit: string
  decimals: number
}
