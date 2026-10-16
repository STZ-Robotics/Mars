// Catalog of installed 3D assets and the three ways to install one.
//
// There are two origins and the scene treats them the same:
//
//   - `bundled`: folders inside `public/fields3d/`. They travel with the app and
//     are served by URL. Dropping a `config.json` + `model.glb` there is enough
//     for them to show up; the glob picks them up at build time without touching
//     code, just like the 2D fields in `public/fields/`.
//
//   - `user`: folders of the on-disk store (%APPDATA%/MARS/assets3d), read with
//     `read_binary_file`. It is where the packages the user downloads or imports
//     land, and what allows having the 20 MB field without putting it in the
//     repo.
//
// The three ways to install, all resolved in Rust:
//   1. Download from AdvantageScope's official catalog.
//   2. Pick a .zip the user already downloaded.
//   3. Pick an already extracted folder, including AdvantageScope's
//      `userAssets`, which has exactly the same format.

import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { AssetConfig, FieldAssetConfig, RobotAssetConfig, parseAssetConfig } from "./assetConfig"

/** How the loader is asked for the content of one of the package's files. */
export type AssetSource =
  | { kind: "url"; url: string }
  | { kind: "path"; path: string }

export interface AssetPack {
  /** The stable key the layout references the asset with. */
  key: string
  origin: "bundled" | "user"
  config: AssetConfig
  /** The .glb names, already sorted: model.glb, model_0.glb, model_1.glb... */
  models: string[]
  bytes: number
  /** Where it lives; only for showing it in the panel. */
  location: string
}

export interface FieldPack extends AssetPack { config: FieldAssetConfig }
export interface RobotPack extends AssetPack { config: RobotAssetConfig }

export function isFieldPack(pack: AssetPack): pack is FieldPack {
  return pack.config.kind === "field"
}

export function isRobotPack(pack: AssetPack): pack is RobotPack {
  return pack.config.kind === "robot"
}

/** How to ask the loader for a package's `index` model (0 = model.glb). */
export function modelSource(pack: AssetPack, index: number): AssetSource | null {
  const file = pack.models[index]
  if (file === undefined) return null
  return pack.origin === "bundled"
    ? { kind: "url", url: `/fields3d/${pack.key}/${file}` }
    : { kind: "path", path: `${pack.location}/${file}` }
}

/** A source's stable key, for caching the already parsed model. */
export function sourceKey(source: AssetSource): string {
  return source.kind === "url" ? source.url : source.path
}

// --- Packages that travel with the app ------------------------------------------

// Same as the 2D fields: dropping `public/fields3d/<Folder>/config.json` (with
// its `model.glb` next to it) is enough for the field to show up in the selector.
const BUNDLED_CONFIGS = import.meta.glob("../../../public/fields3d/*/config.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>

function bundledPacks(): AssetPack[] {
  return Object.entries(BUNDLED_CONFIGS)
    .map(([path, text]): AssetPack | null => {
      const key = path.split("/").slice(-2)[0]
      const config = parseAssetConfig(text)
      if (config === null) return null
      // A bundled package cannot be inspected on disk from the front end,
      // so the canonical name is assumed: model.glb plus the model_N.glb files
      // the game pieces declared in the config ask for.
      const extra = config.kind === "field" ? config.gamePieces.length : 0
      return {
        key,
        origin: "bundled",
        config,
        models: ["model.glb", ...Array.from({ length: extra }, (_, i) => `model_${i}.glb`)],
        bytes: 0,
        location: `/fields3d/${key}`,
      }
    })
    .filter((p): p is AssetPack => p !== null)
}

// --- Packages installed on disk --------------------------------------------

interface RawPack {
  folder: string
  path: string
  config: string
  models: string[]
  bytes: number
}

async function userPacks(): Promise<AssetPack[]> {
  const raw = await invoke<RawPack[]>("list_asset3d_packs")
  return raw
    .map((entry): AssetPack | null => {
      const config = parseAssetConfig(entry.config)
      if (config === null) return null
      return {
        key: entry.folder,
        origin: "user",
        config,
        models: entry.models,
        bytes: entry.bytes,
        location: entry.path,
      }
    })
    .filter((p): p is AssetPack => p !== null)
}

/**
 * Every available package, the app's first.
 *
 * If two share a key the one the user installed wins: it is the one they just
 * put there on purpose, and overriding a field that came with the app with a
 * corrected version is exactly the use case.
 */
export async function listAssetPacks(): Promise<AssetPack[]> {
  const user = await userPacks()
  const userKeys = new Set(user.map(p => p.key))
  return [...bundledPacks().filter(p => !userKeys.has(p.key)), ...user]
    .sort((a, b) => a.config.name.localeCompare(b.config.name))
}

export function assetStoreDir(): Promise<string> {
  return invoke<string>("asset3d_store_dir")
}

export function deleteAssetPack(key: string): Promise<void> {
  return invoke("delete_asset3d_pack", { folder: key })
}

// --- Installation --------------------------------------------------------------

// Downloading and unzipping live in RUST (`src-tauri/src/assets3d.rs`), not here.
// It is not a style preference: GitHub sends no CORS headers on its release
// downloads, so a `fetch` from the webview always fails with "Failed to fetch"
// however open the CSP is. As a bonus, the package's ~20 MB do not cross the IPC.

/** Opens the dialog to pick an already downloaded .zip and installs it. */
export async function installAssetZipFromDisk(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    title: "Select an asset .zip",
    filters: [{ name: "Asset archive", extensions: ["zip"] }],
  })
  if (typeof picked !== "string") return null
  return invoke<string>("install_asset3d_zip", { path: picked })
}

