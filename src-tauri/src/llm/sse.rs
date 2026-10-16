//! Minimal, tolerant Server-Sent Events parser over a reqwest byte stream.

use anyhow::Result;
use futures_util::StreamExt;

#[derive(Debug, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Incremental parser. Bytes are buffered until a full line arrives, so
/// multi-byte UTF-8 characters split across network chunks decode intact.
#[derive(Default)]
struct Parser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl Parser {
    fn feed(&mut self, bytes: &[u8], out: &mut Vec<SseEvent>) {
        self.buf.extend_from_slice(bytes);
        let mut start = 0;
        while let Some(nl) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&self.buf[start..start + nl]).into_owned();
            start += nl + 1;
            self.line(line.trim_end_matches('\r'), out);
        }
        self.buf.drain(..start);
    }

    fn line(&mut self, line: &str, out: &mut Vec<SseEvent>) {
        if line.is_empty() {
            if !self.data.is_empty() || self.event.is_some() {
                out.push(SseEvent { event: self.event.take(), data: self.data.join("\n") });
                self.data.clear();
            }
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
    }

    fn finish(mut self, out: &mut Vec<SseEvent>) {
        if !self.buf.is_empty() {
            let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
            self.line(rest.trim_end_matches('\r'), out);
        }
        if !self.data.is_empty() {
            out.push(SseEvent { event: self.event.take(), data: self.data.join("\n") });
        }
    }
}

/// Calls `on_event` for each complete SSE event. Return `false` to stop early.
pub async fn for_each_event(resp: reqwest::Response, mut on_event: impl FnMut(SseEvent) -> Result<bool>) -> Result<()> {
    let mut stream = resp.bytes_stream();
    let mut parser = Parser::default();
    let mut events = Vec::new();
    while let Some(chunk) = stream.next().await {
        parser.feed(&chunk?, &mut events);
        for ev in events.drain(..) {
            if !on_event(ev)? {
                return Ok(());
            }
        }
    }
    parser.finish(&mut events);
    for ev in events {
        if !on_event(ev)? {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multibyte_split_across_chunks() {
        let body = "event: delta\ndata: café ☕\n\ndata: [DONE]\n\n".as_bytes();
        // Split inside both the 2-byte "é" and the 3-byte "☕".
        let cut1 = body.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let cut2 = body.iter().position(|&b| b == 0xE2).unwrap() + 2;
        let mut p = Parser::default();
        let mut out = Vec::new();
        for part in [&body[..cut1], &body[cut1..cut2], &body[cut2..]] {
            p.feed(part, &mut out);
        }
        p.finish(&mut out);
        assert_eq!(
            out,
            vec![
                SseEvent { event: Some("delta".into()), data: "café ☕".into() },
                SseEvent { event: None, data: "[DONE]".into() },
            ]
        );
    }

    #[test]
    fn crlf_multiline_and_unterminated_tail() {
        let mut p = Parser::default();
        let mut out = Vec::new();
        p.feed(b": comment\r\ndata: a\r\ndata: b\r\n\r\ndata: tail", &mut out);
        p.finish(&mut out);
        assert_eq!(out[0].data, "a\nb");
        assert_eq!(out[1].data, "tail");
    }
}
