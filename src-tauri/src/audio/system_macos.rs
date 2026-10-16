//! macOS system-audio capture via Core Audio process taps (macOS 14.2+).
//!
//! A global mono tap (excluding no processes) is attached to a private aggregate
//! device. The aggregate device's IO proc downmixes whatever the tap delivers to
//! mono f32 and pushes it into a lock-free ring buffer (no allocation, no locks on
//! the realtime thread). A dedicated worker thread owns every Core Audio handle,
//! drains the ring, resamples to 16 kHz and calls the user callback. Dropping /
//! stopping signals that thread, which tears everything down in the right order
//! (stop device, destroy IO proc, destroy aggregate device, destroy tap).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use cidre::core_audio::{
    self as ca, AggregateDevice, DeviceIoProcId, aggregate_device_keys as agg_keys, sub_device_keys,
};
use cidre::{cat, cf, ns, os};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::audio::Resampler;

/// How often the worker thread drains the ring buffer.
const DRAIN_INTERVAL: Duration = Duration::from_millis(20);
/// Ring capacity in mono samples at the tap's native rate (about 10 s at 48 kHz).
const RING_SECONDS: usize = 10;

/// Whether the OS supports process taps (macOS >= 14.2).
pub fn is_supported() -> bool {
    let v = ns::ProcessInfo::current().os_version();
    (v.major, v.minor) >= (14, 2)
}

/// Per-capture state handed to the realtime IO proc.
struct IoCtx {
    producer: HeapProd<f32>,
    counter: Arc<AtomicU64>,
    channels: usize,
    interleaved: bool,
    is_float: bool,
    bits: u32,
}

extern "C" fn io_proc(
    _device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input_data: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output_data: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    client_data: Option<&mut IoCtx>,
) -> os::Status {
    let Some(ctx) = client_data else {
        return os::Status::NO_ERR;
    };
    ctx.counter.fetch_add(1, Ordering::Relaxed);

    let n_bufs = input_data.number_buffers as usize;
    if n_bufs == 0 {
        return os::Status::NO_ERR;
    }
    // The list is variable length; `buffers` is declared with 1 element, so go through a raw pointer.
    let bufs = input_data.buffers.as_ptr();

    if ctx.interleaved {
        // One buffer holding `channels` interleaved samples per frame.
        let buf = unsafe { *bufs };
        if buf.data.is_null() {
            return os::Status::NO_ERR;
        }
        let ch = (buf.number_channels as usize).max(1);
        let bytes = buf.data_bytes_size as usize;
        match (ctx.is_float, ctx.bits) {
            (true, 32) => {
                let frames = bytes / (4 * ch);
                let data = unsafe { std::slice::from_raw_parts(buf.data as *const f32, frames * ch) };
                for f in data.chunks_exact(ch) {
                    let s: f32 = f.iter().sum::<f32>() / ch as f32;
                    let _ = ctx.producer.try_push(s);
                }
            }
            (false, 16) => {
                let frames = bytes / (2 * ch);
                let data = unsafe { std::slice::from_raw_parts(buf.data as *const i16, frames * ch) };
                for f in data.chunks_exact(ch) {
                    let s: f32 = f.iter().map(|v| *v as f32 / 32768.0).sum::<f32>() / ch as f32;
                    let _ = ctx.producer.try_push(s);
                }
            }
            (false, 32) => {
                let frames = bytes / (4 * ch);
                let data = unsafe { std::slice::from_raw_parts(buf.data as *const i32, frames * ch) };
                for f in data.chunks_exact(ch) {
                    let s: f32 = f.iter().map(|v| *v as f32 / 2_147_483_648.0).sum::<f32>() / ch as f32;
                    let _ = ctx.producer.try_push(s);
                }
            }
            _ => {}
        }
    } else {
        // Planar: one buffer per channel; average them.
        let n = n_bufs.min(ctx.channels.max(1));
        let first = unsafe { *bufs };
        if first.data.is_null() {
            return os::Status::NO_ERR;
        }
        let sample_bytes = (ctx.bits / 8).max(1) as usize;
        let frames = first.data_bytes_size as usize / sample_bytes;
        for i in 0..frames {
            let mut acc = 0.0f32;
            for c in 0..n {
                let b = unsafe { *bufs.add(c) };
                if b.data.is_null() || i * sample_bytes >= b.data_bytes_size as usize {
                    continue;
                }
                acc += unsafe {
                    match (ctx.is_float, ctx.bits) {
                        (true, 32) => *(b.data as *const f32).add(i),
                        (false, 16) => *(b.data as *const i16).add(i) as f32 / 32768.0,
                        (false, 32) => *(b.data as *const i32).add(i) as f32 / 2_147_483_648.0,
                        _ => 0.0,
                    }
                };
            }
            let _ = ctx.producer.try_push(acc / n as f32);
        }
    }
    os::Status::NO_ERR
}