/** Copies an already extracted folder into the store. */
export async function importAssetFolder(): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    title: "Select an asset folder (the one with config.json)",
  })
  if (typeof picked !== "string") return null
  return invoke<string>("import_asset3d_folder", { source: picked })
}

// --- Official catalog ---------------------------------------------------------

export interface CatalogEntry {
  /** The .zip's name in the release, without extension; it is also the folder. */
  key: string
  label: string
  kind: "field" | "robot"
  url: string
  /** Approximate size, to warn before downloading 20 MB. */
  approxBytes: number
}

const ASSETS_RELEASE =
  "https://github.com/Mechanical-Advantage/AdvantageScopeAssets/releases/download/default-assets-v2"

/**
 * AdvantageScope's official packages, which are the same models that app uses:
 * it is the only public source of the field in glTF already converted and
 * measured. They are downloaded on demand and not put in the repo because a
 * single field weighs more than the whole rest of the project together.
 *
 * The assets are by Littleton Robotics (FRC 6328) and their license allows
 * redistribution keeping the copyright notice — see ASSET_LICENSE_NOTE.
 */
export const ASSET_CATALOG: CatalogEntry[] = [
  { key: "Field3d_2026FRCFieldV2", label: "2026 Field (Rebuilt)", kind: "field", url: `${ASSETS_RELEASE}/Field3d_2026FRCFieldV2.zip`, approxBytes: 4_872_257 },
  { key: "Field3d_2025FRCFieldWeldedV3", label: "2025 Field (welded)", kind: "field", url: `${ASSETS_RELEASE}/Field3d_2025FRCFieldWeldedV3.zip`, approxBytes: 3_787_054 },
  { key: "Field3d_2025FRCFieldAndyMarkV3", label: "2025 Field (AndyMark)", kind: "field", url: `${ASSETS_RELEASE}/Field3d_2025FRCFieldAndyMarkV3.zip`, approxBytes: 3_789_831 },
  { key: "Field3d_2024FRCFieldV4", label: "2024 Field (Crescendo)", kind: "field", url: `${ASSETS_RELEASE}/Field3d_2024FRCFieldV4.zip`, approxBytes: 6_042_932 },
  { key: "Field3d_2023FRCFieldV5", label: "2023 Field (Charged Up)", kind: "field", url: `${ASSETS_RELEASE}/Field3d_2023FRCFieldV5.zip`, approxBytes: 4_205_657 },
  { key: "Field3d_2022FRCFieldV4", label: "2022 Field (Rapid React)", kind: "field", url: `${ASSETS_RELEASE}/Field3d_2022FRCFieldV4.zip`, approxBytes: 4_235_138 },
  { key: "Robot_2026FRCKitBotV2", label: "2026 KitBot", kind: "robot", url: `${ASSETS_RELEASE}/Robot_2026FRCKitBotV2.zip`, approxBytes: 8_575_189 },
  { key: "Robot_2025FRCKitBotV3", label: "2025 KitBot", kind: "robot", url: `${ASSETS_RELEASE}/Robot_2025FRCKitBotV3.zip`, approxBytes: 6_490_790 },
  { key: "Robot_CrabBotV4", label: "CrabBot (swerve demo)", kind: "robot", url: `${ASSETS_RELEASE}/Robot_CrabBotV4.zip`, approxBytes: 17_533_783 },
]

export const ASSET_LICENSE_NOTE =
  "3D field and robot models © 2021-2026 Littleton Robotics (FRC 6328). " +
  "Redistributed under the AdvantageScopeAssets BSD-3-Clause licence."

/** Downloads a package from the catalog and installs it. */
export function downloadAsset(entry: CatalogEntry): Promise<string> {
  return invoke<string>("download_asset3d", { url: entry.url, fallbackName: entry.key })
}
