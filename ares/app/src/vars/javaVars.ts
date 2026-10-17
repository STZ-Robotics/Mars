import type { Dim, Value } from "./expr"
import type { Variable } from "./variables"

// The project's variables as Java constants (Choreo's ChoreoVars): numbers
// with a dimension as WPILib units, plain numbers as doubles, poses as
// Pose2d, each at the value its formula gives now.

const UNITS: Record<Dim, [type: string, unit: string] | null> = {
  length: ["Distance", "Meters"], angle: ["Angle", "Degrees"], mass: ["Mass", "Kilograms"], time: ["Time", "Seconds"],
  speed: ["LinearVelocity", "MetersPerSecond"], accel: ["LinearAcceleration", "MetersPerSecondPerSecond"],
  angular: ["AngularVelocity", "DegreesPerSecond"], current: ["Current", "Amps"], plain: null,
}

const KEYWORDS = new Set(("abstract assert boolean break byte case catch char class const continue default do double else enum extends final " +
  "finally float for goto if implements import instanceof int interface long native new package private protected public return short " +
  "static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield").split(" "))

/** A variable's name as a Java identifier (a keyword gets a trailing _). */
export function javaName(name: string): string {
  return KEYWORDS.has(name) ? `${name}_` : name
}

function literal(v: number): string {
  if (!Number.isFinite(v)) return "Double.NaN"
  const s = String(v)
  return /[.eE]/.test(s) ? s : `${s}.0`
}

export function varsJava(pkg: string, className: string, vars: Variable[], scope: ReadonlyMap<string, Value>, source: string): string {
  const numbers: string[] = [], poses: string[] = [], types = new Set<string>(), skipped: string[] = []
  for (const v of vars) {
    const value = scope.get(v.name)
    if (value === undefined) { skipped.push(v.name); continue }
    if (v.kind === "pose" && typeof value === "object") {
      poses.push(`    public static final Pose2d ${javaName(v.name)} = new Pose2d(${literal(value.x)}, ${literal(value.y)}, Rotation2d.fromDegrees(${literal(value.heading)}));`)
    } else if (v.kind === "number" && typeof value === "number") {
      const u = UNITS[v.dim]
      if (u) {
        types.add(u[0])
        numbers.push(`  public static final ${u[0]} ${javaName(v.name)} = ${u[1]}.of(${literal(value)});`)
      } else {
        numbers.push(`  public static final double ${javaName(v.name)} = ${literal(value)};`)
      }
    }
  }
  const imports = [
    ...(poses.length ? ["import edu.wpi.first.math.geometry.Pose2d;", "import edu.wpi.first.math.geometry.Rotation2d;"] : []),
    ...[...types].sort().map(t => `import edu.wpi.first.units.measure.${t};`),
  ]
  const out = [
    `package ${pkg};`,
    "",
    ...(types.size ? ["import static edu.wpi.first.units.Units.*;", ""] : []),
    ...imports,
    ...(imports.length ? [""] : []),
    "/**",
    ` * The Ares project's variables (${source}), at their values when Ares wrote`,
    " * this. Written by Ares every time they change: do not edit it, change them",
    " * in Ares's Variables tab.",
    " */",
    `public final class ${className} {`,
    `  private ${className}() {}`,
  ]
  if (numbers.length) out.push("", ...numbers)
  if (poses.length) out.push("", "  public static final class Poses {", "    private Poses() {}", "", ...poses, "  }")
  if (skipped.length) out.push("", `  // Left out, their formulas have no value now: ${skipped.join(", ")}.`)
  out.push("}", "")
  return out.join("\n")
}
