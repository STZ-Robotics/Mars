import { useState, useEffect, useMemo, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import PageHeader from "../components/layout/PageHeader"
import PanelHeader from "../components/layout/PanelHeader"
import EmptyState from "../components/common/EmptyState"
import AlertBanner from "../components/common/AlertBanner"
import Panel from "../components/common/Panel"
import PropertyRow from "../components/common/PropertyRow"
import { propertyInputStyle } from "../styles/pageForm"
import { SUPPORTED_FEATURE_URLS } from "../utils/mars/supportedPackages"

interface Props {
  projectName: string | null
  projectPath: string | null
}

interface MarsFeature {
  featureId: string
  name: string
  description?: string
  version: string
  author?: string
}

type CombinedFeature = MarsFeature & { isInstalled: boolean; installedVersion?: string }

export default function PackagePage({ projectName, projectPath }: Props) {
  const [catalogData, setCatalogData] = useState<MarsFeature[]>([])
  const [installedData, setInstalledData] = useState<MarsFeature[]>([])
  const [loading, setLoading] = useState(true)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [lastSynced, setLastSynced] = useState<Date | null>(null)

  const [isInstalling, setIsInstalling] = useState(false)
  const [installStatus, setInstallStatus] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState("")
  const [directUrl, setDirectUrl] = useState("")

  const loadPackages = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    setRegistryError(null)

    try {
      const localPackages: MarsFeature[] = await invoke("get_installed_packages", { projectPath })
      setInstalledData(localPackages)
    } catch (e) {
      console.error("Error reading local packages:", e)
    }

    // The list of verified features travels with the app
    // (`supported-packages.json`); only the descriptors are downloaded from the
    // network, so the versions are always upstream's.
    const fetchedFeatures: MarsFeature[] = []
    const failedUrls: string[] = []
    for (const url of SUPPORTED_FEATURE_URLS) {
      try {
        const featRes = await fetch(url)
        if (featRes.ok) fetchedFeatures.push(await featRes.json())
        else failedUrls.push(url)
      } catch (e) {
        console.error(`Error fetching feature descriptor ${url}:`, e)
        failedUrls.push(url)
      }
    }

    setCatalogData(fetchedFeatures)
    if (failedUrls.length > 0) {
      setRegistryError(
        failedUrls.length === SUPPORTED_FEATURE_URLS.length
          ? "Could not reach any of the supported packages. Showing locally installed packages only."
          : `${failedUrls.length} of ${SUPPORTED_FEATURE_URLS.length} supported packages failed to load.`,
      )
    }
    setLastSynced(new Date())
    setLoading(false)
  }, [projectPath])

  useEffect(() => { loadPackages() }, [loadPackages])

  const handleInstall = async (featureJsonData: string | object) => {
    if (!projectPath) return
    setIsInstalling(true)
    setInstallStatus("Downloading and compiling Gradle... This may take a moment.")

    try {
      const jsonStr = typeof featureJsonData === "string" ? featureJsonData : JSON.stringify(featureJsonData)
      const result = await invoke<string>("install_package_from_json", { projectPath, featureData: jsonStr })
      setInstallStatus(`SUCCESS: ${result}`)
      setDirectUrl("")
      await loadPackages()
    } catch (err) {
      setInstallStatus(`ERROR: ${err}`)
    } finally {
      setIsInstalling(false)
      setTimeout(() => setInstallStatus(null), 5000)
    }
  }

  const handleDirectInstall = async () => {
    if (!directUrl.trim()) return
    setIsInstalling(true)
    setInstallStatus("Fetching JSON from URL...")
    try {
      const res = await fetch(directUrl)
      if (!res.ok) throw new Error("Invalid URL or network error")
      const json = await res.json()
      await handleInstall(json)
    } catch (err) {
      setInstallStatus("ERROR: Could not fetch feature from URL")
      setIsInstalling(false)
    }
  }

  // Combination: local + verified catalog, without duplicates
  const combined = useMemo(() => {
    const map = new Map<string, CombinedFeature>()
    catalogData.forEach(p => map.set(p.featureId, { ...p, isInstalled: false }))
    installedData.forEach(p => {
      if (map.has(p.featureId)) {
        const existing = map.get(p.featureId)!
        existing.isInstalled = true
        existing.installedVersion = p.version
      } else {
        map.set(p.featureId, { ...p, isInstalled: true, installedVersion: p.version })
      }
    })
    return Array.from(map.values())
  }, [catalogData, installedData])

  const filtered = useMemo(() => {
    if (searchQuery.trim() === "") return combined
    const q = searchQuery.toLowerCase()
    return combined.filter(p => p.name.toLowerCase().includes(q) || p.featureId.toLowerCase().includes(q))
  }, [combined, searchQuery])

  const installedList = filtered.filter(p => p.isInstalled)
  const availableList = filtered.filter(p => !p.isInstalled)

  if (!projectName) {
    return <PageShell><p style={{ color: "var(--text-muted)", fontSize: 13 }}>No active project selected.</p></PageShell>
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-page)", overflow: "hidden" }}>

      {/* SIDEBAR */}
      <div style={{ width: 300, background: "var(--bg-panel)", borderRight: "1px solid var(--border-main)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <PageHeader
          eyebrow="Package Manager"
          title="MARS Packages"
          subtitle={
            <>
              Project: <span style={{ color: "var(--mars-accent)", fontWeight: 600 }}>{projectName.toUpperCase()}</span><br />
              Dependency registry
            </>
          }
        />

        <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 24, overflowY: "auto" }}>

          <Panel title="Registry" icon="ti-package">
            <div>
              <PropertyRow label="Search packages">
                <input
                  type="text"
                  placeholder="e.g. Limelight..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={propertyInputStyle}
                />
              </PropertyRow>
              <PropertyRow label="Installed"><span style={{ color: "var(--status-success)" }}>{installedData.length}</span></PropertyRow>
              <PropertyRow label="Available"><span>{catalogData.length}</span></PropertyRow>
              <PropertyRow label="Last synced"><span>{lastSynced ? lastSynced.toLocaleTimeString() : "—"}</span></PropertyRow>
            </div>
            <div style={{ padding: 8 }}>
              <button
                onClick={loadPackages}
                disabled={loading}
                style={{
                  width: "100%", padding: "7px 0", background: "var(--bg-input)",
                  border: "1px solid var(--border-main)", borderRadius: 3, color: "var(--text-primary)",
                  fontSize: 11, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6
                }}
              >
                <i className={`ti ti-refresh ${loading ? "mars-spin" : ""}`} />
                REFRESH REGISTRY
              </button>
            </div>
          </Panel>

          <Panel title="Manual Install" icon="ti-download">
            <div>
              <PropertyRow label="Feature URL">
                <input
                  type="text"
                  placeholder="Paste JSON Feature URL..."
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  style={propertyInputStyle}
                  disabled={isInstalling}
                />
              </PropertyRow>
            </div>
            <div style={{ padding: 8 }}>
              <button
                onClick={handleDirectInstall}
                disabled={isInstalling || !directUrl.trim()}
                style={{
                  padding: "8px 12px", background: isInstalling || !directUrl.trim() ? "var(--bg-input)" : "var(--status-success)",
                  color: isInstalling || !directUrl.trim() ? "var(--text-muted)" : "#fff",
                  border: isInstalling || !directUrl.trim() ? "1px solid var(--border-main)" : "1px solid rgba(0,0,0,0.2)",
                  borderRadius: 3, fontSize: 11, fontWeight: 700, cursor: isInstalling || !directUrl.trim() ? "not-allowed" : "pointer"
                }}
              >
                <i className="ti ti-download" style={{ marginRight: 6 }} />
                INSTALL FROM URL
              </button>
            </div>
          </Panel>

        </div>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <PanelHeader
          title="Verified Packages"
          meta={`${installedList.length} installed · ${availableList.length} available`}
          action={isInstalling && (
            <div style={{ fontSize: 11, color: "var(--status-sim)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <i className="ti ti-loader mars-spin" />
              BUILDING GRADLE...
            </div>
          )}
        />

        <div style={{ flex: 1, padding: "24px 24px 40px", overflowY: "auto" }}>
          <div style={{ width: "100%", maxWidth: 950, margin: "0 auto" }}>

            {installStatus && (
              <div style={{ marginBottom: 20 }}>
                <AlertBanner icon="" variant={installStatus.includes("ERROR") ? "error" : "neutral"}>
                  {installStatus}
                </AlertBanner>
              </div>
            )}

            {registryError && (
              <div style={{ marginBottom: 20 }}>
                <AlertBanner variant="error">{registryError}</AlertBanner>
              </div>
            )}

            {loading && combined.length === 0 ? (
              <EmptyState dashed={false} padding="60px" message="Connecting to MARS Registry..." />
            ) : (
              <>
                <PackageSection
                  title="INSTALLED"
                  count={installedList.length}
                  emptyText="No packages installed in this project yet."
                  packages={installedList}
                  isInstalling={isInstalling}
                  onInstall={handleInstall}
                />
                <PackageSection
                  title="AVAILABLE"
                  count={availableList.length}
                  emptyText={searchQuery ? "No packages match your search." : "No verified packages available."}
                  packages={availableList}
                  isInstalling={isInstalling}
                  onInstall={handleInstall}
                />
              </>
            )}

          </div>
        </div>
      </div>

      {/* A local keyframe for the refresh/loading icon, without depending on global CSS */}
      <style>{`
        @keyframes mars-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .mars-spin { display: inline-block; animation: mars-spin 1s linear infinite; }
      `}</style>
    </div>
  )
}

