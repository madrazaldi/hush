//! Microphone capture via cpal. The cpal stream is not `Send` on every
//! platform, so it lives on a dedicated thread; audio is downmixed and
//! resampled to 16 kHz mono before reaching the caller.

use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use super::{Resampler, to_mono};

#[derive(Debug, Clone, Serialize)]
pub struct InputDevice {
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.description().ok()).map(|d| d.name().to_string());
    let Ok(devices) = host.input_devices() else { return Vec::new() };
    devices
        .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
        // Hide our own private tap aggregate devices.
        .filter(|n| !n.starts_with("Hush"))
        .map(|name| InputDevice { is_default: Some(&name) == default.as_ref(), name })
        .collect()
}

fn pick_device(name: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();
    if let Some(want) = name.filter(|n| !n.is_empty()) {
        if let Ok(mut devs) = host.input_devices() {
            if let Some(d) = devs.find(|d| d.description().map(|x| x.name() == want).unwrap_or(false)) {
                return Ok(d);
            }
        }
        log::warn!("input device {want:?} not found, using default");
    }
    host.default_input_device().ok_or_else(|| anyhow!("No microphone found"))
}

enum Msg {
    Audio(Vec<f32>),
    Error(String),
}

pub struct MicCapture {
    stop_tx: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    pub device_name: String,
}

impl MicCapture {
    /// Start capturing. `on_audio` receives 16 kHz mono chunks on a worker thread.
    /// Returns once the device is actually running.
    pub fn start(device: Option<&str>, mut on_audio: Box<dyn FnMut(&[f32]) + Send + 'static>) -> Result<Self> {
        let device = device.map(str::to_string);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let thread = std::thread::Builder::new().name("hush-mic".into()).spawn(move || {
            let (tx, rx) = mpsc::channel::<Msg>();
            let built = (|| -> Result<(cpal::Stream, u32, usize, String)> {
                let dev = pick_device(device.as_deref())?;
                let name = dev.description().map(|d| d.name().to_string()).unwrap_or_default();
                let cfg = dev.default_input_config().map_err(|e| anyhow!("mic config: {e}"))?;
                let rate = cfg.sample_rate();
                let channels = cfg.channels() as usize;
                let err_tx = tx.clone();
                let on_err = move |e: cpal::Error| {
                    let _ = err_tx.send(Msg::Error(e.to_string()));
                };
                let stream_cfg = cfg.config();
                let stream = match cfg.sample_format() {
                    cpal::SampleFormat::F32 => {
                        let tx = tx.clone();
                        dev.build_input_stream::<f32, _, _>(stream_cfg, move |d, _| { let _ = tx.send(Msg::Audio(to_mono(d, channels))); }, on_err, None)
                    }
                    cpal::SampleFormat::I16 => {
                        let tx = tx.clone();
                        dev.build_input_stream::<i16, _, _>(
                            stream_cfg,
                            move |d, _| {
                                let f: Vec<f32> = d.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                                let _ = tx.send(Msg::Audio(to_mono(&f, channels)));
                            },
                            on_err,
                            None,
                        )
                    }
                    cpal::SampleFormat::I32 => {
                        let tx = tx.clone();
                        dev.build_input_stream::<i32, _, _>(
                            stream_cfg,
                            move |d, _| {
                                let f: Vec<f32> = d.iter().map(|s| *s as f32 / i32::MAX as f32).collect();
                                let _ = tx.send(Msg::Audio(to_mono(&f, channels)));
                            },
                            on_err,
                            None,
                        )
                    }
                    other => return Err(anyhow!("unsupported mic sample format {other:?}")),
                }
                .map_err(|e| anyhow!("could not open microphone: {e}"))?;
                stream.play().map_err(|e| anyhow!("could not start microphone: {e}"))?;
                Ok((stream, rate, channels, name))
            })();

            let (stream, rate, _channels, name) = match built {
                Ok(v) => v,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(name));
            let mut resampler = Resampler::new(rate);
            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(Msg::Audio(buf)) => {
                        let out = resampler.process(&buf);
                        if !out.is_empty() {
                            on_audio(&out);
                        }
                    }
                    Ok(Msg::Error(e)) => log::warn!("mic stream error: {e}"),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            drop(stream);
            // Drain anything captured before the stop request.
            while let Ok(Msg::Audio(buf)) = rx.try_recv() {
                let out = resampler.process(&buf);
                if !out.is_empty() {
                    on_audio(&out);
                }
            }
            let tail = resampler.finish();
            if !tail.is_empty() {
                on_audio(&tail);
            }
        })?;

        let device_name = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| anyhow!("microphone did not start in time"))??;
        Ok(Self { stop_tx: Some(stop_tx), thread: Some(thread), device_name })
    }

    /// Stop and wait until all captured audio has been delivered.
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for MicCapture {
    fn drop(&mut self) {
        self.stop();
    }
}
