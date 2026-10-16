import { describe, it, expect } from "vitest"
import {
  hexToHsl, severityFromHex, severityOf, findStatusSubsystems, statusTopicNames,
  readSubsystemStatus, sortBySeverity, countBySeverity, hasCriticalAlerts,
  pushStatusChange, SubsystemStatus, StatusChange,
} from "./subsystemStatus"
import { TopicAnnounce } from "../../store/appStore"

const topic = (name: string, type = "string"): [string, TopicAnnounce] => [
  name, { id: 0, name, topic_type: type },
]

describe("hexToHsl", () => {
  it("converts the base colors", () => {
    expect(hexToHsl("#ff0000")!.h).toBeCloseTo(0, 5)
    expect(hexToHsl("#00ff00")!.h).toBeCloseTo(120, 5)
    expect(hexToHsl("#0000ff")!.h).toBeCloseTo(240, 5)
  })

  it("accepts with and without the hash, and the short form", () => {
    expect(hexToHsl("00ff00")!.h).toBeCloseTo(120, 5)
    expect(hexToHsl("#0f0")!.h).toBeCloseTo(120, 5)
  })

  it("marks greys as unsaturated", () => {
    expect(hexToHsl("#808080")!.s).toBe(0)
  })

  it("returns null if it is not a valid hex", () => {
    expect(hexToHsl("rojo")).toBeNull()
    expect(hexToHsl("#12345")).toBeNull()
    expect(hexToHsl("")).toBeNull()
  })
})

describe("severityFromHex", () => {
  it("classifies GlobalColorCode's four colors", () => {
    // NOMINAL verde, WORKING amarillo, TIMEOUT naranja, HARDWARE_FAULT rojo.
    expect(severityFromHex("#00ff00")).toBe("ok")
    expect(severityFromHex("#ffff00")).toBe("warning")
    expect(severityFromHex("#ff8000")).toBe("error")
    expect(severityFromHex("#ff0000")).toBe("critical")
  })

  it("recognizes dark shades of the same color", () => {
    // Teams use things like DarkGreen for IDLE.
    expect(severityFromHex("#006400")).toBe("ok")
    expect(severityFromHex("#8b0000")).toBe("critical")
  })

  it("does not force a severity on colors that do not convey one", () => {
    // Painting red a state the team chose to be light blue would be lying.
    expect(severityFromHex("#0000ff")).toBe("unknown")
    expect(severityFromHex("#00ffff")).toBe("unknown")
    expect(severityFromHex("#800080")).toBe("unknown")
    expect(severityFromHex("#808080")).toBe("unknown")
    expect(severityFromHex("#000000")).toBe("unknown")
  })

  it("returns unknown without a color", () => {
    expect(severityFromHex(null)).toBe("unknown")
    expect(severityFromHex("not-a-color")).toBe("unknown")
  })
})

describe("severityOf", () => {
  it("the global code's name wins over the color", () => {
    // If the robot says HARDWARE_FAULT, it is critical even if it sent green.
    expect(severityOf("HARDWARE_FAULT", "#00ff00")).toBe("critical")
    expect(severityOf("NOMINAL", "#ff0000")).toBe("ok")
    expect(severityOf("TIMEOUT", null)).toBe("error")
  })

  it("is case-insensitive on the code", () => {
    expect(severityOf("nominal", null)).toBe("ok")
  })

  it("falls back to the color with the team's own codes", () => {
    // ModuleColorCode.solid(...) define nombres arbitrarios.
    expect(severityOf("INTAKING", "#ffff00")).toBe("warning")
    expect(severityOf("ON_TARGET", "#00ff00")).toBe("ok")
  })
})

describe("findStatusSubsystems", () => {
  it("detects the subsystems by their Hex topic", () => {
    const topics = new Map([
      topic("/Arm/Status/Hex"),
      topic("/Arm/Status/Name"),
      topic("/Arm/Status/Message"),
      topic("/Drive/Status/Hex"),
      topic("/Drive/Status/Name"),
    ])
    expect(findStatusSubsystems(topics)).toEqual(["/Arm", "/Drive"])
  })

  it("ignores topics that are not strings", () => {
    // A double with the same name is not a subsystem state.
    const topics = new Map([topic("/Fake/Status/Hex", "double")])
    expect(findStatusSubsystems(topics)).toEqual([])
  })

  it("sorts in natural order", () => {
    const topics = new Map([
      topic("/Module10/Status/Hex"),
      topic("/Module9/Status/Hex"),
    ])
    expect(findStatusSubsystems(topics)).toEqual(["/Module9", "/Module10"])
  })

  it("returns empty if there are none", () => {
    expect(findStatusSubsystems(new Map([topic("/Otro/Cosa")]))).toEqual([])
  })
})

