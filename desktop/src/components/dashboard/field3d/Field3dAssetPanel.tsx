// 3D asset manager: the field and robot models the tab draws.
//
// An "asset" is a folder with a `config.json` and one or more `model*.glb`,
// exactly AdvantageScope's format. There are two kinds and they do different
// things, so the panel separates them instead of mixing them in one list:
//
//   FIELD -> chosen in the FIELD selector of the top bar.
//   ROBOT -> chosen in the SCENE tab, and each robot object can use another.
//
// That second line is the one that was missing: without it, you install a robot
// and have no idea where it is supposed to show up.
//
// And a note that matters: the .step FIRST publishes CANNOT be loaded here nor
// in AdvantageScope. STEP is a boundary-representation CAD format (B-rep), with
// no meshes: it has to be converted to glTF first. The panel says so, because
// downloading it and having it not work is everyone's first stumble.

import { memo, useState } from "react"
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener"
import {
  ASSET_CATALOG, ASSET_LICENSE_NOTE, AssetPack, CatalogEntry, assetStoreDir,
  deleteAssetPack, downloadAsset, importAssetFolder, installAssetZipFromDisk,
  isFieldPack, isRobotPack,
} from "../../../utils/field3d/assetStore"
import { formatBytes } from "../../../utils/field3d/assetConfig"
import { ErrorNote, Hint, PanelButton, PanelIcon, Row, Section } from "../three/PanelFields"

interface Props {
  packs: AssetPack[]
  onChanged: () => void
}

const STEP_CONVERT_DOC = "https://docs.advantagescope.org/more-features/custom-assets/gltf-convert/"
const FIELD_LIBRARY = "https://www.firstinspires.org/resources/library/frc/playing-field"

