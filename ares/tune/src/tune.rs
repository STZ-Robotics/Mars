//! The search: gains tried against many worlds, kept by how they do in the
//! worst of them (or on average), generation after generation.
//!
//! What `tools/robust_autotune.py` did in Gazebo, but in the time Ares's own
//! simulator takes (about a millisecond a run instead of a minute), so a
//! search can try thousands of gain sets against dozens of worlds while you
//! watch: a grid over the gains, or a population that learns where the good
//! gains are (the cross-entropy method: sample, keep the best fifth, move
//! toward them, narrow, repeat).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ares_core::trajectory::Trajectory;
use ares_core::RobotConfig;
use serde::{Deserialize, Serialize};

use crate::sim::{simulate, RobotCode, RunResult, SimOptions, World};

/// A gain the search may move.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    /// translationKp, translationKi, translationKd, rotationKp, rotationKi,
    /// rotationKd, driveKp, driveKs, driveKv.
    pub key: String,
    pub min: f64,
    pub max: f64,
    /// Where it starts (and what it stays at when not tuned).
    pub start: f64,
    /// Search it on a log scale: for a kP, 2→4 is as far as 10→20.
    #[serde(default)]
    pub log: bool,
    #[serde(default = "yes")]
    pub tune: bool,
}

fn yes() -> bool {
    true
}

pub fn set_param(code: &mut RobotCode, key: &str, v: f64) {
    match key {
        "translationKp" => code.translation.kp = v,
        "translationKi" => code.translation.ki = v,
        "translationKd" => code.translation.kd = v,
        "rotationKp" => code.rotation.kp = v,
        "rotationKi" => code.rotation.ki = v,
        "rotationKd" => code.rotation.kd = v,
        "driveKp" => code.drive_kp = v,
        "driveKs" => code.drive_ks = v,
        "driveKv" => code.drive_kv = v,
        _ => {}
    }
}

