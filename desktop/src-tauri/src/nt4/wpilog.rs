//! WPILOG (WPILib's DataLog) reader and writer, version 1.0.
//! Spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.adoc
//!
//! File layout:
//!
//!   header = "WPILOG" + u16 version (0x0100) + u32 len + extra header (JSON)
//!   record = bitfield + entry id + payload size + timestamp + payload
//!
//! The bitfield says how many BYTES each field of the record takes (all little
//! endian), which lets a small timestamp not spend 8 bytes:
//!
//!   bits 0-1 -> length of the entry id      - 1   (1..4)
//!   bits 2-3 -> length of the payload size  - 1   (1..4)
//!   bits 4-6 -> length of the timestamp     - 1   (1..8)
//!
//! Entry id 0 is reserved for CONTROL records, which are the ones that declare
//! each entry's name and type (start), retire it (finish) or change its
//! metadata. Without them a data record is just loose bytes.
//!
//! When writing we always use each field's maximum size (4/4/8): the file comes
//! out somewhat bigger but the writer has no special cases. When reading every
//! size is honored, because the files the robot produces come with the fields
//! compressed.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::Path;

use serde::Serialize;

use super::client::{NTBuffer, NTValue, TopicHistory};

const MAGIC: &[u8; 6] = b"WPILOG";
const VERSION: u16 = 0x0100;

// Fixed sizes the writer uses (the reader accepts any).
const WRITE_ID_LEN: usize = 4;
const WRITE_SIZE_LEN: usize = 4;
const WRITE_TS_LEN: usize = 8;

// --- Type translation ----------------------------------------------------

/// NT4 says "int"/"int[]"; wpilog calls them "int64"/"int64[]". The rest of the
/// names match, including "struct:Foo", "proto:Foo" and "msgpack".
fn nt_type_to_wpilog(t: &str) -> String {
    match t {
        "int" => "int64".to_string(),
        "int[]" => "int64[]".to_string(),
        other => other.to_string(),
    }
}

fn wpilog_type_to_nt(t: &str) -> String {
    match t {
        "int64" => "int".to_string(),
        "int64[]" => "int[]".to_string(),
        other => other.to_string(),
    }
}

// --- Payload encoding ----------------------------------------------

// The declared type wins over the stored variant: an "int" topic lives in
// memory as NTValue::Number(f64) but in the file it has to come out as an
// 8-byte i64, or no other reader will understand it.
fn encode_payload(wpilog_type: &str, value: &NTValue) -> Option<Vec<u8>> {
    match (wpilog_type, value) {
        ("boolean", NTValue::Boolean(b)) => Some(vec![u8::from(*b)]),
        ("int64", NTValue::Number(n)) => Some((*n as i64).to_le_bytes().to_vec()),
        ("float", NTValue::Number(n)) => Some((*n as f32).to_le_bytes().to_vec()),
        ("double", NTValue::Number(n)) => Some(n.to_le_bytes().to_vec()),
        ("string", NTValue::String(s)) | ("json", NTValue::String(s)) => Some(s.as_bytes().to_vec()),

        ("boolean[]", NTValue::BooleanArray(a)) => Some(a.iter().map(|b| u8::from(*b)).collect()),
        ("int64[]", NTValue::NumberArray(a)) => {
            Some(a.iter().flat_map(|n| (*n as i64).to_le_bytes()).collect())
        }
        ("float[]", NTValue::NumberArray(a)) => {
            Some(a.iter().flat_map(|n| (*n as f32).to_le_bytes()).collect())
        }
        ("double[]", NTValue::NumberArray(a)) => {
            Some(a.iter().flat_map(|n| n.to_le_bytes()).collect())
        }
        // string[] is the only one that needs framing of its own: a u32 with the
        // count and then each string preceded by its length.
        ("string[]", NTValue::StringArray(a)) => {
            let mut out = Vec::new();
            out.extend_from_slice(&(a.len() as u32).to_le_bytes());
            for s in a {
                out.extend_from_slice(&(s.len() as u32).to_le_bytes());
                out.extend_from_slice(s.as_bytes());
            }
            Some(out)
        }

        // Cualquier tipo desconocido (structs, protobuf, msgpack) viaja crudo.
        (_, NTValue::Raw(b)) => Some(b.clone()),

        // The declared type and the stored value do not agree: the sample is
        // skipped instead of writing bytes nobody can decode later.
        _ => None,
    }
}

