//! El bridge: lleva el estado de la simulación a NetworkTables.
//!
//! Hace dos cosas a la vez:
//!
//! - **Telemetría** (siempre): el motor publica poses por gz-transport, el
//!   bridge las traduce al marco de WPILib y las escribe en NT4 para la app.
//! - **Lazo de hardware** (solo perfil `vendor`): lee los comandos de motor que
//!   publica el glue del código del robot, se los pasa al motor, y le devuelve
//!   posiciones, velocidades y yaw. Ver src/glue.rs.
//!
//! El servidor NT4 --como en un robot real-- no es nuestro: lo levanta el
//! código del robot. El bridge es un cliente más, igual que la app.
//!
//! Uso:
//!   mars-bridge --robot-map sim/models/testbot/robot-map.json [--nt-host IP]
//!
//! Con `--nt-host` se apunta al servidor NT4 del robot. En simulación de
//! escritorio suele ser localhost, que es lo que asume por defecto.
//!
//! Con `--lockstep-port PUERTO` no hay NT4 ni tiempo real: el glue del robot
//! se conecta por TCP y cada petición avanza la física un paso. El mundo corre
//! con `run` y real_time_factor 0: MarsLink espera cada comando. Ver
//! src/lockstep.rs.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use gz_msgs::actuators::Actuators;
use gz_msgs::clock::Clock;
use gz_msgs::int32::Int32;
use gz_msgs::model::Model;
use gz_msgs::pose_v::Pose_V;

use mars_sim_bridge::field::{yaw_from_quaternion, Field};
use mars_sim_bridge::glue::{self, Glue};
use mars_sim_bridge::nt4::Nt4;
use mars_sim_bridge::protocol as proto;
use mars_sim_bridge::robotmap::RobotMap;
use mars_sim_bridge::wpistruct;

/// Cada cuánto se recalcula y publica el real-time factor. Más rápido que esto
/// solo añade ruido: el RTF es una media móvil, no una lectura instantánea.
const PERIODO_SALUD: Duration = Duration::from_millis(500);

/// Cada cuanto se reintenta la conexion al servidor NT4.
const ESPERA_NT: Duration = Duration::from_secs(2);

/// Valores de /mars/cmd/match (ver topics.toml). El glue solo distingue
/// habilitado de no, asi que el bridge manda teleop: para el motor lo unico que
/// cambia es si aplica par o no.
const MATCH_DISABLED: i32 = 0;
const MATCH_TELEOP: i32 = 2;

struct Args {
    robot_map: PathBuf,
    nt_host: String,
    nt_port: u16,
    lockstep_port: Option<u16>,
}

