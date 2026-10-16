//! Minimal NT4 client: publish and subscribe.
//!
//! Publishes the `[[nt]]` topics of sim/protocol/topics.toml and subscribes to
//! the `[[glue]]` ones that come from the robot code. Almost everything a full
//! client has is still left out -- history buffer, bandwidth accounting,
//! reconnection -- because the bridge does not need them.
//!
//! **Why `src-tauri/src/nt4/client.rs` is not reused.** That client is a
//! consumer and has Tauri woven all through its reconnection loop: it emits five
//! different events to the front end and pulls its own instance out of
//! `state::<NT4State>()`. Decoupling it would mean refactoring code that works,
//! with a risk of regressions in the app.
//!
//! This decision was revisited when the `vendor` profile arrived, which does need
//! to subscribe -- that was the noted trigger. It held: adding subscription by
//! prefix to this client is ~60 lines, while taking Tauri out of the other one's
//! reconnection loop is a refactor with real risk that leaves nothing better.
//!
//! The wire format is the same one the app's client implements, and it follows
//! the NT4.1 spec.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

/// How often the round-trip ping (id -1) is sent. With a single one on connect
/// the offset stays pinned to startup and drifts with the computer's clock.
const RTT_PERIOD: Duration = Duration::from_millis(250);

/// Type indices from the NT4 spec. Everything binary shares 5: WPILib structs,
/// their schemas and loose raw.
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

/// The latest value received for each subscribed topic, by NAME.
///
/// The bridge wants the most recent value, not a history: motor commands are
/// replaced 200 times a second and keeping the old ones would only serve to apply
/// a stale one.
pub type Values = Arc<Mutex<HashMap<String, rmpv::Value>>>;

pub struct Nt4 {
    tx: mpsc::UnboundedSender<Message>,
    /// topic name -> pubuid. Publishing is idempotent: a name's first `set` sends
    /// the announcement, the following ones only the value.
    published: Mutex<HashMap<String, i32>>,
    next_pubuid: AtomicI32,
    offset_us: Arc<AtomicI64>,
    offset_valid: Arc<AtomicBool>,
    values: Values,
    next_subuid: AtomicI32,
}

impl Nt4 {
    /// Connects and leaves the read, write and ping tasks running.
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

