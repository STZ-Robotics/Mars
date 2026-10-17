//! The Logs tab's backend: a .wpilog from a real run (WPILib's DataLogManager
//! keeps the NetworkTables it saw, AresLib's /Ares among them), read with MARS
//! Desktop's reader, cut into the paths AresLib drove, and used to calibrate
//! the simulator: the world in which it does what the robot did.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use ares_core::RobotConfig;
use ares_tune::calibrate::{calibrate, Calibration, FitVar, Observation};
use ares_tune::{RobotCode, World};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::nt::client::{NTValue, TopicHistory};
use crate::nt::wpilog::read_wpilog;

/// One path AresLib drove, as the log saw it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedRun {
    pub index: usize,
    pub path: String,
    /// Seconds from the log's start.
    pub start_s: f64,
    pub duration_s: f64,
    pub max_err_m: f64,
    pub mean_err_m: f64,
    pub replans: f64,
    /// The gains it ran with, when the log has /Ares/Gains.
    pub translation: Option<[f64; 3]>,
    pub rotation: Option<[f64; 3]>,
    /// Every robot pose in the run, with what went with it.
    pub samples: Vec<LoggedSample>,
    /// The path as published (x, y, heading).
    pub path_poses: Vec<[f64; 3]>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedSample {
    /// Seconds since the run started.
    pub t: f64,
    pub robot: [f64; 3],
    pub target: Option<[f64; 3]>,
    pub commanded: Option<[f64; 3]>,
    pub measured: Option<[f64; 3]>,
    pub err: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInfo {
    pub name: String,
    pub duration_s: f64,
    /// The /Ares topics found; empty means the log has none of AresLib's.
    pub topics: Vec<String>,
    /// The runs, without their samples (ask log_run for those).
    pub runs: Vec<LoggedRun>,
}

static LOG: Mutex<Option<Vec<LoggedRun>>> = Mutex::new(None);

/// The topic whose name ends in `suffix` ("Ares/Robot" finds "NT:/Ares/Robot").
fn find<'a>(topics: &'a HashMap<i32, TopicHistory>, suffix: &str) -> Option<&'a TopicHistory> {
    topics.values().find(|h| h.name.ends_with(suffix) && h.name.contains("Ares/"))
}

fn poses(v: &NTValue) -> Vec<[f64; 3]> {
    let NTValue::Raw(b) = v else { return vec![] };
    b.chunks_exact(24)
        .map(|c| {
            let f = |i: usize| f64::from_le_bytes(c[i..i + 8].try_into().unwrap());
            [f(0), f(8), f(16)]
        })
        .collect()
}

fn triple(v: &NTValue) -> Option<[f64; 3]> {
    match v {
        NTValue::NumberArray(a) if a.len() >= 3 => Some([a[0], a[1], a[2]]),
        _ => None,
    }
}

/// The value of `h` at time `ts` (the last one at or before it).
fn at(h: Option<&TopicHistory>, ts: u64) -> Option<&NTValue> {
    let h = h?;
    let i = h.data.partition_point(|(t, _)| *t <= ts);
    if i == 0 { None } else { Some(&h.data[i - 1].1) }
}

