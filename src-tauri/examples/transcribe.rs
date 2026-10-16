//! Transcribe a media file with a local model: `cargo run --example transcribe -- <file> [model-id]`

use std::time::Instant;

use hush_lib::{audio, stt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let file = args.next().expect("usage: transcribe <file> [model-id]");
    let model = args.next().unwrap_or_else(|| "parakeet-tdt-0.6b-v3".into());

    let t = Instant::now();
    let pcm = audio::decode::decode_file(std::path::Path::new(&file))?;
    println!("decoded {:.1}s of audio in {:?}", pcm.len() as f64 / stt::SAMPLE_RATE as f64, t.elapsed());

    let t = Instant::now();
    let out = stt::local::transcribe(&model, &pcm, &Default::default(), &|p| eprint!("\r{:>3.0}%", p * 100.0)).await?;
    eprintln!();
    println!("transcribed with {model} in {:?}", t.elapsed());
    for s in &out.segments {
        println!("[{:>6} - {:>6}] {}", s.start_ms, s.end_ms, s.text);
    }
    println!("---\n{}", out.text);
    stt::local::shutdown();
    Ok(())
}
