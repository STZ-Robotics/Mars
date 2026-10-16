//! Ares from the terminal, until the app exists and for scripts after.
//!
//!     ares time <robot.json> <path.json> [-o trajectory.json]
//!     ares plan <robot.json> <path.json> [--env environment.json] [-o trajectory.json]
//!
//! `time` follows the spline through the waypoints as fast as the robot can
//! (stage 1, milliseconds). `plan` frees the curve and optimizes the whole
//! trajectory (stage 2, starting from stage 1).

use std::path::PathBuf;
use std::process::ExitCode;

use ares_core::{solve, PathSpec, RobotConfig, SolverOptions, Trajectory};
use ares_planner::{plan, Environment, PlannerOptions};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("ares: {e}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "usage: ares (time|plan) <robot.json> <path.json> [--env environment.json] [-o trajectory.json]";

fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let [cmd, robot, path, rest @ ..] = args else { return Err(USAGE.into()) };
    let (mut out, mut env) = (None, Environment::default());
    let mut it = rest.iter();
    while let Some(flag) = it.next() {
        let value = it.next().ok_or(USAGE)?;
        match flag.as_str() {
            "-o" => out = Some(PathBuf::from(value)),
            "--env" => env = serde_json::from_str(&std::fs::read_to_string(value)?)?,
            _ => return Err(USAGE.into()),
        }
    }

    let robot = RobotConfig::load(robot.as_ref())?;
    let spec: PathSpec = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let started = std::time::Instant::now();
    let t = match cmd.as_str() {
        "time" => {
            let t = solve(&robot, &spec, &SolverOptions::default())?;
            report(&t, started.elapsed().as_millis());
            t
        }
        "plan" => {
            let p = plan(&robot, &spec, &env, &PlannerOptions::default())?;
            report(&p.trajectory, p.solve_time.as_millis());
            println!(
                "  along the spline it takes {:.3} s: the free path saves {:.0}% ({} iterations)",
                p.spline_duration_s,
                100.0 * (1.0 - p.trajectory.duration_s / p.spline_duration_s),
                p.iterations
            );
            p.trajectory
        }
        _ => return Err(USAGE.into()),
    };
    if let Some(out) = out {
        std::fs::write(&out, serde_json::to_string(&t)?)?;
        println!("wrote {}", out.display());
    }
    Ok(())
}

fn report(t: &Trajectory, ms: u128) {
    let modules = || t.samples.iter().flat_map(|s| s.modules.iter());
    let peak_current = modules().map(|m| m.current_a.abs()).fold(0.0, f64::max);
    let peak_grip = modules().map(|m| m.grip_used).fold(0.0, f64::max);
    println!(
        "{} on {}: {:.3} s, top speed {:.2} m/s, peak drive current {:.0} A, peak grip {:.0}% ({} samples, {} ms)",
        t.name,
        t.robot,
        t.duration_s,
        t.max_speed(),
        peak_current,
        100.0 * peak_grip,
        t.samples.len(),
        ms
    );
}