fn parse_args() -> Result<Args> {
    let mut robot_map = None;
    let mut nt_host = "127.0.0.1".to_string();
    let mut nt_port = 5810u16;
    let mut lockstep_port = None;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--robot-map" => robot_map = it.next().map(PathBuf::from),
            "--nt-host" => nt_host = it.next().ok_or_else(|| anyhow!("--nt-host needs a value"))?,
            "--nt-port" => {
                nt_port = it
                    .next()
                    .ok_or_else(|| anyhow!("--nt-port needs a value"))?
                    .parse()
                    .context("--nt-port is not a number")?
            }
            "--lockstep-port" => {
                lockstep_port = Some(
                    it.next()
                        .ok_or_else(|| anyhow!("--lockstep-port needs a value"))?
                        .parse()
                        .context("--lockstep-port is not a number")?,
                )
            }
            otro => return Err(anyhow!("unknown argument: {otro}")),
        }
    }

    Ok(Args {
        robot_map: robot_map.ok_or_else(|| anyhow!("--robot-map is required"))?,
        nt_host,
        nt_port,
        lockstep_port,
    })
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mapa = RobotMap::load(&args.robot_map)?;
    println!(
        "[bridge] robot '{}', profile '{}', protocol {}",
        mapa.robot, mapa.profile, proto::PROTOCOL_VERSION
    );

    let campo = Field { length_m: proto::FIELD_LENGTH_M, width_m: proto::FIELD_WIDTH_M };

    // --- gz-transport ----------------------------------------------------
    // La API del FFI es sincrónica y entrega canales de crossbeam, así que el
    // lazo principal vive en este hilo y NT4 corre en su propio runtime.
    let mut node = gz_transport::Node::new().ok_or_else(|| anyhow!("could not create the gz node"))?;

    if let Some(puerto) = args.lockstep_port {
        return correr_lockstep(&mut node, &mapa, campo, puerto);
    }

    // Cola de 1 en todos: solo importa el estado más reciente. Una cola larga
    // haría que el bridge publicara poses viejas cuando se atrasa, que es peor
    // que saltarse alguna.
    let poses = node
        .subscribe_channel::<Pose_V>(proto::T_MARS_STATE_POSE, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_MARS_STATE_POSE))?;
    let joints = node
        .subscribe_channel::<Model>(proto::T_MARS_STATE_JOINTS, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_MARS_STATE_JOINTS))?;
    let clock = node
        .subscribe_channel::<Clock>(proto::T_WORLD_MARS_CLOCK, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_WORLD_MARS_CLOCK))?;

    // Publicadores hacia el motor. Solo se usan en perfil `vendor`, pero se
    // anuncian siempre: el discovery de gz-transport es asincrono y anunciar
    // tarde significa perder los primeros comandos.
    let mut act_pub = node
        .advertise::<Actuators>(proto::T_MARS_CMD_ACTUATORS)
        .ok_or_else(|| anyhow!("could not advertise {}", proto::T_MARS_CMD_ACTUATORS))?;
    let mut match_pub = node
        .advertise::<Int32>(proto::T_MARS_CMD_MATCH)
        .ok_or_else(|| anyhow!("could not advertise {}", proto::T_MARS_CMD_MATCH))?;
    println!("[bridge] subscribed to the engine");

    // Un ciclo por SESION de NT4. Cada vez que el codigo del robot se
    // reinicia se cae la conexion, y aqui se vuelve a empezar: reconectar,
    // republicar los schemas y resuscribir el glue. La simulacion sigue
    // corriendo debajo, sin enterarse.
    let arranque = Instant::now();
    let mut publicadas = 0u64;

    'sesion: loop {
        // --- NT4 -------------------------------------------------------------
        // Se reintenta para siempre, y no es una comodidad: el servidor NT4 lo
        // levanta el codigo del robot, que se reinicia cada vez que el equipo
        // compila. Morir cuando no esta obligaria a rearrancar la simulacion
        // entera --- la fisica incluida --- por cada compilacion del robot.
        //
        // Tambien deja arrancar la simulacion ANTES que el codigo del robot, que es
        // el orden natural cuando lo lanza MARS Simulation Studio.
        let rt = tokio::runtime::Runtime::new()?;
        let mut aviso_dado = false;
        let nt = loop {
            match rt.block_on(Nt4::connect(&args.nt_host, args.nt_port, "MARS-Sim")) {
                Ok(nt) => break nt,
                Err(e) => {
                    // Un aviso, no uno cada dos segundos: esto puede estar
                    // esperando minutos mientras alguien compila.
                    if !aviso_dado {
                        aviso_dado = true;
                        println!(
                            "[bridge] waiting for the NT4 server at {}:{} ({e}). Robot code brings it up.",
                            args.nt_host, args.nt_port
                        );
                    }
                    std::thread::sleep(ESPERA_NT);
                }
            }
        };
        println!("[bridge] NT4 connected to {}:{}", args.nt_host, args.nt_port);

        // Los schemas van ANTES que cualquier valor: un struct sin su descriptor
        // publicado llega a la app como un blob que no puede decodificar.
        for s in wpistruct::SCHEMAS {
            nt.set_raw(
                &format!("/.schema/struct:{}", s.name),
                "structschema",
                s.descriptor.as_bytes().to_vec(),
            )?;
        }
        nt.set_string(proto::T_MARS_SIM_STATE, "running")?;

        // --- glue ------------------------------------------------------------
        // Solo en perfil `vendor`. En `hal` el lazo de hardware va por HALSim
        // WebSocket y el bridge no toca los actuadores.
        let glue = if mapa.profile == "vendor" {
            let g = Glue::new(&mapa);
            g.suscribir(&nt)?;
            println!("[bridge] glue active: {} actuators over NT4", g.actuadores());
            Some(g)
        } else {
            println!("[bridge] profile '{}': no glue, telemetry only", mapa.profile);
            None
        };
        let mut habilitado_previo: Option<bool> = None;
    let mut aviso_glue = Instant::now();
    let mut glue_visto = false;

        // Un error escribiendo a NT4 casi siempre es que el codigo del robot
        // se cerro a mitad de escritura (fin de un test, recompilar). Eso no es
        // motivo para morir: se vuelve al principio de la sesion y se espera
        // al servidor, igual que cuando is_connected() da false.
        macro_rules! nt_try {
            ($e:expr) => {
                if let Err(e) = $e {
                    if !nt.is_connected() {
                        println!("
[bridge] the NT4 server went away ({e}); waiting for it to come back");
                        continue 'sesion;
                    }
                    return Err(e);
                }
            };
        }

        // --- lazo principal --------------------------------------------------
        let mut ultima_salud = Instant::now();
        let mut sim_previo = 0.0f64;
        let mut real_previo = 0.0f64;
        // El yaw sale de la pose y lo consume el glue, que corre despues en el
        // mismo ciclo. Se guarda entre iteraciones para que un ciclo sin pose nueva
        // no le mande un cero al giroscopio del robot.
        let mut yaw_actual = 0.0f64;

        loop {
            if !nt.is_connected() {
                // Ni error ni salida: el codigo del robot se reinicia a
                // menudo y la simulacion no tiene por que morir con el. Se
                // vuelve al principio de la sesion y se espera a que vuelva.
                println!("
[bridge] the NT4 server went away; waiting for it to come back");
                continue 'sesion;
            }

            // El lazo va al ritmo de los JOINTS (200 Hz), no de las poses
            // (50 Hz): los encoders son la realimentacion del lazo de velocidad
            // del TalonFX, que corre en el robot, y entregarlos a 50 Hz le mete
            // 20 ms de retraso. Medido con Offseason2026: a 50 Hz el mismo path
            // seguia con 10 cm de RMS contra 2 cm de la sim cinematica.
            //
            // El timeout hace de latido: si el motor se detiene, en vez de
            // bloquearse para siempre el bridge lo dice y marca el estado.
            let joint_actual = match joints.recv_timeout(Duration::from_secs(2)) {
                Ok(j) => j,
                Err(_) => {
                    nt_try!(nt.set_string(proto::T_MARS_SIM_STATE, "paused"));
                    eprintln!("[bridge] no joints from the engine for 2 s");
                    continue;
                }
            };

            // La pose llega a 50 Hz: se publica la mas reciente cuando hay una
            // nueva, y el yaw se conserva entre ciclos sin pose.
            let mut ultima_pose = None;
            while let Ok(p) = poses.try_recv() {
                ultima_pose = Some(p);
            }
            if let Some(msg) = ultima_pose {
                if let Some(pose) = msg.pose.iter().find(|p| p.name == mapa.base_link) {
                    if let (Some(pos), Some(rot)) = (pose.position.as_ref(), pose.orientation.as_ref()) {
                        let (x, y) = campo.to_wpilib(pos.x, pos.y);
                        let yaw = yaw_from_quaternion(rot.w, rot.x, rot.y, rot.z);
                        yaw_actual = yaw;

                        nt_try!(nt.set_raw(
                            proto::T_MARS_SIM_TRUTHPOSE,
                            "struct:Pose2d",
                            wpistruct::pose2d(x, y, yaw),
                        ));
                        nt_try!(nt.set_raw(
                            proto::T_MARS_SIM_TRUTHPOSE3D,
                            "struct:Pose3d",
                            wpistruct::pose3d(x, y, pos.z, rot.w, rot.x, rot.y, rot.z),
                        ));
                        // Redundante con truthPose, pero es la convención de Field2d
                        // de WPILib: con esto la sim se ve en Glass, Shuffleboard y
                        // AdvantageScope sin configurar nada.
                        nt_try!(nt.set_double_array(
                            proto::T_SMARTDASHBOARD_FIELD_ROBOT,
                            &[x, y, yaw.to_degrees()],
                        ));
                        publicadas += 1;
                    }
                }
            }

            // --- lazo de hardware --------------------------------------------
            if let Some(g) = &glue {
            // El fallo mas comun del glue es MUDO: el codigo del robot no
            // publica, o publica con otros nombres, y el robot se queda quieto
            // sin que nada lo explique. Esto lo explica.
            if !glue_visto && aviso_glue.elapsed() >= Duration::from_secs(3) {
                aviso_glue = Instant::now();
                let mut vistos = nt.names_with_prefix(glue::PREFIJO_SALIDA);
                if vistos.is_empty() {
                    eprintln!(
                        "[bridge] nobody is publishing on {}. Without it the engine holds zero \n                         torque and the robot will not move. Check that MarsSimGlue is \n                         constructed and that update() is being called.",
                        glue::PREFIJO_SALIDA
                    );
                } else {
                    glue_visto = true;
                    vistos.sort();
                    println!("
[bridge] glue receiving {} topics:", vistos.len());
                    for t in &vistos {
                        println!("[bridge]   {t}");
                    }
                }
            }

                // Comandos del robot hacia el motor. Van los dos arreglos: cada
                // actuador aporta al que le toca por su modo y el motor lee ese.
                let cmd = g.comandos(&nt);
                let mut msg = Actuators::new();
                msg.normalized = cmd.duty;
                msg.position = cmd.posicion;
                if !act_pub.publish(&msg) {
                    return Err(anyhow!("publishing actuators failed"));
                }
                let habilitado = cmd.habilitado;

                // El estado de partido solo cuando cambia: es un valor pegajoso, no
                // un flujo, y republicarlo 200 veces por segundo solo gasta red.
                if habilitado_previo != Some(habilitado) {
                    let mut m = Int32::new();
                    m.data = if habilitado { MATCH_TELEOP } else { MATCH_DISABLED };
                    if !match_pub.publish(&m) {
                        return Err(anyhow!("publishing the match state failed"));
                    }
                    println!("
[bridge] robot {}", if habilitado { "enabled" } else { "disabled" });
                    habilitado_previo = Some(habilitado);
                }

                // Estado de la fisica de vuelta al robot. Se usa el joint mas
                // reciente y se descarta el resto: aplicar una posicion de hace
                // varios pasos es peor que saltarsela.
                let mut ultimo = joint_actual;
                while let Ok(j) = joints.try_recv() {
                    ultimo = j;
                }
                nt_try!(g.publicar_estado(&nt, &ultimo, yaw_actual));
            } else {
                // Sin glue igual hay que drenar: dejar el canal lleno hace que
                // MarsLink escriba a un buzon saturado.
                let _ = joint_actual;
                while joints.try_recv().is_ok() {}
            }

            if ultima_salud.elapsed() >= PERIODO_SALUD {
                ultima_salud = Instant::now();
                if let Ok(c) = clock.try_recv() {
                    let sim = c.sim.as_ref().map_or(0.0, |t| t.sec as f64 + t.nsec as f64 * 1e-9);
                    let real = c.real.as_ref().map_or(0.0, |t| t.sec as f64 + t.nsec as f64 * 1e-9);

                    nt_try!(nt.set_double(proto::T_MARS_SIM_SIMTIME, sim));

                    // RTF como derivada, no como sim/real acumulado: lo que importa
                    // es si la simulación va al día AHORA. El cociente acumulado
                    // esconde una caída reciente detrás de un buen arranque.
                    let d_sim = sim - sim_previo;
                    let d_real = real - real_previo;
                    if d_real > 1e-6 {
                        let rtf = d_sim / d_real;
                        nt_try!(nt.set_double(proto::T_MARS_SIM_REALTIMEFACTOR, rtf));
                        // Por debajo de esto el código del robot corre su ciclo de
                        // 20 ms contra una física más lenta, y cualquier ganancia
                        // que se afine ahí no transfiere al robot real.
                        if rtf < 0.95 {
                            eprintln!("[bridge] real-time factor {rtf:.2}: the simulation is falling behind");
                        }
                    }
                    sim_previo = sim;
                    real_previo = real;
                    nt_try!(nt.set_string(proto::T_MARS_SIM_STATE, "running"));
                }

                let s = arranque.elapsed().as_secs_f64();
                print!("\r[bridge] {publicadas} poses ({:.0} Hz)   ", publicadas as f64 / s);
                use std::io::Write;
                let _ = std::io::stdout().flush();
            }
        }
    }
}

/// El modo lockstep: sus propias suscripciones, con capacidad de sobra, porque
/// `subscribe_channel` usa `try_send` y con un canal lleno pierde el mensaje
/// NUEVO. Ver src/lockstep.rs.
fn correr_lockstep(
    node: &mut gz_transport::Node,
    mapa: &RobotMap,
    campo: Field,
    puerto: u16,
) -> Result<()> {
    use mars_sim_bridge::lockstep::{Canales, Lockstep};

    let joints = node
        .subscribe_channel::<Model>(proto::T_MARS_STATE_JOINTS, 256)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_MARS_STATE_JOINTS))?;
    let poses = node
        .subscribe_channel::<Pose_V>(proto::T_MARS_STATE_POSE, 256)
        .ok_or_else(|| anyhow!("could not subscribe to {}", proto::T_MARS_STATE_POSE))?;
    let mut act_pub = node
        .advertise::<Actuators>(proto::T_MARS_CMD_ACTUATORS)
        .ok_or_else(|| anyhow!("could not advertise {}", proto::T_MARS_CMD_ACTUATORS))?;
    let mut match_pub = node
        .advertise::<Int32>(proto::T_MARS_CMD_MATCH)
        .ok_or_else(|| anyhow!("could not advertise {}", proto::T_MARS_CMD_MATCH))?;

    // Mismo respiro que el modo normal: el discovery de gz-transport es
    // asincrono y el primer paso no puede salir antes de que el motor nos vea.
    std::thread::sleep(Duration::from_millis(800));
    println!("[bridge] lockstep mode");

    Lockstep::new(mapa, campo, Canales { joints, poses }, &mut act_pub, &mut match_pub)
        .servir(puerto)
}
