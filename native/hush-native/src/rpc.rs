//! Newline-delimited JSON-RPC 2.0 over stdio.
//!
//! * stdin: one request object per line (`{"jsonrpc":"2.0","id":1,"method":"x","params":{}}`).
//! * stdout: one response (`result` or `error`) per request, plus notifications
//!   (no `id`) for pushed events such as audio levels. Nothing else is written
//!   to stdout; logs go to stderr.
//!
//! Each request runs on its own thread, so a long transcription never blocks
//! a level meter or a hotkey rebind. Responses may therefore arrive out of
//! order and are matched by `id`.

use std::io::{BufRead, Write};
use std::sync::Arc;

use anyhow::Result;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};

/// Writes whole JSON lines to the shared output, one at a time.
#[derive(Clone)]
pub struct Emitter {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Emitter {
    pub fn new(out: impl Write + Send + 'static) -> Self {
        Self { out: Arc::new(Mutex::new(Box::new(out))) }
    }

    pub fn stdout() -> Self {
        Self::new(std::io::stdout())
    }

    fn write(&self, v: &Value) {
        let mut line = v.to_string();
        line.push('\n');
        let mut out = self.out.lock();
        // A closed pipe means the parent is gone; the read loop notices EOF too.
        let _ = out.write_all(line.as_bytes()).and_then(|_| out.flush());
    }

    /// Push an event to the parent.
    pub fn emit(&self, method: &str, params: impl Serialize) {
        self.write(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    fn respond(&self, id: Value, res: Result<Value>) {
        match res {
            Ok(result) => self.write(&json!({"jsonrpc": "2.0", "id": id, "result": result})),
            Err(e) => {
                self.write(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": format!("{e:#}")}}))
            }
        }
    }
}

pub type Handler = dyn Fn(&str, Value) -> Result<Value> + Send + Sync;

/// Parse one input line into `(id, method, params)`.
fn parse(line: &str) -> Result<(Value, String, Value), (Value, String)> {
    let v: Value = serde_json::from_str(line).map_err(|e| (Value::Null, format!("parse error: {e}")))?;
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = v.get("method").and_then(Value::as_str) else {
        return Err((id, "missing method".into()));
    };
    Ok((id, method.to_string(), v.get("params").cloned().unwrap_or(Value::Null)))
}

/// Read requests until EOF, answering each on its own thread.
pub fn serve(input: impl BufRead, emitter: &Emitter, handler: Arc<Handler>) {
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let (id, method, params) = match parse(&line) {
            Ok(r) => r,
            Err((id, msg)) => {
                emitter.respond(id, Err(anyhow::anyhow!(msg)));
                continue;
            }
        };
        let (emitter, handler) = (emitter.clone(), handler.clone());
        let spawned = std::thread::Builder::new().name(format!("rpc-{method}")).spawn(move || {
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&method, params)))
                .unwrap_or_else(|_| Err(anyhow::anyhow!("{method} panicked")));
            emitter.respond(id, res);
        });
        if let Err(e) = spawned {
            log::error!("could not spawn request thread: {e}");
        }
    }
}

/// Deserialize a request's params, with a readable error.
pub fn params<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(if v.is_null() { json!({}) } else { v }).map_err(|e| anyhow::anyhow!("bad params: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);

    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn lines(buf: &Buf) -> Vec<Value> {
        let s = String::from_utf8(buf.0.lock().clone()).unwrap();
        let mut v: Vec<Value> = s.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        v.sort_by_key(|x| x["id"].as_i64().unwrap_or(-1));
        v
    }

    #[test]
    fn answers_requests_and_reports_errors() {
        let buf = Buf::default();
        let emitter = Emitter::new(buf.clone());
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let handler: Arc<Handler> = Arc::new(move |method, params| {
            c.fetch_add(1, Ordering::SeqCst);
            match method {
                "echo" => Ok(params),
                "boom" => Err(anyhow::anyhow!("nope")),
                "panic" => panic!("bug"),
                _ => Err(anyhow::anyhow!("unknown method {method}")),
            }
        });
        let input = "{\"id\":1,\"method\":\"echo\",\"params\":{\"a\":1}}\n\n{\"id\":2,\"method\":\"boom\"}\n{\"id\":3,\"method\":\"panic\"}\nnot json\n{\"id\":4}\n";
        serve(Cursor::new(input), &emitter, handler);
        // Request threads are detached; wait for all three handler calls and their replies.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while buf.0.lock().iter().filter(|b| **b == b'\n').count() < 5 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let out = lines(&buf);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let by_id = |id: i64| out.iter().find(|v| v["id"] == id).unwrap().clone();
        assert_eq!(by_id(1)["result"], json!({"a": 1}));
        assert_eq!(by_id(2)["error"]["message"], "nope");
        assert!(by_id(3)["error"]["message"].as_str().unwrap().contains("panicked"));
        assert_eq!(by_id(4)["error"]["message"], "missing method");
        assert!(
            out.iter().any(|v| v["id"].is_null() && v["error"]["message"].as_str().unwrap().starts_with("parse error"))
        );
    }

    #[test]
    fn events_are_notifications() {
        let buf = Buf::default();
        Emitter::new(buf.clone()).emit("capture.level", json!({"id": "a", "level": 0.5}));
        let v = &lines(&buf)[0];
        assert_eq!(v["method"], "capture.level");
        assert_eq!(v["params"]["level"], 0.5);
        assert!(v.get("id").is_none());
    }
}
