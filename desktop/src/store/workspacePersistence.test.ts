import { describe, it, expect } from "vitest"
import { normalizeLayout } from "./workspacePersistence"
import { defaultMechanismSettings, defaultSwerveSettings, defaultFieldSettings } from "./appStore"

// These tests cover migrating layouts saved by earlier versions. It is the
// point where adding a new tool could silently invalidate the layouts people
// already had on disk.

const tab = (overrides: Record<string, unknown> = {}) => ({
  id: "1",
  kind: "display",
  title: "Display",
  ...overrides,
})

describe("normalizeLayout", () => {
  it("rejects anything that is not an object", () => {
    expect(normalizeLayout(null)).toBeNull()
    expect(normalizeLayout("nope")).toBeNull()
    expect(normalizeLayout(42)).toBeNull()
  })

  it("accepts a layout without tabs", () => {
    const layout = normalizeLayout({ openTabs: [], activeTabId: null })
    expect(layout).not.toBeNull()
    expect(layout!.openTabs).toEqual([])
    expect(layout!.activeTabId).toBeNull()
  })

  it("fills with defaults the fields an old version did not save", () => {
    // A layout written before the Mechanism tab existed has neither
    // mechanismSources nor mechanismSettings.
    const layout = normalizeLayout({ openTabs: [tab({ kind: "swerve" })], activeTabId: "1" })
    const restored = layout!.openTabs[0]

    expect(restored.mechanismSources).toEqual([])
    expect(restored.mechanismSettings).toEqual(defaultMechanismSettings)
    expect(restored.swerveSettings).toEqual(defaultSwerveSettings)
    expect(restored.fieldSettings).toEqual(defaultFieldSettings)
    expect(restored.widgets).toEqual([])
    expect(restored.equations).toEqual([])
  })

  it("keeps the saved settings and completes only what is missing", () => {
    const layout = normalizeLayout({
      openTabs: [tab({ kind: "mechanism", mechanismSettings: { showGrid: false } })],
      activeTabId: "1",
    })
    const settings = layout!.openTabs[0].mechanismSettings

    expect(settings.showGrid).toBe(false)
    // The rest still comes from the default, it is not lost.
    expect(settings.weightScale).toBe(defaultMechanismSettings.weightScale)
    expect(settings.showOrigin).toBe(defaultMechanismSettings.showOrigin)
  })

  it("drops tabs of a type that no longer exists", () => {
    const layout = normalizeLayout({
      openTabs: [tab(), tab({ id: "2", kind: "herramienta-borrada" })],
      activeTabId: "1",
    })
    expect(layout!.openTabs.map(t => t.id)).toEqual(["1"])
  })

  it("drops tabs without a usable id", () => {
    const layout = normalizeLayout({
      openTabs: [tab({ id: "" }), tab({ id: 7 }), null, tab({ id: "ok" })],
      activeTabId: null,
    })
    expect(layout!.openTabs.map(t => t.id)).toEqual(["ok"])
  })

  it("forgets the activeTabId if its tab is gone", () => {
    // Otherwise the app starts showing an empty screen with no way back.
    const layout = normalizeLayout({
      openTabs: [tab()],
      activeTabId: "borrada",
    })
    expect(layout!.activeTabId).toBeNull()
  })

  it("respects the activeTabId when it does exist", () => {
    const layout = normalizeLayout({
      openTabs: [tab(), tab({ id: "2" })],
      activeTabId: "2",
    })
    expect(layout!.activeTabId).toBe("2")
  })

  it("tolera openTabs corrupto", () => {
    const layout = normalizeLayout({ openTabs: "not an array", activeTabId: null })
    expect(layout!.openTabs).toEqual([])
  })

  it("saves the sidebar's collapsed state", () => {
    expect(normalizeLayout({ openTabs: [], activeTabId: null, sidebarCollapsed: true })!.sidebarCollapsed).toBe(true)
  })

  it("assumes an expanded sidebar if the layout predates it", () => {
    expect(normalizeLayout({ openTabs: [], activeTabId: null })!.sidebarCollapsed).toBe(false)
    // Anything that is not true counts as expanded, not as truthy.
    expect(normalizeLayout({ openTabs: [], activeTabId: null, sidebarCollapsed: "si" })!.sidebarCollapsed).toBe(false)
  })

  it("drops marks with an invalid time", () => {
    // A mark at NaN would draw the flag at an impossible pixel and break jumping
    // between marks.
    const layout = normalizeLayout({
      openTabs: [], activeTabId: null,
      markers: [
        { id: "ok", timeUs: 100, label: "buena", color: "#f00" },
        { id: "nan", timeUs: NaN, label: "rota", color: "#f00" },
        { id: "sin-tiempo", label: "rota", color: "#f00" },
        { timeUs: 50, label: "sin id" },
        null,
      ],
    })
    expect(layout!.markers.map(m => m.id)).toEqual(["ok"])
  })

  it("sorts and completes the marks when restoring them", () => {
    const layout = normalizeLayout({
      openTabs: [], activeTabId: null,
      markers: [
        { id: "b", timeUs: 200.6 },
        { id: "a", timeUs: 100, label: "" },
      ],
    })
    expect(layout!.markers.map(m => m.id)).toEqual(["a", "b"])
    expect(layout!.markers[0].label).toBe("Marker")
    expect(layout!.markers[1].timeUs).toBe(201)
  })

  it("fills in the SysId config of an old layout", () => {
    const sysid = normalizeLayout({ openTabs: [], activeTabId: null })!.sysid
    expect(sysid.mechanism).toBe("simple")
    expect(sysid.voltageTopic).toBeNull()
    // The four ranges have to exist even if empty: the page walks them by name
    // and an undefined would blow up reading .startUs.
    expect(Object.keys(sysid.ranges)).toHaveLength(4)
  })

  it("drops SysId ranges with invalid times", () => {
    const sysid = normalizeLayout({
      openTabs: [], activeTabId: null,
      sysid: {
        mechanism: "arm",
        voltageTopic: "/Volts",
        ranges: {
          "dynamic-forward": { startUs: 100, endUs: NaN },
          "quasistatic-forward": { startUs: 5, endUs: 10 },
        },
      },
    })!.sysid

    expect(sysid.mechanism).toBe("arm")
    expect(sysid.voltageTopic).toBe("/Volts")
    expect(sysid.ranges["dynamic-forward"].endUs).toBeNull()
    expect(sysid.ranges["quasistatic-forward"]).toEqual({ startUs: 5, endUs: 10 })
  })

  it("falls back to 'simple' if the saved mechanism does not exist", () => {
    const sysid = normalizeLayout({ openTabs: [], activeTabId: null, sysid: { mechanism: "cohete" } })!.sysid
    expect(sysid.mechanism).toBe("simple")
  })

  it("accepts a layout without marks", () => {
    expect(normalizeLayout({ openTabs: [], activeTabId: null })!.markers).toEqual([])
  })

  it("uses the kind as the title if the saved one was not text", () => {
    const layout = normalizeLayout({ openTabs: [tab({ title: 123 })], activeTabId: null })
    expect(layout!.openTabs[0].title).toBe("display")
  })
})
