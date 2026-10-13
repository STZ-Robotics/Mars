//! Bridge de simulación de MARS.
//!
//! Traduce entre gz-transport (el motor), HALSim WebSocket (el código del
//! robot) y NT4 (la app). El contrato está en sim/protocol/.

pub mod field;
pub mod glue;
pub mod lockstep;
pub mod nt4;
pub mod robotmap;
pub mod wpistruct;

/// Constantes generadas de `sim/protocol/topics.toml` en tiempo de compilación.
///
/// Nombres de tópico, versión del protocolo y dimensiones de la cancha. Ver
/// build.rs: renombrar un tópico en el manifiesto rompe la compilación aquí,
/// que es justo lo que se quiere de una fuente única de verdad.
pub mod protocol {
    include!(concat!(env!("OUT_DIR"), "/protocol.rs"));
}