describe("statusTopicNames", () => {
  it("asks for each subsystem's three topics", () => {
    expect(statusTopicNames(["/Arm"])).toEqual([
      "/Arm/Status/Name", "/Arm/Status/Hex", "/Arm/Status/Message",
    ])
  })
})

describe("readSubsystemStatus", () => {
  it("builds the state from the NT values", () => {
    const values = {
      "/Arm/Status/Name": { String: "ON_TARGET" },
      "/Arm/Status/Hex": { String: "#00ff00" },
      "/Arm/Status/Message": { String: "Holding at 45.00 deg" },
    }
    const status = readSubsystemStatus(values, "/Arm")
    expect(status.name).toBe("Arm")
    expect(status.code).toBe("ON_TARGET")
    expect(status.message).toBe("Holding at 45.00 deg")
    expect(status.severity).toBe("ok")
  })

  it("uses the last segment as the display name", () => {
    const status = readSubsystemStatus({}, "/Robot/Subsystems/Intake")
    expect(status.name).toBe("Intake")
  })

  it("survives a subsystem with no values yet", () => {
    const status = readSubsystemStatus({}, "/Arm")
    expect(status.code).toBeNull()
    expect(status.hex).toBeNull()
    expect(status.severity).toBe("unknown")
  })

  it("treats the empty string as missing", () => {
    const status = readSubsystemStatus({ "/Arm/Status/Hex": { String: "" } }, "/Arm")
    expect(status.hex).toBeNull()
  })
})

// ---------------------------------------------------------------------------

const make = (name: string, severity: SubsystemStatus["severity"]): SubsystemStatus => ({
  prefix: `/${name}`, name, code: null, hex: null, message: null, severity,
})

describe("sorting and counts", () => {
  it("puts the most severe first", () => {
    const sorted = sortBySeverity([
      make("A", "ok"), make("B", "critical"), make("C", "warning"),
      make("D", "unknown"), make("E", "error"),
    ])
    expect(sorted.map(s => s.severity)).toEqual(["critical", "error", "warning", "ok", "unknown"])
  })

  it("breaks ties alphabetically within the same severity", () => {
    const sorted = sortBySeverity([make("Zeta", "ok"), make("Alfa", "ok")])
    expect(sorted.map(s => s.name)).toEqual(["Alfa", "Zeta"])
  })

  it("counts by severity", () => {
    const counts = countBySeverity([make("A", "ok"), make("B", "ok"), make("C", "critical")])
    expect(counts.ok).toBe(2)
    expect(counts.critical).toBe(1)
    expect(counts.error).toBe(0)
  })

  it("hasCriticalAlerts is the gate before enabling", () => {
    expect(hasCriticalAlerts([make("A", "ok"), make("B", "error")])).toBe(false)
    expect(hasCriticalAlerts([make("A", "ok"), make("B", "critical")])).toBe(true)
  })
})

describe("pushStatusChange", () => {
  const status = (code: string, hex: string, message: string): SubsystemStatus => ({
    prefix: "/Arm", name: "Arm", code, hex, message, severity: "ok",
  })

  it("adds nothing if the state did not change", () => {
    // At a 4Hz poll, without this the history fills with identical entries and
    // hides the changes that matter.
    const first = pushStatusChange([], status("A", "#0f0", "m"), 1000)
    const second = pushStatusChange(first, status("A", "#0f0", "m"), 2000)
    expect(second).toHaveLength(1)
    expect(second).toBe(first) // misma referencia: no re-renderiza
  })

  it("adds when the code, the color or the message changes", () => {
    let h: StatusChange[] = []
    h = pushStatusChange(h, status("A", "#0f0", "m"), 1000)
    h = pushStatusChange(h, status("B", "#0f0", "m"), 2000)
    h = pushStatusChange(h, status("B", "#f00", "m"), 3000)
    h = pushStatusChange(h, status("B", "#f00", "otro"), 4000)
    expect(h).toHaveLength(4)
  })

  it("trims the history to the limit", () => {
    let h: StatusChange[] = []
    for (let i = 0; i < 20; i++) h = pushStatusChange(h, status(`C${i}`, "#0f0", "m"), i)
    expect(h).toHaveLength(12)
    // The MOST RECENT ones are kept.
    expect(h[h.length - 1].code).toBe("C19")
  })
})
