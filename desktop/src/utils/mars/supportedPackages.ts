// Registro de features verificadas.
//
// La lista es `supported-packages.json`, en la raíz de este repo. El workflow
// `pages` la publica junto al resto del sitio y la app la baja en tiempo de
// ejecución: para agregar una feature al catálogo basta un commit a `main`, sin
// sacar otra versión de MARS Desktop.
//
// Sin red (el pit) se usa la última lista que se bajó bien, y si nunca se bajó
// ninguna, la que viaja compilada dentro de la app -- por eso vite sigue
// necesitando `server.fs.allow` para verla en dev. El catálogo nunca queda
// vacío por no tener internet.
//
// De cada feature solo se guarda la URL de su `MarsFeature.json`; esos se bajan
// aparte, así que las versiones siempre son las de upstream.
import bundled from "../../../../supported-packages.json"

/** Dónde publica el workflow `pages` la lista. */
export const REGISTRY_URL = "https://stz-robotics.github.io/Mars/supported-packages.json"

/**
 * Versiones del formato que esta app sabe leer. Una lista remota con otra
 * versión es de una app más nueva: se ignora y se usa la guardada o la
 * compilada.
 */
const KNOWN_REGISTRY_VERSIONS = ["1.0"]

const CACHE_KEY = "mars.supportedPackages"

interface Registry {
  registryVersion: string
  lastUpdated: string
  verifiedFeatures: string[]
}

/** De dónde salió la lista: la red, la última guardada o la compilada. */
export type RegistrySource = "live" | "cache" | "bundled"

export interface LoadedRegistry {
  /** URLs de los `MarsFeature.json` verificados, en el orden del archivo. */
  urls: string[]
  source: RegistrySource
  /** Fecha (YYYY-MM-DD) de la última edición de la lista que se usó. */
  lastUpdated: string
}

function parse(data: unknown): Registry | null {
  const reg = data as Partial<Registry> | null
  if (!reg || typeof reg !== "object") return null
  if (!KNOWN_REGISTRY_VERSIONS.includes(String(reg.registryVersion))) return null
  if (!Array.isArray(reg.verifiedFeatures)) return null
  return {
    registryVersion: String(reg.registryVersion),
    lastUpdated: typeof reg.lastUpdated === "string" ? reg.lastUpdated : "",
    verifiedFeatures: reg.verifiedFeatures.filter(
      (url): url is string => typeof url === "string" && url.trim() !== "",
    ),
  }
}

function loaded(reg: Registry, source: RegistrySource): LoadedRegistry {
  return { urls: reg.verifiedFeatures, source, lastUpdated: reg.lastUpdated }
}

/** La lista de features verificadas: la publicada, la guardada o la compilada. */
export async function loadRegistry(): Promise<LoadedRegistry> {
  try {
    const res = await fetch(REGISTRY_URL, { cache: "no-store" })
    if (res.ok) {
      const reg = parse(await res.json())
      if (reg) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(reg)) } catch { /* sin storage: no pasa nada */ }
        return loaded(reg, "live")
      }
    }
  } catch (e) {
    console.warn(`Could not fetch the supported packages from ${REGISTRY_URL}:`, e)
  }

  try {
    const cached = localStorage.getItem(CACHE_KEY)
    const reg = cached ? parse(JSON.parse(cached)) : null
    if (reg) return loaded(reg, "cache")
  } catch { /* guardado roto o sin storage: a la compilada */ }

  return loaded(parse(bundled)!, "bundled")
}
