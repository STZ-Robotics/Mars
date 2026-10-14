//! Measures a FUEL's real bounce off the floor.
//!
//! It exists because the restitution coefficient in `models/fuel/model.sdf`
//! is the only number in the model that does not come from the game manual,
//! and because nothing said anywhere that the physics engine honors it: a
//! `<bounce>` the solver silently ignores produces a ball that drops and stays
//! dead, with the SDF saying otherwise.
//!
//! It subscribes to the world's poses, follows each FUEL's Z and notes the
//! height it drops from and the height of the first bounce. The measured
//! coefficient comes from that: `e = sqrt(h_bounce / h_drop)`.
//!
//! Usage, with the engine running separately:
//!   mars-sim-server worlds/fuel-drop.sdf run
//!   cargo run --bin fuel-bounce

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use gz_msgs::pose_v::Pose_V;
use gz_transport::Node;

/// Published by the SceneBroadcaster with the pose of everything in the world.
const T_POSES: &str = "/world/mars/pose/info";

/// How long to watch. With drops from 2.5 m, 6 s covers the fall and the
/// whole first bounce with margin.
const WATCH: Duration = Duration::from_secs(6);

/// FUEL radius: the Z gz publishes is the center's, not the contact point's,
/// so the height above the floor is Z minus the radius.
const RADIUS: f64 = 0.075;

/// Below this it does not count as having left the floor. The micro-bounces
/// of a ball that has already settled are not a bounce.
const MIN_BOUNCE: f64 = 0.005;

#[derive(Default)]
struct Trace {
    z_start: f64,
    z_min: f64,
    landed: bool,
    /// Height of the first bounce, in meters above the floor.
    apex: f64,
    /// Closed when the ball comes back down after the first bounce.
    closed: bool,
    z_prev: f64,
}

fn main() -> Result<()> {
    let mut node = Node::new().ok_or_else(|| anyhow!("could not create the node"))?;
    let poses = node
        .subscribe_channel::<Pose_V>(T_POSES, 1)
        .ok_or_else(|| anyhow!("could not subscribe to {T_POSES}"))?;
    println!("[bounce] subscribed to {T_POSES}, watching for {WATCH:?}");

    let mut traces: HashMap<String, Trace> = HashMap::new();
    let start = Instant::now();

    while start.elapsed() < WATCH {
        let Ok(msg) = poses.recv_timeout(Duration::from_millis(500)) else {
            continue;
        };
        for p in msg.pose.iter() {
            if !p.name.starts_with("fuel_") {
                continue;
            }
            let Some(pos) = p.position.as_ref() else { continue };
            let z = pos.z;

            let t = traces.entry(p.name.clone()).or_insert_with(|| Trace {
                z_start: z,
                z_min: z,
                z_prev: z,
                ..Default::default()
            });
            if t.closed {
                continue;
            }

            let height = (z - RADIUS).max(0.0);

            if !t.landed {
                // Falling: look for the lowest point, which is the impact.
                if z < t.z_min {
                    t.z_min = z;
                } else if t.z_prev <= t.z_min + 1e-6 && z > t.z_prev {
                    // It started going up: the impact already happened.
                    t.landed = true;
                }
            } else if height > t.apex {
                t.apex = height;
            } else if t.apex > MIN_BOUNCE && height < t.apex - 1e-4 {
                // It came back down: the first bounce is complete.
                t.closed = true;
            }
            t.z_prev = z;
        }
    }

    if traces.is_empty() {
        println!("[bounce] no FUEL seen. Is the engine running with worlds/fuel-drop.sdf?");
        return Ok(());
    }

    println!();
    println!("  {:<18} {:>10} {:>10} {:>10}", "model", "drop (m)", "bounce (m)", "e");
    let mut names: Vec<&String> = traces.keys().collect();
    names.sort();
    for n in names {
        let t = &traces[n];
        let drop = (t.z_start - RADIUS).max(0.0);
        let e = if drop > 1e-6 {
            (t.apex / drop).sqrt()
        } else {
            0.0
        };
        println!("  {n:<18} {drop:>10.3} {:>10.3} {e:>10.3}", t.apex);
    }
    println!();
    println!("  e = sqrt(bounce / drop). If every e is 0.000 the engine is ignoring");
    println!("  <bounce> and the restitution in model.sdf means nothing.");
    Ok(())
}
