// Dependency catalog for the feature wizard.
//
// Two sources, in order of trust:
//
// 1. The open project's vendordeps (`vendordeps/*.json`). They carry the EXACT
//    version the robot already uses, so the feature compiles against the same
//    thing as the project that will install it. It is the good option.
// 2. The static catalog below, for when there is no open project. The versions
//    are a starting point for the 2026 season and have to be confirmed against
//    the real vendordep — that is why they are editable in the UI.

/** What travels to the backend and ends up in build.gradle. */
export interface FeatureDependency {
  id: string
  label: string
  mavenUrls: string[]
  /** Coordenadas gradle completas: "grupo:artefacto:version". */
  artifacts: string[]
}

export interface CatalogEntry {
  id: string
  label: string
  hint: string
  mavenUrls: string[]
  /** Coordinates with `{version}` as a placeholder. */
  artifacts: string[]
  defaultVersion: string
}

export const VENDOR_CATALOG: CatalogEntry[] = [
  {
    id: "phoenix6",
    label: "CTRE Phoenix 6",
    hint: "TalonFX, CANcoder, Pigeon 2, CTRE swerve",
    mavenUrls: ["https://maven.ctr-electronics.com/release/"],
    artifacts: ["com.ctre.phoenix6:wpiapi-java:{version}"],
    defaultVersion: "26.1.1",
  },
  {
    id: "pathplanner",
    label: "PathPlannerLib",
    hint: "PathPlanner trajectories and autos",
    mavenUrls: ["https://3015rangerrobotics.github.io/pathplannerlib/repo"],
    artifacts: ["com.pathplanner.lib:PathplannerLib-java:{version}"],
    defaultVersion: "2026.1.2",
  },
  {
    id: "revlib",
    label: "REVLib",
    hint: "SPARK MAX / SPARK Flex",
    mavenUrls: ["https://maven.revrobotics.com/"],
    artifacts: ["com.revrobotics.frc:REVLib-java:{version}"],
    defaultVersion: "2026.0.0",
  },
  {
    id: "studica",
    label: "Studica (navX)",
    hint: "navX2, Titan, Cobra",
    mavenUrls: ["https://dev.studica.com/maven/release/2026/"],
    artifacts: ["com.studica.frc:Studica-java:{version}"],
    defaultVersion: "2026.0.0",
  },
  {
    id: "photonvision",
    label: "PhotonLib",
    hint: "PhotonVision vision",
    mavenUrls: ["https://maven.photonvision.org/repository/internal"],
    artifacts: [
      "org.photonvision:photonlib-java:{version}",
      "org.photonvision:photontargeting-java:{version}",
    ],
    defaultVersion: "v2026.1.1",
  },
  {
    id: "choreo",
    label: "ChoreoLib",
    hint: "Choreo optimized trajectories",
    mavenUrls: ["https://SleipnirGroup.github.io/ChoreoLib/dep"],
    artifacts: ["choreo:ChoreoLib-java:{version}"],
    defaultVersion: "2026.0.0",
  },
  {
    id: "advantagekit",
    label: "AdvantageKit",
    hint: "Littleton logging and replay",
    mavenUrls: ["https://frcmaven.wpi.edu/artifactory/littletonrobotics-mvn-release"],
    artifacts: ["org.littletonrobotics.akit:akit-java:{version}"],
    defaultVersion: "2026.1.0",
  },
  {
    id: "reduxlib",
    label: "ReduxLib",
    hint: "Canandmag, Canandcolor, Canandgyro",
    mavenUrls: ["https://maven.reduxrobotics.com/"],
    artifacts: ["com.reduxrobotics.frc:ReduxLib-java:{version}"],
    defaultVersion: "2026.0.0",
  },
]

export function catalogToDependency(entry: CatalogEntry, version: string): FeatureDependency {
  return {
    id: entry.id,
    label: entry.label,
    mavenUrls: entry.mavenUrls,
    artifacts: entry.artifacts.map(a => a.replace("{version}", version.trim())),
  }
}

// --- Vendordeps del proyecto ------------------------------------------------

/** The shape of WPILib's vendordep JSON. */
export interface Vendordep {
  name?: string
  fileName?: string
  version?: string
  frcYear?: string
  mavenUrls?: string[]
  javaDependencies?: { groupId: string; artifactId: string; version: string }[]
}

// What the template already declares on its own: all of WPILib via
// `wpi.java.deps.wpilib()` + wpilibNewCommands, and Mars/ForgeMini via
// marsCoreRequired/forgeMiniRequired. Adding them again from a vendordep would
// only duplicate lines — and in Mars' case it would overwrite the version range
// with a fixed one.
const TEMPLATE_PROVIDED_PREFIXES = ["edu.wpi.first.", "com.stzteam.mars", "com.stzteam.forgemini"]

export function isProvidedByTemplate(dep: Vendordep): boolean {
  const java = dep.javaDependencies ?? []
  return java.length > 0 && java.every(d => TEMPLATE_PROVIDED_PREFIXES.some(p => d.groupId.startsWith(p)))
}

export function vendordepToDependency(dep: Vendordep): FeatureDependency {
  const label = dep.name || dep.fileName?.replace(/\.json$/i, "") || "Vendordep"
  return {
    id: `vendordep:${dep.fileName || label}`,
    label,
    mavenUrls: (dep.mavenUrls ?? []).filter(u => u.trim() !== ""),
    // The literal version "wpilib" is WPILib's convention for "the active
    // GradleRIO's"; the backend translates it into gradle interpolation.
    artifacts: (dep.javaDependencies ?? []).map(d => `${d.groupId}:${d.artifactId}:${d.version}`),
  }
}

// --- Derivaciones del wizard ------------------------------------------------

/** `MyFeature` + `Imcab` -> `com.imcab.myfeature`. */
export function deriveGroupId(githubUser: string, featureId: string): string {
  const user = githubUser.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "myteam"
  const feature = featureId.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "myfeature"
  return `com.${user}.${feature}`
}

export interface FeatureUrls {
  pages: string
  install: string
  maven: string
}

/** GitHub Pages lowercases the user but respects the repo's name. */
export function deriveUrls(githubUser: string, githubRepo: string): FeatureUrls | null {
  const user = githubUser.trim()
  const repo = githubRepo.trim()
  if (!user || !repo) return null
  const pages = `https://${user.toLowerCase()}.github.io/${repo}`
  return { pages, install: `${pages}/MarsFeature.json`, maven: `${pages}/maven/` }
}

const JAVA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidFeatureId(id: string): boolean {
  return JAVA_IDENTIFIER.test(id.trim())
}

export function isValidGroupId(groupId: string): boolean {
  const trimmed = groupId.trim()
  return trimmed !== "" && trimmed.split(".").every(seg => JAVA_IDENTIFIER.test(seg))
}
