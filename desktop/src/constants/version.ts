// MARS Desktop's version.
//
// Single source: the loading screen's version comes from here (vite injects it
// into index.html at build time, see the `marsVersion` plugin in
// vite.config.ts), and so does whatever "About" screen comes later. If it
// changes, package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json
// have to change too: the installer and the packager read those three, not the
// bundle.
//
// `scripts/sync-version.mjs` checks that all four agree, and the release
// workflow runs it before packaging: a version that has drifted breaks the
// build instead of reaching a published release.
//
// vite.config.ts imports this file and runs it in Node, so it cannot depend on
// anything from the bundle. The compiled edition lives in `edition.ts`.

export const MARS_VERSION = "1.1.8"

/** How it is written on screen. */
export const MARS_VERSION_LABEL = `v${MARS_VERSION}`
