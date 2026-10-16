//! Well-known on-disk locations, rooted at the app data directory.

use std::path::PathBuf;
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn init(app_data: PathBuf) {
    let _ = ROOT.set(app_data);
    for d in [root(), models_dir(), audio_dir(), media_dir()] {
        let _ = std::fs::create_dir_all(d);
    }
    // Spooled meeting audio from a session that didn't end cleanly.
    let _ = std::fs::remove_dir_all(spool_dir());
}

pub fn root() -> PathBuf {
    ROOT.get().cloned().unwrap_or_else(|| dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("com.hush.app"))
}

pub fn models_dir() -> PathBuf {
    root().join("models")
}

/// Recorded audio (dictations, meetings).
pub fn audio_dir() -> PathBuf {
    root().join("audio")
}

/// Temporary per-session meeting audio waiting for transcription.
pub fn spool_dir() -> PathBuf {
    root().join("spool")
}

/// Imported / downloaded media for file transcriptions.
pub fn media_dir() -> PathBuf {
    root().join("media")
}

pub fn settings_file() -> PathBuf {
    root().join("settings.json")
}

pub fn db_file() -> PathBuf {
    root().join("hush.db")
}
