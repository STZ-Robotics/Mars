import { create } from "zustand"
import { MechanismType, SysIdTestType } from "../utils/sysid/feedforward"

/** A run's time range, in microseconds (the NT server's scale). */
export interface TestRange {
  startUs: number | null
  endUs: number | null
}

export interface SysIdConfig {
  mechanism: MechanismType
  /** Topic of the voltage applied to the motor. */
  voltageTopic: string | null
  /** Only the arm model needs it (for cos θ). */
  positionTopic: string | null
  velocityTopic: string | null
  ranges: Record<SysIdTestType, TestRange>
}

export const emptyRanges = (): Record<SysIdTestType, TestRange> => ({
  "quasistatic-forward": { startUs: null, endUs: null },
  "quasistatic-backward": { startUs: null, endUs: null },
  "dynamic-forward": { startUs: null, endUs: null },
  "dynamic-backward": { startUs: null, endUs: null },
})

export const defaultSysIdConfig: SysIdConfig = {
  mechanism: "simple",
  voltageTopic: null,
  positionTopic: null,
  velocityTopic: null,
  ranges: emptyRanges(),
}

interface SysIdState {
  config: SysIdConfig
  update: (updates: Partial<SysIdConfig>) => void
  setRange: (test: SysIdTestType, range: Partial<TestRange>) => void
  clearRange: (test: SysIdTestType) => void
  reset: () => void
  /** Replaces everything (when restoring a saved layout). */
  setConfig: (config: SysIdConfig) => void
}

// The configuration lives in a store and not in the page's local state because
// SysId is a singleton Page: navigating to another screen and back would lose
// the four ranges that took effort to mark by hand.
export const useSysIdStore = create<SysIdState>((set) => ({
  config: defaultSysIdConfig,

  update: (updates) => set(state => ({ config: { ...state.config, ...updates } })),

  setRange: (test, range) => set(state => ({
    config: {
      ...state.config,
      ranges: { ...state.config.ranges, [test]: { ...state.config.ranges[test], ...range } },
    },
  })),

  clearRange: (test) => set(state => ({
    config: {
      ...state.config,
      ranges: { ...state.config.ranges, [test]: { startUs: null, endUs: null } },
    },
  })),

  reset: () => set({ config: { ...defaultSysIdConfig, ranges: emptyRanges() } }),

  setConfig: (config) => set({ config }),
}))

/** A range is only usable if it has both ends and the end comes after the start. */
export function isRangeUsable(range: TestRange): boolean {
  return range.startUs !== null && range.endUs !== null && range.endUs > range.startUs
}

/** Fills in whatever a config saved by an earlier version is missing. */
export function normalizeSysIdConfig(raw: any): SysIdConfig {
  const mechanisms: MechanismType[] = ["simple", "elevator", "arm"]
  const ranges = emptyRanges()

  if (raw && typeof raw.ranges === "object" && raw.ranges !== null) {
    for (const key of Object.keys(ranges) as SysIdTestType[]) {
      const r = raw.ranges[key]
      if (!r) continue
      // A range with a non-finite time would draw at NaN and break the fit.
      const startUs = typeof r.startUs === "number" && isFinite(r.startUs) ? r.startUs : null
      const endUs = typeof r.endUs === "number" && isFinite(r.endUs) ? r.endUs : null
      ranges[key] = { startUs, endUs }
    }
  }

  const asTopic = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null)

  return {
    mechanism: mechanisms.includes(raw?.mechanism) ? raw.mechanism : "simple",
    voltageTopic: asTopic(raw?.voltageTopic),
    positionTopic: asTopic(raw?.positionTopic),
    velocityTopic: asTopic(raw?.velocityTopic),
    ranges,
  }
}
