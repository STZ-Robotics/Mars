//! Where the files being installed come from: a GitHub release.
//!
//! There are two paths and the order matters:
//!
//! 1. **The release's `manifest.json`** — written by `make-manifest.mjs` at
//!    packaging time, carrying the size and sha256 of every file. This is the
//!    good one: it makes the download verifiable and the progress bar honest.
//! 2. **The API's asset list** — if the release has no manifest (one published
//!    by hand, say), the files are derived from their names. It still
//!    installs; what is lost is the checksum, and the interface says so
//!    instead of pretending it verified something.
//!
//! Without path 2 a hand-published release would leave the installer dead for
//! no technical reason at all.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::platform::{self, Edition};

/// Repository the releases are downloaded from. It can be pointed elsewhere
/// with MARS_RELEASES_REPO, which is what tests and forks use.
///
/// It has moved twice: `Imcab/mars-desktop` was renamed when it grew into the
/// whole ecosystem, and then transferred to the STZ-Robotics organisation,
/// which is where it stays. GitHub redirects both old names, but an installer
/// that leans on a redirect breaks the day somebody claims a freed-up name ---
/// and what breaks is every user's update check, on a machine nobody here can
/// reach.
pub fn repo() -> String {
    std::env::var("MARS_RELEASES_REPO").unwrap_or_else(|_| "STZ-Robotics/Mars".to_string())
}

/// One installable file, already resolved for this platform.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub component: String,
    pub file: String,
    pub url: String,
    /// Bytes, or 0 if the release does not declare it.
    #[serde(default)]
    pub size: u64,
    /// Lowercase hex, or empty if it did not come from a manifest.
    #[serde(default)]
    pub sha256: String,
}

/// What the installer knows about the latest published version.
#[derive(Debug, Clone, Serialize)]
pub struct Release {
    pub version: String,
    pub tag: String,
    pub notes: String,
    pub url: String,
    /// `true` if it came with a manifest written by the packager.
    pub verified: bool,
}

/// A release plus the artifacts that apply to this machine and edition.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadPlan {
    pub release: Release,
    pub artifacts: Vec<Artifact>,
    /// Components the edition asked for that the release does not publish for
    /// this platform. Shown as a warning: installing what IS there beats
    /// installing nothing.
    pub missing: Vec<String>,
    /// `Some(true)` if the published version is newer than the installed one,
    /// `Some(false)` if it is not, `None` if nothing is installed. Filled in by
    /// the command, which is what knows about the local record.
    pub is_newer: Option<bool>,
}

// --- GitHub API responses ---------------------------------------------------

#[derive(Deserialize, Clone)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

#[derive(Deserialize, Clone)]
struct ApiAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

/// The `manifest.json` the packager uploads.
#[derive(Deserialize, Clone)]
struct ManifestJson {
    version: String,
    #[serde(default)]
    artifacts: Vec<ManifestArtifact>,
}

