//! Ares from the terminal, until the app exists and for scripts after.
//!
//!     ares solve <robot.json> <path.json> [-o trajectory.json]

use std::path::PathBuf;
use std::process::ExitCode;

use ares_core::{solve, PathSpec, RobotConfig, SolverOptions};

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

fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let usage = "usage: ares solve <robot.json> <path.json> [-o trajectory.json]";
    let [cmd, robot, path, rest @ ..] = args else { return Err(usage.into()) };
    if cmd != "solve" {
        return Err(usage.into());
    }
    let out = match rest {
        [] => None,
        [flag, file] if flag == "-o" => Some(PathBuf::from(file)),
        _ => return Err(usage.into()),
    };

    let robot = RobotConfig::load(robot.as_ref())?;
    let spec: PathSpec = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let started = std::time::Instant::now();
    let t = solve(&robot, &spec, &SolverOptions::default())?;
    let peak_current = t
        .samples
        .iter()
        .flat_map(|s| s.modules.iter().map(|m| m.current_a.abs()))
        .fold(0.0, f64::max);
    println!(
        "{} on {}: {:.3} s, top speed {:.2} m/s, peak drive current {:.0} A ({} samples, solved in {} ms)",
        t.name,
        t.robot,
        t.duration_s,
        t.max_speed(),
        peak_current,
        t.samples.len(),
        started.elapsed().as_millis()
    );
    if let Some(out) = out {
        std::fs::write(&out, serde_json::to_string(&t)?)?;
        println!("wrote {}", out.display());
    }
    Ok(())
}
