//! NetworkTables for the Characterize tab, through MARS Desktop's NT4 client
//! (the same file, included by path: one client to maintain). The robot runs
//! AresLib's characterization routines and publishes them under
//! /Ares/Characterize; this reads them live and presses their dashboard
//! buttons.

#[path = "../../../../desktop/src-tauri/src/nt4/client.rs"]
#[allow(dead_code)]
pub mod client;

use std::collections::HashMap;
use std::sync::Arc;

use client::{NT4Client, NT4State, NTValue};
use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

pub fn state() -> NT4State {
    NT4State(Arc::new(Mutex::new(NT4Client::new())))
}

const NT4_PORT: u16 = 5810;

/// "sim" (this computer), a team number (10.TE.AM.2), or a host/IP.
fn address(target: &str) -> String {
    let t = target.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("sim") {
        return "127.0.0.1".into();
    }
    match t.parse::<u32>() {
        Ok(team) => format!("10.{}.{:02}.2", team / 100, team % 100),
        Err(_) => t.to_string(),
    }
}

#[tauri::command]
pub async fn nt_connect(target: String, app: AppHandle, state: State<'_, NT4State>) -> Result<String, String> {
    let ip = address(&target);
    let mut client = state.0.lock().await;
    client.disconnect().await;
    client.connect(&ip, NT4_PORT, app).await?;
    client.connection_mode = if ip == "127.0.0.1" { "sim".into() } else { "real".into() };
    Ok(format!("{ip}:{NT4_PORT}"))
}

#[tauri::command]
pub async fn nt_disconnect(state: State<'_, NT4State>) -> Result<(), String> {
    state.0.lock().await.disconnect().await;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NtStatus {
    connected: bool,
    address: String,
}

#[tauri::command]
pub async fn nt_status(state: State<'_, NT4State>) -> Result<NtStatus, String> {
    let c = state.0.lock().await;
    Ok(NtStatus { connected: c.is_connected, address: c.current_ip.clone() })
}

/// The latest value of every topic under `prefix`.
#[tauri::command]
pub async fn nt_read(prefix: String, state: State<'_, NT4State>) -> Result<HashMap<String, NTValue>, String> {
    let c = state.0.lock().await;
    let buffer = c.buffer.lock().await;
    Ok(buffer
        .topics
        .values()
        .filter(|h| h.name.starts_with(&prefix))
        .filter_map(|h| h.data.back().map(|(_, v)| (h.name.clone(), v.clone())))
        .collect())
}

/// Publishes a boolean: what pressing a dashboard command button is (its
/// `running` topic set to true).
#[tauri::command]
pub async fn nt_set_boolean(topic: String, value: bool, state: State<'_, NT4State>) -> Result<(), String> {
    let mut c = state.0.lock().await;
    c.set_value(&topic, "boolean", 0, rmpv::Value::from(value)).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn addresses() {
        assert_eq!(super::address("sim"), "127.0.0.1");
        assert_eq!(super::address("3472"), "10.34.72.2");
        assert_eq!(super::address("254"), "10.2.54.2");
        assert_eq!(super::address("172.22.11.2"), "172.22.11.2");
    }
}
