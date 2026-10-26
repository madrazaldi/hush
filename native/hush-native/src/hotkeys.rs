//! Global hotkeys on a dedicated thread (handy-keys / CGEventTap on macOS).
//! If Accessibility isn't granted yet, the thread keeps retrying so hotkeys
//! start working as soon as the user grants it.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use handy_keys::{Hotkey, HotkeyId, HotkeyManager, HotkeyState};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Dictate,
    Command,
    PasteLast,
    Cancel,
}

enum Cmd {
    Bind(Vec<(Action, String)>, Sender<Vec<String>>),
    Cancel(bool),
}

#[derive(Clone)]
pub struct Hotkeys {
    tx: Sender<Cmd>,
}

pub type Handler = Box<dyn Fn(Action, bool) + Send + 'static>;

impl Hotkeys {
    pub fn spawn(handler: Handler) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new().name("hush-hotkeys".into()).spawn(move || run(rx, handler)).expect("hotkey thread");
        Self { tx }
    }

    /// Replace the bindings. Returns human-readable errors for bindings that failed.
    pub fn bind(&self, bindings: Vec<(Action, String)>) -> Vec<String> {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Cmd::Bind(bindings, tx)).is_err() {
            return vec!["hotkey thread stopped".into()];
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
    }

    /// Enable/disable the Esc cancel hotkey (only active while recording so Esc
    /// isn't swallowed globally).
    pub fn set_cancel_enabled(&self, enabled: bool) {
        let _ = self.tx.send(Cmd::Cancel(enabled));
    }
}

pub fn validate(s: &str) -> Result<(), String> {
    s.parse::<Hotkey>().map(|_| ()).map_err(|e| e.to_string())
}

fn run(rx: Receiver<Cmd>, handler: Handler) {
    let mut manager: Option<HotkeyManager> = None;
    let mut last_attempt = Instant::now() - Duration::from_secs(60);
    let mut wanted: Vec<(Action, String)> = Vec::new();
    let mut ids: HashMap<HotkeyId, Action> = HashMap::new();
    let mut cancel_id: Option<HotkeyId> = None;

    let apply = |m: &HotkeyManager, wanted: &[(Action, String)], ids: &mut HashMap<HotkeyId, Action>| -> Vec<String> {
        for id in ids.keys().copied().collect::<Vec<_>>() {
            let _ = m.unregister(id);
        }
        ids.clear();
        let mut errors = Vec::new();
        for (action, spec) in wanted {
            if spec.trim().is_empty() {
                continue;
            }
            match spec.parse::<Hotkey>() {
                Ok(hk) => match m.register(hk) {
                    Ok(id) => {
                        ids.insert(id, *action);
                    }
                    Err(e) => errors.push(format!("{spec}: {e}")),
                },
                Err(e) => errors.push(format!("{spec}: {e}")),
            }
        }
        errors
    };

    loop {
        // (Re)create the manager until Accessibility permission allows it.
        if manager.is_none() && last_attempt.elapsed() > Duration::from_secs(2) {
            last_attempt = Instant::now();
            match HotkeyManager::new_with_blocking() {
                Ok(m) => {
                    log::info!("global hotkeys active");
                    let errs = apply(&m, &wanted, &mut ids);
                    for e in errs {
                        log::warn!("hotkey: {e}");
                    }
                    manager = Some(m);
                }
                Err(e) => log::debug!("hotkeys unavailable (accessibility?): {e}"),
            }
        }

        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::Bind(b, reply) => {
                    wanted = b;
                    cancel_id = None;
                    let errs = match &manager {
                        Some(m) => apply(m, &wanted, &mut ids),
                        None => Vec::new(),
                    };
                    let _ = reply.send(errs);
                }
                Cmd::Cancel(on) => {
                    if let Some(m) = &manager {
                        match (on, cancel_id) {
                            (true, None) => {
                                if let Ok(hk) = "Escape".parse::<Hotkey>()
                                    && let Ok(id) = m.register(hk)
                                {
                                    cancel_id = Some(id);
                                    ids.insert(id, Action::Cancel);
                                }
                            }
                            (false, Some(id)) => {
                                let _ = m.unregister(id);
                                ids.remove(&id);
                                cancel_id = None;
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        match &manager {
            Some(m) => {
                let mut got = false;
                while let Some(ev) = m.try_recv() {
                    got = true;
                    if let Some(action) = ids.get(&ev.id) {
                        handler(*action, ev.state == HotkeyState::Pressed);
                    }
                }
                if !got {
                    std::thread::sleep(Duration::from_millis(8));
                }
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}
