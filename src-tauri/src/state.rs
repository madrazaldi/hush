//! Process-wide application state.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::db::Db;
use crate::dictation::Dictation;
use crate::files::FileQueue;
use crate::meetings::Meetings;
use crate::settings::Settings;

pub struct AppState {
    pub app: AppHandle,
    pub settings: RwLock<Settings>,
    pub db: Db,
    pub dictation: Dictation,
    pub meetings: Meetings,
    pub files: FileQueue,
    /// Cancellation tokens for in-flight LLM requests, keyed by request id.
    pub llm_tasks: Mutex<HashMap<String, CancellationToken>>,
}

static STATE: OnceLock<Arc<AppState>> = OnceLock::new();

pub fn init(state: Arc<AppState>) {
    let _ = STATE.set(state);
}

pub fn get() -> &'static Arc<AppState> {
    STATE.get().expect("app state initialized")
}

impl AppState {
    pub fn settings(&self) -> Settings {
        self.settings.read().clone()
    }

    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Err(e) = self.app.emit(event, payload) {
            log::warn!("emit {event}: {e}");
        }
    }
}
