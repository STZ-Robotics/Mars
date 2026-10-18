// Registry of verified features.
//
// The list is `supported-packages.json`, at the root of this repo. The `pages`
// workflow publishes it with the rest of the site and the app downloads it at
// run time: adding a feature to the catalog takes a commit to `main`, not a new
// MARS Desktop release.
//
// Offline (the pit) it uses the last list downloaded successfully, and if none
// ever was, the one bundled with the app -- which is why vite still needs
// `server.fs.allow` to see it in dev. The catalog is never empty for lack of
// internet.
//
// Only each feature's `MarsFeature.json` URL is kept here; those are downloaded
// separately, so the versions are always upstream's.
import bundled from "../../../../supported-packages.json"

/** Where the `pages` workflow publishes the list. */
export const REGISTRY_URL = "https://stz-robotics.github.io/Mars/supported-packages.json"

/**
 * Format versions this app can read. A remote list with another version is
 * for a newer app: it is ignored and the saved or bundled one is used.
 */
const KNOWN_REGISTRY_VERSIONS = ["1.0"]

const CACHE_KEY = "mars.supportedPackages"

interface Registry {
  registryVersion: string
  lastUpdated: string
  verifiedFeatures: string[]
}

/** Where the list came from: the network, the last one saved, or the bundled one. */
export type RegistrySource = "live" | "cache" | "bundled"

export interface LoadedRegistry {
  /** URLs of the verified `MarsFeature.json` files, in the file's order. */
  urls: string[]
  source: RegistrySource
  /** Date (YYYY-MM-DD) of the last edit of the list in use. */
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

/** The list of verified features: the published one, the saved one, or the bundled one. */
export async function loadRegistry(): Promise<LoadedRegistry> {
  try {
    const res = await fetch(REGISTRY_URL, { cache: "no-store" })
    if (res.ok) {
      const reg = parse(await res.json())
      if (reg) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(reg)) } catch { /* no storage: nothing lost */ }
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
  } catch { /* broken save or no storage: use the bundled one */ }

  return loaded(parse(bundled)!, "bundled")
}
