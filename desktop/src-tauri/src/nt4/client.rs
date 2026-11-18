use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message, tungstenite::client::IntoClientRequest};
use futures_util::{StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use std::collections::{HashMap, VecDeque};

type RttTuple = (i32, u32, i32, u64);

/// How much history is kept per topic before pruning (prevents unbounded
/// memory growth in long sessions). 0 = no limit (explicit opt-in via
/// `set_buffer_retention_minutes`, for whoever wants to record the whole session
/// at the cost of memory).
const DEFAULT_RETENTION_US: u64 = 15 * 60 * 1_000_000;

/// How often the round-trip ping (topic id -1) is sent. It is the period
/// AdvantageScope uses for v4.1; without it the server/client offset would be
/// computed once on connecting and drift with the clock.
const RTT_PERIOD: Duration = Duration::from_millis(250);

const RECONNECT_MIN_BACKOFF: Duration = Duration::from_secs(1);
const RECONNECT_MAX_BACKOFF: Duration = Duration::from_secs(15);

/// How long opening the socket may take before giving up. A robot that is
/// there answers in milliseconds; one that is rebooting behind a radio that
/// is up does not answer at all, and the operating system's own TCP timeout
/// (about 20 s on Windows, over a minute elsewhere) is far too long to wait.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Gap left on the timeline between the samples from before a robot reboot and
/// the ones after it, so the two sessions do not look like one stretch.
const REBOOT_GAP_US: u64 = 1_000_000;

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Equivalent to `[T]::partition_point` but for `VecDeque`, which does not
/// expose the method directly. It assumes `deque` is sorted according to `pred`
/// (monotonically decreasing from true to false), as `TopicHistory.data` is,
/// since it is always inserted in increasing arrival/timestamp order.
pub fn partition_point_deque<T>(deque: &VecDeque<T>, pred: impl Fn(&T) -> bool) -> usize {
    let mut lo = 0usize;
    let mut hi = deque.len();
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if pred(&deque[mid]) { lo = mid + 1; } else { hi = mid; }
    }
    lo
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum NTValue {
    Boolean(bool),
    Number(f64),
    String(String),
    NumberArray(Vec<f64>),      // double[] / int[] / float[]
    BooleanArray(Vec<bool>),
    StringArray(Vec<String>),
    Raw(Vec<u8>),               // structs, protobuf, msgpack (bytes)
}

#[derive(Clone)]
pub struct TopicHistory {
    pub name: String,
    pub topic_type: String,
    pub data: VecDeque<(u64, NTValue)>,
}

pub struct NTBuffer {
    pub topics: HashMap<i32, TopicHistory>,
    pub end_time: Option<u64>,
    /// Retention window in microseconds. 0 = no limit.
    pub retention_us: u64,
    /// Added to every live timestamp, so a session that follows a robot reboot
    /// (whose clock starts again near zero) continues the timeline instead of
    /// landing on top of the samples from before it. 0 until that happens.
    session_offset_us: u64,
    /// Where the previous session's samples ended, from an automatic
    /// reconnection until the first sample of the new one says whether the
    /// robot's clock kept running or started again.
    continue_after: Option<u64>,
    /// The last id handed to a topic from an earlier session (see
    /// `begin_new_session`). Counts down from -2: -1 is the RTT ping.
    last_stale_id: i32,
}

// Helper: extracts an f64 whether MessagePack sent it as Float, Integer or
// UInteger (NT4's ints arrive as native integers, not floats).
fn value_as_f64(v: &rmpv::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|i| i as f64))
        .or_else(|| v.as_u64().map(|u| u as f64))
}

fn value_as_u64(v: &rmpv::Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_i64().map(|i| i as u64))
        .or_else(|| v.as_f64().map(|f| f as u64))
}

/// Local clock in microseconds since the epoch. It is the scale we send the RTT
/// pings in and the response is measured against; it is NOT NT4's timestamp
/// scale (that one comes from `NT4Client::server_time_us`).
fn now_epoch_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

