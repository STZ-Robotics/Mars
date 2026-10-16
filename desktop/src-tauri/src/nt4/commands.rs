use tauri::{State, AppHandle};
use super::client::{partition_point_deque, NT4State, NTValue, TopicAnnounce};
use super::wpilog::{self, ExportSummary, LogSummary};
use super::bandwidth::{self, BandwidthReport};
use std::collections::HashMap;
use std::path::PathBuf;
use serde::Serialize;

/// 3472 -> 10.34.72.2. If it is not a number, it is taken as the host as is
/// (so a hostname or an IP can be passed directly).
fn team_to_address(team: &str) -> String {
    match team.trim().parse::<u32>() {
        Ok(team) => format!("10.{}.{:02}.2", team / 100, team % 100),
        Err(_) => team.trim().to_string(),
    }
}

#[tauri::command]
pub async fn connect_sim(app: AppHandle, state: State<'_, NT4State>) -> Result<String, String> {
    // The simulator always runs on the local machine, but the port does depend
    // on the target: the Driver Station re-exposes the same data on 6767 over
    // localhost.
    let port = crate::load_mars_settings().nt_port();
    let mut client = state.0.lock().await;
    match client.connect("127.0.0.1", port, app).await {
        Ok(_) => {
            client.connection_mode = "sim".to_string();
            Ok(format!("Simulation connected at 127.0.0.1:{}", port))
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn connect_real(team_number: Option<String>, app: AppHandle, state: State<'_, NT4State>) -> Result<String, String> {
    let settings = crate::load_mars_settings();
    let port = settings.nt_port();

    // A custom address wins over the team number: it is the only way to reach
    // the robot over USB (172.22.11.2) or by hostname.
    let ip = if !settings.nt_custom_address.trim().is_empty() {
        settings.nt_custom_address.trim().to_string()
    } else {
        let team = team_number
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| settings.team_number.clone());
        team_to_address(&team)
    };

    let mut client = state.0.lock().await;
    match client.connect(&ip, port, app).await {
        Ok(_) => {
            client.connection_mode = "real".to_string();
            Ok(format!("Connected to real robot at {}:{}", ip, port))
        }
        Err(e) => Err(e),
    }
}

// --- Logs (.wpilog) ---------------------------------------------------------

/// Dumps the current buffer to a WPILOG file. It works both for a live session
/// and for re-exporting a log that is already open.
#[tauri::command]
pub async fn export_wpilog(path: String, state: State<'_, NT4State>) -> Result<ExportSummary, String> {
    let client = state.0.lock().await;
    let buffer = client.buffer.lock().await;
    if buffer.topics.is_empty() {
        return Err("No data in the buffer to export.".to_string());
    }
    wpilog::write_wpilog(&buffer, &PathBuf::from(&path))
}

#[derive(Serialize)]
pub struct OpenLogResult {
    pub summary: LogSummary,
    /// The log's topics, so the frontend replaces the tree in one go instead of
    /// receiving hundreds of loose `nt-topic-announced` events.
    pub topics: Vec<TopicAnnounce>,
}

/// Loads a WPILOG into the same buffer NT4 uses. Since the buffer is the whole
/// app's only data source, with this Field, Swerve, Mechanism, Display and
/// Functions read from the log without changing a line.
#[tauri::command]
pub async fn open_wpilog(path: String, state: State<'_, NT4State>) -> Result<OpenLogResult, String> {
    let (topics, summary) = wpilog::read_wpilog(&PathBuf::from(&path))?;

    let mut client = state.0.lock().await;
    // The log and the connection share a buffer: leaving NT4 alive would mix the
    // live data with the file's on the same timeline.
    client.disconnect().await;

    let announces: Vec<TopicAnnounce> = topics
        .iter()
        .map(|(id, h)| TopicAnnounce { id: *id, name: h.name.clone(), topic_type: h.topic_type.clone() })
        .collect();

    let mut buffer = client.buffer.lock().await;
    wpilog::load_into_buffer(&mut buffer, topics, &summary);

    Ok(OpenLogResult { summary, topics: announces })
}

/// Discards the loaded log and leaves the buffer clean to connect again.
#[tauri::command]
pub async fn close_log(state: State<'_, NT4State>) -> Result<(), String> {
    let client = state.0.lock().await;
    let mut buffer = client.buffer.lock().await;
    buffer.topics.clear();
    buffer.end_time = None;
    Ok(())
}

/// Bandwidth usage per topic, over the last `window_seconds` of data in the
/// buffer. At competition the FMS cuts off at 4 Mbps and the typical cause of
/// going over is logging too much without knowing it.
#[tauri::command]
pub async fn get_bandwidth_report(window_seconds: u32, state: State<'_, NT4State>) -> Result<BandwidthReport, String> {
    let client = state.0.lock().await;
    let buffer = client.buffer.lock().await;
    Ok(bandwidth::measure(&buffer, window_seconds))
}

#[derive(Serialize)]
pub struct NTLinkStatus {
    pub address: String,
    pub port: u16,
    pub connected: bool,
    /// Half the round trip measured with the RTT ping, in µs.
    pub latency_us: i64,
    /// The NT server's time in µs, or None if the clocks are not synced yet.
    pub server_time_us: Option<u64>,
}

/// State of the NT4 link as the RTT ping measures it. It shows which host:port
/// we are really talking to (the status bar used to always assume
/// localhost:5810) and whether the clocks are already synced.
#[tauri::command]
pub async fn get_nt_link_status(state: State<'_, NT4State>) -> Result<NTLinkStatus, String> {
    let client = state.0.lock().await;
    Ok(NTLinkStatus {
        address: client.current_ip.clone(),
        port: client.current_port,
        connected: client.is_connected,
        latency_us: client.network_latency_us(),
        server_time_us: client.server_time_us(),
    })
}

#[tauri::command]
pub async fn disconnect_nt(state: State<'_, NT4State>) -> Result<String, String> {
    let mut client = state.0.lock().await;
    client.disconnect().await;
    Ok("Disconnected successfully".to_string())
}

/// Sets how much history per topic is kept in RAM before pruning.
/// `minutes == 0` turns pruning off (the whole session in memory, at the cost of
/// unbounded growth -- meant for whoever wants to record a long test whole and
/// knows they will close the app afterwards).
#[tauri::command]
pub async fn set_buffer_retention_minutes(minutes: u32, state: State<'_, NT4State>) -> Result<(), String> {
    let client = state.0.lock().await;
    let mut buffer = client.buffer.lock().await;
    buffer.set_retention_us(minutes as u64 * 60 * 1_000_000);
    Ok(())
}

#[derive(Serialize)]
pub struct TimeBounds {
    pub start: Option<u64>,
    pub end: Option<u64>,
}

#[tauri::command]
pub async fn get_time_bounds(state: State<'_, NT4State>) -> Result<TimeBounds, String> {
    let client = state.0.lock().await;
    let buffer = client.buffer.lock().await;
    Ok(TimeBounds { start: buffer.effective_start_time(), end: buffer.end_time })
}

#[tauri::command]
pub async fn get_live_values(topic_names: Vec<String>, state: State<'_, NT4State>) -> Result<HashMap<String, NTValue>, String> {
    let client = state.0.lock().await;
    let mut result = HashMap::new();

    let buffer = client.buffer.lock().await;

    for history in buffer.topics.values() {
        if topic_names.contains(&history.name) {
            if let Some((_, last_value)) = history.data.back() {
                result.insert(history.name.clone(), last_value.clone());
            }
        }
    }

    Ok(result)
}

/// Same as get_live_values but for a specific instant in the past: returns
/// each topic's last known value with timestamp <= `timestamp`. It is what the
/// frontend uses when the timeline is paused/scrubbing.
#[tauri::command]
pub async fn get_values_at(
    topic_names: Vec<String>,
    timestamp: u64,
    state: State<'_, NT4State>,
) -> Result<HashMap<String, NTValue>, String> {
    let client = state.0.lock().await;
    let buffer = client.buffer.lock().await;
    let mut result = HashMap::new();

    for history in buffer.topics.values() {
        if !topic_names.contains(&history.name) { continue; }

        // Requires history.data to be sorted by timestamp (it is, since
        // insert_value pushes in the websocket's arrival order).
        let idx = partition_point_deque(&history.data, |(ts, _)| *ts <= timestamp);
        if idx == 0 { continue; } // there was no value yet at that instant
        result.insert(history.name.clone(), history.data[idx - 1].1.clone());
    }

    Ok(result)
}

/// Returns ALL the points of each topic within [start, end]. It is used by
/// FunctionPage/useLiveSeriesBuffers when paused, to rebuild the plot's window
/// from the real buffer instead of local accumulation.
#[tauri::command]
pub async fn get_values_range(
    topic_names: Vec<String>,
    start: u64,
    end: u64,
    state: State<'_, NT4State>,
) -> Result<HashMap<String, Vec<(u64, NTValue)>>, String> {
    let client = state.0.lock().await;
    let buffer = client.buffer.lock().await;
    let mut result = HashMap::new();

    for history in buffer.topics.values() {
        if !topic_names.contains(&history.name) { continue; }

        let lo = partition_point_deque(&history.data, |(ts, _)| *ts < start);
        let hi = partition_point_deque(&history.data, |(ts, _)| *ts <= end);
        result.insert(history.name.clone(), history.data.range(lo..hi).cloned().collect());
    }

    Ok(result)
}

fn type_idx_from_type_str(topic_type: &str) -> Result<i32, String> {
    match topic_type {
        "boolean" => Ok(0),
        "double" => Ok(1),
        "int" => Ok(2),
        "float" => Ok(3),
        "string" => Ok(4),
        // The arrays are needed for the NT Session: a Pose2d published by hand
        // travels as a double[] {x, y, theta}. The indices are the ones NT4's spec
        // fixes and the same `insert_value` decodes.
        "boolean[]" => Ok(16),
        "double[]" => Ok(17),
        "int[]" => Ok(18),
        "float[]" => Ok(19),
        "string[]" => Ok(20),
        // Everything binary shares index 5: WPILib structs, their schemas and
        // loose raw. The frontend builds the bytes (it already has the layout table
        // to decode them) and sends them as an array of numbers.
        "structschema" | "raw" | "rpc" | "msgpack" | "protobuf" => Ok(5),
        other if other.starts_with("struct:") => Ok(5),
        other => Err(format!("Type not supported for writing yet: {}", other)),
    }
}

/// Converts a JSON array applying `item` to each element. A single invalid
/// element invalidates the whole array: publishing half a Pose2d would be
/// worse than failing.
fn json_array_to_rmpv(
    value: &serde_json::Value,
    what: &str,
    item: impl Fn(&serde_json::Value) -> Option<rmpv::Value>,
) -> Result<rmpv::Value, String> {
    let array = value.as_array().ok_or_else(|| format!("Expected a {} array", what))?;
    let mut out = Vec::with_capacity(array.len());
    for entry in array {
        out.push(item(entry).ok_or_else(|| format!("Invalid element in the {} array", what))?);
    }
    Ok(rmpv::Value::Array(out))
}

fn json_to_rmpv(value: &serde_json::Value, type_idx: i32) -> Result<rmpv::Value, String> {
    match type_idx {
        0 => value.as_bool().map(rmpv::Value::from).ok_or_else(|| "Invalid boolean value".to_string()),
        1 | 3 => value.as_f64().map(rmpv::Value::from).ok_or_else(|| "Invalid numeric value".to_string()),
        2 => value.as_i64().map(rmpv::Value::from).ok_or_else(|| "Invalid integer value".to_string()),
        4 => value.as_str().map(|s| rmpv::Value::from(s)).ok_or_else(|| "Invalid text value".to_string()),
        16 => json_array_to_rmpv(value, "boolean", |v| v.as_bool().map(rmpv::Value::from)),
        17 | 19 => json_array_to_rmpv(value, "number", |v| v.as_f64().map(rmpv::Value::from)),
        18 => json_array_to_rmpv(value, "integer", |v| v.as_i64().map(rmpv::Value::from)),
        20 => json_array_to_rmpv(value, "string", |v| v.as_str().map(rmpv::Value::from)),
        // Binary: arrives as an array of bytes 0..255.
        5 => {
            let array = value.as_array().ok_or("Expected a byte array")?;
            let mut bytes = Vec::with_capacity(array.len());
            for entry in array {
                let byte = entry.as_u64().filter(|n| *n <= 255)
                    .ok_or("Byte out of range (expected 0..255)")?;
                bytes.push(byte as u8);
            }
            Ok(rmpv::Value::Binary(bytes))
        }
        _ => Err("Type not supported for writing yet".to_string()),
    }
}

/// Writes a value to a NetworkTables topic (Command Console).
/// `value` arrives as raw JSON from the frontend; it is converted to the right
/// type according to `topic_type` before sending it over the socket.
#[tauri::command]
pub async fn set_value(
    topic_name: String,
    topic_type: String,
    value: serde_json::Value,
    state: State<'_, NT4State>,
) -> Result<(), String> {
    let type_idx = type_idx_from_type_str(&topic_type)?;
    let rmpv_value = json_to_rmpv(&value, type_idx)?;
    let mut client = state.0.lock().await;
    client.set_value(&topic_name, &topic_type, type_idx, rmpv_value).await
}

/// Withdraws a topic published by MARS (see `NT4Client::unpublish`).
#[tauri::command]
pub async fn unpublish_value(topic_name: String, state: State<'_, NT4State>) -> Result<(), String> {
    let mut client = state.0.lock().await;
    client.unpublish(&topic_name).await
}

#[derive(Serialize)]
pub struct JitterStats {
    pub mean_dt_ms: f64,
    pub stddev_dt_ms: f64,
    pub min_dt_ms: f64,
    pub max_dt_ms: f64,
    pub sample_count: usize,
    pub expected_hz: f64,
}

/// Analyzes each topic's arrival timing within a recent window (not the whole
/// session, so it reflects the robot's CURRENT behavior, not an average diluted
/// over hours of connection). It computes the delta between consecutive
/// timestamps -- that is directly the topic's real publishing period, with its
/// drops and overruns included.
#[tauri::command]
pub async fn get_jitter_stats(
    topic_names: Vec<String>,
    window_us: u64,
    state: State<'_, NT4State>,
) -> Result<HashMap<String, JitterStats>, String> {
    let client = state.0.lock().await;
    let buffer = client.buffer.lock().await;
    let mut result = HashMap::new();

    let now = buffer.end_time.unwrap_or(0);
    let cutoff = now.saturating_sub(window_us);

    for history in buffer.topics.values() {
        if !topic_names.contains(&history.name) { continue; }

        let timestamps: Vec<u64> = history.data.iter()
            .map(|(ts, _)| *ts)
            .filter(|&ts| ts >= cutoff)
            .collect();

        if timestamps.len() < 2 { continue; } // not enough samples in the window

        let deltas: Vec<f64> = timestamps.windows(2)
            .map(|w| (w[1] - w[0]) as f64 / 1000.0) // us -> ms
            .collect();

        let n = deltas.len() as f64;
        let mean = deltas.iter().sum::<f64>() / n;
        let variance = deltas.iter().map(|d| (d - mean).powi(2)).sum::<f64>() / n;
        let stddev = variance.sqrt();
        let min = deltas.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = deltas.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        result.insert(history.name.clone(), JitterStats {
            mean_dt_ms: mean,
            stddev_dt_ms: stddev,
            min_dt_ms: min,
            max_dt_ms: max,
            sample_count: timestamps.len(),
            expected_hz: if mean > 0.0 { 1000.0 / mean } else { 0.0 },
        });
    }

    Ok(result)
}