fn decode_payload(wpilog_type: &str, payload: &[u8]) -> Option<NTValue> {
    match wpilog_type {
        "boolean" => Some(NTValue::Boolean(payload.first().copied().unwrap_or(0) != 0)),
        "int64" => {
            if payload.len() < 8 { return None; }
            Some(NTValue::Number(i64::from_le_bytes(payload[..8].try_into().ok()?) as f64))
        }
        "float" => {
            if payload.len() < 4 { return None; }
            Some(NTValue::Number(f32::from_le_bytes(payload[..4].try_into().ok()?) as f64))
        }
        "double" => {
            if payload.len() < 8 { return None; }
            Some(NTValue::Number(f64::from_le_bytes(payload[..8].try_into().ok()?)))
        }
        "string" | "json" => Some(NTValue::String(String::from_utf8_lossy(payload).into_owned())),

        "boolean[]" => Some(NTValue::BooleanArray(payload.iter().map(|b| *b != 0).collect())),
        "int64[]" => Some(NTValue::NumberArray(
            payload.chunks_exact(8)
                .map(|c| i64::from_le_bytes(c.try_into().unwrap()) as f64)
                .collect(),
        )),
        "float[]" => Some(NTValue::NumberArray(
            payload.chunks_exact(4)
                .map(|c| f32::from_le_bytes(c.try_into().unwrap()) as f64)
                .collect(),
        )),
        "double[]" => Some(NTValue::NumberArray(
            payload.chunks_exact(8)
                .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
                .collect(),
        )),
        "string[]" => {
            if payload.len() < 4 { return None; }
            let count = u32::from_le_bytes(payload[..4].try_into().ok()?) as usize;
            let mut cursor = 4usize;
            let mut out = Vec::with_capacity(count.min(1024));
            for _ in 0..count {
                if cursor + 4 > payload.len() { break; }
                let len = u32::from_le_bytes(payload[cursor..cursor + 4].try_into().ok()?) as usize;
                cursor += 4;
                if cursor + len > payload.len() { break; }
                out.push(String::from_utf8_lossy(&payload[cursor..cursor + len]).into_owned());
                cursor += len;
            }
            Some(NTValue::StringArray(out))
        }

        _ => Some(NTValue::Raw(payload.to_vec())),
    }
}

// --- Escritura --------------------------------------------------------------

#[derive(Serialize)]
pub struct ExportSummary {
    pub path: String,
    pub topic_count: usize,
    pub sample_count: usize,
    pub bytes: u64,
}

fn write_record(out: &mut impl Write, entry_id: u32, timestamp: u64, payload: &[u8]) -> std::io::Result<()> {
    let bitfield: u8 = ((WRITE_ID_LEN - 1) as u8)
        | (((WRITE_SIZE_LEN - 1) as u8) << 2)
        | (((WRITE_TS_LEN - 1) as u8) << 4);
    out.write_all(&[bitfield])?;
    out.write_all(&entry_id.to_le_bytes())?;
    out.write_all(&(payload.len() as u32).to_le_bytes())?;
    out.write_all(&timestamp.to_le_bytes())?;
    out.write_all(payload)
}

fn control_start(entry_id: u32, name: &str, type_str: &str, metadata: &str) -> Vec<u8> {
    let mut p = vec![0u8]; // 0 = Start
    p.extend_from_slice(&entry_id.to_le_bytes());
    for s in [name, type_str, metadata] {
        p.extend_from_slice(&(s.len() as u32).to_le_bytes());
        p.extend_from_slice(s.as_bytes());
    }
    p
}

