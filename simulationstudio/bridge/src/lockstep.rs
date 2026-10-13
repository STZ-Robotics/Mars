//! Lockstep: el código del robot marca el paso de la física.
//!
//! En tiempo real, robot y física corren cada uno con su reloj y se hablan por
//! NT4. Funciona, pero cada corrida sale distinta (±10% medido con
//! Offseason2026) y una máquina cargada degrada la física en vez de ir más
//! lenta. En lockstep el robot manda los comandos de un paso, la física avanza
//! exactamente ese paso, y el robot no sigue hasta tener el estado resultante.
//!
//! Quien espera es MarsLink: con comandos que traen `header.data["seq"]`, cada
//! paso de física se bloquea en PreUpdate hasta el comando con el siguiente
//! seq, y publica joints y pose con ese mismo seq. El mundo corre SIN pausa y
//! con real_time_factor 0, así que no hay servicios ni pausas de por medio.
//! (Una primera versión pausaba el mundo y pedía cada paso por
//! /world/<mundo>/control: el servidor tardaba ~11 ms en atender cada paso
//! desde la pausa y el lockstep iba a 0.26x.)
//!
//! Por qué TCP y no NT4 entre el robot y el bridge: NT4 entrega como mucho
//! cada 5 ms (`periodic` mínimo), o sea ≥10 ms por ida y vuelta para un paso
//! de 4 ms. Un socket local tarda decenas de microsegundos.
//!
//! Protocolo (little-endian), una petición → una respuesta:
//!
//! ```text
//! petición:  u32 MAGIA | u64 seq | u8 habilitado | u32 pasos | u32 n | n × f64
//!            (un valor por actuador, en el orden del robot-map: duty en
//!            [-1, 1] para modo duty, consigna en rad del MOTOR para modo
//!            posición --- las mismas unidades que /MARS/Glue/out/*. Con
//!            `pasos` > 1 el mismo comando se sostiene durante varios pasos.)
//! respuesta: u32 MAGIA | u64 seq | f64 t_sim | f64 x | f64 y | f64 yaw
//!            | u32 n | n × (f64 pos, f64 vel)
//!            (x, y, yaw: la pose real en el marco de WPILib; pos y vel en rad
//!            y rad/s del MOTOR, como /MARS/Glue/in/*)
//! ```

use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::Receiver;

use gz_msgs::actuators::Actuators;
use gz_msgs::header::{header::Map, Header};
use gz_msgs::int32::Int32;
use gz_msgs::model::Model;
use gz_msgs::pose_v::Pose_V;
use gz_transport::Publisher;

use crate::field::{yaw_from_quaternion, Field};
use crate::robotmap::{Control, RobotMap};

/// "MLS1" en ASCII. Si no coincide, el otro lado no habla este protocolo.
pub const MAGIA: u32 = 0x4D4C_5331;

/// Valores de /mars/cmd/match (ver topics.toml).
const MATCH_DISABLED: i32 = 0;
const MATCH_TELEOP: i32 = 2;

/// Cuánto esperar el estado de un paso antes de declarar colgado el motor.
const ESPERA_MOTOR: Duration = Duration::from_secs(3);

/// Cada cuánto reenviar un comando sin respuesta. El primero de una conexión
/// nueva de gz-transport a veces se pierde mientras termina el discovery; un
/// reenvío con el mismo seq no cuenta como paso nuevo en MarsLink.
const REENVIO: Duration = Duration::from_millis(50);

/// Los canales que necesita el lockstep, ya suscritos con capacidad de sobra:
/// `subscribe_channel` usa `try_send`, y con un canal lleno se pierde el
/// mensaje NUEVO.
pub struct Canales {
    pub joints: Receiver<Model>,
    pub poses: Receiver<Pose_V>,
}

pub struct Lockstep<'a> {
    mapa: &'a RobotMap,
    campo: Field,
    canales: Canales,
    act_pub: &'a mut Publisher<Actuators>,
    match_pub: &'a mut Publisher<Int32>,
    habilitado_previo: Option<bool>,
    /// El seq que va a MarsLink. Propio del bridge y nunca se reinicia: si se
    /// reiniciara con el robot, MarsLink veria seqs "viejos" y no avanzaria.
    seq_fisica: u64,
    ultimo_stamp: f64,
    ultima_pose: (f64, f64, f64),
    /// Tiempo de pared por paso: esperando el estado de la física.
    espera_fisica: Duration,
}