/// Sets a world variable by its (camelCase) name.
pub fn set_world(w: &mut World, key: &str, v: f64) {
    match key {
        "massKg" => w.mass_kg = v,
        "moiKgM2" => w.moi_kg_m2 = v,
        "cogHeightM" => w.cog_height_m = v.max(0.0),
        "mu" => w.mu = v.max(0.05),
        "batteryV" => w.battery_v = v,
        "batteryROhm" => w.battery_r_ohm = v.max(0.0),
        "wheelRadiusM" => w.wheel_radius_m = v,
        "motorScale" => w.motor_scale = v.max(0.1),
        "driveFrictionV" => w.drive_friction_v = v.max(0.0),
        "wheelMassKg" => w.wheel_mass_kg = v.max(0.05),
        "latencyS" => w.latency_s = v.max(0.0),
        "poseNoiseM" => w.pose_noise_m = v.max(0.0),
        "headingNoiseRad" => w.heading_noise_rad = v.max(0.0),
        "startOffsetXM" => w.start_offset_x_m = v,
        "startOffsetYM" => w.start_offset_y_m = v,
        "startOffsetRad" => w.start_offset_rad = v,
        "steerTauS" => w.steer_tau_s = v.max(0.001),
        _ => {}
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Criterion {
    /// The worst world decides (minimax): gains that never go badly.
    Worst,
    Mean,
    /// The world at the 90th percentile: the worst, minus the outliers.
    P90,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Method {
    /// Every combination of `steps` values per tuned gain.
    Grid { steps: usize },
    /// The cross-entropy method.
    Population { generations: usize, population: usize },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuneConfig {
    /// The robot code the gains go into (its other values stay).
    pub code: RobotCode,
    pub params: Vec<Param>,
    /// The nominal world; `vary` spreads its variables (± around it).
    pub world: World,
    #[serde(default)]
    pub vary: BTreeMap<String, f64>,
    /// How many worlds: the nominal one and the rest sampled.
    pub environments: usize,
    pub method: Method,
    pub criterion: Criterion,
    #[serde(default)]
    pub sim: SimOptions,
    #[serde(default = "default_seed")]
    pub seed: u64,
}

fn default_seed() -> u64 {
    2026
}

/// One gain set and how it did.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Every param's value, in `params` order.
    pub values: Vec<f64>,
    pub score: f64,
    /// Per world: the mean cost over the paths.
    pub per_env: Vec<f64>,
    /// Per path: the mean cost over the worlds.
    pub per_path: Vec<f64>,
    pub aborts: usize,
    pub mean_rms_m: f64,
    pub worst_final_m: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub generation: usize,
    /// The best score so far.
    pub best: f64,
    /// This generation's best, median and worst.
    pub gen_best: f64,
    pub gen_median: f64,
    pub gen_worst: f64,
}

/// The robot's true path in one world, for drawing.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub env: usize,
    pub path: usize,
    pub cost: f64,
    pub aborted: bool,
    pub points: Vec<[f32; 3]>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub generation: usize,
    pub generations: usize,
    pub runs: usize,
    pub elapsed_s: f64,
    pub baseline: Candidate,
    pub best: Candidate,
    /// This generation's candidates.
    pub population: Vec<Candidate>,
    pub history: Vec<HistoryPoint>,
    /// The best's runs, when it changed (empty otherwise: keep the last ones).
    pub tracks: Vec<Track>,
    /// The baseline's runs, sent once with the baseline.
    pub baseline_tracks: Vec<Track>,
    /// The worlds, as sampled.
    pub worlds: Vec<World>,
    /// How much the score moves when each tuned gain moves off the best, at
    /// the end: flat means any value near it does, steep means it matters.
    #[serde(default)]
    pub sensitivity: Vec<Sensitivity>,
    pub done: bool,
    pub cancelled: bool,
}

/// The best's score with one gain at ×0.8 and at ×1.25 (or ±0.05 from 0).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sensitivity {
    pub key: String,
    pub lower_value: f64,
    pub lower_score: f64,
    pub upper_value: f64,
    pub upper_score: f64,
}

/// The worlds: the nominal one first, the rest a Latin hypercube over the
/// varied variables (every variable's range cut in `n − 1` slices, each slice
/// used once), so a few dozen worlds cover the corners.
pub fn worlds(base: &World, vary: &BTreeMap<String, f64>, n: usize, seed: u64) -> Vec<World> {
    let n = n.max(1);
    let mut out = vec![base.clone()];
    if n == 1 {
        return out;
    }
    let mut rng = Rng::new(seed);
    let m = n - 1;
    let probe = serde_json::to_value(base).unwrap_or_default();
    let nominal = |key: &str| probe.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
    // Per variable, a shuffled order of the slices.
    let columns: Vec<(String, f64, f64, Vec<usize>)> = vary
        .iter()
        .filter(|(_, s)| **s > 0.0)
        .map(|(k, s)| {
            let mut order: Vec<usize> = (0..m).collect();
            for i in (1..m).rev() {
                order.swap(i, ((rng.next() * (i + 1) as f64) as usize).min(i));
            }
            (k.clone(), nominal(k), *s, order)
        })
        .collect();
    for i in 0..m {
        let mut w = base.clone();
        for (k, mid, spread, order) in &columns {
            let u = (order[i] as f64 + rng.next()) / m as f64;
            set_world(&mut w, k, mid - spread + 2.0 * spread * u);
        }
        w.seed = seed.wrapping_add(i as u64 + 1);
        out.push(w);
    }
    out
}

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1)
    }
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545F4914F6CDD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn gauss(&mut self) -> f64 {
        let (u, v) = (self.next().max(1e-12), self.next());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

/// [0, 1] to the param's value, and back.
fn to_value(p: &Param, u: f64) -> f64 {
    let u = u.clamp(0.0, 1.0);
    if p.log && p.min > 0.0 {
        (p.min.ln() + (p.max.ln() - p.min.ln()) * u).exp()
    } else {
        p.min + (p.max - p.min) * u
    }
}

fn to_unit(p: &Param, v: f64) -> f64 {
    if p.max <= p.min {
        return 0.0;
    }
    if p.log && p.min > 0.0 {
        ((v.max(p.min).ln() - p.min.ln()) / (p.max.ln() - p.min.ln())).clamp(0.0, 1.0)
    } else {
        ((v - p.min) / (p.max - p.min)).clamp(0.0, 1.0)
    }
}

/// Runs the whole search; `progress` hears about every generation. Returns
/// the last progress (`done`).
pub fn run(robot: &RobotConfig, paths: &[Trajectory], cfg: &TuneConfig, cancel: Arc<AtomicBool>, mut progress: impl FnMut(&Progress)) -> Progress {
    let started = Instant::now();
    let envs = worlds(&cfg.world, &cfg.vary, cfg.environments, cfg.seed);
    let tuned: Vec<usize> = (0..cfg.params.len()).filter(|&i| cfg.params[i].tune && cfg.params[i].max > cfg.params[i].min).collect();
    let start: Vec<f64> = cfg.params.iter().map(|p| p.start).collect();
    let mut state = Progress { worlds: envs.clone(), ..Default::default() };
    let mut history: Vec<HistoryPoint> = Vec::new();

    // Generation 0: the gains as they are now.
    let baseline = evaluate(robot, paths, cfg, &envs, std::slice::from_ref(&start), &cancel).remove(0);
    state.runs += envs.len() * paths.len();
    state.baseline = baseline.clone();
    state.best = baseline.clone();
    state.baseline_tracks = tracks(robot, paths, cfg, &envs, &baseline.values);
    state.tracks = state.baseline_tracks.clone();
    history.push(HistoryPoint { generation: 0, best: baseline.score, gen_best: baseline.score, gen_median: baseline.score, gen_worst: baseline.score });
    state.history = history.clone();
    state.population = vec![baseline];

    // A grid is every combination, run in batches so progress shows.
    let grid: Vec<Vec<Vec<f64>>> = match &cfg.method {
        Method::Grid { steps } => {
            let steps = (*steps).max(2);
            let mut all = vec![start.clone()];
            for &i in &tuned {
                let p = &cfg.params[i];
                all = all
                    .into_iter()
                    .flat_map(|base| {
                        (0..steps).map(move |k| {
                            let mut v = base.clone();
                            v[i] = to_value(p, k as f64 / (steps - 1) as f64);
                            v
                        })
                    })
                    .collect();
            }
            let batch = 32usize.max(all.len() / 40);
            all.chunks(batch).map(|c| c.to_vec()).collect()
        }
        Method::Population { .. } => vec![],
    };
    state.generations = match &cfg.method {
        Method::Grid { .. } => grid.len(),
        Method::Population { generations, .. } => *generations,
    };
    state.elapsed_s = started.elapsed().as_secs_f64();
    progress(&state);
    state.baseline_tracks.clear();

    let record = |gen: usize, cands: Vec<Candidate>, state: &mut Progress, history: &mut Vec<HistoryPoint>| {
        let mut scores: Vec<f64> = cands.iter().map(|c| c.score).collect();
        scores.sort_by(f64::total_cmp);
        let better = cands.iter().min_by(|a, b| a.score.total_cmp(&b.score)).filter(|c| c.score < state.best.score).cloned();
        match better {
            Some(c) => {
                state.best = c;
                state.tracks = tracks(robot, paths, cfg, &envs, &state.best.values);
            }
            None => state.tracks.clear(),
        }
        history.push(HistoryPoint {
            generation: gen,
            best: state.best.score,
            gen_best: scores.first().copied().unwrap_or(f64::NAN),
            gen_median: scores.get(scores.len() / 2).copied().unwrap_or(f64::NAN),
            gen_worst: scores.last().copied().unwrap_or(f64::NAN),
        });
        state.generation = gen;
        state.history = history.clone();
        state.runs += cands.len() * envs.len() * paths.len();
        state.population = cands;
        state.elapsed_s = started.elapsed().as_secs_f64();
    };

    match &cfg.method {
        Method::Grid { .. } => {
            for (g, batch) in grid.into_iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let cands = evaluate(robot, paths, cfg, &envs, &batch, &cancel);
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                record(g + 1, cands, &mut state, &mut history);
                progress(&state);
            }
        }
        Method::Population { generations, population } => {
            let d = tuned.len();
            let mut rng = Rng::new(cfg.seed ^ 0xA5A5);
            let mut mean: Vec<f64> = tuned.iter().map(|&i| to_unit(&cfg.params[i], start[i])).collect();
            let mut sigma = vec![0.3; d];
            let pop = (*population).max(4);
            let elite = (pop / 5).max(2);
            for g in 1..=*generations {
                if cancel.load(Ordering::Relaxed) || d == 0 {
                    break;
                }
                let mut cands: Vec<Vec<f64>> = Vec::with_capacity(pop);
                // The best so far runs again: nothing good is lost.
                cands.push(state.best.values.clone());
                while cands.len() < pop {
                    let mut v = start.clone();
                    for (k, &i) in tuned.iter().enumerate() {
                        v[i] = to_value(&cfg.params[i], mean[k] + sigma[k] * rng.gauss());
                    }
                    cands.push(v);
                }
                let mut scored = evaluate(robot, paths, cfg, &envs, &cands, &cancel);
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                scored.sort_by(|a, b| a.score.total_cmp(&b.score));
                // Toward the elite, a little at a time.
                for (k, &i) in tuned.iter().enumerate() {
                    let us: Vec<f64> = scored[..elite].iter().map(|c| to_unit(&cfg.params[i], c.values[i])).collect();
                    let m = us.iter().sum::<f64>() / us.len() as f64;
                    let s = (us.iter().map(|u| (u - m) * (u - m)).sum::<f64>() / us.len() as f64).sqrt();
                    mean[k] = 0.7 * m + 0.3 * mean[k];
                    sigma[k] = (0.7 * s + 0.3 * sigma[k]).max(0.01);
                }
                record(g, scored, &mut state, &mut history);
                progress(&state);
            }
        }
    }
    state.cancelled = cancel.load(Ordering::Relaxed);
    if !state.cancelled && !tuned.is_empty() {
        state.sensitivity = sensitivity(robot, paths, cfg, &envs, &state.best.values, &tuned, &cancel);
        state.runs += 2 * tuned.len() * envs.len() * paths.len();
    }
    state.done = true;
    state.elapsed_s = started.elapsed().as_secs_f64();
    if state.tracks.is_empty() {
        state.tracks = tracks(robot, paths, cfg, &envs, &state.best.values);
    }
    progress(&state);
    state
}