pub fn write_wpilog(buffer: &NTBuffer, path: &Path) -> Result<ExportSummary, String> {
    let file = File::create(path).map_err(|e| format!("Could not create {}: {}", path.display(), e))?;
    let mut out = BufWriter::new(file);

    // Header. The extra header is free text; a JSON with the source is left so
    // that on reopening it is known where it came from.
    out.write_all(MAGIC).map_err(|e| e.to_string())?;
    out.write_all(&VERSION.to_le_bytes()).map_err(|e| e.to_string())?;
    let extra = format!("{{\"source\":\"MARS\",\"version\":\"1.0\"}}");
    out.write_all(&(extra.len() as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    out.write_all(extra.as_bytes()).map_err(|e| e.to_string())?;

    // The file's entry ids are its own (1..N) and not the NT server's: 0 is
    // reserved for control and NT's ids can start at 0.
    let mut entry_ids: HashMap<i32, u32> = HashMap::new();
    let mut next_entry_id: u32 = 1;
    let mut topic_count = 0usize;

    // A flat index of all the samples so they can be sorted by time without
    // materializing the payloads: only (timestamp, entry, topic, idx) is stored,
    // and the payload is encoded only when writing.
    let mut index: Vec<(u64, u32, i32, usize)> = Vec::new();

    let mut topic_ids: Vec<&i32> = buffer.topics.keys().collect();
    topic_ids.sort();

    for topic_id in topic_ids {
        let history = &buffer.topics[topic_id];
        if history.data.is_empty() { continue; }

        let entry_id = next_entry_id;
        next_entry_id += 1;
        entry_ids.insert(*topic_id, entry_id);
        topic_count += 1;

        let wpilog_type = nt_type_to_wpilog(&history.topic_type);
        // The start record goes at the topic's first timestamp: declaring the
        // entry AFTER its first data point leaves that point orphaned on rereading.
        let first_ts = history.data.front().map(|(ts, _)| *ts).unwrap_or(0);
        let payload = control_start(entry_id, &history.name, &wpilog_type, "");
        write_record(&mut out, 0, first_ts, &payload).map_err(|e| e.to_string())?;

        for (idx, (ts, _)) in history.data.iter().enumerate() {
            index.push((*ts, entry_id, *topic_id, idx));
        }
    }

    index.sort_by_key(|(ts, entry, _, _)| (*ts, *entry));

    let mut sample_count = 0usize;
    for (ts, entry_id, topic_id, idx) in &index {
        let history = &buffer.topics[topic_id];
        let (_, value) = &history.data[*idx];
        let wpilog_type = nt_type_to_wpilog(&history.topic_type);
        if let Some(payload) = encode_payload(&wpilog_type, value) {
            write_record(&mut out, *entry_id, *ts, &payload).map_err(|e| e.to_string())?;
            sample_count += 1;
        }
    }

    out.flush().map_err(|e| e.to_string())?;
    drop(out);

    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportSummary {
        path: path.display().to_string(),
        topic_count,
        sample_count,
        bytes,
    })
}

// --- Lectura ----------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct LogSummary {
    pub path: String,
    pub name: String,
    pub topic_count: usize,
    pub sample_count: usize,
    pub start_us: Option<u64>,
    pub end_us: Option<u64>,
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.remaining() < n { return None; }
        let slice = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Some(slice)
    }

    /// Little endian integer of `n` bytes (1..8), which is how the format stores
    /// the record header's variable-length fields.
    fn take_uint(&mut self, n: usize) -> Option<u64> {
        let bytes = self.take(n)?;
        let mut value: u64 = 0;
        for (i, b) in bytes.iter().enumerate() {
            value |= (*b as u64) << (8 * i);
        }
        Some(value)
    }

    fn take_u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    fn take_string(&mut self) -> Option<String> {
        let len = self.take_u32()? as usize;
        Some(String::from_utf8_lossy(self.take(len)?).into_owned())
    }
}

/// The app's tree splits names by "/" and table prefixes are built with a
/// leading slash, so the log's names are normalized the same way.
fn normalize_name(name: &str) -> String {
    if name.starts_with('/') { name.to_string() } else { format!("/{}", name) }
}

