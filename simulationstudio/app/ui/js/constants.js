// Interface constants: what does not come from the backend and is written in
// more than one place.
//
// MARS Simulation Studio version
// ------------------------------
// Single source: the welcome portal's "STUDIO x" line, the About page, the
// status bar corner and the Diagnostics row all come from here. Before, each
// one read `sim_options().version` --- the crate's version --- and fell back
// to a hand-written "0.1.0" when the backend had not answered yet, so the
// number on the main menu depended on when the screen was drawn.
//
// If it changes, simulationstudio/app/Cargo.toml and
// simulationstudio/app/tauri.conf.json have to change too: those two are read
// by the installer, not the interface.
// `scripts/sync-version.mjs` checks that all three say the same and the
// workflow runs it before packaging, so a version left behind breaks the
// build instead of reaching an installation --- which is how you end up
// staring at a screen that says 0.9.4 without knowing whether it is the old
// one or the change did not work.

export const MSS_VERSION = "0.9.5"

/** How it is written on its own, without the word "version" next to it. */
export const MSS_VERSION_LABEL = `v${MSS_VERSION}`

/**
 * Version of the protocol spoken by the engine, the bridge and the robot
 * code. It is separate from the app's on purpose: the interface moves much
 * faster than the NT4 contract, and mixing them would suggest every release
 * breaks it.
 */
export const MSS_PROTOCOL_VERSION = "0.1.0"
