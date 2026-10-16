import { useEffect, useMemo, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener"
import { useMarsSettings } from "../hooks/useMarsSettings"
import {
  VENDOR_CATALOG,
  CatalogEntry,
  FeatureDependency,
  Vendordep,
  catalogToDependency,
  vendordepToDependency,
  isProvidedByTemplate,
  deriveGroupId,
  deriveUrls,
  isValidFeatureId,
  isValidGroupId,
} from "../utils/mars/featureCatalog"

interface Props {
  projectPath: string | null
}

interface CreateFeatureResult {
  path: string
  installUrl: string
  mavenUrl: string
  docsUrl: string
  mainClass: string
  gitInitialized: boolean
  warnings: string[]
}

interface CustomDependency {
  id: string
  label: string
  mavenUrl: string
  coordinate: string
}

// The fields that autocomplete from others while the user does not touch them.
// Just like an installer: typing the feature's name already sets the java
// package, the repo and the folder, and whoever wants something else simply
// types over it.
type DerivedField = "name" | "groupId" | "githubRepo" | "folderName"

const STEPS = ["Identity", "Dependencies", "Publishing", "Review"]

export default function FeatureWizardPage({ projectPath }: Props) {
  const { settings, save: saveSettings, loading } = useMarsSettings()

  const [step, setStep] = useState(0)
  const [touched, setTouched] = useState<Set<DerivedField>>(new Set())

  const [featureId, setFeatureId] = useState("")
  const [name, setName] = useState("")
  const [version, setVersion] = useState("1.0.0")
  const [groupId, setGroupId] = useState("")
  const [author, setAuthor] = useState("")
  const [description, setDescription] = useState("")
  const [marsCoreRequired, setMarsCoreRequired] = useState(">=1.6.0")
  const [forgeMiniRequired, setForgeMiniRequired] = useState(">=1.1.0")
  const [githubUser, setGithubUser] = useState("")
  const [githubRepo, setGithubRepo] = useState("")
  const [folderName, setFolderName] = useState("")
  const [isProcessor, setIsProcessor] = useState(false)
  const [initGit, setInitGit] = useState(true)
  const [openEditor, setOpenEditor] = useState(true)

  const [vendordeps, setVendordeps] = useState<Vendordep[]>([])
  const [selectedVendordeps, setSelectedVendordeps] = useState<Set<string>>(new Set())
  const [selectedCatalog, setSelectedCatalog] = useState<Set<string>>(new Set())
  const [catalogVersions, setCatalogVersions] = useState<Record<string, string>>(
    () => Object.fromEntries(VENDOR_CATALOG.map(e => [e.id, e.defaultVersion]))
  )
  const [customDeps, setCustomDeps] = useState<CustomDependency[]>([])

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CreateFeatureResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // The identity is saved in MARS's config: the team's second feature comes out
  // prefilled without typing the author or the GitHub user again.
  useEffect(() => {
    if (loading) return
    setAuthor(a => a || settings.feature_author || "")
    setGithubUser(u => u || settings.github_user || "")
  }, [loading, settings.feature_author, settings.github_user])

  useEffect(() => {
    if (!projectPath) { setVendordeps([]); return }
    invoke<Vendordep[]>("read_project_vendordeps", { projectPath })
      .then(setVendordeps)
      .catch(() => setVendordeps([]))
  }, [projectPath])

  // --- Derivaciones -------------------------------------------------------
  const derivedName = featureId.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  const derivedGroupId = deriveGroupId(githubUser, featureId)
  const derivedRepo = featureId
  const derivedFolder = githubRepo.trim() || featureId

  const effective = {
    name: touched.has("name") ? name : derivedName,
    groupId: touched.has("groupId") ? groupId : derivedGroupId,
    githubRepo: touched.has("githubRepo") ? githubRepo : derivedRepo,
    folderName: touched.has("folderName") ? folderName : derivedFolder,
  }

  const touch = (field: DerivedField) => setTouched(t => new Set(t).add(field))

  const urls = deriveUrls(githubUser, effective.githubRepo)
  const targetPath = settings.workspace_path
    ? `${settings.workspace_path}\\${effective.folderName || "..."}`
    : ""

  // --- Dependencias -------------------------------------------------------
  const installableVendordeps = useMemo(
    () => vendordeps.filter(d => !isProvidedByTemplate(d)),
    [vendordeps]
  )
  const bundledVendordeps = useMemo(
    () => vendordeps.filter(isProvidedByTemplate),
    [vendordeps]
  )

  const dependencies: FeatureDependency[] = useMemo(() => {
    const out: FeatureDependency[] = []

    for (const dep of installableVendordeps) {
      const converted = vendordepToDependency(dep)
      if (selectedVendordeps.has(converted.id)) out.push(converted)
    }

    for (const entry of VENDOR_CATALOG) {
      if (!selectedCatalog.has(entry.id)) continue
      // If the same vendor already came in from the project, the real version wins.
      const alreadyFromProject = out.some(d =>
        d.artifacts.some(a =>
          entry.artifacts.some(c => a.startsWith(c.replace(":{version}", "")))
        )
      )
      if (!alreadyFromProject) out.push(catalogToDependency(entry, catalogVersions[entry.id] ?? entry.defaultVersion))
    }

    for (const custom of customDeps) {
      if (!custom.coordinate.trim()) continue
      out.push({
        id: custom.id,
        label: custom.label.trim() || custom.coordinate.trim(),
        mavenUrls: custom.mavenUrl.trim() ? [custom.mavenUrl.trim()] : [],
        artifacts: [custom.coordinate.trim()],
      })
    }

    return out
  }, [installableVendordeps, selectedVendordeps, selectedCatalog, catalogVersions, customDeps])

  // --- Validation ---------------------------------------------------------
  const featureIdError =
    featureId.trim() === ""
      ? "Required."
      : !isValidFeatureId(featureId)
      ? "Becomes a Java class and a Maven artifact: letters, digits and underscores only, starting with a letter."
      : null
  const groupIdError = !isValidGroupId(effective.groupId)
    ? "Must be a Java package, e.g. com.myteam.myfeature."
    : null
  const canCreate =
    !featureIdError && !groupIdError && version.trim() !== "" && !!settings.workspace_path && !busy

  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text).then(
      () => { setCopied(label); setTimeout(() => setCopied(null), 1600) },
      () => setErrorMsg("Could not reach the clipboard.")
    )
  }

  const handleCreate = async () => {
    setBusy(true)
    setErrorMsg(null)
    setResult(null)
    try {
      const created = await invoke<CreateFeatureResult>("create_mars_feature", {
        config: {
          featureId: featureId.trim(),
          name: effective.name.trim() || featureId.trim(),
          version: version.trim(),
          groupId: effective.groupId.trim(),
          author: author.trim(),
          description: description.trim(),
          marsCoreRequired: marsCoreRequired.trim(),
          forgeMiniRequired: forgeMiniRequired.trim(),
          githubUser: githubUser.trim(),
          githubRepo: effective.githubRepo.trim(),
          workspacePath: settings.workspace_path,
          folderName: effective.folderName.trim(),
          dependencies,
          isProcessor,
          initGit,
          openEditor,
        },
      })
      setResult(created)
      if (author.trim() !== settings.feature_author || githubUser.trim() !== settings.github_user) {
        await saveSettings({ ...settings, feature_author: author.trim(), github_user: githubUser.trim() })
      }
    } catch (e) {
      setErrorMsg(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", background: "var(--bg-page)", padding: 24 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: 0.5, textTransform: "uppercase" }}>Workspace Setup</div>
        <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)" }}>Create Feature</div>
        <div style={{ fontSize: 11, color: "var(--text-light)", marginTop: 2 }}>
          Set up a feature repository wired to your team, your dependencies and your GitHub Pages
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {STEPS.map((label, i) => (
          <button
            key={label}
            onClick={() => setStep(i)}
            style={{
              flex: 1, padding: "8px 12px", borderRadius: 6,
              border: `1px solid ${i === step ? "var(--mars-accent)" : "var(--border-main)"}`,
              background: i === step ? "var(--mars-accent)" : "var(--bg-panel)",
              color: i === step ? "#fff" : "var(--text-secondary)",
              fontSize: 12, cursor: "pointer",
            }}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>

      {step === 0 && (
        <Section title="Feature identity">
          <Field label="Feature ID (Java class + Maven artifact)" error={featureIdError}>
            <input
              style={inputStyle}
              value={featureId}
              onChange={e => setFeatureId(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))}
              placeholder="MARSPoseFinderCTRESwerve"
            />
          </Field>

          <Field label="Display name">
            <input
              style={inputStyle}
              value={effective.name}
              onChange={e => { touch("name"); setName(e.target.value) }}
              placeholder="PoseFinder CTRE Swerve"
            />
          </Field>

          <Field label="Description" hint="Shown on the card in the MARS package manager.">
            <textarea
              style={{ ...inputStyle, minHeight: 60, resize: "vertical", fontFamily: "inherit" }}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="A PoseFinder using pathplanner compatible with CTRE Swerve"
            />
          </Field>

          <Row>
            <Field label="Version" flex={1}>
              <input style={inputStyle} value={version} onChange={e => setVersion(e.target.value)} placeholder="1.0.0" />
            </Field>
            <Field label="Author" flex={2} hint="Saved in MARS settings for the next feature.">
              <input style={inputStyle} value={author} onChange={e => setAuthor(e.target.value)} placeholder="STZ-Robotics" />
            </Field>
          </Row>

          <Field label="Group ID (Java package)" error={groupIdError} hint="Derived from your GitHub user and the feature ID until you edit it.">
            <input
              style={inputStyle}
              value={effective.groupId}
              onChange={e => { touch("groupId"); setGroupId(e.target.value) }}
              placeholder="com.stzteam.features.posefinder"
            />
          </Field>

          <Row>
            <Field label="MARS core required" flex={1}>
              <input style={inputStyle} value={marsCoreRequired} onChange={e => setMarsCoreRequired(e.target.value)} placeholder=">=1.6.0" />
            </Field>
            <Field label="ForgeMini required" flex={1}>
              <input style={inputStyle} value={forgeMiniRequired} onChange={e => setForgeMiniRequired(e.target.value)} placeholder=">=1.1.0" />
            </Field>
          </Row>
          <p style={hintStyle}>
            Ranges use the same syntax as <code>MarsFeature.json</code>: <code>&gt;=1.6.0</code>, <code>&lt;2.0.0</code> or an exact
            version. Gradle resolves them through the ranges the template builds.
          </p>

          <label style={checkboxStyle}>
            <input type="checkbox" checked={isProcessor} onChange={e => setIsProcessor(e.target.checked)} />
            This feature is an annotation processor
            <span style={{ color: "var(--text-muted)" }}>— sets <code>isProcessor</code> in the descriptor</span>
          </label>
        </Section>
      )}

      {step === 1 && (
        <>
          <Section title="Always included">
            <p style={hintStyle}>
              The template already declares these, so the wizard never repeats them in <code>build.gradle</code>:
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              <Chip>WPILib (wpi.java.deps.wpilib)</Chip>
              <Chip>WPILib New Commands</Chip>
              <Chip>MARS core {marsCoreRequired}</Chip>
              <Chip>ForgeMini {forgeMiniRequired}</Chip>
              {bundledVendordeps.map(d => <Chip key={d.fileName || d.name}>{d.name} (project)</Chip>)}
            </div>
          </Section>

          <Section title="From the open project's vendordeps">
            {!projectPath ? (
              <p style={hintStyle}>No project is open. Open one to pull the exact vendor versions it uses, or pick from the catalog below.</p>
            ) : installableVendordeps.length === 0 ? (
              <p style={hintStyle}>This project has no vendor libraries beyond WPILib and MARS.</p>
            ) : (
              <>
                <p style={hintStyle}>
                  Exact versions read from <code>vendordeps/</code>. Prefer these: the feature then compiles against the same
                  versions as the robot project that will install it.
                </p>
                {installableVendordeps.map(dep => {
                  const converted = vendordepToDependency(dep)
                  const checked = selectedVendordeps.has(converted.id)
                  return (
                    <DependencyRow
                      key={converted.id}
                      checked={checked}
                      onToggle={() => setSelectedVendordeps(prev => {
                        const next = new Set(prev)
                        if (checked) next.delete(converted.id)
                        else next.add(converted.id)
                        return next
                      })}
                      label={converted.label}
                      version={dep.version}
                      coordinates={converted.artifacts}
                    />
                  )
                })}
              </>
            )}
          </Section>

          <Section title="Vendor catalog">
            <p style={hintStyle}>
              Fallback for when there's no project open. The versions below are 2026 defaults — check them against the
              vendordep you actually use before publishing.
            </p>
            {VENDOR_CATALOG.map(entry => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                checked={selectedCatalog.has(entry.id)}
                version={catalogVersions[entry.id] ?? entry.defaultVersion}
                onToggle={() => setSelectedCatalog(prev => {
                  const next = new Set(prev)
                  if (next.has(entry.id)) next.delete(entry.id)
                  else next.add(entry.id)
                  return next
                })}
                onVersion={v => setCatalogVersions(prev => ({ ...prev, [entry.id]: v }))}
              />
            ))}
          </Section>

          <Section title="Custom dependency">
            {customDeps.map(dep => (
              <div key={dep.id} style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <input
                  style={{ ...inputStyle, width: 150 }}
                  value={dep.label}
                  onChange={e => setCustomDeps(list => list.map(d => d.id === dep.id ? { ...d, label: e.target.value } : d))}
                  placeholder="Label"
                />
                <input
                  style={{ ...inputStyle, flex: 1, minWidth: 220 }}
                  value={dep.coordinate}
                  onChange={e => setCustomDeps(list => list.map(d => d.id === dep.id ? { ...d, coordinate: e.target.value } : d))}
                  placeholder="group:artifact:version"
                />
                <input
                  style={{ ...inputStyle, flex: 1, minWidth: 220 }}
                  value={dep.mavenUrl}
                  onChange={e => setCustomDeps(list => list.map(d => d.id === dep.id ? { ...d, mavenUrl: e.target.value } : d))}
                  placeholder="https://maven.example.com/release/ (optional)"
                />
                <button
                  onClick={() => setCustomDeps(list => list.filter(d => d.id !== dep.id))}
                  style={{ background: "transparent", border: "1px solid var(--status-error)", color: "var(--status-error)", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              onClick={() => setCustomDeps(list => [...list, { id: `custom-${Date.now()}`, label: "", mavenUrl: "", coordinate: "" }])}
              style={dashedButtonStyle}
            >
              + Add custom dependency
            </button>
          </Section>
        </>
      )}

      {step === 2 && (
        <>
          <Section title="GitHub">
            <p style={hintStyle}>
              Publishing is a <code>git push</code>: the workflow that ships with the template builds the jar into
              <code> maven/</code>, generates the Javadoc and deploys both to GitHub Pages. These two fields are what turn
              that into the URL people install from.
            </p>
            <Row>
              <Field label="GitHub user or org" flex={1} hint="Saved in MARS settings.">
                <input style={inputStyle} value={githubUser} onChange={e => setGithubUser(e.target.value)} placeholder="Imcab" />
              </Field>
              <Field label="Repository name" flex={1}>
                <input
                  style={inputStyle}
                  value={effective.githubRepo}
                  onChange={e => { touch("githubRepo"); setGithubRepo(e.target.value) }}
                  placeholder="CTREPoseFinderFeature"
                />
              </Field>
            </Row>

            <Field label="Local folder name" hint="Inside the workspace base folder from settings.">
              <input
                style={inputStyle}
                value={effective.folderName}
                onChange={e => { touch("folderName"); setFolderName(e.target.value) }}
                placeholder={derivedFolder || "MyFeature"}
              />
            </Field>

            <label style={checkboxStyle}>
              <input type="checkbox" checked={initGit} onChange={e => setInitGit(e.target.checked)} />
              Run <code>git init</code>, commit and add <code>origin</code>
            </label>
            <label style={checkboxStyle}>
              <input type="checkbox" checked={openEditor} onChange={e => setOpenEditor(e.target.checked)} />
              Open the folder in VS Code when it's ready
            </label>
          </Section>

          <Section title="How people will install it">
            {urls ? (
              <>
                <UrlRow label="Install URL (Packages > Manual Install)" url={urls.install} copied={copied} onCopy={copy} />
                <UrlRow label="Maven repository" url={urls.maven} copied={copied} onCopy={copy} />
                <UrlRow label="Javadoc" url={urls.pages} copied={copied} onCopy={copy} />
              </>
            ) : (
              <p style={hintStyle}>Fill in the GitHub user and repository to see the URLs.</p>
            )}
            <PublishGuide user={githubUser} repo={effective.githubRepo} />
          </Section>
        </>
      )}

      {step === 3 && (
        <>
          <Section title="Review">
            <ul style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.9, paddingLeft: 20, listStyle: "disc", margin: 0 }}>
              <li>Feature: <strong style={{ color: "var(--text-primary)" }}>{effective.name || "—"}</strong> (<code>{featureId || "—"}</code> v{version})</li>
              <li>Class: <code>{effective.groupId}.{featureId || "Feature"}</code></li>
              <li>Folder: <code>{targetPath || "workspace path not set in settings"}</code></li>
              <li>Author: {author || "—"}</li>
              <li>Extra dependencies: {dependencies.length === 0 ? "none beyond WPILib + MARS" : dependencies.map(d => d.label).join(", ")}</li>
              <li>Install URL: <code>{urls?.install || "set the GitHub user/repo in step 3"}</code></li>
            </ul>

            {dependencies.length > 0 && (
              <>
                <p style={{ ...hintStyle, marginTop: 12 }}>Lines added to <code>build.gradle</code>:</p>
                <pre style={preStyle}>
                  {dependencies.flatMap(d => d.artifacts).map(a =>
                    a.endsWith(":wpilib")
                      ? `implementation "${a.slice(0, -":wpilib".length)}:\${wpi.versions.wpilibVersion.get()}"`
                      : `implementation '${a}'`
                  ).join("\n")}
                </pre>
                <p style={hintStyle}>
                  These end up in the published POM as transitive dependencies, so a robot project installing this feature
                  needs the matching vendordeps. The generated README says so too.
                </p>
              </>
            )}

            {!settings.workspace_path && (
              <p style={{ color: "var(--status-error)", fontSize: 12, marginTop: 12 }}>
                Workspace base folder is not configured — set it in Config &gt; Settings first.
              </p>
            )}

            <button
              disabled={!canCreate}
              onClick={handleCreate}
              style={{
                marginTop: 16,
                background: canCreate ? "var(--mars-red)" : "var(--mars-grey)",
                border: "none", borderRadius: 6, color: "#fff", padding: "10px 20px",
                cursor: canCreate ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600,
              }}
            >
              {busy ? "Cloning template..." : "Create Feature"}
            </button>

            {errorMsg && <pre style={{ ...preStyle, color: "var(--status-error)", marginTop: 12 }}>{errorMsg}</pre>}
          </Section>

          {result && (
            <Section title="Feature created">
              <p style={{ fontSize: 13, color: "var(--status-success)", marginTop: 0 }}>
                <code>{result.path}</code>
              </p>

              {result.warnings.length > 0 && (
                <ul style={{ fontSize: 12, color: "var(--status-warning)", lineHeight: 1.7, paddingLeft: 20 }}>
                  {result.warnings.map(w => <li key={w}>{w}</li>)}
                </ul>
              )}

              <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
                <button onClick={() => { void revealItemInDir(result.path) }} style={secondaryButtonStyle}>
                  Reveal folder
                </button>
                {result.installUrl && (
                  <button onClick={() => copy("result-install", result.installUrl)} style={secondaryButtonStyle}>
                    {copied === "result-install" ? "Copied" : "Copy install URL"}
                  </button>
                )}
                {githubUser && (
                  <button onClick={() => { void openUrl(`https://github.com/new?name=${encodeURIComponent(effective.githubRepo)}`) }} style={secondaryButtonStyle}>
                    Create the GitHub repo
                  </button>
                )}
              </div>

              <p style={hintStyle}>
                Write your code in <code>{result.mainClass}</code>. The <code>generated/</code> folder is rewritten by Gradle on
                every build — don't touch it.
              </p>
              <PublishGuide user={githubUser} repo={effective.githubRepo} committed={result.gitInitialized} />
            </Section>
          )}
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <button
          disabled={step === 0}
          onClick={() => setStep(s => Math.max(0, s - 1))}
          style={{ background: "transparent", border: "1px solid var(--border-main)", color: "var(--text-secondary)", borderRadius: 6, padding: "8px 16px", cursor: step === 0 ? "not-allowed" : "pointer", fontSize: 12 }}
        >
          Back
        </button>
        <button
          disabled={step === STEPS.length - 1 || (step === 0 && !!featureIdError)}
          onClick={() => setStep(s => Math.min(STEPS.length - 1, s + 1))}
          style={{ background: "var(--mars-accent)", border: "none", color: "#fff", borderRadius: 6, padding: "8px 16px", cursor: "pointer", fontSize: 12 }}
        >
          Next
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Publishing guide — the same one written into the generated README, so the
// user does not have to open the repo to know what comes next.
// ---------------------------------------------------------------------------

function PublishGuide({ user, repo, committed }: { user: string; repo: string; committed?: boolean }) {
  const origin = user && repo ? `https://github.com/${user}/${repo}.git` : "https://github.com/<user>/<repo>.git"

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border-light)", paddingTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: 0.6, marginBottom: 8 }}>
        PUBLISHING
      </div>
      <ol style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
        <li>Create an empty repository <code>{user && repo ? `${user}/${repo}` : "<user>/<repo>"}</code> on GitHub (no README).</li>
        <li>
          Push the folder to <code>main</code>:
          <pre style={preStyle}>
            {committed
              ? `git push -u origin main`
              : `git init -b main\ngit add -A\ngit commit -m "Initial feature"\ngit remote add origin ${origin}\ngit push -u origin main`}
          </pre>
        </li>
        <li><strong>Settings &gt; Pages</strong> → source <em>Deploy from a branch</em> → branch <code>gh-pages</code>, folder <code>/(root)</code>.</li>
        <li>The <em>Publish MARS Feature</em> action runs on every push to <code>main</code>: it builds the jar into <code>maven/</code>, generates the Javadoc and deploys both to Pages. No manual hosting.</li>
        <li>For a new release: bump <code>version</code> in <code>MarsFeature.json</code> and push again.</li>
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Piezas de formulario
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-input)", border: "1px solid var(--border-main)",
  borderRadius: 4, color: "var(--text-primary)", padding: "6px 8px", fontSize: 13,
  outline: "none", boxSizing: "border-box",
}

const hintStyle: React.CSSProperties = {
  fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6, margin: "4px 0 0",
}

const preStyle: React.CSSProperties = {
  background: "var(--bg-input)", border: "1px solid var(--border-light)", borderRadius: 4,
  padding: 10, fontSize: 11, color: "var(--text-secondary)", whiteSpace: "pre-wrap",
  wordBreak: "break-all", margin: "6px 0",
}

const checkboxStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)",
  fontSize: 12, marginTop: 10,
}

const dashedButtonStyle: React.CSSProperties = {
  background: "var(--bg-panel)", border: "1px dashed var(--border-dark)", borderRadius: 6,
  color: "var(--text-secondary)", padding: "8px 12px", cursor: "pointer", fontSize: 12, width: "100%",
}

const secondaryButtonStyle: React.CSSProperties = {
  background: "var(--bg-input)", border: "1px solid var(--border-main)", borderRadius: 4,
  color: "var(--text-primary)", padding: "6px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600,
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-main)", borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, margin: "0 0 12px", color: "var(--text-primary)" }}>{title}</h3>
      {children}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 12 }}>{children}</div>
}

function Field({ label, children, hint, error, flex }: {
  label: string
  children: React.ReactNode
  hint?: string
  error?: string | null
  flex?: number
}) {
  return (
    <div style={{ marginBottom: 12, flex, minWidth: 0 }}>
      <label style={{ display: "block", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        {label}
      </label>
      {children}
      {error && <p style={{ ...hintStyle, color: "var(--status-error)" }}>{error}</p>}
      {!error && hint && <p style={hintStyle}>{hint}</p>}
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-input)",
      border: "1px solid var(--border-light)", borderRadius: 3, padding: "2px 8px",
    }}>
      {children}
    </span>
  )
}