#[derive(Deserialize, Clone)]
struct ManifestArtifact {
    component: String,
    file: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    sha256: String,
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        // GitHub's API rejects requests with no User-Agent with a 403 that
        // explains nothing.
        .user_agent(concat!("mars-installer/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("could not create the HTTP client")
}

/// What the latest release publishes, however it was found out.
#[derive(Clone)]
struct Published {
    release: ApiRelease,
    manifest: Option<ManifestJson>,
}

/// How long one answer about the latest release is reused.
///
/// The installer asks on its first screen, again on the confirmation screen
/// and once more when it installs. GitHub's API lets a computer ask 60 times an
/// hour, counted per public IP: in a school lab every machine shares one, and
/// three questions per run used that up fast, with a bare "403 Forbidden" as
/// the only explanation.
const CACHE_FOR: std::time::Duration = std::time::Duration::from_secs(10 * 60);

static CACHE: std::sync::Mutex<Option<(std::time::Instant, String, Published)>> = std::sync::Mutex::new(None);

async fn published() -> Result<Published> {
    let repo = repo();
    if let Ok(cache) = CACHE.lock() {
        if let Some((at, cached_repo, p)) = cache.as_ref() {
            if *cached_repo == repo && at.elapsed() < CACHE_FOR {
                return Ok(p.clone());
            }
        }
    }

    let client = client()?;
    let found = match from_api(&client, &repo).await {
        Ok(p) => p,
        // The API refused (its hourly limit, most likely) or did not answer:
        // the same release can be read without it. If that fails too, the
        // API's error is the one worth showing.
        Err(api_error) => match from_download_link(&client, &repo).await {
            Ok(p) => p,
            Err(_) => return Err(api_error),
        },
    };

    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((std::time::Instant::now(), repo, found.clone()));
    }
    Ok(found)
}

/// Whether a tag is one of MARS's own releases (`v1.1.7`).
///
/// The repository also publishes Ares, tagged `ares-v0.1.0`. GitHub's
/// "latest release" is simply the newest one marked as such, of whichever
/// product: when Ares took it, every installer asking for "latest" found no
/// MARS files there and could neither install nor update.
fn is_mars_tag(tag: &str) -> bool {
    let Some(numbers) = tag.strip_prefix('v') else { return false };
    let parts: Vec<&str> = numbers.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// MARS's newest release through GitHub's API: the notes and the page link
/// come from here, which is why it is the first choice. It reads the list of
/// releases and picks MARS's newest, rather than trusting "latest".
async fn from_api(client: &reqwest::Client, repo: &str) -> Result<Published> {
    let url = format!("https://api.github.com/repos/{repo}/releases?per_page=30");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .with_context(|| format!("could not reach {url}"))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        bail!(
            "{repo} has no published release yet.\n\n\
             Publish one with the executables (the repo's release.yml workflow \
             does it on its own when you push a vX.Y.Z tag) and open the \
             installer again."
        );
    }
    if resp.status() == reqwest::StatusCode::FORBIDDEN || resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        bail!(
            "GitHub is not answering this network for now ({}): it limits how \
             often one network can ask, and computers sharing a connection, \
             like a school lab, use that up together. Try again in an hour, or \
             from another network.",
            resp.status()
        );
    }
    if !resp.status().is_success() {
        bail!("GitHub answered {} when asked for the latest release", resp.status());
    }

    let releases: Vec<ApiRelease> = resp
        .json()
        .await
        .context("GitHub's response is not what was expected")?;
    // Newest first, as GitHub lists them.
    let Some(release) = releases
        .into_iter()
        .find(|r| !r.draft && !r.prerelease && is_mars_tag(&r.tag_name))
    else {
        bail!(
            "{repo} has no published MARS release yet.\n\n\
             Publish one with the executables (the repo's release.yml workflow \
             does it on its own when you push a vX.Y.Z tag) and open the \
             installer again."
        );
    };
    let manifest = fetch_manifest(client, &release).await;
    Ok(Published { release, manifest })
}