function PackageSection({ title, count, emptyText, packages, isInstalling, onInstall }: {
  title: string
  count: number
  emptyText: string
  packages: CombinedFeature[]
  isInstalling: boolean
  onInstall: (pkg: CombinedFeature) => void
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: 1 }}>{title}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--bg-input)", border: "1px solid var(--border-main)", padding: "1px 6px", borderRadius: 3 }}>{count}</span>
        <div style={{ flex: 1, height: 1, background: "var(--border-light)" }} />
      </div>

      {packages.length === 0 ? (
        <EmptyState padding="28px 20px" message={emptyText} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {packages.map(pkg => (
            <div key={pkg.featureId} style={{
              background: "var(--bg-panel)", border: "1px solid var(--border-main)",
              borderTop: `3px solid ${pkg.isInstalled ? "var(--status-success)" : "var(--mars-accent)"}`,
              borderRadius: 4, display: "flex", flexDirection: "column", overflow: "hidden"
            }}>
              <div style={{ padding: "16px", flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{pkg.name}</div>
                  <div style={{ fontSize: 10, fontFamily: "monospace", color: "var(--text-muted)", background: "var(--bg-page)", padding: "2px 6px", borderRadius: 3 }}>
                    v{pkg.version}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 12 }}>
                  {pkg.description || "No description provided."}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  By: {pkg.author || "Unknown"}
                </div>
              </div>

              <div style={{ background: "var(--bg-input)", padding: "12px 16px", borderTop: "1px solid var(--border-light)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace" }}>{pkg.featureId}</div>

                {pkg.isInstalled ? (
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--status-success)", display: "flex", alignItems: "center", gap: 4 }}>
                    <i className="ti ti-check" />
                    INSTALLED {pkg.installedVersion && `(v${pkg.installedVersion})`}
                  </div>
                ) : (
                  <button
                    onClick={() => onInstall(pkg)}
                    disabled={isInstalling}
                    style={{
                      padding: "6px 14px", background: "var(--mars-accent)", border: "none",
                      color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 3, cursor: isInstalling ? "not-allowed" : "pointer"
                    }}
                  >
                    INSTALL
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PageShell({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", background: "var(--bg-page)" }}>{children}</div>
}