/// Everything the worker thread owns while capturing. Field order matters only
/// insofar as `teardown` consumes them explicitly in the right order.
struct Session {
    tap: ca::TapGuard,
    agg: AggregateDevice,
    proc_id: DeviceIoProcId,
    started: bool,
    // Boxed so the pointer handed to Core Audio stays stable.
    _ctx: Box<IoCtx>,
    cons: HeapCons<f32>,
    counter: Arc<AtomicU64>,
    sample_rate: u32,
}

fn build_session() -> Result<Session> {
    if !is_supported() {
        return Err(anyhow!("system audio capture requires macOS 14.2 or later"));
    }

    // Global mono tap that excludes nothing => everything that plays out.
    let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
    let tap = tap_desc.create_process_tap().map_err(|e| anyhow!("create process tap failed: {e:?}"))?;
    let tap_uid = tap.uid().map_err(|e| anyhow!("tap uid: {e:?}"))?;
    let asbd = tap.asbd().map_err(|e| anyhow!("tap format: {e:?}"))?;

    let sample_rate = asbd.sample_rate.round() as u32;
    if sample_rate == 0 {
        return Err(anyhow!("tap reported a zero sample rate"));
    }
    let channels = (asbd.channels_per_frame as usize).max(1);
    let interleaved = asbd.is_interleaved();
    let is_float = asbd.format_flags.contains(cat::AudioFormatFlags::IS_FLOAT);
    let bits = if asbd.bits_per_channel == 0 { 32 } else { asbd.bits_per_channel };
    log::debug!(
        "system tap format: {sample_rate} Hz, {channels} ch, {bits} bit, float={is_float}, interleaved={interleaved}"
    );

    // Sub-tap list: [{ uid: <tap uid> }]
    let sub_tap = cf::DictionaryOf::with_keys_values(&[sub_device_keys::uid()], &[tap_uid.as_type_ref()]);
    let tap_list = cf::ArrayOf::from_slice(&[sub_tap.as_ref()]);

    // Use the default output device as clock source (if there is one).
    let output_uid = ca::System::default_output_device().and_then(|d| d.uid()).ok();

    let agg_uid = cf::Uuid::new().to_cf_string();
    let name = cf::str!(c"Hush System Tap");
    let yes = cf::Boolean::value_true().as_type_ref();
    let no = cf::Boolean::value_false();

    let dict = if let Some(out_uid) = output_uid.as_ref() {
        let sub_dev = cf::DictionaryOf::with_keys_values(&[sub_device_keys::uid()], &[out_uid.as_type_ref()]);
        let sub_devs = cf::ArrayOf::from_slice(&[sub_dev.as_ref()]);
        cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::is_stacked(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::uid(),
                agg_keys::main_sub_device(),
                agg_keys::sub_device_list(),
                agg_keys::tap_list(),
            ],
            &[
                yes,
                no,
                yes,
                name.as_type_ref(),
                agg_uid.as_type_ref(),
                out_uid.as_type_ref(),
                sub_devs.as_type_ref(),
                tap_list.as_type_ref(),
            ],
        )
    } else {
        cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::is_stacked(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::uid(),
                agg_keys::tap_list(),
            ],
            &[yes, no, yes, name.as_type_ref(), agg_uid.as_type_ref(), tap_list.as_type_ref()],
        )
    };

    let agg = AggregateDevice::with_desc(&dict).map_err(|e| anyhow!("create aggregate device failed: {e:?}"))?;

    let rb = HeapRb::<f32>::new(sample_rate as usize * RING_SECONDS);
    let (producer, cons) = rb.split();
    let counter = Arc::new(AtomicU64::new(0));
    let mut ctx = Box::new(IoCtx { producer, counter: counter.clone(), channels, interleaved, is_float, bits });

    let proc_id =
        agg.create_io_proc_id(io_proc, Some(&mut *ctx)).map_err(|e| anyhow!("create IO proc failed: {e:?}"))?;

    let mut session = Session { tap, agg, proc_id, started: false, _ctx: ctx, cons, counter, sample_rate };

    // SAFETY: AudioDeviceStart on the aggregate device with our proc id.
    let status = unsafe { AudioDeviceStart(session.agg.0.0, Some(session.proc_id)) };
    if let Err(e) = status.result() {
        session.teardown();
        return Err(anyhow!("start aggregate device failed: {e:?}"));
    }
    session.started = true;
    Ok(session)
}