function Field3dAssetPanel({ packs, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const fields = packs.filter(isFieldPack)
  const robots = packs.filter(isRobotPack)
  const installed = new Set(packs.map(p => p.key))

  // Every action that touches the disk goes through here: that way the panel is
  // locked while it runs (a second download in parallel would write over the
  // first) and any failure lands on the same notice.
  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(label)
    setError(null)
    setDone(null)
    try {
      const result = await action()
      // `null` = the user closed the dialog without choosing anything. It is not an
      // error and there is nothing to celebrate either.
      if (result !== null && success) setDone(success)
      onChanged()
    } catch (err) {
      setError(String((err as any)?.message ?? err))
    } finally {
      setBusy(null)
    }
  }

  // `revealItemInDir` and not `openPath`: the first one falls under the
  // `opener:default` permission the app already declares, and opening the
  // explorer with the folder selected is exactly what is wanted here.
  const handleReveal = async () => {
    setError(null)
    try {
      await revealItemInDir(await assetStoreDir())
    } catch (err) {
      setError(String((err as any)?.message ?? err))
    }
  }

  const handleDownload = (entry: CatalogEntry) => run(
    entry.key,
    () => downloadAsset(entry),
    entry.kind === "robot"
      ? `${entry.label} installed. Pick it under Scene › Robot model.`
      : `${entry.label} installed. Pick it in the FIELD selector above.`,
  )

  const handleRemove = (key: string) => run(key, () => deleteAssetPack(key))

  const catalogueFields = ASSET_CATALOG.filter(e => e.kind === "field")
  const catalogueRobots = ASSET_CATALOG.filter(e => e.kind === "robot")

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{
        padding: "10px 12px", fontSize: 10, lineHeight: 1.6,
        color: "var(--text-muted)", borderBottom: "1px solid var(--border-light)",
      }}>
        The 3D models this tab draws. Two kinds, and they show up in different places:
        <br />
        <b style={{ color: "var(--text-primary)" }}>Fields</b> — pick one in the
        <b style={{ color: "var(--text-primary)" }}> FIELD</b> selector at the top of the window.
        <br />
        <b style={{ color: "var(--text-primary)" }}>Robots</b> — pick one under
        <b style={{ color: "var(--text-primary)" }}> Scene › Robot model</b>, or per object in
        the Objects tab. Without one, every robot is drawn as a box with coloured bumpers.
      </div>

      <Section title={`Fields installed (${fields.length})`} defaultOpen svg="field3d.svg" svgFallback="visualizer2d.svg" icon="ti-map-2">
        {fields.length === 0
          ? <Hint>None yet — the tab is running on the built-in schematic field. Download a season below.</Hint>
          : fields.map(pack => (
            <PackRow key={pack.key} pack={pack} busy={busy} onRemove={handleRemove} />
          ))}
      </Section>

      <Section title={`Robots installed (${robots.length})`} defaultOpen svg="robot.svg" icon="ti-robot">
        {robots.length === 0
          ? (
            <Hint>
              None yet, so your robot is drawn as a plain box. Download the KitBot below to
              see how it works, or use <i>Install folder</i> to add your own CAD once it is
              exported as <code>.glb</code>.
            </Hint>
          )
          : robots.map(pack => (
            <PackRow key={pack.key} pack={pack} busy={busy} onRemove={handleRemove} />
          ))}
      </Section>

      <Section title="Download" defaultOpen svg="export.svg" icon="ti-download">
        <Hint>
          Official AdvantageScope models — the same geometry that app uses, already converted
          from the FIRST CAD and measured. They are fetched on demand rather than shipped with
          MARS, because one field weighs more than the whole app.
        </Hint>

        <div style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 }}>
          Fields
        </div>
        {catalogueFields.map(entry => (
          <CatalogueRow
            key={entry.key}
            entry={entry}
            installed={installed.has(entry.key)}
            busy={busy}
            onDownload={handleDownload}
          />
        ))}

        <div style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 6 }}>
          Robots
        </div>
        {catalogueRobots.map(entry => (
          <CatalogueRow
            key={entry.key}
            entry={entry}
            installed={installed.has(entry.key)}
            busy={busy}
            onDownload={handleDownload}
          />
        ))}

        {busy !== null && (
          <Hint>Downloading and unpacking — a field can take a minute on a slow connection.</Hint>
        )}
        {done !== null && (
          <div style={{ fontSize: 10, lineHeight: 1.4, color: "var(--status-sim, var(--mars-accent))" }}>
            {done}
          </div>
        )}
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <Hint>{ASSET_LICENSE_NOTE}</Hint>
      </Section>

      <Section title="Install from disk" svg="import-model.svg" icon="ti-folder-plus">
        <Hint>
          For an asset you already have: one you downloaded by hand, one another team shared,
          or your own robot. Both accept the AdvantageScope layout — a{" "}
          <code>config.json</code> next to a <code>model.glb</code>.
        </Hint>
        <Row>
          <PanelButton
            label="Install .zip…"
            svg="import-model.svg"
            icon="ti-file-zip"
            disabled={busy !== null}
            onClick={() => run("zip", installAssetZipFromDisk, "Archive installed.")}
            title="An asset archive you already downloaded, still zipped"
          />
          <PanelButton
            label="Install folder…"
            svg="open-folder.svg"
            icon="ti-folder"
            disabled={busy !== null}
            onClick={() => run("folder", importAssetFolder, "Folder installed.")}
            title="An already-extracted folder — AdvantageScope's userAssets works as-is"
          />
        </Row>
        <PanelButton
          label="Show the asset folder"
          svg="open-folder.svg"
          icon="ti-folder-open"
          onClick={handleReveal}
          title="Opens the folder where installed assets live"
        />
      </Section>

      <Section title="Using your own CAD" svg="model-file.svg" icon="ti-help">
        <Hint>
          <b>A .step file cannot be loaded</b> — not here and not in AdvantageScope. STEP
          describes surfaces mathematically (B-rep) and has no triangles; a renderer needs a
          mesh. The field CAD that FIRST publishes is STEP, so it has to be converted first.
          <br /><br />
          The short version: open the .step in <b>CAD Assistant</b> (free), tick
          <i> merge faces within the same part</i>, and save as <b>.glb</b>. Put that file in a
          folder beside a <code>config.json</code>, then use <i>Install folder</i> above.
          <br /><br />
          Unless you need this season's field exactly as FIRST published it, the download list
          is the shortcut: someone already did the conversion, the cleanup and the measuring.
        </Hint>
        <Row>
          <PanelButton
            label="Convert guide"
            svg="help.svg"
            icon="ti-external-link"
            onClick={() => { void openUrl(STEP_CONVERT_DOC) }}
          />
          <PanelButton
            label="FIRST field CAD"
            svg="help.svg"
            icon="ti-external-link"
            onClick={() => { void openUrl(FIELD_LIBRARY) }}
          />
        </Row>
      </Section>
    </div>
  )
}