impl NTBuffer {
    pub fn new() -> Self {
        Self {
            topics: HashMap::new(),
            end_time: None,
            retention_us: DEFAULT_RETENTION_US,
            session_offset_us: 0,
            continue_after: None,
            last_stale_id: -1,
        }
    }

    pub fn add_topic(&mut self, id: i32, name: String, topic_type: String) {
        if self.topics.contains_key(&id) {
            return;
        }
        // A topic from before an automatic reconnection comes back under the
        // id the server gives it now, and keeps its history.
        let stale = self.topics.iter().find(|(k, h)| **k < -1 && h.name == name).map(|(k, _)| *k);
        if let Some(old_id) = stale {
            let history = self.topics.remove(&old_id).expect("found just above");
            if history.topic_type == topic_type {
                self.topics.insert(id, history);
                return;
            }
            // Same name with another type: its old samples cannot be read as
            // the new one, so they go.
        }
        self.topics.insert(id, TopicHistory { name, topic_type, data: VecDeque::new() });
    }

    /// Keeps the history across an automatic reconnection.
    ///
    /// The server numbers its topics anew on every connection, so the ids
    /// from before mean nothing now and could collide with the new ones. Each
    /// topic moves to an id of its own below -1, where `add_topic` finds it by
    /// name when the server announces it again. Topics that never come back
    /// stay there, still readable by name on the timeline.
    pub fn begin_new_session(&mut self) {
        let live: Vec<i32> = self.topics.keys().copied().filter(|id| *id >= 0).collect();
        for id in live {
            if let Some(history) = self.topics.remove(&id) {
                self.last_stale_id -= 1;
                self.topics.insert(self.last_stale_id, history);
            }
        }
        self.continue_after = self.end_time;
    }

    /// Forgets the live-session clock: for a buffer that now holds a log.
    pub fn reset_session_clock(&mut self) {
        self.session_offset_us = 0;
        self.continue_after = None;
    }

    /// Oldest timestamp still present in the buffer, computed on demand by
    /// scanning the front of each topic (cheap: O(topics), not O(samples)).
    /// It cannot be kept as an incremental field because pruning by retention
    /// invalidates any cached minimum.
    pub fn effective_start_time(&self) -> Option<u64> {
        self.topics.values().filter_map(|h| h.data.front().map(|(ts, _)| *ts)).min()
    }

    pub fn set_retention_us(&mut self, us: u64) {
        self.retention_us = us;
    }

