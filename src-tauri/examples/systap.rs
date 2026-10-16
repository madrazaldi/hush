//! Smoke test for macOS system-audio capture.
//! Run with `cargo run --example systap`; play some audio while it runs.

#[cfg(target_os = "macos")]
fn main() {
    use hush_lib::audio::system_macos::{SystemAudioCapture, is_supported};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    println!("is_supported: {}", is_supported());

    for round in 1..=2 {
        let samples = Arc::new(AtomicU64::new(0));
        let peak_bits = Arc::new(AtomicU64::new(0));
        let (s, p) = (samples.clone(), peak_bits.clone());

        let t0 = Instant::now();
        let mut cap = SystemAudioCapture::start(Box::new(move |chunk: &[f32]| {
            s.fetch_add(chunk.len() as u64, Ordering::Relaxed);
            let peak = chunk.iter().fold(0f32, |m, v| m.max(v.abs()));
            let prev = f32::from_bits(p.load(Ordering::Relaxed) as u32);
            if peak > prev {
                p.store(peak.to_bits() as u64, Ordering::Relaxed);
            }
        }))
        .expect("start capture");
        println!("[round {round}] started in {:?}", t0.elapsed());

        // Play a few sounds during the capture.
        for _ in 0..2 {
            let _ = std::process::Command::new("afplay")
                .arg("/System/Library/Sounds/Glass.aiff")
                .spawn();
            std::thread::sleep(Duration::from_secs(2));
        }

        let cb = cap.callback_count();
        let t1 = Instant::now();
        cap.stop();
        println!("[round {round}] stop took {:?}", t1.elapsed());
        cap.stop(); // idempotent

        let n = samples.load(Ordering::Relaxed);
        let peak = f32::from_bits(peak_bits.load(Ordering::Relaxed) as u32);
        println!(
            "[round {round}] callbacks={cb} samples@16k={n} (~{:.2}s) peak={peak:.4}",
            n as f64 / 16_000.0
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("macOS only");
}
