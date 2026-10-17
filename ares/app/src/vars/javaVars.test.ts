import { describe, expect, it } from "vitest"
import { evaluateAll, Variable } from "./variables"
import { javaName, varsJava } from "./javaVars"

describe("variables as Java constants", () => {
  it("writes numbers with their units, plain doubles and poses", () => {
    const vars: Variable[] = [
      { name: "intakeReach", kind: "number", dim: "length", value: "0.45" },
      { name: "shotSpeed", kind: "number", dim: "speed", value: "intakeReach * 10" },
      { name: "pieces", kind: "number", dim: "plain", value: "4" },
      { name: "speaker", kind: "pose", x: "0.9", y: "5.55", heading: "180" },
      { name: "broken", kind: "number", dim: "plain", value: "nope + 1" },
      { name: "class", kind: "number", dim: "plain", value: "2" },
    ]
    const { scope } = evaluateAll(vars)
    const java = varsJava("frc.robot.generated", "AresVars", vars, scope, "variables.json")
    expect(java).toContain("package frc.robot.generated;")
    expect(java).toContain("import static edu.wpi.first.units.Units.*;")
    expect(java).toContain("import edu.wpi.first.units.measure.Distance;")
    expect(java).toContain("public static final Distance intakeReach = Meters.of(0.45);")
    expect(java).toContain("public static final LinearVelocity shotSpeed = MetersPerSecond.of(4.5);")
    expect(java).toContain("public static final double pieces = 4.0;")
    expect(java).toContain("public static final Pose2d speaker = new Pose2d(0.9, 5.55, Rotation2d.fromDegrees(180.0));")
    expect(java).toContain("public static final double class_ = 2.0;")
    expect(java).toContain("Left out, their formulas have no value now: broken.")
    expect(javaName("int")).toBe("int_")
  })
})
