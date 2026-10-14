//! Diagnostic: lists the topics gz-transport's discovery sees.
//!
//! For the case where a topic "does not exist" even though the engine is
//! publishing it. With the engine running:
//!
//!   cargo run --bin gz-topics

use anyhow::{anyhow, Result};
use std::time::Duration;

fn main() -> Result<()> {
    let node = gz_transport::Node::new().ok_or_else(|| anyhow!("could not create the node"))?;

    // Discovery is multicast and asynchronous: asking right away returns an
    // empty list and makes it look like nobody is publishing.
    println!("[topics] waiting 3 s for discovery...");
    std::thread::sleep(Duration::from_secs(3));

    let mut topics = node.topic_list();
    topics.sort();
    println!("[topics] {} discovered:", topics.len());
    for t in &topics {
        println!("  {t}");
    }
    Ok(())
}
