//! What MARS Simulation Studio needs from the disk: worlds, robots, files and
//! preferences.
//!
//! The supervisor (`supervisor.rs`) only knows how to *start* a simulation.
//! Everything about authoring --- creating a world, importing it, editing it,
//! reading a robot map --- lives here, kept apart on purpose: a failure writing
//! an SDF has no business being able to touch the code that kills processes.
//!
//! # Managed worlds
//!
//! A world created from the Studio is saved TWICE: the `.sdf` that Gazebo
//! consumes and a `.studio.json` next to it with the properties that produced
//! it. That JSON is what makes it possible to reopen the property tree and
//! rewrite the SDF without losing anything.
//!
//! An `.sdf` without its JSON is an EXTERNAL world: it can be read, run and
//! edited by hand, but the property tree does not touch it. Regenerating a
//! hand-written SDF from the little a regex can pull out of it would silently
//! destroy someone else's work, which is worse than not offering the button.
//!
//! # Modules
//!
//! | module | what |
//! |---|---|
//! | [`paths`] | resolving UI paths against `sim/` without escaping it |
//! | [`library`] | the world and robot libraries |
//! | [`fields`] | the 3D FRC fields a world can carry |
//! | [`worldgen`] | `WorldSpec` and the SDF it generates |
//! | [`worlds`] | saving, duplicating, importing and deleting worlds |
//! | [`generators`] | worlds written by a script (`worlds/gen_<name>.py`) |
//! | [`files`] | raw text files, the file browser and preferences |

mod fields;
mod files;
mod generators;
mod library;
mod paths;
mod worldgen;
mod worlds;

pub use fields::{install_field, list_fields, FieldInfo};
pub use files::{browse, prefs, read_text, reveal, save_prefs, write_text, Listing};
pub use generators::{generate_world, generator_options};
pub use library::{list_robots, list_worlds, RobotInfo, WorldInfo};
pub use worldgen::{generate_sdf, WorldSpec};
pub use worlds::{delete_world, duplicate_world, import_world, read_spec, save_world};
