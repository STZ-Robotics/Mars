// Loading of the assets the Field 3D tab needs: the installed catalog, the
// chosen field's model, its game pieces, and the robot models the list's
// objects use.
//
// Everything goes through the `assetModels` cache: a field model weighs ~18 MB
// and parsing it takes almost a second, so switching tabs, coming back, or
// opening a second Field 3D has to reuse what was already parsed.
//
// The loads are launched in parallel and each one updates its part of the state
// separately: the field shows up as soon as it is ready without waiting for the
// robots to finish, which is what makes the tab feel fast even though the total
// work is the same.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Field3dObjectConfig, Field3dSettings, EVERGREEN_FIELD_KEY } from "../store/appStore"
import {
  AssetPack, FieldPack, RobotPack, isFieldPack, isRobotPack, listAssetPacks, modelSource,
} from "../utils/field3d/assetStore"
import { LoadedAsset, OPTIMIZE_PRESETS, loadAssetModel } from "../utils/field3d/assetModels"
import { GamePieceEntry, RobotAssetEntry } from "../components/dashboard/field3d/objectVisuals"

export type AssetStatus = "idle" | "loading" | "ready" | "error"

export interface Field3dAssets {
  /** Everything installed, fields and robots. */
  packs: AssetPack[]
  fieldPacks: FieldPack[]
  robotPacks: RobotPack[]
  /** The chosen field's package, or null if it is the schematic one. */
  fieldPack: FieldPack | null
  fieldModel: LoadedAsset | null
  gamePieces: GamePieceEntry[]
  robotAssets: Map<string, RobotAssetEntry>
  status: AssetStatus
  error: string | null
  /** Reads the store again; the panel calls it after installing or deleting. */
  refresh: () => void
}

export function useField3dAssets(
  settings: Field3dSettings,
  objects: Field3dObjectConfig[],
): Field3dAssets {
  const [packs, setPacks] = useState<AssetPack[]>([])
  const [fieldModel, setFieldModel] = useState<LoadedAsset | null>(null)
  const [gamePieces, setGamePieces] = useState<GamePieceEntry[]>([])
  const [robotAssets, setRobotAssets] = useState<Map<string, RobotAssetEntry>>(new Map())
  const [status, setStatus] = useState<AssetStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const refresh = useCallback(() => setReloadToken(token => token + 1), [])

  // The quality mode changes HOW the model is optimized (how much detail is
  // discarded and how bright it is drawn), not just how it is lit. That is why
  // changing it forces optimizing again; the cache keeps each mode separately,
  // so going back and forth between two is instant the second time.
  const optimize = OPTIMIZE_PRESETS[settings.quality]

  // --- Catalog ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    listAssetPacks()
      .then(list => { if (!cancelled) setPacks(list) })
      .catch(err => { if (!cancelled) setError(String(err?.message ?? err)) })
    return () => { cancelled = true }
  }, [reloadToken])

  const fieldPacks = useMemo(() => packs.filter(isFieldPack), [packs])
  const robotPacks = useMemo(() => packs.filter(isRobotPack), [packs])

  const fieldPack = useMemo(
    () => (settings.fieldKey === EVERGREEN_FIELD_KEY
      ? null
      : fieldPacks.find(p => p.key === settings.fieldKey) ?? null),
    [fieldPacks, settings.fieldKey],
  )

  // --- Field and its game pieces -------------------------------------------
  useEffect(() => {
    if (fieldPack === null) {
      setFieldModel(null)
      setGamePieces([])
      setStatus("idle")
      setError(null)
      return
    }

    let cancelled = false
    setStatus("loading")
    setError(null)

    // The nodes of the pieces already in place are requested WITHOUT merging: the
    // scene has to be able to turn them off one by one when the robot publishes
    // that piece type, and a merged mesh cannot be split afterwards.
    const staged = fieldPack.config.gamePieces.flatMap(piece => piece.stagedObjects)
    const source = modelSource(fieldPack, 0)
    if (source === null) {
      setStatus("error")
      setError("The field asset has no model.glb.")
      return
    }

    loadAssetModel(source, staged, optimize)
      .then(model => {
        if (cancelled) return
        setFieldModel(model)
        setStatus("ready")
      })
      .catch(err => {
        if (cancelled) return
        setFieldModel(null)
        setStatus("error")
        setError(String(err?.message ?? err))
      })

    // The game pieces are model_0.glb onwards; the config's 0 is the first one
    // after model.glb. They are loaded separately and without blocking the
    // field: a missing piece leaves its object with the stand-in sphere, not the
    // whole field undrawn.
    Promise.all(fieldPack.config.gamePieces.map(async (piece, index): Promise<GamePieceEntry> => {
      const pieceSource = modelSource(fieldPack, index + 1)
      if (pieceSource === null) return { config: piece, asset: null }
      try {
        return { config: piece, asset: await loadAssetModel(pieceSource, [], optimize) }
      } catch {
        return { config: piece, asset: null }
      }
    })).then(entries => { if (!cancelled) setGamePieces(entries) })

    return () => { cancelled = true }
  }, [fieldPack, optimize])

  // --- Robots ------------------------------------------------------------------

  // Only the ones someone uses are loaded: the tab's default plus the ones the
  // objects set. Loading the whole catalog just in case would be tens of MB for
  // nothing.
  const neededRobots = useMemo(() => {
    const keys = new Set<string>()
    if (settings.robotAssetKey) keys.add(settings.robotAssetKey)
    objects.forEach(object => {
      if (object.robotAssetKey) keys.add(object.robotAssetKey)
    })
    return Array.from(keys).sort()
  }, [settings.robotAssetKey, objects])

  const neededSignature = neededRobots.join("|")

  useEffect(() => {
    let cancelled = false

    Promise.all(neededRobots.map(async (key): Promise<[string, RobotAssetEntry] | null> => {
      const pack = robotPacks.find(p => p.key === key)
      if (!pack) return null
      const baseSource = modelSource(pack, 0)
      if (baseSource === null) return null

      try {
        const base = await loadAssetModel(baseSource, [], optimize)
        // One component per `model_N.glb`, in the same order the config declares
        // them: it is the published pose's index.
        const components = await Promise.all(
          pack.config.components.map(async (_, index) => {
            const source = modelSource(pack, index + 1)
            return source === null ? null : loadAssetModel(source, [], optimize).catch(() => null)
          }),
        )
        return [key, {
          config: pack.config,
          base,
          components: components.filter((c): c is LoadedAsset => c !== null),
        }]
      } catch {
        // A robot that does not load must not bring down the tab: its object falls
        // back to the generic chassis, which is exactly what you see without an asset.
        return null
      }
    })).then(entries => {
      if (cancelled) return
      setRobotAssets(new Map(entries.filter((e): e is [string, RobotAssetEntry] => e !== null)))
    })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededSignature, robotPacks, optimize])

  return {
    packs, fieldPacks, robotPacks,
    fieldPack, fieldModel, gamePieces, robotAssets,
    status, error, refresh,
  }
}