unsafe extern "C" {
    fn AudioDeviceStart(device: u32, proc_id: Option<DeviceIoProcId>) -> os::Status;
    fn AudioDeviceStop(device: u32, proc_id: Option<DeviceIoProcId>) -> os::Status;
}

impl Session {
    /// Stop device, destroy IO proc, destroy aggregate device, destroy tap.
    fn teardown(self) {
        let Session { tap, agg, proc_id, started, _ctx, cons, .. } = self;
        let dev = agg.0.0;
        unsafe {
            if started {
                let _ = AudioDeviceStop(dev, Some(proc_id));
            }
        }
        drop(agg); // destroys the aggregate device
        drop(tap); // destroys the tap
        drop(_ctx);
        drop(cons);
    }
}

fn drain(cons: &mut HeapCons<f32>, scratch: &mut Vec<f32>, resampler: &mut Resampler, cb: &mut dyn FnMut(&[f32])) {
    scratch.clear();
    while let Some(s) = cons.try_pop() {
        scratch.push(s);
    }
    if scratch.is_empty() {
        return;
    }
    let out = resampler.process(scratch);
    if !out.is_empty() {
        cb(&out);
    }
}

/// Captures all system output audio as 16 kHz mono f32.
pub struct SystemAudioCapture {
    stop_tx: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    counter: Arc<AtomicU64>,
}

impl SystemAudioCapture {
    /// Start capturing all system output audio. `on_audio` receives 16 kHz mono f32 chunks
    /// (any size) on a background (non-realtime) thread.
    pub fn start(mut on_audio: crate::audio::AudioCallback) -> Result<Self> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (init_tx, init_rx) = mpsc::sync_channel::<Result<Arc<AtomicU64>>>(1);

        let thread = std::thread::Builder::new()
            .name("hush-system-audio".into())
            .spawn(move || {
                let mut session = match build_session() {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = init_tx.send(Err(e));
                        return;
                    }
                };
                let _ = init_tx.send(Ok(session.counter.clone()));

                let mut resampler = Resampler::new(session.sample_rate);
                let mut scratch: Vec<f32> = Vec::with_capacity(8192);
                // Runs until stop is requested or the owner vanishes.
                while let Err(mpsc::RecvTimeoutError::Timeout) = stop_rx.recv_timeout(DRAIN_INTERVAL) {
                    drain(&mut session.cons, &mut scratch, &mut resampler, &mut *on_audio);
                }

                // Stops the hardware first so no more samples arrive, flushes what is
                // left, then destroys everything.
                session_stop_and_flush(session, &mut scratch, &mut resampler, &mut *on_audio);
            })
            .context("spawn system audio thread")?;

        let counter = match init_rx.recv() {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                let _ = thread.join();
                return Err(e);
            }
            Err(_) => {
                let _ = thread.join();
                return Err(anyhow!("system audio thread exited during startup"));
            }
        };

        Ok(Self { stop_tx: Some(stop_tx), thread: Some(thread), counter })
    }

    /// Stop capturing (also happens on Drop). Idempotent.
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }

    /// Number of IO callbacks received so far (for a "permission denied -> silence" watchdog).
    pub fn callback_count(&self) -> u64 {
        self.counter.load(Ordering::Relaxed)
    }
}

impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Stop the device, flush remaining ring samples + resampler tail, then destroy everything.
fn session_stop_and_flush(
    mut session: Session,
    scratch: &mut Vec<f32>,
    resampler: &mut Resampler,
    cb: &mut dyn FnMut(&[f32]),
) {
    unsafe {
        if session.started {
            let _ = AudioDeviceStop(session.agg.0.0, Some(session.proc_id));
            session.started = false;
        }
    }
    drain(&mut session.cons, scratch, resampler, cb);
    let tail = resampler.finish();
    if !tail.is_empty() {
        cb(&tail);
    }
    session.teardown();
}