function DependencyRow({ checked, onToggle, label, version, coordinates }: {
  checked: boolean
  onToggle: () => void
  label: string
  version?: string
  coordinates: string[]
}) {
  return (
    <label style={{
      display: "flex", gap: 10, alignItems: "flex-start", padding: 10, marginBottom: 8,
      background: "var(--bg-input)", borderRadius: 6, cursor: "pointer",
      border: `1px solid ${checked ? "var(--mars-accent)" : "transparent"}`,
    }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 2 }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{label}</span>
        {version && <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>v{version}</span>}
        <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", fontFamily: "monospace", marginTop: 3, wordBreak: "break-all" }}>
          {coordinates.join("  ·  ")}
        </span>
      </span>
    </label>
  )
}

function CatalogRow({ entry, checked, version, onToggle, onVersion }: {
  entry: CatalogEntry
  checked: boolean
  version: string
  onToggle: () => void
  onVersion: (v: string) => void
}) {
  return (
    <div style={{
      display: "flex", gap: 10, alignItems: "center", padding: 10, marginBottom: 8,
      background: "var(--bg-input)", borderRadius: 6,
      border: `1px solid ${checked ? "var(--mars-accent)" : "transparent"}`,
    }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{entry.label}</div>
        <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{entry.hint}</div>
      </div>
      <input
        style={{ ...inputStyle, width: 110 }}
        value={version}
        onChange={e => onVersion(e.target.value)}
        disabled={!checked}
        aria-label={`${entry.label} version`}
      />
    </div>
  )
}

function UrlRow({ label, url, copied, onCopy }: {
  label: string
  url: string
  copied: string | null
  onCopy: (label: string, text: string) => void
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <code style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-input)", border: "1px solid var(--border-light)", borderRadius: 4, padding: "6px 8px", wordBreak: "break-all" }}>
          {url}
        </code>
        <button onClick={() => onCopy(label, url)} style={secondaryButtonStyle}>
          {copied === label ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  )
}