        // Writing: a single exit point to the socket, fed by an unbounded channel.
        // That way `set` can be called from any thread without being async, which
        // is what the gz-transport loop needs.
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        });

        // Reading: RTT responses, topic announcements and values.
        let off = offset_us.clone();
        let valid = offset_valid.clone();
        let values: Values = Arc::new(Mutex::new(HashMap::new()));
        let values_rx = values.clone();
        // NT4 announces each topic with a numeric id and then sends the values
        // with only that id. Without this table the data arrives without knowing
        // which topic it belongs to.
        let mut ids: HashMap<i64, String> = HashMap::new();
        // With MARS_NT_DEBUG=1 the wire is dumped. It is the only way to tell
        // "I did not subscribe right" from "the server does not announce".
        let debug = std::env::var("MARS_NT_DEBUG").is_ok();

        tokio::spawn(async move {
            while let Some(Ok(msg)) = source.next().await {
                // Text messages are the control channel: announce, unannounce,
                // properties.
                if let Message::Text(txt) = &msg {
                    if debug {
                        eprintln!("[nt<-] {txt}");
                    }
                    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(txt) {
                        for m in arr {
                            let method = m.get("method").and_then(|v| v.as_str()).unwrap_or("");
                            let params = m.get("params");
                            let (Some(p), true) = (params, method == "announce") else {
                                if method == "unannounce" {
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
                    // Id -1 is not a topic: it is the response to the ping.
                    if record.0 != -1 {
                        if debug {
                            eprintln!("[nt<-] value id={} known={}", record.0,
                                      ids.contains_key(&(record.0 as i64)));
                        }
                        if let Some(topic_name) = ids.get(&(record.0 as i64)) {
                            if let Ok(mut v) = values_rx.lock() {
                                v.insert(topic_name.clone(), record.3);
                            }
                        }
                        continue;
                    }
                    let Some(sent_at) = record.3.as_u64() else { continue };
                    let now = now_epoch_us();
                    // A symmetric trip is assumed: half the round trip is how long the
                    // response took since the server stamped it.
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
            values,
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

    /// The SERVER's time in µs, or None while it has not synchronized.
    ///
    /// NT4 stamps values on the server's scale, not in Unix epoch. Sending epoch
    /// puts in a number five orders of magnitude bigger than the rest of the
    /// buffer and throws the app's whole timeline off.
    pub fn server_time_us(&self) -> Option<u64> {
        if !self.offset_valid.load(Ordering::SeqCst) {
            return None;
        }
        let t = now_epoch_us() as i64 + self.offset_us.load(Ordering::SeqCst);
        (t >= 0).then_some(t as u64)
    }

    /// Announces the topic if it is the first time and returns its pubuid.
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

    /// Writes a value. Synchronous on purpose: the gz-transport loop calls it,
    /// and it is not async.
    pub fn set(&self, name: &str, type_str: &str, type_idx: i32, value: rmpv::Value) -> Result<()> {
        let id = self.pubuid(name, type_str)?;
        // 0 is what the spec asks for while the client has not synchronized: the
        // server replaces it with its own time.
        let ts = self.server_time_us().unwrap_or(0);
        let frame: (i32, u64, i32, rmpv::Value) = (id, ts, type_idx, value);
        // The usual case of this branch is not our bug: the robot code restarts
        // every time the team builds, and the NT4 server goes with it. It
        // deserves a message that says so instead of the "channel closed" that
        // comes out of the channel internally.
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

    /// Publishes raw bytes under a binary type (`struct:Pose2d`,
    /// `structschema`, `raw`...). They all share index 5.
    pub fn set_raw(&self, name: &str, type_str: &str, bytes: Vec<u8>) -> Result<()> {
        self.set(name, type_str, TYPE_RAW, rmpv::Value::Binary(bytes))
    }

    /// Subscribes to everything hanging from a prefix.
    ///
    /// By prefix and not by list on purpose: the glue's topics carry the
    /// actuator's name inside (`/MARS/Glue/out/fl_drive/duty`), so listing them
    /// would force the bridge to know every robot-map name in advance and to
    /// resubscribe if it changes. With the prefix, adding a motor to the robot
    /// does not touch the bridge.
    pub fn subscribe_prefix(&self, prefix: &str) -> Result<()> {
        let id = self.next_subuid.fetch_add(1, Ordering::SeqCst);
        let msg = serde_json::json!([{
            "method": "subscribe",
            "params": {
                "topics": [prefix],
                "subuid": id,
                // `prefix` is what turns the list into a pattern. `all` asks for
                // EVERY change and not only the last one per period: a lost motor
                // command is a lost control cycle.
                //
                // `periodic` is HOW OFTEN the server sends what it accumulated.
                // Without it, NT4 uses 100 ms: the robot's server batches the drive
                // duties and delivers them in 10 Hz bursts, and the TalonFX's
                // velocity loop (which runs on the robot) ends up with up to 100 ms
                // of delay. Measured with Offseason2026: the same path gave 13 cm of
                // RMS once and aborted with 50 cm the next, with 60-86 cm of slip.
                // 5 ms is NT4's minimum.
                "options": { "prefix": true, "all": true, "periodic": 0.005 }
            }
        }]);
        if std::env::var("MARS_NT_DEBUG").is_ok() {
            eprintln!("[nt->] {msg}");
        }
        self.tx
            .send(Message::Text(msg.to_string().into()))
            .map_err(|_| anyhow!("the NT4 connection closed while subscribing to {prefix}"))?;
        Ok(())
    }

    /// The last value received for a topic, if any arrived.
    pub fn get(&self, name: &str) -> Option<rmpv::Value> {
        self.values.lock().ok()?.get(name).cloned()
    }

    pub fn get_f64(&self, name: &str) -> Option<f64> {
        match self.get(name)? {
            rmpv::Value::F64(v) => Some(v),
            rmpv::Value::F32(v) => Some(v as f64),
            // An exact 0 or 1 travels as an integer even if the topic is a
            // double: MessagePack picks the shortest encoding.
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

    /// Names of every received topic that starts with the prefix.
    pub fn names_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.values
            .lock()
            .map(|v| v.keys().filter(|k| k.starts_with(prefix)).cloned().collect())
            .unwrap_or_default()
    }

    pub fn is_connected(&self) -> bool {
        !self.tx.is_closed()
    }
}
