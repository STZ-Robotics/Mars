import { describe, it, expect } from "vitest"
import {
  preferenceKeyOf, preferenceKind, collectPreferences, preferenceTopicName,
  parsePreferenceValue, formatPreferenceValue, defaultValueFor,
  javaInit, javaGet, javaRemove, javaVariableName, javaInitBlock, javaGetBlock,
} from "./preferences"
import { TopicAnnounce } from "../../store/appStore"

function topicMap(entries: [string, string][]): Map<string, TopicAnnounce> {
  const map = new Map<string, TopicAnnounce>()
  entries.forEach(([name, type], i) => map.set(name, { id: i, name, topic_type: type }))
  return map
}

describe("claves", () => {
  it("trims the table's prefix", () => {
    expect(preferenceKeyOf("/Preferences/kP")).toBe("kP")
    expect(preferenceKeyOf("/Preferences/Arm/offset")).toBe("Arm/offset")
  })

  it("ignores what does not hang from /Preferences", () => {
    expect(preferenceKeyOf("/SmartDashboard/kP")).toBeNull()
    expect(preferenceKeyOf("/Preferences")).toBeNull()
  })

  it("drops the .type WPILib marks the table with", () => {
    expect(preferenceKeyOf("/Preferences/.type")).toBeNull()
  })

  it("preferenceTopicName is the way back", () => {
    expect(preferenceTopicName("Arm/kP")).toBe("/Preferences/Arm/kP")
    expect(preferenceKeyOf(preferenceTopicName("kP"))).toBe("kP")
  })
})

describe("tipos", () => {
  it("maps the types Preferences can store", () => {
    expect(preferenceKind("double")).toBe("double")
    expect(preferenceKind("int")).toBe("int")
    expect(preferenceKind("float")).toBe("float")
    expect(preferenceKind("boolean")).toBe("boolean")
    expect(preferenceKind("string")).toBe("string")
  })

  it("rejects what Preferences cannot store", () => {
    expect(preferenceKind("double[]")).toBeNull()
    expect(preferenceKind("struct:Pose2d")).toBeNull()
  })
})

describe("collectPreferences", () => {
  it("gathers only the preferences and sorts them by key", () => {
    const rows = collectPreferences(topicMap([
      ["/Preferences/zLast", "double"],
      ["/Preferences/aFirst", "boolean"],
      ["/Preferences/.type", "string"],
      ["/SmartDashboard/other", "double"],
      ["/Preferences/weird", "double[]"],
    ]))

    expect(rows.map(r => r.key)).toEqual(["aFirst", "zLast"])
    expect(rows[0].kind).toBe("boolean")
  })

  it("an empty table breaks nothing", () => {
    expect(collectPreferences(new Map())).toEqual([])
  })
})

describe("values", () => {
  it("parses numbers and respects integers", () => {
    expect(parsePreferenceValue("double", "0.3")).toBe(0.3)
    expect(parsePreferenceValue("int", "2.7")).toBe(3)
  })

  it("a half-typed number returns null instead of NaN", () => {
    expect(parsePreferenceValue("double", "")).toBeNull()
    expect(parsePreferenceValue("double", "abc")).toBeNull()
  })

  it("accepts both spellings of a boolean", () => {
    expect(parsePreferenceValue("boolean", "true")).toBe(true)
    expect(parsePreferenceValue("boolean", "1")).toBe(true)
    expect(parsePreferenceValue("boolean", "FALSE")).toBe(false)
    expect(parsePreferenceValue("boolean", "maybe")).toBeNull()
  })

  it("an empty string is a valid string", () => {
    expect(parsePreferenceValue("string", "")).toBe("")
  })

  it("formats for the edit box", () => {
    expect(formatPreferenceValue(true)).toBe("true")
    expect(formatPreferenceValue(0.3)).toBe("0.3")
    expect(formatPreferenceValue(undefined)).toBe("")
  })

  it("every type has a sensible initial value", () => {
    expect(defaultValueFor("boolean")).toBe(false)
    expect(defaultValueFor("string")).toBe("")
    expect(defaultValueFor("double")).toBe(0)
  })
})

describe("Java", () => {
  it("declares with the type's init", () => {
    expect(javaInit("kP", "double", 0.3)).toBe('Preferences.initDouble("kP", 0.3);')
    expect(javaInit("useVision", "boolean", true)).toBe('Preferences.initBoolean("useVision", true);')
    expect(javaInit("mode", "string", "auto")).toBe('Preferences.initString("mode", "auto");')
    expect(javaInit("slot", "int", 2)).toBe('Preferences.initInt("slot", 2);')
  })

  it("a float carries its suffix and a double its dot", () => {
    expect(javaInit("k", "float", 1)).toBe('Preferences.initFloat("k", 1.0f);')
    expect(javaInit("k", "double", 1)).toBe('Preferences.initDouble("k", 1.0);')
  })

  it("escapes quotes in the key and in the value", () => {
    expect(javaInit('we"ird', "string", 'a"b')).toBe('Preferences.initString("we\\"ird", "a\\"b");')
  })

  it("the read uses the current value as the fallback", () => {
    expect(javaGet("kP", "double", 0.3)).toBe('double kP = Preferences.getDouble("kP", 0.3);')
  })

  it("a key with slashes gives a usable variable name", () => {
    expect(javaVariableName("Arm/kP")).toBe("armKP")
    expect(javaVariableName("2ndStage")).toBe("v2ndStage")
    expect(javaGet("Arm/offset", "double", 1)).toContain("double armOffset =")
  })

  it("allows forcing the variable's name", () => {
    expect(javaGet("kP", "double", 0.3, "armKp")).toContain("double armKp =")
  })

  it("remove is the line that really deletes", () => {
    expect(javaRemove("kP")).toBe('Preferences.remove("kP");')
  })

  it("the blocks carry the import only once", () => {
    const rows = [
      { key: "kP", kind: "double" as const, value: 0.3 },
      { key: "useVision", kind: "boolean" as const, value: true },
    ]
    const init = javaInitBlock(rows)
    expect(init.match(/import /g)).toHaveLength(1)
    expect(init).toContain("import edu.wpi.first.wpilibj.Preferences;")
    expect(init).toContain("initDouble")
    expect(init).toContain("initBoolean")

    expect(javaGetBlock(rows)).toContain("getDouble")
    expect(javaInitBlock([])).toBe("")
  })
})