/// The latest release WITHOUT the API, for when it refuses.
///
/// `releases/latest/download/<file>` is an ordinary download link, outside the
/// API and its limit. Its first redirect names the release's tag; the manifest
/// it leads to names every file, with its size and sha256, so the download is
/// still verified. What is lost is only the release notes.
async fn from_download_link(client: &reqwest::Client, repo: &str) -> Result<Published> {
    let latest = format!("https://github.com/{repo}/releases/latest/download/manifest.json");
    let no_redirects = reqwest::Client::builder()
        .user_agent(concat!("mars-installer/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("could not create the HTTP client")?;
    let resp = no_redirects
        .get(&latest)
        .send()
        .await
        .with_context(|| format!("could not reach {latest}"))?;
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| anyhow!("{latest} did not point at a release ({})", resp.status()))?
        .to_string();
    let tag = tag_from_download_url(&location)
        .ok_or_else(|| anyhow!("could not read the release out of {location}"))?;
    // "Latest" can be another product's release (see `is_mars_tag`).
    if !is_mars_tag(&tag) {
        bail!("the repository's latest release is {tag}, not a MARS release");
    }

    let text = client
        .get(&location)
        .send()
        .await
        .with_context(|| format!("could not download {location}"))?
        .error_for_status()?
        .text()
        .await?;
    let manifest: ManifestJson =
        serde_json::from_str(&text).context("the release's manifest.json is unreadable")?;

    let assets = manifest
        .artifacts
        .iter()
        .map(|a| ApiAsset {
            name: a.file.clone(),
            browser_download_url: format!("https://github.com/{repo}/releases/download/{tag}/{}", a.file),
            size: a.size,
        })
        .collect();
    let release = ApiRelease {
        tag_name: tag.clone(),
        draft: false,
        prerelease: false,
        body: None,
        html_url: format!("https://github.com/{repo}/releases/tag/{tag}"),
        assets,
    };
    Ok(Published { release, manifest: Some(manifest) })
}

/// `…/releases/download/v1.1.7/manifest.json` → `v1.1.7`.
fn tag_from_download_url(url: &str) -> Option<String> {
    let rest = url.split("/releases/download/").nth(1)?;
    let tag = rest.split('/').next()?;
    (!tag.is_empty()).then(|| tag.to_string())
}

/// Queries the latest release and builds the download plan for this machine.
pub async fn fetch(edition: Edition) -> Result<DownloadPlan> {
    let Published { release, manifest } = published().await?;
    let version = release.tag_name.trim_start_matches('v').to_string();

    let mut artifacts = Vec::new();
    let mut missing = Vec::new();

    for component in platform::components(edition) {
        let name = platform::archive_name(component, edition);
        match release.assets.iter().find(|a| a.name == name) {
            Some(asset) => {
                // Size and checksum come from the manifest when there is one;
                // otherwise from the size the API reports, which at least
                // drives the progress bar.
                let from_manifest = manifest
                    .as_ref()
                    .and_then(|m| m.artifacts.iter().find(|a| a.file == name));
                artifacts.push(Artifact {
                    component: component.id().to_string(),
                    file: name.clone(),
                    url: asset.browser_download_url.clone(),
                    size: from_manifest
                        .map(|a| a.size)
                        .filter(|s| *s > 0)
                        .unwrap_or(asset.size),
                    sha256: from_manifest.map(|a| a.sha256.clone()).unwrap_or_default(),
                });
                // The manifest's `component` is checked here and not in serde
                // so an older release that spelled it differently can still be
                // installed.
                if let Some(a) = from_manifest {
                    if a.component != component.id() {
                        missing.push(format!(
                            "{} (the manifest calls it \"{}\")",
                            component.name(),
                            a.component
                        ));
                    }
                }
            }
            None => missing.push(component.name().to_string()),
        }
    }

    if artifacts.is_empty() {
        bail!(
            "Release {} publishes nothing for {} {}.\n\n\
             Files I looked for: {}",
            release.tag_name,
            platform::OS,
            platform::ARCH,
            platform::components(edition)
                .iter()
                .map(|c| platform::archive_name(*c, edition))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    let verified = artifacts.iter().all(|a| !a.sha256.is_empty());

    Ok(DownloadPlan {
        release: Release {
            version: manifest.map(|m| m.version).unwrap_or(version),
            tag: release.tag_name,
            notes: release
                .body
                .unwrap_or_default()
                .lines()
                .take(24)
                .collect::<Vec<_>>()
                .join("\n"),
            url: release.html_url,
            verified,
        },
        artifacts,
        missing,
        is_newer: None,
    })
}

async fn fetch_manifest(client: &reqwest::Client, release: &ApiRelease) -> Option<ManifestJson> {
    let asset = release.assets.iter().find(|a| a.name == "manifest.json")?;
    let text = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    match serde_json::from_str::<ManifestJson>(&text) {
        Ok(m) => Some(m),
        Err(e) => {
            // Not fatal: path 2 takes over. But it is worth logging, because it
            // means the packager wrote something odd.
            eprintln!("unreadable manifest.json, falling back to the asset list: {e}");
            None
        }
    }
}

/// Compares two versions like `1.10.2`. Returns `true` if `candidate` is
/// greater.
///
/// Comparing as text would say 1.9.0 > 1.10.0, which is exactly the case where
/// an important update would not be offered.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split(['.', '-', '+'])
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Checks that the configured repository looks like `user/repo`.
pub fn validate_repo() -> Result<()> {
    let r = repo();
    let parts: Vec<&str> = r.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty()) {
        return Err(anyhow!(
            "MARS_RELEASES_REPO has to be \"user/repo\", not \"{r}\""
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::Component;

    #[test]
    fn versions_compare_as_numbers_not_as_text() {
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(is_newer("1.1.4", "1.1.3"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.1.3", "1.1.3"));
        assert!(!is_newer("1.1.2", "1.1.3"));
        // With and without the tag's "v" has to give the same answer.
        assert!(is_newer("v1.2.0", "1.1.9"));
        // Fewer components does not mean smaller: 1.2 == 1.2.0.
        assert!(!is_newer("1.2", "1.2.0"));
    }

    #[test]
    fn only_mars_tags_count_as_mars_releases() {
        assert!(is_mars_tag("v1.1.7"));
        assert!(is_mars_tag("v10.0.12"));
        assert!(!is_mars_tag("ares-v0.1.0"), "Ares shares the repository");
        assert!(!is_mars_tag("v1.1"));
        assert!(!is_mars_tag("v1.1.7-rc1"));
        assert!(!is_mars_tag("1.1.7"));
    }

    #[test]
    fn the_tag_comes_out_of_the_download_redirect() {
        assert_eq!(
            tag_from_download_url("https://github.com/STZ-Robotics/Mars/releases/download/v1.1.7/manifest.json").as_deref(),
            Some("v1.1.7")
        );
        assert_eq!(tag_from_download_url("https://github.com/STZ-Robotics/Mars/releases"), None);
    }

    /// The way around GitHub's API limit, against the published release: the
    /// same files, with their checksums, without asking the API anything.
    #[tokio::test]
    #[ignore = "needs the network and a published release"]
    async fn the_release_can_be_read_without_the_api() {
        let client = client().unwrap();
        let p = from_download_link(&client, &repo()).await.expect("the download link did not lead to a manifest");
        assert!(p.release.tag_name.starts_with('v'), "{}", p.release.tag_name);
        let m = p.manifest.expect("a manifest");
        assert!(!m.artifacts.is_empty());
        assert!(m.artifacts.iter().all(|a| a.sha256.len() == 64));
        let asset = &p.release.assets[0];
        let head = client.head(&asset.browser_download_url).send().await.unwrap();
        assert!(head.status().is_success(), "{} answered {}", asset.browser_download_url, head.status());
    }

    /// Against the actually published release.
    ///
    /// Marked `ignore` because it needs the network: `cargo test` on a machine
    /// with no internet has no business failing. Run it by hand with
    /// `cargo test -- --ignored` whenever the name format or the manifest
    /// changes, which is exactly what no offline test can cover: that what the
    /// packager publishes is what the installer looks for.
    #[tokio::test]
    #[ignore = "needs the network and a published release"]
    async fn finds_the_files_of_the_published_release() {
        let plan = fetch(Edition::Full).await.expect("could not reach the release");
        assert!(
            !plan.artifacts.is_empty(),
            "the release ships nothing for this platform"
        );
        assert!(
            plan.release.verified,
            "the release published no sha256: the installer could not verify anything"
        );
        for a in &plan.artifacts {
            assert_eq!(a.sha256.len(), 64, "odd-looking sha256 on {}", a.file);
            assert!(a.size > 0, "{} claims to be 0 bytes", a.file);
            assert!(a.url.starts_with("https://"), "{} has no URL", a.file);
        }
        // The Tools edition has to resolve to a different file than Full.
        let tools = fetch(Edition::Tools).await.expect("tools");
        assert_ne!(
            tools.artifacts[0].file, plan.artifacts[0].file,
            "both editions point at the same archive"
        );
    }

    #[test]
    fn file_names_follow_the_convention() {
        let n = platform::archive_name(Component::MarsDesktop, Edition::Tools);
        assert!(n.starts_with("mars-desktop-tools-"), "{n}");
        assert!(n.ends_with(platform::ARCHIVE_EXT), "{n}");
        assert_ne!(n, platform::archive_name(Component::MarsDesktop, Edition::Full));
    }
}
