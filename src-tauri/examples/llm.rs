//! Clean up a dictation with each installed agent CLI: `cargo run --example llm`

use std::time::Instant;

use hush_lib::{ai, llm};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let raw = "um so i think we should uh move the launch to next tuesday no wait wednesday and tell sarah";
    let style = ai::builtin_styles().into_iter().find(|s| s.id == "message").unwrap();
    let req = ai::dictation_request(&style, raw, &ai::DictationContext { app_name: Some("Slack"), vocabulary: &[] });
    for cli in llm::detect_clis().await {
        println!("{:?}: {:?} {:?}", cli.kind, cli.path, cli.version);
        if cli.path.is_none() {
            continue;
        }
        let profile = llm::LlmProfile {
            id: "t".into(),
            name: "t".into(),
            kind: cli.kind,
            model: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            bin_path: String::new(),
            effort: String::new(),
        };
        let t = Instant::now();
        match llm::complete_text(&profile, &req).await {
            Ok(out) => println!("  -> {out:?} ({:?})", t.elapsed()),
            Err(e) => println!("  !! {e:#}"),
        }
    }
    Ok(())
}
