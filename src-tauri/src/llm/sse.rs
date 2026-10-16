//! Minimal, tolerant Server-Sent Events parser over a reqwest byte stream.

use anyhow::Result;
use futures_util::StreamExt;

pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Calls `on_event` for each complete SSE event. Return `false` to stop early.
pub async fn for_each_event(
    resp: reqwest::Response,
    mut on_event: impl FnMut(SseEvent) -> Result<bool>,
) -> Result<()> {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut event: Option<String> = None;
    let mut data: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !data.is_empty() || event.is_some() {
                    let ev = SseEvent { event: event.take(), data: data.join("\n") };
                    data.clear();
                    if !on_event(ev)? {
                        return Ok(());
                    }
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line, ""),
            };
            match field {
                "event" => event = Some(value.to_string()),
                "data" => data.push(value.to_string()),
                _ => {}
            }
        }
    }
    if !data.is_empty() {
        on_event(SseEvent { event, data: data.join("\n") })?;
    }
    Ok(())
}