impl<'a> Lockstep<'a> {
    pub fn new(
        mapa: &'a RobotMap,
        campo: Field,
        canales: Canales,
        act_pub: &'a mut Publisher<Actuators>,
        match_pub: &'a mut Publisher<Int32>,
    ) -> Self {
        Self {
            mapa,
            campo,
            canales,
            act_pub,
            match_pub,
            habilitado_previo: None,
            seq_fisica: 0,
            ultimo_stamp: 0.0,
            ultima_pose: (0.0, 0.0, 0.0),
            espera_fisica: Duration::ZERO,
        }
    }

    /// Atiende clientes para siempre, uno a la vez. Un robot que se reinicia
    /// cierra el socket; se vuelve a escuchar y la física queda donde estaba.
    pub fn servir(&mut self, puerto: u16) -> Result<()> {
        let oyente = TcpListener::bind(("127.0.0.1", puerto))
            .with_context(|| format!("could not listen on 127.0.0.1:{puerto}"))?;
        println!("[lockstep] waiting for the robot on 127.0.0.1:{puerto}");
        loop {
            let (socket, desde) = oyente.accept()?;
            println!("[lockstep] robot connected from {desde}");
            match self.sesion(socket) {
                Ok(pasos) => println!("[lockstep] robot disconnected after {pasos} steps"),
                Err(e) => eprintln!("[lockstep] session ended: {e:#}"),
            }
        }
    }

    fn sesion(&mut self, socket: TcpStream) -> Result<u64> {
        socket.set_nodelay(true)?;
        let mut entrada = BufReader::new(socket.try_clone()?);
        let mut salida = BufWriter::new(socket);
        let n = self.mapa.actuators.len();
        let mut pasos = 0u64;
        let mut pasos_reporte = 0u64;
        self.espera_fisica = Duration::ZERO;
        let mut t_reporte = Instant::now();
        let mut t_sim_reporte = self.ultimo_stamp;

        loop {
            // --- petición ---
            let magia = match leer_u32(&mut entrada) {
                Ok(m) => m,
                // EOF limpio: el robot se cerró entre pasos.
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(pasos),
                Err(e) => return Err(e.into()),
            };
            if magia != MAGIA {
                bail!("bad magic {magia:#x}: the other side is not a lockstep glue");
            }
            let seq_robot = leer_u64(&mut entrada)?;
            let habilitado = leer_u8(&mut entrada)? != 0;
            let cuantos = leer_u32(&mut entrada)?.max(1);
            let recibidos = leer_u32(&mut entrada)? as usize;
            if recibidos != n {
                bail!("the robot sent {recibidos} actuator values; the robot-map has {n}");
            }
            let mut valores = vec![0.0; n];
            for v in valores.iter_mut() {
                *v = leer_f64(&mut entrada)?;
            }

            // --- pasos ---
            self.publicar_partido(habilitado)?;
            let mut joints = None;
            for _ in 0..cuantos {
                joints = Some(self.paso(&valores)?);
            }
            let joints = joints.expect("cuantos >= 1");

            // --- respuesta ---
            escribir_u32(&mut salida, MAGIA)?;
            escribir_u64(&mut salida, seq_robot)?;
            escribir_f64(&mut salida, self.ultimo_stamp)?;
            escribir_f64(&mut salida, self.ultima_pose.0)?;
            escribir_f64(&mut salida, self.ultima_pose.1)?;
            escribir_f64(&mut salida, self.ultima_pose.2)?;
            escribir_u32(&mut salida, n as u32)?;
            for a in &self.mapa.actuators {
                let (pos, vel) = joints
                    .joint
                    .iter()
                    .find(|j| j.name == a.joint)
                    .and_then(|j| j.axis1.as_ref())
                    .map(|ax| (ax.position * a.gear_ratio, ax.velocity * a.gear_ratio))
                    .unwrap_or((0.0, 0.0));
                escribir_f64(&mut salida, pos)?;
                escribir_f64(&mut salida, vel)?;
            }
            salida.flush()?;

            pasos += cuantos as u64;
            pasos_reporte += cuantos as u64;
            if t_reporte.elapsed() >= Duration::from_secs(2) {
                let pared = t_reporte.elapsed().as_secs_f64();
                println!(
                    "[lockstep] {pasos} steps, {:.2}x real time | {:.2} ms/step waiting on physics, {:.2} ms/step total",
                    (self.ultimo_stamp - t_sim_reporte) / pared,
                    self.espera_fisica.as_secs_f64() * 1e3 / pasos_reporte as f64,
                    pared * 1e3 / pasos_reporte as f64,
                );
                t_reporte = Instant::now();
                t_sim_reporte = self.ultimo_stamp;
                pasos_reporte = 0;
                self.espera_fisica = Duration::ZERO;
            }
        }
    }

