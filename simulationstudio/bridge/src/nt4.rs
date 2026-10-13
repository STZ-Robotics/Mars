//! Cliente NT4 mínimo: publicar y suscribirse.
//!
//! Publica los tópicos `[[nt]]` de sim/protocol/topics.toml y se suscribe a los
//! `[[glue]]` que vienen del código del robot. Sigue quedando fuera casi todo un
//! cliente completo -- buffer de historia, contabilidad de ancho de banda,
//! reconexión -- porque el bridge no los necesita.
//!
//! **Por qué no se reutiliza `src-tauri/src/nt4/client.rs`.** Ese cliente es de
//! consumo y tiene Tauri tejido por todo su bucle de reconexión: emite cinco
//! eventos distintos al frontend y saca su propia instancia de
//! `state::<NT4State>()`. Desacoplarlo significaría refactorizar código que
//! funciona, con riesgo de regresión en la app.
//!
//! Esta decisión se revisó al llegar el perfil `vendor`, que sí necesita
//! suscribirse -- era el disparador anotado. Se mantuvo: añadir suscripción por
//! prefijo a este cliente son ~60 líneas, mientras que sacar Tauri del bucle de
//! reconexión del otro es un refactor con riesgo real y no deja nada mejor.
//!
//! El formato de cable es el mismo que implementa el cliente de la app, y sigue
//! la spec de NT4.1.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

/// Cada cuánto se manda el ping de round trip (id -1). Con uno solo al conectar
/// el offset queda clavado al arranque y va derivando con el reloj del equipo.
const RTT_PERIOD: Duration = Duration::from_millis(250);

/// Índices de tipo de la spec de NT4. Todo lo binario comparte el 5: structs de
/// WPILib, sus schemas y el raw suelto.
pub const TYPE_DOUBLE: i32 = 1;
pub const TYPE_INT: i32 = 2;
pub const TYPE_STRING: i32 = 4;
pub const TYPE_RAW: i32 = 5;
pub const TYPE_DOUBLE_ARRAY: i32 = 17;

fn now_epoch_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

/// Lo ultimo recibido de cada topico suscrito, por NOMBRE.
///
/// El bridge quiere el valor mas reciente, no un historial: los comandos de
/// motor se reemplazan 200 veces por segundo y guardar los viejos solo serviria
/// para aplicar uno caducado.
pub type Valores = Arc<Mutex<HashMap<String, rmpv::Value>>>;

pub struct Nt4 {
    tx: mpsc::UnboundedSender<Message>,
    /// nombre de tópico -> pubuid. Publicar es idempotente: el primer `set` de
    /// un nombre manda el anuncio, los siguientes solo el valor.
    published: Mutex<HashMap<String, i32>>,
    next_pubuid: AtomicI32,
    offset_us: Arc<AtomicI64>,
    offset_valid: Arc<AtomicBool>,
    valores: Valores,
    next_subuid: AtomicI32,
}

impl Nt4 {
    /// Conecta y deja corriendo las tareas de lectura, escritura y ping.
    pub async fn connect(host: &str, port: u16, client_name: &str) -> Result<Arc<Self>> {
        let url = format!("ws://{host}:{port}/nt/{client_name}");
        let mut request = url.as_str().into_client_request()?;
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            "v4.1.networktables.first.wpi.edu".parse()?,
        );

        let (stream, _) = tokio_tungstenite::connect_async(request).await?;
        let (mut sink, mut source) = stream.split();

        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let offset_us = Arc::new(AtomicI64::new(0));
        let offset_valid = Arc::new(AtomicBool::new(false));