    // IMPORTANT: `value` is now an rmpv::Value (MessagePack's native type), NOT a
    // serde_json::Value. serde_json::Value has no variant for bytes, so when a
    // "raw" topic arrived (structs, protobuf, msgpack -> type_idx 5) the
    // deserialization into serde_json::Value failed silently and broke the read
    // loop for that whole binary frame. With rmpv::Value the bytes arrive as
    // Value::Binary and can be read.
    pub fn insert_value(&mut self, id: i32, timestamp: u64, type_idx: i32, value: rmpv::Value) {
        if !self.topics.contains_key(&id) {
            return;
        }
        // The first sample after an automatic reconnection says whether the
        // robot rebooted: its clock went back below where the history ends.
        if let Some(previous_end) = self.continue_after.take() {
            if timestamp + self.session_offset_us < previous_end {
                self.session_offset_us = previous_end + REBOOT_GAP_US - timestamp;
            }
        }
        let timestamp = timestamp + self.session_offset_us;
        if let Some(topic) = self.topics.get_mut(&id) {
            let nt_val = match type_idx {
                0 => NTValue::Boolean(value.as_bool().unwrap_or(false)),
                1 | 2 | 3 => NTValue::Number(value_as_f64(&value).unwrap_or(0.0)),
                4 => NTValue::String(value.as_str().unwrap_or("").to_string()),
                // Raw / struct / protobuf / msgpack (bytes)
                5 => {
                    match &value {
                        rmpv::Value::Binary(bytes) => NTValue::Raw(bytes.clone()),
                        rmpv::Value::Array(arr) => {
                            let bytes: Vec<u8> = arr.iter().filter_map(|v| v.as_u64().map(|n| n as u8)).collect();
                            NTValue::Raw(bytes)
                        }
                        _ => return,
                    }
                },
                // 16 = boolean[]
                16 => {
                    if let Some(arr) = value.as_array() {
                        NTValue::BooleanArray(arr.iter().map(|v| v.as_bool().unwrap_or(false)).collect())
                    } else { return; }
                },
                // 17 = double[], 18 = int[], 19 = float[]. All three are numeric
                // and the frontend consumes them the same: the index only says with
                // what precision the robot published them, it does not change the value.
                17 | 18 | 19 => {
                    if let Some(arr) = value.as_array() {
                        let doubles: Vec<f64> = arr.iter().filter_map(value_as_f64).collect();
                        NTValue::NumberArray(doubles)
                    } else { return; }
                },
                // 20 = string[]
                20 => {
                    if let Some(arr) = value.as_array() {
                        NTValue::StringArray(arr.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect())
                    } else { return; }
                },
                _ => return,
            };
            topic.data.push_back((timestamp, nt_val));

            // Pruning by retention window: since timestamps arrive in
            // increasing order per topic, taking from the front is enough.
            if self.retention_us > 0 {
                let cutoff = timestamp.saturating_sub(self.retention_us);
                while matches!(topic.data.front(), Some((ts, _)) if *ts < cutoff) {
                    topic.data.pop_front();
                }
            }

            if self.end_time.is_none() || timestamp > self.end_time.unwrap() { self.end_time = Some(timestamp); }
        }
    }
}

