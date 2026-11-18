# Complete-edition code

This folder holds what only the Complete edition of MARS Desktop has. MARS Desktop
ships in two editions:

| Edition | What it has | Who it is for |
|---|---|---|
| **Full** | Everything: NetworkTables + the MARS framework (projects, packages, manifest, wizard, features, subsystem status, watchdog) | Teams using MARS |
| **Tools** | Just the dashboard: NetworkTables, 2D/3D visualisers, swerve, mechanisms, telemetry, plots, equations, SysId, loop timing, bandwidth, console, preferences, `.wpilog` files | Teams who want the tool without adopting the framework |

## How MARS is actually removed

It is not a runtime `if`. Tools does **not compile** the MARS code:

- **Front end**: everything that depends on the framework is imported from a
  single module, `@mars`. The alias in `vite.config.ts` resolves it to
  `src/mars/index.tsx` (Full) or `src/mars/index.tools.tsx` (Tools). The stub
  imports no pages, so those pages end up with no importers and rollup keeps
  them out of the bundle.
- **Rust**: the `feature_gen`, `subsystem_gen`, `source_map` and `simlauncher`
  modules, plus the project commands, sit behind cargo's `mars` feature (on by
  default). Tools is built with `--no-default-features` and those
  `#[tauri::command]`s do not even exist in the binary.

To check it:

```bash
MARS_EDITION=tools npm run build
grep -rl "MarsFeature" dist/assets   # must return nothing
```

## Adding a feature that depends on MARS

1. The page goes in `src/pages/`, like any other.
2. It is imported and routed **only** in `src/mars/index.tsx`.
3. Its navigation entry is added to `PROJECT_ITEMS`, `MODULE_ITEMS` or
   `CONFIG_ITEMS` in the same file; the sidebar, the menu and the welcome screen
   read from there and keep no lists of their own.
4. If it needs Rust, the module goes behind `#[cfg(feature = "mars")]`.

If the feature only uses NetworkTables, **it does not belong here**: it goes
straight into `App.tsx`, which is what both editions share.

The contract between the two implementations is in `types.ts` (`MarsSurface`),
and each file assigns itself to that type: if one edition drifts, `tsc` fails
rather than the running app.
