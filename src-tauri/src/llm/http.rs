//! Bring-your-own-key HTTP backends with SSE streaming.

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use super::sse::for_each_event;
use super::{ChatRequest, DeltaFn, LlmProfile, Role};

fn client() -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(20)).build().expect("reqwest client")
}

fn base(profile: &LlmProfile, default: &str) -> String {
    let b = profile.base_url.trim().trim_end_matches('/');
    if b.is_empty() { default.to_string() } else { b.to_string() }
}

/// Joins `base` and `path`, avoiding a doubled `/v1` when the user included it.
fn join(base: &str, path: &str) -> String {
    format!("{base}/{}", path.trim_start_matches('/'))
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or(body);
    bail!("HTTP {status}: {}", msg.chars().take(500).collect::<String>())
}

fn auth(rb: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    if key.trim().is_empty() { rb } else { rb.bearer_auth(key.trim()) }
}

fn require_model(profile: &LlmProfile) -> Result<&str> {
    let m = profile.model.trim();
    if m.is_empty() { Err(anyhow!("No model configured for \"{}\"", profile.name)) } else { Ok(m) }
}

pub async fn chat_completions(profile: &LlmProfile, req: &ChatRequest, on_delta: DeltaFn<'_>) -> Result<String> {
    let url = join(&base(profile, "https://api.openai.com/v1"), "chat/completions");
    let mut messages = Vec::new();
    if !req.system.trim().is_empty() {
        messages.push(json!({"role": "system", "content": req.system}));
    }
    for m in &req.messages {
        let role = if m.role == Role::User { "user" } else { "assistant" };
        messages.push(json!({"role": role, "content": m.content}));
    }
    let mut body = json!({"model": require_model(profile)?, "messages": messages, "stream": true});
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !profile.effort.trim().is_empty() {
        body["reasoning_effort"] = json!(profile.effort.trim());
    }
    let resp = check(auth(client().post(url), &profile.api_key).json(&body).send().await?).await?;

    let mut out = String::new();
    for_each_event(resp, |ev| {
        if ev.data.trim() == "[DONE]" {
            return Ok(false);
        }
        let v: Value = match serde_json::from_str(&ev.data) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        if let Some(err) = v.get("error") {
            bail!("{}", err["message"].as_str().unwrap_or("stream error"));
        }
        if let Some(d) = v["choices"][0]["delta"]["content"].as_str() {
            on_delta(d);
            out.push_str(d);
        }
        Ok(true)
    })
    .await?;
    Ok(strip_think(&out))
}

pub async fn responses(profile: &LlmProfile, req: &ChatRequest, on_delta: DeltaFn<'_>) -> Result<String> {
    let url = join(&base(profile, "https://api.openai.com/v1"), "responses");
    let input: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            if m.role == Role::User {
                json!({"role": "user", "content": [{"type": "input_text", "text": m.content}]})
            } else {
                json!({"role": "assistant", "content": [{"type": "output_text", "text": m.content}]})
            }
        })
        .collect();
    let mut body = json!({
        "model": require_model(profile)?,
        "instructions": req.system,
        "input": input,
        "stream": true,
        "store": false,
    });
    if !profile.effort.trim().is_empty() {
        body["reasoning"] = json!({"effort": profile.effort.trim()});
    }
    let resp = check(auth(client().post(url), &profile.api_key).json(&body).send().await?).await?;

    let mut out = String::new();
    for_each_event(resp, |ev| {
        let v: Value = match serde_json::from_str(&ev.data) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        let ty = v["type"].as_str().or(ev.event.as_deref()).unwrap_or("");
        match ty {
            "response.output_text.delta" => {
                if let Some(d) = v["delta"].as_str() {
                    on_delta(d);
                    out.push_str(d);
                }
            }
            "response.completed" => return Ok(false),
            "response.failed" | "error" => {
                let msg = v["response"]["error"]["message"]
                    .as_str()
                    .or(v["message"].as_str())
                    .or(v["error"]["message"].as_str())
                    .unwrap_or("response failed");
                bail!("{msg}");
            }
            _ => {}
        }
        Ok(true)
    })
    .await?;
    Ok(strip_think(&out))
}

pub async fn anthropic(profile: &LlmProfile, req: &ChatRequest, on_delta: DeltaFn<'_>) -> Result<String> {
    let url = join(&base(profile, "https://api.anthropic.com/v1"), "messages");
    let messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            let role = if m.role == Role::User { "user" } else { "assistant" };
            json!({"role": role, "content": m.content})
        })
        .collect();
    let mut body = json!({
        "model": require_model(profile)?,
        "max_tokens": 16000,
        "messages": messages,
        "stream": true,
    });
    if !req.system.trim().is_empty() {
        body["system"] = json!(req.system);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    let resp = check(
        client()
            .post(url)
            .header("x-api-key", profile.api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?,
    )
    .await?;

    let mut out = String::new();
    for_each_event(resp, |ev| {
        let v: Value = match serde_json::from_str(&ev.data) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        match v["type"].as_str().unwrap_or("") {
            "content_block_delta" if v["delta"]["type"] == "text_delta" => {
                if let Some(d) = v["delta"]["text"].as_str() {
                    on_delta(d);
                    out.push_str(d);
                }
            }
            "message_stop" => return Ok(false),
            "error" => bail!("{}", v["error"]["message"].as_str().unwrap_or("stream error")),
            _ => {}
        }
        Ok(true)
    })
    .await?;
    Ok(out)
}

pub async fn list_models(profile: &LlmProfile) -> Result<Vec<String>> {
    let is_anthropic = profile.kind == super::LlmKind::Anthropic;
    let default = if is_anthropic { "https://api.anthropic.com/v1" } else { "https://api.openai.com/v1" };
    let url = join(&base(profile, default), "models");
    let rb = client().get(url);
    let rb = if is_anthropic {
        rb.header("x-api-key", profile.api_key.trim()).header("anthropic-version", "2023-06-01")
    } else {
        auth(rb, &profile.api_key)
    };
    let v: Value = check(rb.send().await?).await?.json().await?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

/// Removes `<think>…</think>` blocks some local reasoning models emit inline.
pub fn strip_think(s: &str) -> String {
    let mut out = s.to_string();
    while let Some(start) = out.find("<think>") {
        match out[start..].find("</think>") {
            Some(end) => out.replace_range(start..start + end + "</think>".len(), ""),
            None => {
                out.truncate(start);
                break;
            }
        }
    }
    out
}
