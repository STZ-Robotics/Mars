//! Downloading with progress and integrity checking.
//!
//! It writes to a temporary file and computes the sha256 while writing, not
//! afterwards: reading 60 MB twice to verify them is time given away, and on a
//! slow disk it shows.

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Downloads `url` into `dest`, reporting progress through `progress`.
///
/// An empty `expected_sha256` means the release carried no checksum: it is
/// downloaded anyway and the caller decides what to tell the user.
pub async fn file<F>(url: &str, dest: &Path, expected_sha256: &str, mut progress: F) -> Result<PathBuf>
where
    F: FnMut(u64, u64),
{
    let client = reqwest::Client::builder()
        .user_agent(concat!("mars-installer/", env!("CARGO_PKG_VERSION")))
        // No overall limit (a slow school connection may need minutes for a
        // large archive), but a download that stops moving fails instead of
        // leaving the bar frozen forever.
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()?;

    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("could not start the download of {url}"))?;

    if !resp.status().is_success() {
        bail!("the download answered {} ({url})", resp.status());
    }

    let total = resp.content_length().unwrap_or(0);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }
    let mut out = std::fs::File::create(dest)
        .with_context(|| format!("could not write {}", dest.display()))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("the download was cut off")?;
        hasher.update(&chunk);
        out.write_all(&chunk).context("could not write the downloaded file")?;
        downloaded += chunk.len() as u64;
        progress(downloaded, total);
    }
    out.flush()?;
    drop(out);

    if !expected_sha256.is_empty() {
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(expected_sha256) {
            // A corrupt file is not left on disk: if it stayed, the next
            // attempt might "reuse" it and the error would be eternal.
            let _ = std::fs::remove_file(dest);
            bail!(
                "the downloaded file does not match the published checksum.\n\
                 expected {expected_sha256}\n\
                 got      {got}\n\n\
                 This can be a truncated download or a proxy that modified the file."
            );
        }
    }

    Ok(dest.to_path_buf())
}

/// The installer's own temporary folder, inside the system one.
///
/// Its own and not plain `std::env::temp_dir()` so it can be wiped whole at
/// the end with no risk of taking anything else along.
pub fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("mars-installer")
}

pub fn clean_temp() {
    let dir = temp_dir();
    if dir.exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
}
