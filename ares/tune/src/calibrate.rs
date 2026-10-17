//! Calibration: the world that makes the simulator do what the robot did.
//!
//! A log of a real run (AresLib publishes where the robot was, every loop)
//! is compared with the simulator running the same trajectory with the same
//! gains; the world's unknowns (mass, grip, latency, the battery, the motors,
//! the wheels) are searched until the simulated robot's path matches the
//! logged one. Tune then searches gains in worlds around that one, which is
//! the robot as it is, not as the robot.json says.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use ares_core::geometry::wrap_angle;
use ares_core::trajectory::Trajectory;
use ares_core::RobotConfig;
use serde::{Deserialize, Serialize};

use crate::sim::{simulate, RobotCode, SimOptions, World, CONTROL_DT};
use crate::tune::set_world;

/// Where the robot was, seconds after the path started.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub heading: f64,
}

/// A world variable to find, between `min` and `max`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitVar {
    pub key: String,
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    /// The found value of each `FitVar`, in order.
    pub values: Vec<f64>,
    /// How far the simulated robot was from the logged one (RMS, meters),
    /// with the world as it was given and as found.
    pub rms_before_m: f64,
    pub rms_after_m: f64,
    pub world: World,
    /// The best RMS after each generation.
    pub history: Vec<f64>,
    /// The simulated path with the found world, to draw over the logged one.
    pub track: Vec<[f32; 3]>,
    pub runs: usize,
}

/// How far a simulated run is from the logged one: RMS of the position, with
/// a radian of heading weighing as 30 cm.
fn mismatch(robot: &RobotConfig, traj: &Trajectory, code: &RobotCode, world: &World, obs: &[Observation]) -> (f64, Vec<[f32; 3]>) {
    let opts = SimOptions { abort_m: 5.0, settle_s: 0.5, record: true, record_every: 1 };
    let run = simulate(robot, traj, code, world, &opts);
    if run.track.is_empty() || obs.is_empty() {
        return (f64::INFINITY, run.track);
    }
    let mut sum = 0.0;
    for o in obs {
        let k = ((o.t / CONTROL_DT).round() as usize).min(run.track.len() - 1);
        let p = run.track[k];
        let d2 = (p[0] as f64 - o.x).powi(2) + (p[1] as f64 - o.y).powi(2);
        let h = wrap_angle(p[2] as f64 - o.heading);
        sum += d2 + (0.3 * h).powi(2);
    }
    ((sum / obs.len() as f64).sqrt(), run.track)
}

/// The world, starting where the robot really started.
fn placed(base: &World, traj: &Trajectory, obs: &[Observation]) -> World {
    let mut w = base.clone();
    if let (Some(o), Some(s)) = (obs.first(), traj.samples.first()) {
        w.start_offset_x_m = o.x - s.x;
        w.start_offset_y_m = o.y - s.y;
        w.start_offset_rad = wrap_angle(o.heading - s.heading);
    }
    // The log is one run: no noise, its own luck.
    w.pose_noise_m = 0.0;
    w.heading_noise_rad = 0.0;
    w.pushes.clear();
    w
}

struct Rng(u64);
impl Rng {
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

/// The search (cross-entropy over the variables' ranges), on all the cores.
pub fn calibrate(
    robot: &RobotConfig,
    traj: &Trajectory,
    code: &RobotCode,
    base: &World,
    vars: &[FitVar],
    obs: &[Observation],
    generations: usize,
    population: usize,
    cancel: &AtomicBool,
    mut progress: impl FnMut(usize, f64),
) -> Calibration {
    let start = placed(base, traj, obs);
    let probe = serde_json::to_value(&start).unwrap_or_default();
    let now: Vec<f64> = vars.iter().map(|v| probe.get(&v.key).and_then(|x| x.as_f64()).unwrap_or((v.min + v.max) / 2.0)).collect();
    let world_for = |u: &[f64]| {
        let mut w = start.clone();
        for (v, &x) in vars.iter().zip(u) {
            set_world(&mut w, &v.key, v.min + (v.max - v.min) * x.clamp(0.0, 1.0));
        }
        w
    };
    let unit = |v: &FitVar, x: f64| if v.max > v.min { ((x - v.min) / (v.max - v.min)).clamp(0.0, 1.0) } else { 0.5 };
    let (before, _) = mismatch(robot, traj, code, &start, obs);
    let mut mean: Vec<f64> = vars.iter().zip(&now).map(|(v, &x)| unit(v, x)).collect();
    let mut sigma = vec![0.3; vars.len()];
    let mut best = (before, mean.clone());
    let mut history = vec![before];
    let mut rng = Rng(0x5DEECE66D);
    let pop = population.max(6);
    let elite = (pop / 5).max(2);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut runs = 1;
    for g in 0..generations {
        if cancel.load(Ordering::Relaxed) || vars.is_empty() {
            break;
        }
        let mut cands: Vec<Vec<f64>> = vec![best.1.clone()];
        while cands.len() < pop {
            cands.push(mean.iter().zip(&sigma).map(|(m, s)| (m + s * rng.gauss()).clamp(0.0, 1.0)).collect());
        }
        let scores: Vec<Mutex<f64>> = (0..cands.len()).map(|_| Mutex::new(f64::INFINITY)).collect();
        let next = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..threads {
                s.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= cands.len() {
                        break;
                    }
                    *scores[i].lock().unwrap() = mismatch(robot, traj, code, &world_for(&cands[i]), obs).0;
                });
            }
        });
        runs += cands.len();
        let mut ranked: Vec<(f64, Vec<f64>)> = cands.into_iter().zip(scores).map(|(c, s)| (*s.lock().unwrap(), c)).collect();
        ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
        if ranked[0].0 < best.0 {
            best = ranked[0].clone();
        }
        for k in 0..vars.len() {
            let xs: Vec<f64> = ranked[..elite].iter().map(|r| r.1[k]).collect();
            let m = xs.iter().sum::<f64>() / xs.len() as f64;
            let sd = (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / xs.len() as f64).sqrt();
            mean[k] = 0.7 * m + 0.3 * mean[k];
            sigma[k] = (0.7 * sd + 0.3 * sigma[k]).max(0.01);
        }
        history.push(best.0);
        progress(g + 1, best.0);
    }
    let world = world_for(&best.1);
    let (after, track) = mismatch(robot, traj, code, &world, obs);
    Calibration {
        values: vars.iter().zip(&best.1).map(|(v, &x)| v.min + (v.max - v.min) * x).collect(),
        rms_before_m: before,
        rms_after_m: after,
        world,
        history,
        track: track.into_iter().step_by(5).collect(),
        runs,
    }
}