fn sensitivity(robot: &RobotConfig, paths: &[Trajectory], cfg: &TuneConfig, envs: &[World], best: &[f64], tuned: &[usize], cancel: &AtomicBool) -> Vec<Sensitivity> {
    let mut cands = Vec::new();
    for &i in tuned {
        let v = best[i];
        let (lo, hi) = if v.abs() < 1e-6 { (v, v + 0.05) } else { (v * 0.8, v * 1.25) };
        for x in [lo, hi] {
            let mut c = best.to_vec();
            c[i] = x;
            cands.push(c);
        }
    }
    let scored = evaluate(robot, paths, cfg, envs, &cands, cancel);
    tuned
        .iter()
        .enumerate()
        .map(|(k, &i)| Sensitivity {
            key: cfg.params[i].key.clone(),
            lower_value: scored[2 * k].values[i],
            lower_score: scored[2 * k].score,
            upper_value: scored[2 * k + 1].values[i],
            upper_score: scored[2 * k + 1].score,
        })
        .collect()
}

fn code_for(cfg: &TuneConfig, values: &[f64]) -> RobotCode {
    let mut code = cfg.code.clone();
    for (p, v) in cfg.params.iter().zip(values) {
        set_param(&mut code, &p.key, *v);
    }
    code
}

/// Every candidate in every world on every path, on all the cores.
fn evaluate(robot: &RobotConfig, paths: &[Trajectory], cfg: &TuneConfig, envs: &[World], cands: &[Vec<f64>], cancel: &AtomicBool) -> Vec<Candidate> {
    let (ne, np) = (envs.len(), paths.len());
    let total = cands.len() * ne * np;
    let results: Vec<Mutex<Option<RunResult>>> = (0..total).map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    let codes: Vec<RobotCode> = cands.iter().map(|v| code_for(cfg, v)).collect();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= total || cancel.load(Ordering::Relaxed) {
                    break;
                }
                let (c, rest) = (i / (ne * np), i % (ne * np));
                let (e, p) = (rest / np, rest % np);
                let r = simulate(robot, &paths[p], &codes[c], &envs[e], &cfg.sim);
                *results[i].lock().unwrap() = Some(r);
            });
        }
    });
    cands
        .iter()
        .enumerate()
        .map(|(c, values)| {
            let mut per_env = vec![0.0; ne];
            let mut per_path = vec![0.0; np];
            let (mut aborts, mut rms, mut worst_final) = (0, 0.0, 0.0f64);
            for e in 0..ne {
                for p in 0..np {
                    let r = results[c * ne * np + e * np + p].lock().unwrap().take().unwrap_or(RunResult { cost: 20.0, aborted: true, ..Default::default() });
                    per_env[e] += r.cost / np as f64;
                    per_path[p] += r.cost / ne as f64;
                    aborts += r.aborted as usize;
                    rms += r.rms_pos_m / (ne * np) as f64;
                    worst_final = worst_final.max(r.final_pos_m);
                }
            }
            Candidate { values: values.clone(), score: aggregate(cfg.criterion, &per_env), per_env, per_path, aborts, mean_rms_m: rms, worst_final_m: worst_final }
        })
        .collect()
}

pub fn aggregate(c: Criterion, per_env: &[f64]) -> f64 {
    if per_env.is_empty() {
        return f64::INFINITY;
    }
    match c {
        Criterion::Worst => per_env.iter().copied().fold(f64::MIN, f64::max),
        Criterion::Mean => per_env.iter().sum::<f64>() / per_env.len() as f64,
        Criterion::P90 => {
            let mut v = per_env.to_vec();
            v.sort_by(f64::total_cmp);
            v[((v.len() - 1) as f64 * 0.9).round() as usize]
        }
    }
}

/// The robot's paths in every world with these gains, recorded to draw.
fn tracks(robot: &RobotConfig, paths: &[Trajectory], cfg: &TuneConfig, envs: &[World], values: &[f64]) -> Vec<Track> {
    let code = code_for(cfg, values);
    let opts = SimOptions { record: true, ..cfg.sim.clone() };
    let mut out = Vec::new();
    for (e, w) in envs.iter().enumerate() {
        for (p, t) in paths.iter().enumerate() {
            let r = simulate(robot, t, &code, w, &opts);
            out.push(Track { env: e, path: p, cost: r.cost, aborted: r.aborted, points: r.track });
        }
    }
    out
}
