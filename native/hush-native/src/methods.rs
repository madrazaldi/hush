//! The RPC surface: one `match` from method name to implementation.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::capture::{Captures, StartParams};
use crate::hotkeys::{Action, Hotkeys};
use crate::rpc::{Emitter, params};
use crate::{input, mic, perms, stt, system};

pub struct App {
    emitter: Emitter,
    captures: Captures,
    hotkeys: Mutex<Option<Hotkeys>>,
}

#[derive(Deserialize)]
struct RunParams {
    job: String,
    model: PathBuf,
    path: PathBuf,
    /// First sample and sample count within the raw f32 file; the whole file by default.
    #[serde(default)]
    start: u64,
    len: Option<u64>,
    #[serde(default)]
    options: stt::Options,
}

#[derive(Deserialize)]
struct ModelParams {
    model: PathBuf,
}

#[derive(Deserialize)]
struct Binding {
    action: Action,
    spec: String,
}

/// Read `len` samples starting at sample `start` from a raw little-endian f32 file.
pub fn read_samples(path: &Path, start: u64, len: Option<u64>) -> Result<Vec<f32>> {
    let mut f = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let total = f.metadata()?.len() / 4;
    let start = start.min(total);
    let len = len.unwrap_or(total - start).min(total - start);
    f.seek(SeekFrom::Start(start * 4))?;
    let mut bytes = vec![0u8; (len * 4) as usize];
    f.read_exact(&mut bytes)?;
    Ok(bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect())
}

impl App {
    pub fn new(emitter: Emitter) -> Arc<Self> {
        Arc::new(Self { emitter, captures: Captures::default(), hotkeys: Mutex::new(None) })
    }

    fn hotkeys(&self) -> Hotkeys {
        let mut slot = self.hotkeys.lock();
        slot.get_or_insert_with(|| {
            let emitter = self.emitter.clone();
            Hotkeys::spawn(Box::new(move |action, pressed| {
                emitter.emit("hotkey", json!({"action": action, "pressed": pressed}));
            }))
        })
        .clone()
    }

    /// Stop everything that holds a device or a model. Also run when the parent goes away.
    pub fn cleanup(&self) {
        self.captures.stop_all();
        stt::shutdown();
    }

    pub fn call(&self, method: &str, p: Value) -> Result<Value> {
        Ok(match method {
            "ping" => json!({"version": env!("CARGO_PKG_VERSION"), "pid": std::process::id()}),
            "shutdown" => {
                self.cleanup();
                // Let the reply reach the parent before exiting.
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    std::process::exit(0);
                });
                json!({})
            }

            "permissions.get" => {
                let mut v = serde_json::to_value(perms::get())?;
                v["system_audio_supported"] = json!(system::is_supported());
                v
            }
            "devices.list" => serde_json::to_value(mic::list_input_devices())?,
            "audio.mic_users" => json!(perms::mic_users()),

            "capture.start" => self.captures.start(params::<StartParams>(p)?, &self.emitter)?,
            "capture.stop" => {
                #[derive(Deserialize)]
                struct P {
                    id: String,
                }
                self.captures.stop(&params::<P>(p)?.id)?
            }

            "stt.info" => serde_json::to_value(stt::info(&params::<ModelParams>(p)?.model)?)?,
            "stt.preload" => {
                stt::preload(&params::<ModelParams>(p)?.model);
                json!({})
            }
            "stt.evict" => {
                stt::evict(&params::<ModelParams>(p)?.model);
                json!({})
            }
            "stt.cancel" => {
                #[derive(Deserialize)]
                struct P {
                    job: String,
                }
                stt::cancel(&params::<P>(p)?.job);
                json!({})
            }
            "stt.run" => {
                let r = params::<RunParams>(p)?;
                let pcm = read_samples(&r.path, r.start, r.len)?;
                serde_json::to_value(stt::run(&r.job, &r.model, &pcm, &r.options)?)?
            }

            "hotkeys.bind" => {
                #[derive(Deserialize)]
                struct P {
                    bindings: Vec<Binding>,
                }
                let bindings = params::<P>(p)?.bindings.into_iter().map(|b| (b.action, b.spec)).collect();
                json!(self.hotkeys().bind(bindings))
            }
            "hotkeys.validate" => {
                #[derive(Deserialize)]
                struct P {
                    spec: String,
                }
                crate::hotkeys::validate(&params::<P>(p)?.spec).map_err(|e| anyhow!(e))?;
                json!({})
            }
            "hotkeys.set_cancel" => {
                #[derive(Deserialize)]
                struct P {
                    enabled: bool,
                }
                self.hotkeys().set_cancel_enabled(params::<P>(p)?.enabled);
                json!({})
            }

            "input.paste" => {
                #[derive(Deserialize)]
                struct P {
                    text: String,
                    #[serde(default)]
                    restore: bool,
                }
                let P { text, restore } = params(p)?;
                json!({"done": input::paste_text(&text, restore)?})
            }
            "input.type" => {
                #[derive(Deserialize)]
                struct P {
                    text: String,
                }
                json!({"done": input::type_text(&params::<P>(p)?.text)?})
            }
            "input.enter" => {
                #[derive(Deserialize)]
                struct P {
                    #[serde(default)]
                    command: bool,
                }
                input::press_enter(params::<P>(p)?.command)?;
                json!({})
            }
            "input.selected_text" => json!(input::selected_text()?),
            "input.cancel" => {
                input::cancel();
                json!({})
            }
            other => return Err(anyhow!("unknown method {other}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_sample_range() {
        let path = std::env::temp_dir().join(format!("hush-native-read-{}.f32", std::process::id()));
        let samples: Vec<f32> = (0..10).map(|i| i as f32).collect();
        std::fs::write(&path, samples.iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
        assert_eq!(read_samples(&path, 3, Some(2)).unwrap(), vec![3.0, 4.0]);
        assert_eq!(read_samples(&path, 8, None).unwrap(), vec![8.0, 9.0]);
        // Out-of-range requests clamp instead of failing.
        assert_eq!(read_samples(&path, 9, Some(50)).unwrap(), vec![9.0]);
        assert!(read_samples(&path, 20, None).unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unknown_methods_and_bad_params_are_errors() {
        let app = App::new(Emitter::new(std::io::sink()));
        assert!(app.call("nope", Value::Null).unwrap_err().to_string().contains("unknown method"));
        assert!(app.call("stt.run", json!({"job": 1})).unwrap_err().to_string().contains("bad params"));
        assert_eq!(app.call("ping", Value::Null).unwrap()["version"], env!("CARGO_PKG_VERSION"));
    }
}