/// Opens the WebSocket to an NT4 server, giving up after `CONNECT_TIMEOUT`.
///
/// Callers run this BEFORE taking the client's lock and hand the result to
/// `NT4Client::attach`.
pub async fn open_socket(ip: &str, port: u16) -> Result<WsStream, String> {
    let url = format!("ws://{}:{}/nt/MARS", ip, port);
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("Sec-WebSocket-Protocol", "v4.1.networktables.first.wpi.edu".parse().unwrap());
    match tokio::time::timeout(CONNECT_TIMEOUT, connect_async(request)).await {
        Ok(Ok((ws_stream, _))) => Ok(ws_stream),
        Ok(Err(e)) => Err(format!("Could not connect to {}:{}: {}", ip, port, e)),
        Err(_) => Err(format!("{}:{} did not answer within {} s", ip, port, CONNECT_TIMEOUT.as_secs())),
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TopicAnnounce { pub id: i32, pub name: String, pub topic_type: String }

pub struct NT4Client {
    pub is_connected: bool, pub current_ip: String, tx: Option<mpsc::Sender<Message>>, pub buffer: Arc<Mutex<NTBuffer>>,
    /// Port of the current session's NT4 server (5810 normal, 6767 DS,
    /// 6810 Systemcore, or whatever was configured by hand).
    pub current_port: u16,
    published: HashMap<String, i32>,
    next_pubuid: i32,
    /// "sim" | "real" — remembered so the auto-reconnect loop knows which event to
    /// emit when the connection comes back. Set by connect_sim/connect_real.
    pub connection_mode: String,
    /// Set to `true` when the user (or a new call to `connect`) ends the
    /// connection on purpose, so the socket reader knows it must NOT trigger
    /// auto-reconnect on seeing the socket closed.
    manual_disconnect: Arc<AtomicBool>,
    /// Difference between the NT server's clock and the local one, in µs, deduced
    /// from the RTT ping's round trip. They live in atomics because the task that
    /// reads the socket writes them and the commands read them from Tauri's
    /// runtime. They are replaced by new Arcs on every `connect` (just like
    /// `manual_disconnect`), so an old reader does not overwrite the new session.
    server_time_offset_us: Arc<AtomicI64>,
    time_offset_valid: Arc<AtomicBool>,
    network_latency_us: Arc<AtomicI64>,
}

impl NT4Client {
    pub fn new() -> Self {
        Self {
            is_connected: false, current_ip: String::new(), current_port: 5810,
            tx: None, buffer: Arc::new(Mutex::new(NTBuffer::new())),
            published: HashMap::new(), next_pubuid: 1, connection_mode: String::new(),
            manual_disconnect: Arc::new(AtomicBool::new(false)),
            server_time_offset_us: Arc::new(AtomicI64::new(0)),
            time_offset_valid: Arc::new(AtomicBool::new(false)),
            network_latency_us: Arc::new(AtomicI64::new(0)),
        }
    }

    // "Boxed future" signature (instead of `async fn`) on purpose: `connect` and
    // `reconnect_with_backoff` call each other (one reconnects by calling the
    // other), and the compiler cannot give a finite size to the Future type of
    // such a recursion between two plain `async fn`. Returning a
    // `Pin<Box<dyn Future>>` erases that concrete type and breaks the cycle.
    //
    // It takes a socket that is already open (`open_socket`) rather than
    // opening it itself: opening can take seconds, and every caller holds the
    // client's lock while it runs, which is the same lock every command that
    // reads data takes. Waiting for a robot that does not answer with it held
    // froze the whole dashboard, Disconnect button included.
    //
    // `keep_history` is for the automatic reconnection: the history recorded
    // so far stays (see `NTBuffer::begin_new_session`). A connection the user
    // asks for starts a clean buffer.
    pub fn attach<'a>(
        &'a mut self,
        ws_stream: WsStream,
        ip: &'a str,
        port: u16,
        app_handle: AppHandle,
        keep_history: bool,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
        self.disconnect().await;
        // A new flag of this session's own: the previous one (if the socket reader
        // of an earlier connection is still alive) was already marked "manual"
        // above, so it will not trigger its own auto-reconnect.
        self.manual_disconnect = Arc::new(AtomicBool::new(false));
        self.server_time_offset_us = Arc::new(AtomicI64::new(0));
        self.time_offset_valid = Arc::new(AtomicBool::new(false));
        self.network_latency_us = Arc::new(AtomicI64::new(0));
        self.current_ip = ip.to_string();
        self.current_port = port;

        if keep_history {
            self.buffer.lock().await.begin_new_session();
        } else {
            self.buffer = Arc::new(Mutex::new(NTBuffer::new()));
            // A new buffer: without this, every connection would discard the
            // history window the user chose.
            let retention_minutes = crate::load_mars_settings().nt_retention_minutes;
            self.buffer.lock().await.set_retention_us(retention_minutes as u64 * 60 * 1_000_000);
        }
        self.published.clear();
        self.next_pubuid = 1;
        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<Message>(100);
        self.tx = Some(tx.clone());
        self.is_connected = true;

        let app_handle_clone = app_handle.clone();
        let buffer_clone = self.buffer.clone();
        let manual_flag = self.manual_disconnect.clone();
        let reconnect_ip = ip.to_string();
        let reconnect_port = port;
        let offset_slot = self.server_time_offset_us.clone();
        let offset_valid_slot = self.time_offset_valid.clone();
        let latency_slot = self.network_latency_us.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = rx.recv() => {
                        if let Some(msg) = msg { if write.send(msg).await.is_err() { break; } } else { break; }
                    }
                    incoming = read.next() => {
                        // A session ended on purpose (a log was opened, another
                        // connection replaced it) writes nothing more into the
                        // buffer it shared: the socket can still deliver a few
                        // frames before it closes.
                        if manual_flag.load(Ordering::SeqCst) { break; }
                        match incoming {
                            Some(Ok(Message::Binary(bin))) => {
                                let mut buff = buffer_clone.lock().await;
                                let mut cursor = std::io::Cursor::new(&bin);
                                while (cursor.position() as usize) < bin.len() {
                                    if let Ok(record) = rmp_serde::from_read::<_, (i32, u64, i32, rmpv::Value)>(&mut cursor) {
                                        // Topic id -1 is NOT a topic: it is the response to the
                                        // RTT ping. It used to fall into insert_value, which looked for
                                        // id -1 in the topic map, did not find it and silently
                                        // discarded it -- which is why the server/client offset
                                        // never got computed.
                                        if record.0 == -1 {
                                            if let Some(sent_at) = value_as_u64(&record.3) {
                                                let rx = now_epoch_us();
                                                // A symmetric trip is assumed: half the round trip
                                                // is what the response took since the server
                                                // timestamped it.
                                                let latency = (rx.saturating_sub(sent_at) / 2) as i64;
                                                let server_at_rx = record.1 as i64 + latency;
                                                offset_slot.store(server_at_rx - rx as i64, Ordering::SeqCst);
                                                latency_slot.store(latency, Ordering::SeqCst);
                                                offset_valid_slot.store(true, Ordering::SeqCst);
                                            }
                                        } else {
                                            buff.insert_value(record.0, record.1, record.2, record.3);
                                        }
                                    } else { break; }
                                }
                            }
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(json_array) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
                                    for msg in json_array {
                                        if let (Some(method), Some(params)) = (msg.get("method").and_then(|m| m.as_str()), msg.get("params")) {
                                            if method == "announce" {
                                                if let (Some(name), Some(id), Some(t_type)) = (
                                                    params.get("name").and_then(|n| n.as_str()), params.get("id").and_then(|i| i.as_i64()), params.get("type").and_then(|t| t.as_str())
                                                ) {
                                                    buffer_clone.lock().await.add_topic(id as i32, name.to_string(), t_type.to_string());
                                                    let topic = TopicAnnounce { id: id as i32, name: name.to_string(), topic_type: t_type.to_string() };
                                                    let _ = app_handle_clone.emit("nt-topic-announced", topic);
                                                }
                                            } else if method == "unannounce" {
                                                // Without this the topic tree only grows: a topic the
                                                // robot stops publishing, or one MARS withdraws, stays
                                                // on screen until the app restarts.
                                                //
                                                // The history in the buffer is NOT touched: the timeline can
                                                // still show what that topic was worth before it left.
                                                if let Some(name) = params.get("name").and_then(|n| n.as_str()) {
                                                    let _ = app_handle_clone.emit("nt-topic-unannounced", name.to_string());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => { break; }
                            _ => {} 
                        }
                    }
                }
            }
            let _ = app_handle_clone.emit("nt-disconnected", ());

            // The socket closed on its own (not through disconnect_nt nor a new
            // manual connection) -> try to recover it with backoff.
            if !manual_flag.load(Ordering::SeqCst) {
                let client_arc = app_handle_clone.state::<NT4State>().0.clone();
                {
                    let mut client = client_arc.lock().await;
                    // Only touch the state if nobody else already took this session.
                    if Arc::ptr_eq(&client.manual_disconnect, &manual_flag) {
                        client.is_connected = false;
                        client.tx = None;
                    }
                }
                tokio::spawn(NT4Client::reconnect_with_backoff(
                    app_handle_clone.clone(), client_arc, reconnect_ip, reconnect_port, manual_flag,
                ));
            }
        });

        self.send_initial_rtt().await?;

        // Periodic RTT ping. With a single one on connecting the offset is pinned
        // for the whole session and drifts away from the robot's clock.
        let rtt_tx = tx.clone();
        let rtt_manual = self.manual_disconnect.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(RTT_PERIOD);
            ticker.tick().await; // the first tick is immediate and we already sent one above
            loop {
                ticker.tick().await;
                if rtt_manual.load(Ordering::SeqCst) { return; }
                let payload: RttTuple = (-1, 0, 2, now_epoch_us());
                match rmp_serde::to_vec(&payload) {
                    Ok(bin) => { if rtt_tx.send(Message::Binary(bin.into())).await.is_err() { return; } }
                    Err(_) => return,
                }
            }
        });

        if let Some(tx_channel) = &self.tx {
            let sub_msg = serde_json::json!([{"method": "subscribe", "params": {"topics": [""], "subuid": 1, "options": { "all": true, "prefix": true, "periodic": 0.05 }}}]);
            let _ = tx_channel.send(Message::Text(sub_msg.to_string().into())).await;
        }
        Ok(())
        })
    }

        pub async fn set_value(&mut self, topic_name: &str, topic_type: &str, type_idx: i32, value: rmpv::Value) -> Result<(), String> {
        let tx = self.tx.as_ref().ok_or("No active connection")?.clone();

        let pubuid = if let Some(&id) = self.published.get(topic_name) {
            id
        } else {
            let id = self.next_pubuid;
            self.next_pubuid += 1;
            self.published.insert(topic_name.to_string(), id);

            let pub_msg = serde_json::json!([{
                "method": "publish",
                "params": { "name": topic_name, "pubuid": id, "type": topic_type }
            }]);
            tx.send(Message::Text(pub_msg.to_string().into())).await.map_err(|e| e.to_string())?;
            id
        };

        // NT4 timestamps in the SERVER's scale, not the Unix epoch. Sending the
        // epoch here put in a value ~5 orders of magnitude larger than the rest of
        // the buffer, and since `insert_value` moves `end_time` to the maximum seen,
        // the global timeline jumped to 1970+epoch as soon as a topic was written.
        // 0 is what the spec asks for while the client has not synced: the server
        // replaces it with its own time.
        let server_time = self.server_time_us();
        let timestamp = server_time.unwrap_or(0);

        let frame: (i32, u64, i32, rmpv::Value) = (pubuid, timestamp, type_idx, value.clone());
        let bin = rmp_serde::to_vec(&frame).map_err(|e| e.to_string())?;
        tx.send(Message::Binary(bin.into())).await.map_err(|e| e.to_string())?;

        // Local echo for immediate feedback, only if the timestamp is really
        // comparable with the rest of the buffer. Without an offset yet, the value
        // comes back through the subscription anyway with the server's real time.
        if let Some(ts) = server_time {
            let mut buff = self.buffer.lock().await;
            if let Some(&topic_id) = buff.topics.iter().find(|(_, h)| h.name == topic_name).map(|(id, _)| id) {
                buff.insert_value(topic_id, ts, type_idx, value);
            }
        }

        Ok(())
    }

    /// Withdraws a topic this client had published.
    ///
    /// It is truly needed: a published topic survives on the server until its
    /// publisher leaves, so renaming a value without withdrawing the previous one
    /// leaves garbage on the network until the app restarts. It is also mandatory
    /// before republishing the same name with ANOTHER type, which NT does not
    /// allow.
    pub async fn unpublish(&mut self, topic_name: &str) -> Result<(), String> {
        let Some(pubuid) = self.published.remove(topic_name) else { return Ok(()) };
        let tx = self.tx.as_ref().ok_or("No active connection")?.clone();

        let msg = serde_json::json!([{
            "method": "unpublish",
            "params": { "pubuid": pubuid }
        }]);
        tx.send(Message::Text(msg.to_string().into())).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn disconnect(&mut self) {
        // Marks the current session as ended on purpose: if its socket reader is
        // still alive, on seeing the close it must not auto-reconnect.
        self.manual_disconnect.store(true, Ordering::SeqCst);
        if self.is_connected {
            self.tx = None;
            self.is_connected = false;
            self.current_ip.clear();
        }
    }

    /// Retries the connection with exponential backoff (1s -> 2s -> 4s ... capped at 15s)
    /// until it reconnects or `manual_flag` says the session was abandoned (by an
    /// explicit `disconnect_nt` or by a new manual connection that already replaced
    /// it).
    async fn reconnect_with_backoff(
        app_handle: AppHandle,
        client_arc: Arc<Mutex<NT4Client>>,
        ip: String,
        port: u16,
        manual_flag: Arc<AtomicBool>,
    ) {
        let mut backoff = RECONNECT_MIN_BACKOFF;
        loop {
            if manual_flag.load(Ordering::SeqCst) { return; }
            tokio::time::sleep(backoff).await;
            if manual_flag.load(Ordering::SeqCst) { return; }

            // Opened WITHOUT the client's lock: a robot that is still rebooting
            // can take the whole timeout to not answer, and the dashboard has to
            // keep reading the history (and Disconnect has to work) meanwhile.
            let opened = open_socket(&ip, port).await;
            if manual_flag.load(Ordering::SeqCst) { return; }
            let Ok(ws_stream) = opened else {
                backoff = std::cmp::min(backoff * 2, RECONNECT_MAX_BACKOFF);
                continue;
            };

            let mut client = client_arc.lock().await;
            // If another session already took this one's place (a manual reconnection
            // while we were waiting), abort: that one already has its own socket
            // reader running.
            if !Arc::ptr_eq(&client.manual_disconnect, &manual_flag) { return; }

            match client.attach(ws_stream, &ip, port, app_handle.clone(), true).await {
                Ok(_) => {
                    let _ = app_handle.emit("nt-reconnected", client.connection_mode.clone());
                    return;
                }
                Err(_) => {
                    drop(client);
                    backoff = std::cmp::min(backoff * 2, RECONNECT_MAX_BACKOFF);
                }
            }
        }
    }

    /// The NT server's time in µs, or `None` if no RTT ping has come back yet.
    /// It is the only valid scale for timestamping our own samples.
    pub fn server_time_us(&self) -> Option<u64> {
        if !self.time_offset_valid.load(Ordering::SeqCst) { return None; }
        let t = now_epoch_us() as i64 + self.server_time_offset_us.load(Ordering::SeqCst);
        if t < 0 { None } else { Some(t as u64) }
    }

    /// Half the round trip measured against the server, in µs (0 if there is no data).
    pub fn network_latency_us(&self) -> i64 {
        self.network_latency_us.load(Ordering::SeqCst)
    }

    async fn send_initial_rtt(&self) -> Result<(), String> {
        if let Some(tx) = &self.tx {
            let timestamp = now_epoch_us();
            let rtt_payload: RttTuple = (-1, 0, 2, timestamp);
            if let Ok(bin_data) = rmp_serde::to_vec(&rtt_payload) {
                tx.send(Message::Binary(bin_data.into())).await.map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

pub struct NT4State(pub Arc<Mutex<NT4Client>>);
#[cfg(test)]
mod tests {
    use super::*;

    fn number(v: f64) -> rmpv::Value {
        rmpv::Value::F64(v)
    }

    fn samples(buffer: &NTBuffer, name: &str) -> Vec<u64> {
        buffer
            .topics
            .values()
            .find(|h| h.name == name)
            .map(|h| h.data.iter().map(|(ts, _)| *ts).collect())
            .unwrap_or_default()
    }

    /// A connection that drops and comes back: the server numbers its topics
    /// anew, and each one has to find its history again by name.
    #[test]
    fn a_reconnection_keeps_each_topics_history_under_its_new_id() {
        let mut b = NTBuffer::new();
        b.add_topic(1, "/Swerve/Speed".into(), "double".into());
        b.add_topic(2, "/Arm/Angle".into(), "double".into());
        b.insert_value(1, 1_000, 1, number(1.0));
        b.insert_value(2, 2_000, 1, number(2.0));

        b.begin_new_session();
        // The new server swaps the numbers around.
        b.add_topic(1, "/Arm/Angle".into(), "double".into());
        b.add_topic(2, "/Swerve/Speed".into(), "double".into());
        b.insert_value(1, 3_000, 1, number(3.0));
        b.insert_value(2, 4_000, 1, number(4.0));

        assert_eq!(samples(&b, "/Arm/Angle"), vec![2_000, 3_000]);
        assert_eq!(samples(&b, "/Swerve/Speed"), vec![1_000, 4_000]);
        assert_eq!(b.topics.len(), 2, "no topic is left twice");
    }

    /// The robot rebooted: its clock starts again near zero, and the new
    /// samples continue after the old ones instead of landing on top of them.
    #[test]
    fn after_a_robot_reboot_the_timeline_continues_instead_of_going_back() {
        let mut b = NTBuffer::new();
        b.add_topic(1, "/Voltage".into(), "double".into());
        b.insert_value(1, 150_000_000, 1, number(12.0));

        b.begin_new_session();
        b.add_topic(7, "/Voltage".into(), "double".into());
        b.insert_value(7, 2_000_000, 1, number(11.0));
        b.insert_value(7, 2_020_000, 1, number(11.1));

        let ts = samples(&b, "/Voltage");
        assert_eq!(ts[0], 150_000_000);
        assert_eq!(ts[1], 150_000_000 + REBOOT_GAP_US, "right after the old samples, with the gap");
        assert_eq!(ts[2] - ts[1], 20_000, "the new session keeps its own spacing");
        assert_eq!(b.end_time, Some(ts[2]));
    }

    /// Only the network dropped: the robot's clock kept running and nothing
    /// is shifted.
    #[test]
    fn a_network_blip_leaves_the_timestamps_alone() {
        let mut b = NTBuffer::new();
        b.add_topic(1, "/Voltage".into(), "double".into());
        b.insert_value(1, 150_000_000, 1, number(12.0));

        b.begin_new_session();
        b.add_topic(3, "/Voltage".into(), "double".into());
        b.insert_value(3, 153_000_000, 1, number(12.1));

        assert_eq!(samples(&b, "/Voltage"), vec![150_000_000, 153_000_000]);
    }

    /// A topic that came back with another type cannot reuse its samples.
    #[test]
    fn a_topic_that_changed_type_starts_over() {
        let mut b = NTBuffer::new();
        b.add_topic(1, "/Mode".into(), "double".into());
        b.insert_value(1, 1_000, 1, number(1.0));

        b.begin_new_session();
        b.add_topic(1, "/Mode".into(), "string".into());

        assert!(samples(&b, "/Mode").is_empty());
        assert_eq!(b.topics.len(), 1);
    }

    /// A topic the server never announces again stays readable by name.
    #[test]
    fn a_topic_that_does_not_come_back_keeps_its_history() {
        let mut b = NTBuffer::new();
        b.add_topic(1, "/Gone".into(), "double".into());
        b.insert_value(1, 1_000, 1, number(1.0));
        b.begin_new_session();
        b.add_topic(1, "/New".into(), "double".into());

        assert_eq!(samples(&b, "/Gone"), vec![1_000]);
        assert!(b.topics.keys().all(|id| *id != -1), "-1 is the RTT ping, never a topic");
    }

    /// A server that accepts the connection and then never answers the
    /// handshake, as a robot halfway through booting can: opening has to give
    /// up on its own instead of hanging for as long as the system's TCP stack
    /// feels like.
    #[tokio::test]
    async fn opening_a_socket_gives_up_on_a_server_that_never_answers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _hold = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(60)).await;
        });

        let started = std::time::Instant::now();
        let result = open_socket("127.0.0.1", port).await;
        let elapsed = started.elapsed();

        assert!(result.is_err(), "nothing answered, so nothing can be open");
        assert!(result.unwrap_err().contains("did not answer"));
        assert!(elapsed >= CONNECT_TIMEOUT && elapsed < CONNECT_TIMEOUT + Duration::from_secs(2), "{elapsed:?}");
    }
}