        // Escritura: un único punto de salida al socket, alimentado por un
        // canal sin límite. Así `set` puede llamarse desde cualquier hilo sin
        // ser async, que es lo que necesita el lazo de gz-transport.
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        });

        // Lectura: respuestas de RTT, anuncios de topico y valores.
        let off = offset_us.clone();
        let valid = offset_valid.clone();
        let valores: Valores = Arc::new(Mutex::new(HashMap::new()));
        let valores_rx = valores.clone();
        // NT4 anuncia cada topico con un id numerico y despues manda los
        // valores solo con ese id. Sin esta tabla los datos llegan sin saber a
        // que topico pertenecen.
        let mut ids: HashMap<i64, String> = HashMap::new();
        // Con MARS_NT_DEBUG=1 se vuelca el cable. Es la unica forma de
        // distinguir "no me suscribi bien" de "el servidor no anuncia".
        let depurar = std::env::var("MARS_NT_DEBUG").is_ok();

        tokio::spawn(async move {
            while let Some(Ok(msg)) = source.next().await {
                // Los mensajes de texto son el canal de control: announce,
                // unannounce, properties.
                if let Message::Text(txt) = &msg {
                    if depurar {
                        eprintln!("[nt<-] {txt}");
                    }
                    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(txt) {
                        for m in arr {
                            let metodo = m.get("method").and_then(|v| v.as_str()).unwrap_or("");
                            let params = m.get("params");
                            let (Some(p), true) = (params, metodo == "announce") else {
                                if metodo == "unannounce" {
                                    if let Some(id) =
                                        params.and_then(|p| p.get("id")).and_then(|v| v.as_i64())
                                    {
                                        ids.remove(&id);
                                    }
                                }
                                continue;
                            };
                            if let (Some(name), Some(id)) = (
                                p.get("name").and_then(|v| v.as_str()),
                                p.get("id").and_then(|v| v.as_i64()),
                            ) {
                                ids.insert(id, name.to_string());
                            }
                        }
                    }
                    continue;
                }

                let Message::Binary(bin) = msg else { continue };
                let mut cursor = std::io::Cursor::new(&bin[..]);
                while (cursor.position() as usize) < bin.len() {
                    let Ok(record) =
                        rmp_serde::from_read::<_, (i32, u64, i32, rmpv::Value)>(&mut cursor)
                    else {
                        break;
                    };
                    // El id -1 no es un tópico: es la respuesta al ping.
                    if record.0 != -1 {
                        if depurar {
                            eprintln!("[nt<-] value id={} known={}", record.0,
                                      ids.contains_key(&(record.0 as i64)));
                        }
                        if let Some(nombre) = ids.get(&(record.0 as i64)) {
                            if let Ok(mut v) = valores_rx.lock() {
                                v.insert(nombre.clone(), record.3);
                            }
                        }
                        continue;
                    }
                    let Some(sent_at) = record.3.as_u64() else { continue };
                    let now = now_epoch_us();
                    // Se asume viaje simétrico: la mitad del round trip es lo
                    // que tardó la respuesta desde que el servidor la marcó.
                    let latency = (now.saturating_sub(sent_at) / 2) as i64;
                    let server_at_rx = record.1 as i64 + latency;
                    off.store(server_at_rx - now as i64, Ordering::SeqCst);
                    valid.store(true, Ordering::SeqCst);
                }
            }
        });

        let nt = Arc::new(Self {
            tx,
            published: Mutex::new(HashMap::new()),
            next_pubuid: AtomicI32::new(1),
            offset_us,
            offset_valid,
            valores,
            next_subuid: AtomicI32::new(1),
        });

        nt.send_rtt();
        let pinger = nt.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(RTT_PERIOD);
            loop {
                ticker.tick().await;
                if pinger.tx.is_closed() {
                    return;
                }
                pinger.send_rtt();
            }
        });

        Ok(nt)
    }

    fn send_rtt(&self) {
        let payload: (i32, u64, i32, u64) = (-1, 0, TYPE_INT, now_epoch_us());
        if let Ok(bin) = rmp_serde::to_vec(&payload) {
            let _ = self.tx.send(Message::Binary(bin.into()));
        }
    }

    /// Hora del SERVIDOR en µs, o None mientras no se haya sincronizado.
    ///
    /// NT4 marca los valores en la escala del servidor, no en epoch Unix.
    /// Mandar epoch mete un número cinco órdenes de magnitud mayor que el resto
    /// del buffer y descoloca la línea de tiempo entera de la app.
    pub fn server_time_us(&self) -> Option<u64> {
        if !self.offset_valid.load(Ordering::SeqCst) {
            return None;
        }
        let t = now_epoch_us() as i64 + self.offset_us.load(Ordering::SeqCst);
        (t >= 0).then_some(t as u64)
    }

    /// Anuncia el tópico si es la primera vez y devuelve su pubuid.
    fn pubuid(&self, name: &str, type_str: &str) -> Result<i32> {
        let mut published = self
            .published
            .lock()
            .map_err(|_| anyhow!("the published-topic map was poisoned"))?;
        if let Some(&id) = published.get(name) {
            return Ok(id);
        }
        let id = self.next_pubuid.fetch_add(1, Ordering::SeqCst);
        published.insert(name.to_string(), id);

        let announce = serde_json::json!([{
            "method": "publish",
            "params": { "name": name, "pubuid": id, "type": type_str }
        }]);
        self.tx.send(Message::Text(announce.to_string().into())).map_err(|_| {
            anyhow!("the NT4 connection closed while announcing {name}")
        })?;
        Ok(id)
    }

    /// Escribe un valor. Sincrónico a propósito: lo llama el lazo de
    /// gz-transport, que no es async.
    pub fn set(&self, name: &str, type_str: &str, type_idx: i32, value: rmpv::Value) -> Result<()> {
        let id = self.pubuid(name, type_str)?;
        // 0 es lo que pide la spec mientras el cliente no sincronizó: el
        // servidor lo reemplaza por su propia hora.
        let ts = self.server_time_us().unwrap_or(0);
        let frame: (i32, u64, i32, rmpv::Value) = (id, ts, type_idx, value);
        // El caso normal de esta rama no es un bug nuestro: el codigo del robot
        // se reinicia cada vez que el equipo compila, y con el se va el
        // servidor NT4. Merece un mensaje que lo diga en vez del "channel
        // closed" que sale del canal por dentro.
        self.tx
            .send(Message::Binary(rmp_serde::to_vec(&frame)?.into()))
            .map_err(|_| anyhow!("the NT4 connection closed while writing {name}"))?;
        Ok(())
    }

    pub fn set_double(&self, name: &str, v: f64) -> Result<()> {
        self.set(name, "double", TYPE_DOUBLE, rmpv::Value::F64(v))
    }

    pub fn set_string(&self, name: &str, v: &str) -> Result<()> {
        self.set(name, "string", TYPE_STRING, rmpv::Value::String(v.into()))
    }

    pub fn set_double_array(&self, name: &str, v: &[f64]) -> Result<()> {
        let arr = v.iter().copied().map(rmpv::Value::F64).collect();
        self.set(name, "double[]", TYPE_DOUBLE_ARRAY, rmpv::Value::Array(arr))
    }

    /// Publica bytes crudos bajo un tipo binario (`struct:Pose2d`,
    /// `structschema`, `raw`...). Todos comparten el índice 5.
    pub fn set_raw(&self, name: &str, type_str: &str, bytes: Vec<u8>) -> Result<()> {
        self.set(name, type_str, TYPE_RAW, rmpv::Value::Binary(bytes))
    }

    /// Se suscribe a todo lo que cuelgue de un prefijo.
    ///
    /// Por prefijo y no por lista a proposito: los topicos del glue llevan el
    /// nombre del actuador dentro (`/MARS/Glue/out/fl_drive/duty`), asi que
    /// enumerarlos obligaria a que el bridge conociera de antemano cada nombre
    /// del robot-map y a resuscribirse si cambia. Con el prefijo, agregar un
    /// motor al robot no toca el bridge.
    pub fn subscribe_prefix(&self, prefijo: &str) -> Result<()> {
        let id = self.next_subuid.fetch_add(1, Ordering::SeqCst);
        let msg = serde_json::json!([{
            "method": "subscribe",
            "params": {
                "topics": [prefijo],
                "subuid": id,
                // `prefix` es lo que convierte la lista en un patron. `all` pide
                // TODOS los cambios y no solo el ultimo por periodo: un comando
                // de motor que se pierda es un ciclo de control perdido.
                //
                // `periodic` es CADA CUANTO el servidor manda lo acumulado. Sin
                // el, NT4 usa 100 ms: el servidor del robot junta los duty de
                // traccion y los entrega en rafagas a 10 Hz, y el lazo de
                // velocidad del TalonFX (que corre en el robot) queda con hasta
                // 100 ms de retraso. Medido con Offseason2026: el mismo path
                // daba 13 cm de RMS una vez y abortaba con 50 cm la siguiente,
                // con 60-86 cm de patinaje. 5 ms es el minimo de NT4.
                "options": { "prefix": true, "all": true, "periodic": 0.005 }
            }
        }]);
        if std::env::var("MARS_NT_DEBUG").is_ok() {
            eprintln!("[nt->] {msg}");
        }
        self.tx
            .send(Message::Text(msg.to_string().into()))
            .map_err(|_| anyhow!("the NT4 connection closed while subscribing to {prefijo}"))?;
        Ok(())
    }

    /// Ultimo valor recibido de un topico, si llego alguno.
    pub fn get(&self, name: &str) -> Option<rmpv::Value> {
        self.valores.lock().ok()?.get(name).cloned()
    }

    pub fn get_f64(&self, name: &str) -> Option<f64> {
        match self.get(name)? {
            rmpv::Value::F64(v) => Some(v),
            rmpv::Value::F32(v) => Some(v as f64),
            // Un 0 o un 1 exactos viajan como entero aunque el topico sea
            // double: MessagePack elige la codificacion mas corta.
            rmpv::Value::Integer(i) => i.as_f64(),
            _ => None,
        }
    }

    pub fn get_bool(&self, name: &str) -> Option<bool> {
        match self.get(name)? {
            rmpv::Value::Boolean(b) => Some(b),
            _ => None,
        }
    }

    /// Nombres de todos los topicos recibidos que empiezan por el prefijo.
    pub fn names_with_prefix(&self, prefijo: &str) -> Vec<String> {
        self.valores
            .lock()
            .map(|v| v.keys().filter(|k| k.starts_with(prefijo)).cloned().collect())
            .unwrap_or_default()
    }

    pub fn is_connected(&self) -> bool {
        !self.tx.is_closed()
    }
}
