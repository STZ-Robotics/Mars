import { invoke } from "@tauri-apps/api/core"
import { CODE_KEY } from "../autos/robotNames"
import { varsJava } from "./javaVars"
import { evaluateAll, Variable } from "./variables"

/** project.json: what the team shares about the project. */
export interface ProjectSettings { varsJava: { enabled: boolean; file: string } }

/** The Java package of a file under src/main/java. */
export function packageOf(file: string): string | null {
  const m = file.replace(/\\/g, "/").match(/^src\/main\/java\/(.+)\/[^/]+\.java$/)
  return m ? m[1].replace(/\//g, ".") : null
}

/**
 * Writes the variables' Java class where the project says, when it says to.
 * Returns where it wrote it (null: turned off).
 */
export async function writeVarsJava(robotPath: string, variables: Variable[], force = false): Promise<string | null> {
  const s = await invoke<ProjectSettings>("project_settings_open", { robotPath }).catch(() => null)
  const file = s?.varsJava.file
  if (!file || (!s.varsJava.enabled && !force)) return null
  const pkg = packageOf(file)
  if (!pkg) throw new Error(`"${file}" is not under src/main/java`)
  const cls = file.replace(/^.*\//, "").replace(/\.java$/, "")
  const code = varsJava(pkg, cls, variables, evaluateAll(variables).scope, "src/main/deploy/ares/variables.json")
  let folder: string | null = null
  try { folder = localStorage.getItem(CODE_KEY(robotPath)) } catch { /* none */ }
  return invoke<string>("vars_java_write", { robotPath, folder, file, code })
}