// --- Filas -------------------------------------------------------------------

// The two rows live in the MODULE and not inside the panel. Defining a component
// inside another's body creates a new type on every render, and React responds
// by unmounting and remounting the whole subtree. Since the page redraws at
// 30 Hz (the NT poll returns a new object every 33 ms), that did two visible
// things: the icons restarted their fallback chain and flickered, and the
// `mousedown` landed on one button while the `mouseup` landed on a different
// one, so clicks never got to fire.

function CatalogueRow({ entry, installed, busy, onDownload }: {
  entry: CatalogEntry
  installed: boolean
  busy: string | null
  onDownload: (entry: CatalogEntry) => void
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
      <PanelIcon
        svg={entry.kind === "field" ? "field3d.svg" : "robot.svg"}
        svgFallback={entry.kind === "field" ? "visualizer2d.svg" : "part.svg"}
        fallback={entry.kind === "field" ? "ti-map-2" : "ti-robot"}
        size={13}
      />
      <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: "var(--text-primary)" }}>
        {entry.label}
      </span>
      <span style={{ fontSize: 9, color: "var(--text-muted)", flexShrink: 0 }}>
        {formatBytes(entry.approxBytes)}
      </span>
      <button
        disabled={busy !== null || installed}
        onClick={() => onDownload(entry)}
        style={{
          flexShrink: 0, fontSize: 9.5, padding: "2px 7px", borderRadius: 2, minWidth: 58,
          cursor: busy !== null || installed ? "default" : "pointer",
          background: installed ? "transparent" : "var(--bg-input)",
          color: installed ? "var(--text-muted)" : "var(--text-primary)",
          border: `1px solid ${installed ? "transparent" : "var(--border-main)"}`,
          opacity: busy !== null && busy !== entry.key ? 0.4 : 1,
        }}
      >
        {installed ? "Installed" : busy === entry.key ? "Getting…" : "Download"}
      </button>
    </div>
  )
}

function PackRow({ pack, busy, onRemove }: {
  pack: AssetPack
  busy: string | null
  onRemove: (key: string) => void
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 0", borderBottom: "1px solid var(--border-light)",
      }}
    >
      <PanelIcon
        svg={pack.config.kind === "field" ? "field3d.svg" : "robot.svg"}
        svgFallback={pack.config.kind === "field" ? "visualizer2d.svg" : "part.svg"}
        fallback={pack.config.kind === "field" ? "ti-map-2" : "ti-robot"}
        size={14}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 10.5, color: "var(--text-primary)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {pack.config.name}
        </div>
        <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
          {pack.origin === "bundled" ? "Bundled" : formatBytes(pack.bytes)}
          {pack.config.kind === "field"
            && ` · ${pack.config.size.length.toFixed(2)} × ${pack.config.size.width.toFixed(2)} m`}
          {pack.config.kind === "robot" && pack.config.components.length > 0
            && ` · ${pack.config.components.length} moving parts`}
          {pack.config.kind === "robot" && pack.config.cameras.length > 0
            && ` · ${pack.config.cameras.length} cameras`}
        </div>
      </div>
      {pack.origin === "user" && (
        <button
          title="Remove from disk"
          disabled={busy !== null}
          onClick={() => onRemove(pack.key)}
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            padding: 0, display: "flex", flexShrink: 0,
          }}
        >
          <PanelIcon svg="delete.svg" fallback="ti-trash" size={13} color="var(--text-muted)" />
        </button>
      )}
    </div>
  )
}

// The panel looks at no live data, so it has no reason to redraw with the NT
// poll. `memo` keeps it still unless the package list changes, which is the
// only thing that can change from outside.
export default memo(Field3dAssetPanel)
