# MARS Simulation Studio

The simulation application. It is a **separate** product from mars-desktop.

```
cargo build          # or ..\verify.ps1, which builds and tests it
cargo run
```

## Why it is a separate app

mars-desktop carries a single button — *Simulation Studio*, in the Sidebar's
Connection group — and that button launches this executable. Nothing from
Gazebo goes into the dashboard.

The reason is risk, not taste. The simulation drags in the whole conda
environment: Gazebo, its plugins and its dependencies. That weight has no
business travelling in the bundle of the app the team uses **at competition**,
and the simulation can hang, be updated or be reinstalled without touching it.

The process is launched and let go. Closing mars-desktop does not close the
simulation: they are two different life cycles and that is deliberate.

## What it does

Two things, and they live in two different modules because they are two
different risks.

**Running the simulation** (`src/supervisor.rs`). It supervises the three
processes: the engine (`mars-sim-server`), the world window (`mars-sim-gui`)
and the bridge (`mars-bridge`). None of them can be launched "bare" — they need
the conda environment on the PATH for their DLLs, the gz-sim and gz-gui plugin
paths, OGRE's RenderSystem path, and the right working directory so the
worlds' paths resolve.

**Writing what the simulation consumes** (`src/studio/`). The worlds, the props
in them, and reading the robot maps. A failure writing an SDF has no business
being able to touch the code that kills processes, so they do not share a
module.

| `src/studio/` | what |
|---|---|
| `paths.rs` | resolving UI paths against `sim/` without escaping it |
| `library.rs` | the world and robot libraries |
| `fields.rs` | the 3D FRC fields, and the material patch below |
| `worldgen.rs` | `WorldSpec` and the SDF it generates, FUEL seeding included |
| `worlds.rs` | saving, duplicating, importing and deleting worlds |
| `generators.rs` | worlds written by a script (`worlds/gen_<name>.py --options`) |
| `files.rs` | raw text files, the file browser and preferences |

## What it does NOT do

**It does not draw the robot.** The Gazebo window does that, showing the
physics, and so does mars-desktop, which receives the poses over NT4 exactly as
from a real robot. Duplicating the viewer here would mean maintaining two.

## Managed worlds and external worlds

A world created from the Studio is saved **twice**: the `.sdf` Gazebo consumes
and a `.studio.json` next to it with the properties that produced it. That JSON
is what makes it possible to reopen the property tree and rewrite the SDF
without losing anything.

An `.sdf` without its JSON is an **external** world: it is run, read and edited
as XML, but the property tree does not touch it. Regenerating a hand-written
SDF from the little a regex can pull out of it would silently destroy someone
else's work, which is worse than not offering the button.

The `<world name>` it generates is always `mars`. It is not a default: it is a
contract. gz-sim's standard topics carry it embedded (`/world/mars/clock`) and
`sim/protocol/check.py` rejects any SDF in `worlds/` that declares another.

> **The `.studio.json` field names were renamed into English.** Files written
> by an older Studio (`paso`, `cancha_largo`, ...) still open: every renamed
> field keeps its old name as a `serde(alias)`, and the file is rewritten with
> the new names the next time it is saved. `old_studio_json_still_reads` in
> `src/studio/worldgen.rs` is the tripwire.

## The FRC field

`sim/fields/<name>/` holds a field in AdvantageScope's format (`config.json` +
`model.glb`), the same one mars-desktop's 3D Field consumes. The **Field
Library** page finds on its own the ones the dashboard has installed in
`%APPDATA%/MARS/assets3d/` and copies them into the project.

It goes into the world as **a visual and nothing more**. The 2026 field is
~2.9 M triangles: as collision it would have the solver resolve mesh-mesh
contact and the real-time factor would sink. The physics still comes from the
ground plane and the walls, so the robot drives through field elements ---
they are scenery.

Installing also **prepares the mesh**: the official models declare almost all
of their materials as metallic, and a metal under a PBR renderer with no
environment map reflects black. The field loaded, the physics ran, and on
screen there was a field-shaped black blot. `flatten_metals` sets the metallic
factor to zero, which is the same fix AdvantageScope makes by forcing
`MeshPhongMaterial`.

> The patch is **at the byte level, keeping the length**. Reserializing the
> glTF's JSON leaves a valid file that **hangs the Gazebo window** (tested: more
> than eight minutes without opening against the original's thirty seconds).
> Replacing the number with another of the same length does not move a single
> offset in the file.

**The origin is the CENTER.** The robot starts at Gazebo's `0,0`, which is the
center of the field; the corner origin WPILib uses is produced by the bridge
adding half a field (`../bridge/src/field.rs`). That is why the mesh goes at
`0 0 0` and not shifted: moving it so its corner lands on the origin would
offset every pose by half a field, without any error.

## The interface

Still no bundler and no framework: `ui/` is ES modules the browser resolves on
its own, so `cargo build` is all the build there is. What there is now is
structure — `css/tokens.css` is a literal copy of mars-desktop's palette, and
`js/ui.js` reimplements as functions the same components (Panel, PropertyRow,
AlertBanner, StatusBadge) that are React over there. The two products have to
look like the same program.

Every control that needs explaining carries a `?` next to it; the texts live in
`js/help.js` and can be read whole on the **Help Topics** page.

> **The UI is embedded in the binary.** `tauri-build` only watches
> `tauri.conf.json`, so without the `rerun-if-changed` our `build.rs` emits over
> `ui/`, editing a `.js` and rebuilding rebuilds nothing: cargo says
> "Finished", the app opens with the previous version and the change does not
> show up, without any error.

### Killing for real

On Windows **killing the parent does not kill the children**. If this app
closes without going through `stop`, an engine and a bridge stay alive holding
the gz-transport topics, and the next start finds two engines publishing on
`/mars/state/pose`: the poses overwrite each other without any error.

That is why it kills in three places — in `stop`, in `Drop`, and in the
window's close event. All three are needed and none covers the others.

**Known limit:** if the app dies abruptly (killed from Task Manager, or a
process crash), none of the three runs and the orphans stay. The robust way out
would be a Windows Job Object; it is not there.

### Crash detection

`status()` calls `try_wait` on each child. Without it the UI would say
"Running" forever after a crash, which is the worst way to fail: silently.
When one of the two dies, the other is stopped — it has nobody to talk to.

## Headless mode

```
mars-sim-app --headless [seconds]
```

Starts, waits and stops, with an exit code. It exists so the supervisor can be
verified in CI, where there is no screen. It is step 8 of
`simulationstudio/verify.ps1`. Set `MARS_WITH_WINDOW=1` to include the 3D
window and test the full path of the Start button.

It also checks that no process is left alive after `stop`, which is what
tells "we asked them to stop" from "they stopped".

## Where it looks for things

| What | Search order |
|---|---|
| `sim/` | `MARS_SIM_DIR`, then going up from the executable and from the current directory |
| conda environment | `MARS_CONDA_ENV`, `CONDA_PREFIX`, then `~/miniforge3/envs/mars-sim` and equivalents |

The executable is checked before the current directory because it is the only
reliable thing when another process launches the app — which is exactly what
mars-desktop's button does.

The **Diagnostics** page checks all of this one thing at a time and says how
to fix whatever is missing: almost every failure of this app is an
installation one and none explains itself.

## Local state

`sim/build/studio-prefs.json` holds what the UI remembers between sessions —
last page, chosen world and robot, NT4 host, recent worlds and whether the
welcome portal opens at startup. It goes in `build/` because it is local, not
something that goes into the repository. Keys written by an older Studio are
carried over on read (`migratePrefs` in `ui/js/core.js`).
