//! hush-native: the small native sidecar behind Hush.
//!
//! Everything that is not plain TypeScript lives here: audio capture (microphone
//! and the Core Audio system tap), on-device speech-to-text through ggml/Metal,
//! global hotkeys (CGEventTap) and synthesizing paste/typing into the focused
//! app. It speaks newline-delimited JSON-RPC over stdio (see [`rpc`]).

pub mod audio;
pub mod capture;
pub mod hotkeys;
pub mod input;
pub mod methods;
pub mod mic;
pub mod pasteboard;
pub mod perms;
pub mod rpc;
pub mod stt;
pub mod system;