pub fn read_wpilog(path: &Path) -> Result<(HashMap<i32, TopicHistory>, LogSummary), String> {
    let mut file = File::open(path).map_err(|e| format!("Could not open {}: {}", path.display(), e))?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(|e| format!("Error reading the file: {}", e))?;

    let mut cursor = Cursor { data: &data, pos: 0 };

    if cursor.take(6) != Some(MAGIC) {
        return Err("Not a WPILOG file (the header signature is missing).".to_string());
    }
    let version = cursor.take_uint(2).ok_or("Cabecera incompleta")? as u16;
    if version >> 8 != 1 {
        return Err(format!("Unsupported WPILOG version: {}.{}", version >> 8, version & 0xff));
    }
    let extra_len = cursor.take_u32().ok_or("Cabecera incompleta")? as usize;
    cursor.take(extra_len).ok_or("Cabecera incompleta")?;

    // A file's entry id can be retired (finish) and reused for another name, so
    // the entry->topic map is rebuilt on every start; topics are identified by
    // NAME, which is the only stable thing.
    let mut topics: HashMap<i32, TopicHistory> = HashMap::new();
    let mut by_name: HashMap<String, i32> = HashMap::new();
    let mut entry_to_topic: HashMap<u32, i32> = HashMap::new();
    let mut next_topic_id: i32 = 0;

    let mut sample_count = 0usize;
    let mut start_us: Option<u64> = None;
    let mut end_us: Option<u64> = None;

    while cursor.remaining() > 0 {
        let bitfield = match cursor.take(1) {
            Some(b) => b[0],
            None => break,
        };
        let id_len = ((bitfield & 0x03) + 1) as usize;
        let size_len = (((bitfield >> 2) & 0x03) + 1) as usize;
        let ts_len = (((bitfield >> 4) & 0x07) + 1) as usize;

        let entry_id = match cursor.take_uint(id_len) { Some(v) => v as u32, None => break };
        let payload_size = match cursor.take_uint(size_len) { Some(v) => v as usize, None => break };
        let timestamp = match cursor.take_uint(ts_len) { Some(v) => v, None => break };
        let payload = match cursor.take(payload_size) { Some(p) => p, None => break };

        if entry_id == 0 {
            // Record de control.
            let mut ctrl = Cursor { data: payload, pos: 0 };
            let ctrl_type = match ctrl.take(1) { Some(b) => b[0], None => continue };
            match ctrl_type {
                0 => {
                    // Start: declares (or redeclares) an entry.
                    let (Some(file_entry), Some(name), Some(type_str)) =
                        (ctrl.take_u32(), ctrl.take_string(), ctrl.take_string())
                    else { continue };

                    let name = normalize_name(&name);
                    let nt_type = wpilog_type_to_nt(&type_str);

                    let topic_id = *by_name.entry(name.clone()).or_insert_with(|| {
                        let id = next_topic_id;
                        next_topic_id += 1;
                        topics.insert(id, TopicHistory {
                            name: name.clone(),
                            topic_type: nt_type.clone(),
                            data: Default::default(),
                        });
                        id
                    });
                    entry_to_topic.insert(file_entry, topic_id);
                }
                1 => {
                    // Finish: the entry stops existing, but the data already read
                    // is kept.
                    if let Some(file_entry) = ctrl.take_u32() {
                        entry_to_topic.remove(&file_entry);
                    }
                }
                _ => { /* setMetadata and future ones: they do not change the values */ }
            }
            continue;
        }

        let Some(topic_id) = entry_to_topic.get(&entry_id).copied() else {
            // Data for an entry that was never declared: without a type it cannot
            // be decoded, so it is discarded instead of guessed.
            continue;
        };
        let Some(history) = topics.get_mut(&topic_id) else { continue };

        let wpilog_type = nt_type_to_wpilog(&history.topic_type);
        if let Some(value) = decode_payload(&wpilog_type, payload) {
            history.data.push_back((timestamp, value));
            sample_count += 1;
            start_us = Some(start_us.map_or(timestamp, |s: u64| s.min(timestamp)));
            end_us = Some(end_us.map_or(timestamp, |e: u64| e.max(timestamp)));
        }
    }

    // The buffer and `get_values_at` assume data sorted by timestamp; a file
    // can carry out-of-order records (several writers, or merges).
    for history in topics.values_mut() {
        if history.data.iter().zip(history.data.iter().skip(1)).any(|((a, _), (b, _))| a > b) {
            let mut sorted: Vec<_> = history.data.drain(..).collect();
            sorted.sort_by_key(|(ts, _)| *ts);
            history.data = sorted.into();
        }
    }

    topics.retain(|_, h| !h.data.is_empty());

    let summary = LogSummary {
        path: path.display().to_string(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        topic_count: topics.len(),
        sample_count,
        start_us,
        end_us,
    };

    if topics.is_empty() {
        return Err("The file does not contain any readable data.".to_string());
    }

    Ok((topics, summary))
}

/// Replaces the buffer's contents with a log's. Retention is turned off: a
/// 40-minute log cannot be pruned to the 15-minute window the live mode uses,
/// or half the session would vanish on opening it.
pub fn load_into_buffer(buffer: &mut NTBuffer, topics: HashMap<i32, TopicHistory>, summary: &LogSummary) {
    buffer.topics = topics;
    buffer.end_time = summary.end_us;
    buffer.retention_us = 0;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn topic(id: i32, name: &str, ty: &str, data: Vec<(u64, NTValue)>) -> (i32, TopicHistory) {
        (id, TopicHistory {
            name: name.to_string(),
            topic_type: ty.to_string(),
            data: VecDeque::from(data),
        })
    }

    fn sample_buffer() -> NTBuffer {
        let mut buffer = NTBuffer::new();
        let entries = vec![
            topic(0, "/Robot/Enabled", "boolean", vec![(100, NTValue::Boolean(true)), (200, NTValue::Boolean(false))]),
            topic(1, "/Robot/Voltage", "double", vec![(150, NTValue::Number(12.75))]),
            topic(2, "/Robot/Ticks", "int", vec![(120, NTValue::Number(4096.0))]),
            topic(3, "/Robot/Mode", "string", vec![(110, NTValue::String("teleop".into()))]),
            topic(4, "/Mech/dims", "double[]", vec![(105, NTValue::NumberArray(vec![3.0, 2.5]))]),
            topic(5, "/Robot/Flags", "boolean[]", vec![(130, NTValue::BooleanArray(vec![true, false, true]))]),
            topic(6, "/Robot/Names", "string[]", vec![(140, NTValue::StringArray(vec!["a".into(), "bb".into()]))]),
            topic(7, "/Odom/Pose", "struct:Pose2d", vec![(160, NTValue::Raw(vec![1, 2, 3, 4, 5, 6, 7, 8]))]),
            topic(8, "/Robot/Counts", "int[]", vec![(170, NTValue::NumberArray(vec![1.0, -2.0, 3.0]))]),
        ];
        for (id, history) in entries {
            buffer.topics.insert(id, history);
        }
        buffer.end_time = Some(200);
        buffer
    }

    #[test]
    fn roundtrip_preserves_every_type() {
        let buffer = sample_buffer();
        let path = std::env::temp_dir().join("mars_wpilog_roundtrip.wpilog");
        let summary = write_wpilog(&buffer, &path).expect("write failed");
        assert_eq!(summary.topic_count, 9);
        assert_eq!(summary.sample_count, 10);

        let (topics, log) = read_wpilog(&path).expect("read failed");
        assert_eq!(log.topic_count, 9);
        assert_eq!(log.sample_count, 10);
        assert_eq!(log.start_us, Some(100));
        assert_eq!(log.end_us, Some(200));

        let by_name: HashMap<String, &TopicHistory> =
            topics.values().map(|h| (h.name.clone(), h)).collect();

        // The declared type has to survive the round trip through wpilog
        // (where "int" is called "int64").
        assert_eq!(by_name["/Robot/Ticks"].topic_type, "int");
        assert_eq!(by_name["/Robot/Counts"].topic_type, "int[]");
        assert_eq!(by_name["/Odom/Pose"].topic_type, "struct:Pose2d");

        let check = |name: &str, expected: Vec<(u64, NTValue)>| {
            let actual = &by_name[name].data;
            assert_eq!(actual.len(), expected.len(), "{} sample count", name);
            for (i, (ts, value)) in expected.iter().enumerate() {
                assert_eq!(actual[i].0, *ts, "{}[{}] timestamp", name, i);
                assert_eq!(
                    format!("{:?}", actual[i].1), format!("{:?}", value),
                    "{}[{}] value", name, i
                );
            }
        };

        check("/Robot/Enabled", vec![(100, NTValue::Boolean(true)), (200, NTValue::Boolean(false))]);
        check("/Robot/Voltage", vec![(150, NTValue::Number(12.75))]);
        check("/Robot/Ticks", vec![(120, NTValue::Number(4096.0))]);
        check("/Robot/Mode", vec![(110, NTValue::String("teleop".into()))]);
        check("/Mech/dims", vec![(105, NTValue::NumberArray(vec![3.0, 2.5]))]);
        check("/Robot/Flags", vec![(130, NTValue::BooleanArray(vec![true, false, true]))]);
        check("/Robot/Names", vec![(140, NTValue::StringArray(vec!["a".into(), "bb".into()]))]);
        check("/Odom/Pose", vec![(160, NTValue::Raw(vec![1, 2, 3, 4, 5, 6, 7, 8]))]);
        check("/Robot/Counts", vec![(170, NTValue::NumberArray(vec![1.0, -2.0, 3.0]))]);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn records_are_written_in_timestamp_order() {
        let buffer = sample_buffer();
        let path = std::env::temp_dir().join("mars_wpilog_order.wpilog");
        write_wpilog(&buffer, &path).expect("write failed");

        let data = std::fs::read(&path).expect("read failed");
        let mut cursor = Cursor { data: &data, pos: 0 };
        cursor.take(6).unwrap();
        cursor.take_uint(2).unwrap();
        let extra = cursor.take_u32().unwrap() as usize;
        cursor.take(extra).unwrap();

        let mut last_data_ts = 0u64;
        while cursor.remaining() > 0 {
            let bitfield = cursor.take(1).unwrap()[0];
            let id_len = ((bitfield & 0x03) + 1) as usize;
            let size_len = (((bitfield >> 2) & 0x03) + 1) as usize;
            let ts_len = (((bitfield >> 4) & 0x07) + 1) as usize;
            let entry = cursor.take_uint(id_len).unwrap();
            let size = cursor.take_uint(size_len).unwrap() as usize;
            let ts = cursor.take_uint(ts_len).unwrap();
            cursor.take(size).unwrap();
            if entry != 0 {
                assert!(ts >= last_data_ts, "records out of order: {} after {}", ts, last_data_ts);
                last_data_ts = ts;
            }
        }

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_files_that_are_not_wpilog() {
        let path = std::env::temp_dir().join("mars_wpilog_bogus.wpilog");
        std::fs::write(&path, b"not a log at all").unwrap();
        assert!(read_wpilog(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_records_with_compact_field_widths() {
        // The robot's files do not always use 4/4/8 bytes like our writer: they
        // compress each field to the minimum. The reader has to accept it.
        let mut data = Vec::new();
        data.extend_from_slice(MAGIC);
        data.extend_from_slice(&VERSION.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());

        // bitfield: id 1 byte, size 1 byte, timestamp 1 byte
        let compact: u8 = 0;
        let start = control_start(7, "/Compact", "double", "");
        data.push(compact);
        data.push(0);
        data.push(start.len() as u8);
        data.push(42);
        data.extend_from_slice(&start);

        let payload = 3.5f64.to_le_bytes();
        data.push(compact);
        data.push(7);
        data.push(payload.len() as u8);
        data.push(99);
        data.extend_from_slice(&payload);

        let path = std::env::temp_dir().join("mars_wpilog_compact.wpilog");
        std::fs::write(&path, &data).unwrap();

        let (topics, summary) = read_wpilog(&path).expect("read failed");
        assert_eq!(summary.sample_count, 1);
        let history = topics.values().next().unwrap();
        assert_eq!(history.name, "/Compact");
        assert_eq!(history.data[0].0, 99);
        assert_eq!(format!("{:?}", history.data[0].1), format!("{:?}", NTValue::Number(3.5)));

        let _ = std::fs::remove_file(&path);
    }
}