    fn publicar_partido(&mut self, habilitado: bool) -> Result<()> {
        if self.habilitado_previo == Some(habilitado) {
            return Ok(());
        }
        let mut m = Int32::new();
        m.data = if habilitado { MATCH_TELEOP } else { MATCH_DISABLED };
        if !self.match_pub.publish(&m) {
            bail!("publishing the match state failed");
        }
        // Cambia una vez por partido y viaja por otro tópico que el comando:
        // un respiro corto para que llegue antes del próximo paso.
        std::thread::sleep(Duration::from_millis(20));
        self.habilitado_previo = Some(habilitado);
        Ok(())
    }

    /// Un paso de física con estos valores. Devuelve los joints de ESE paso.
    fn paso(&mut self, valores: &[f64]) -> Result<Model> {
        self.seq_fisica += 1;
        let seq = self.seq_fisica;

        let mut msg = Actuators::new();
        msg.normalized = vec![0.0; valores.len()];
        msg.position = vec![0.0; valores.len()];
        for (i, a) in self.mapa.actuators.iter().enumerate() {
            match a.control {
                Control::Duty => msg.normalized[i] = valores[i].clamp(-1.0, 1.0),
                Control::Position => msg.position[i] = valores[i] / a.gear_ratio,
            }
        }
        let mut cabecera = Header::new();
        let mut dato = Map::new();
        dato.key = "seq".into();
        dato.value = vec![seq.to_string()];
        cabecera.data.push(dato);
        msg.header = Some(cabecera).into();

        let t0 = Instant::now();
        let limite = t0 + ESPERA_MOTOR;
        let joints = 'esperar: loop {
            if !self.act_pub.publish(&msg) {
                bail!("publishing actuators failed");
            }
            let reenvio = (Instant::now() + REENVIO).min(limite);
            loop {
                match self.canales.joints.recv_deadline(reenvio) {
                    Ok(j) => match seq_de(&j.header) {
                        Some(s) if s == seq => break 'esperar j,
                        // De un paso anterior, o de antes de entrar en lockstep.
                        _ => continue,
                    },
                    Err(_) => break,
                }
            }
            if Instant::now() >= limite {
                return Err(anyhow!(
                    "no physics state for step {seq}: is mars-sim-server running the world \
                     with `run`, and is MarsLink built with lockstep support?"
                ));
            }
        };
        self.ultimo_stamp = stamp(&joints.header);

        // La pose sale en el mismo PostUpdate que los joints, con el mismo seq.
        let limite_pose = Instant::now() + Duration::from_millis(20);
        while let Ok(p) = self.canales.poses.recv_deadline(limite_pose) {
            let es_este = seq_de(&p.header) == Some(seq);
            if let Some(base) = p.pose.iter().find(|q| q.name == self.mapa.base_link) {
                if let (Some(pos), Some(rot)) = (base.position.as_ref(), base.orientation.as_ref()) {
                    let (x, y) = self.campo.to_wpilib(pos.x, pos.y);
                    self.ultima_pose = (x, y, yaw_from_quaternion(rot.w, rot.x, rot.y, rot.z));
                }
            }
            if es_este {
                break;
            }
        }
        self.espera_fisica += t0.elapsed();
        Ok(joints)
    }
}

fn seq_de(h: &gz_msgs::protobuf::MessageField<Header>) -> Option<u64> {
    h.as_ref()?
        .data
        .iter()
        .find(|d| d.key == "seq")
        .and_then(|d| d.value.first())
        .and_then(|v| v.parse().ok())
}

fn stamp(h: &gz_msgs::protobuf::MessageField<Header>) -> f64 {
    h.as_ref()
        .and_then(|h| h.stamp.as_ref())
        .map(|t| t.sec as f64 + t.nsec as f64 * 1e-9)
        .unwrap_or(-1.0)
}

fn leer_u8(r: &mut impl Read) -> std::io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}
fn leer_u32(r: &mut impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn leer_u64(r: &mut impl Read) -> std::io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}
fn leer_f64(r: &mut impl Read) -> std::io::Result<f64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(f64::from_le_bytes(b))
}
fn escribir_u32(w: &mut impl Write, v: u32) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
fn escribir_u64(w: &mut impl Write, v: u64) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
fn escribir_f64(w: &mut impl Write, v: f64) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