/// The runs in a log: every stretch where /Ares/Active names a path.
pub fn runs_of(topics: &HashMap<i32, TopicHistory>) -> Vec<LoggedRun> {
    let (Some(active), Some(robot)) = (find(topics, "Ares/Active"), find(topics, "Ares/Robot")) else { return vec![] };
    let (target, path, cmd, meas, err, replans) = (
        find(topics, "Ares/Target"),
        find(topics, "Ares/Path"),
        find(topics, "Ares/CommandedSpeeds"),
        find(topics, "Ares/MeasuredSpeeds"),
        find(topics, "Ares/ErrorM"),
        find(topics, "Ares/Replans"),
    );
    let (tg, rg) = (find(topics, "Ares/Gains/Translation"), find(topics, "Ares/Gains/Rotation"));
    let first = topics.values().filter_map(|h| h.data.front().map(|(t, _)| *t)).min().unwrap_or(0);
    // The stretches.
    let mut spans: Vec<(String, u64, u64)> = vec![];
    let mut open: Option<(String, u64)> = None;
    for (ts, v) in &active.data {
        let name = match v {
            NTValue::String(s) => s.clone(),
            _ => continue,
        };
        if let Some((n, s)) = open.take() {
            if n == name {
                open = Some((n, s));
                continue;
            }
            spans.push((n, s, *ts));
        }
        if !name.is_empty() && name != "pathfinding" {
            open = Some((name, *ts));
        }
    }
    if let Some((n, s)) = open {
        spans.push((n, s, robot.data.back().map(|(t, _)| *t).unwrap_or(s)));
    }
    spans
        .into_iter()
        .enumerate()
        .map(|(index, (name, s, e))| {
            let mut samples = vec![];
            for (ts, v) in robot.data.iter().filter(|(t, _)| *t >= s && *t <= e) {
                let Some(r) = poses(v).first().copied() else { continue };
                samples.push(LoggedSample {
                    t: (*ts - s) as f64 / 1e6,
                    robot: r,
                    target: at(target, *ts).and_then(|v| poses(v).first().copied()),
                    commanded: at(cmd, *ts).and_then(triple),
                    measured: at(meas, *ts).and_then(triple),
                    err: match at(err, *ts) {
                        Some(NTValue::Number(x)) => *x,
                        _ => 0.0,
                    },
                });
            }
            let errs: Vec<f64> = samples.iter().map(|k| k.err).collect();
            LoggedRun {
                index,
                path: name,
                start_s: (s - first) as f64 / 1e6,
                duration_s: (e - s) as f64 / 1e6,
                max_err_m: errs.iter().copied().fold(0.0, f64::max),
                mean_err_m: if errs.is_empty() { 0.0 } else { errs.iter().sum::<f64>() / errs.len() as f64 },
                replans: match at(replans, e) {
                    Some(NTValue::Number(x)) => *x,
                    _ => 0.0,
                },
                translation: at(tg, e).and_then(triple),
                rotation: at(rg, e).and_then(triple),
                path_poses: at(path, s + 1).map(poses).filter(|p| !p.is_empty()).or_else(|| at(path, e).map(poses)).unwrap_or_default(),
                samples,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn log_open(path: String) -> Result<LogInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (topics, summary) = read_wpilog(Path::new(&path))?;
        let runs = runs_of(&topics);
        let mut names: Vec<String> = topics.values().filter(|h| h.name.contains("Ares/")).map(|h| h.name.clone()).collect();
        names.sort();
        let duration = match (summary.start_us, summary.end_us) {
            (Some(s), Some(e)) => (e - s) as f64 / 1e6,
            _ => 0.0,
        };
        let light = runs.iter().map(|r| LoggedRun { samples: vec![], path_poses: vec![], ..r.clone() }).collect();
        *LOG.lock().unwrap() = Some(runs);
        Ok(LogInfo { name: summary.name, duration_s: duration, topics: names, runs: light })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn log_run(index: usize) -> Result<LoggedRun, String> {
    LOG.lock().unwrap().as_ref().and_then(|r| r.get(index).cloned()).ok_or_else(|| "Open a log first".to_string())
}

static CANCEL: AtomicBool = AtomicBool::new(false);

/// The world in which the simulator does what the robot did in run `index`.
/// The robot code's PIDs are the ones the log says it ran with, when it says.
#[tauri::command]
pub async fn log_calibrate(
    app: AppHandle,
    robot: RobotConfig,
    robot_path: String,
    index: usize,
    code: RobotCode,
    world: World,
    vars: Vec<FitVar>,
    generations: usize,
) -> Result<Calibration, String> {
    let run = log_run(index)?;
    let traj = crate::project::trajectory_open(robot_path, run.path.clone())
        .ok_or_else(|| format!("\"{}\" has no trajectory in this project: the log is from a path this project does not have", run.path))?;
    let mut code = code;
    if let Some(t) = run.translation {
        code.translation = ares_tune::Pid { kp: t[0], ki: t[1], kd: t[2] };
    }
    if let Some(r) = run.rotation {
        code.rotation = ares_tune::Pid { kp: r[0], ki: r[1], kd: r[2] };
    }
    let obs: Vec<Observation> = run.samples.iter().map(|s| Observation { t: s.t, x: s.robot[0], y: s.robot[1], heading: s.robot[2] }).collect();
    if obs.len() < 10 {
        return Err("The run has too few poses to compare".into());
    }
    CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(calibrate(&robot, &traj, &code, &world, &vars, &obs, generations, 24, &CANCEL, |g, rms| {
            let _ = app.emit("log-calibrate-progress", (g, rms));
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn log_calibrate_cancel() {
    CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nt::client::NTBuffer;
    use crate::nt::wpilog::write_wpilog;

    fn pose_bytes(p: &[[f64; 3]]) -> rmpv::Value {
        rmpv::Value::Binary(p.iter().flat_map(|q| q.iter().flat_map(|v| v.to_le_bytes())).collect())
    }

    /// A log as DataLogManager writes it: NT:/Ares/... topics, a run of
    /// "Main" from 1.0 s to 2.0 s, the robot moving along x.
    pub(crate) fn synthetic_log(path: &Path) {
        let mut b = NTBuffer::new();
        b.set_retention_us(0);
        let topics = [
            (1, "NT:/Ares/Active", "string"),
            (2, "NT:/Ares/Robot", "struct:Pose2d"),
            (3, "NT:/Ares/Target", "struct:Pose2d"),
            (4, "NT:/Ares/ErrorM", "double"),
            (5, "NT:/Ares/CommandedSpeeds", "double[]"),
            (6, "NT:/Ares/MeasuredSpeeds", "double[]"),
            (7, "NT:/Ares/Gains/Translation", "double[]"),
            (8, "NT:/Ares/Gains/Rotation", "double[]"),
            (9, "NT:/Ares/Path", "struct:Pose2d[]"),
            (10, "NT:/SmartDashboard/Other", "double"),
        ];
        for (id, name, ty) in topics {
            b.add_topic(id, name.into(), ty.into());
        }
        let s = 10_000_000u64;
        b.insert_value(1, s, 4, "".into());
        b.insert_value(7, s, 17, rmpv::Value::Array(vec![2.5.into(), 0.0.into(), 0.1.into()]));
        b.insert_value(8, s, 17, rmpv::Value::Array(vec![3.0.into(), 0.0.into(), 0.0.into()]));
        b.insert_value(9, s + 1_000_000, 5, pose_bytes(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]));
        b.insert_value(1, s + 1_000_000, 4, "Main".into());
        for k in 0..=50u64 {
            let ts = s + 1_000_000 + k * 20_000;
            let x = k as f64 * 0.02;
            b.insert_value(2, ts, 5, pose_bytes(&[[x, 0.01, 0.0]]));
            b.insert_value(3, ts, 5, pose_bytes(&[[x + 0.02, 0.0, 0.0]]));
            b.insert_value(4, ts, 1, 0.022.into());
            b.insert_value(5, ts, 17, rmpv::Value::Array(vec![1.0.into(), 0.0.into(), 0.0.into()]));
            b.insert_value(6, ts, 17, rmpv::Value::Array(vec![0.98.into(), 0.0.into(), 0.0.into()]));
        }
        b.insert_value(1, s + 2_000_000, 4, "".into());
        b.insert_value(10, s + 3_000_000, 1, 1.0.into());
        write_wpilog(&b, path).unwrap();
    }

    #[test]
    fn a_log_is_cut_into_the_paths_ares_drove() {
        let path = std::env::temp_dir().join(format!("ares-log-{}.wpilog", std::process::id()));
        synthetic_log(&path);
        let (topics, _) = read_wpilog(&path).unwrap();
        let runs = runs_of(&topics);
        assert_eq!(runs.len(), 1);
        let r = &runs[0];
        assert_eq!(r.path, "Main");
        assert!((r.duration_s - 1.0).abs() < 1e-9, "{}", r.duration_s);
        assert_eq!(r.samples.len(), 51);
        assert!((r.samples[50].robot[0] - 1.0).abs() < 1e-9);
        assert_eq!(r.samples[10].commanded, Some([1.0, 0.0, 0.0]));
        assert_eq!(r.translation, Some([2.5, 0.0, 0.1]));
        assert_eq!(r.path_poses.len(), 2);
        assert!((r.max_err_m - 0.022).abs() < 1e-12);
        assert!((r.start_s - 1.0).abs() < 1e-9);
    }
}
