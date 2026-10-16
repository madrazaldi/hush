//! Local model catalog (GGUF models for transcribe-cpp) and downloads.
//!
//! The catalog is derived from Handy's (MIT) curated catalog: each entry pins a
//! Hugging Face revision and sha256, with a static mirror as fallback.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use anyhow::{Context, Result, anyhow, bail};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub family: String,
    pub description: String,
    pub repo: String,
    pub revision: String,
    pub filename: String,
    pub quant: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub languages: Vec<String>,
    pub streaming: bool,
    pub translate: bool,
    pub lang_detect: bool,
    pub timestamps: String,
    pub speed: u32,
    pub accuracy: u32,
    pub recommended: bool,
    pub rank: u32,
    pub license: String,
}

#[derive(Deserialize)]
struct Catalog {
    mirrors: Vec<String>,
    models: Vec<CatalogModel>,
}

static CATALOG: LazyLock<Catalog> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../resources/models.json")).expect("valid models.json"));

pub fn catalog() -> &'static [CatalogModel] {
    &CATALOG.models
}

pub fn find(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.models.iter().find(|m| m.id == id)
}

pub fn model_path(m: &CatalogModel) -> PathBuf {
    paths::models_dir().join(&m.filename)
}

pub fn is_downloaded(id: &str) -> bool {
    find(id).map(|m| model_path(m).is_file()).unwrap_or(false)
}

/// Resolve a model id to a file on disk. Accepts catalog ids or absolute paths
/// to custom GGUF / ggml `.bin` files.
pub fn resolve(id: &str) -> Result<PathBuf> {
    if let Some(m) = find(id) {
        let p = model_path(m);
        if p.is_file() {
            return Ok(p);
        }
        bail!("Model \"{}\" is not downloaded yet. Download it in Settings → Models.", m.name);
    }
    let p = PathBuf::from(id);
    if p.is_file() {
        return Ok(p);
    }
    Err(anyhow!("Unknown local model \"{id}\""))
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
    #[serde(flatten)]
    pub model: CatalogModel,
    pub downloaded: bool,
    pub downloading: Option<f32>,
}

#[derive(Default)]
struct Downloads {
    active: HashMap<String, (CancellationToken, Arc<Mutex<f32>>)>,
}

static DOWNLOADS: LazyLock<Mutex<Downloads>> = LazyLock::new(Default::default);

pub fn statuses() -> Vec<ModelStatus> {
    let dl = DOWNLOADS.lock();
    catalog()
        .iter()
        .map(|m| ModelStatus {
            downloaded: model_path(m).is_file(),
            downloading: dl.active.get(&m.id).map(|(_, p)| *p.lock()),
            model: m.clone(),
        })
        .collect()
}

pub fn cancel_download(id: &str) {
    if let Some((tok, _)) = DOWNLOADS.lock().active.get(id) {
        tok.cancel();
    }
}

pub fn delete(id: &str) -> Result<()> {
    let m = find(id).ok_or_else(|| anyhow!("unknown model"))?;
    let p = model_path(m);
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    crate::stt::local::evict(id);
    Ok(())
}

/// Download a catalog model, reporting progress (0..1). Verifies sha256.
pub async fn download(id: &str, on_progress: impl Fn(f32) + Send + Sync + 'static) -> Result<()> {
    let m = find(id).ok_or_else(|| anyhow!("unknown model {id}"))?.clone();
    if model_path(&m).is_file() {
        return Ok(());
    }
    let token = CancellationToken::new();
    let progress = Arc::new(Mutex::new(0.0f32));
    {
        let mut dl = DOWNLOADS.lock();
        if dl.active.contains_key(id) {
            bail!("already downloading");
        }
        dl.active.insert(id.to_string(), (token.clone(), progress.clone()));
    }
    let result = download_inner(&m, &token, &|p| {
        *progress.lock() = p;
        on_progress(p);
    })
    .await;
    DOWNLOADS.lock().active.remove(id);
    result
}

async fn download_inner(
    m: &CatalogModel,
    token: &CancellationToken,
    on_progress: &(dyn Fn(f32) + Send + Sync),
) -> Result<()> {
    let mut urls = vec![format!("https://huggingface.co/{}/resolve/{}/{}", m.repo, m.revision, m.filename)];
    urls.extend(
        CATALOG.mirrors.iter().map(|b| format!("{}/{}/{}/{}", b.trim_end_matches('/'), m.repo, m.revision, m.filename)),
    );

    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(15)).build()?;
    let dest = model_path(m);
    let part = dest.with_extension("part");
    let mut last_err = anyhow!("no download sources");

    for url in urls {
        if token.is_cancelled() {
            bail!("cancelled");
        }
        match fetch(&client, &url, &part, m, token, on_progress).await {
            Ok(()) => {
                tokio::fs::rename(&part, &dest).await?;
                on_progress(1.0);
                return Ok(());
            }
            Err(e) => {
                log::warn!("download from {url} failed: {e:#}");
                let _ = tokio::fs::remove_file(&part).await;
                if token.is_cancelled() {
                    bail!("cancelled");
                }
                last_err = e;
            }
        }
    }
    Err(last_err)
}

async fn fetch(
    client: &reqwest::Client,
    url: &str,
    part: &std::path::Path,
    m: &CatalogModel,
    token: &CancellationToken,
    on_progress: &(dyn Fn(f32) + Send + Sync),
) -> Result<()> {
    let resp = client.get(url).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(m.size_bytes).max(1);
    let mut file = tokio::fs::File::create(part).await.context("create model file")?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut last_report = 0.0f32;
    let mut stream = resp.bytes_stream();
    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = token.cancelled() => bail!("cancelled"),
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        let p = (done as f32 / total as f32).min(0.999);
        if p - last_report >= 0.005 {
            last_report = p;
            on_progress(p);
        }
    }
    file.flush().await?;
    let digest = hex::encode(hasher.finalize());
    if !m.sha256.is_empty() && digest != m.sha256 {
        bail!("checksum mismatch");
    }
    Ok(())
}
