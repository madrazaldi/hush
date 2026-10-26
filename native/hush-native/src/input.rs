//! Text insertion into the focused app: paste through the clipboard (restoring
//! it afterwards), typed keystrokes, Return, and reading the current selection.
//!
//! Keystrokes are synthesized with Core Graphics events using fixed virtual key
//! codes. That deliberately avoids anything that resolves keys through Text
//! Input Sources (which macOS asserts must run on the main queue), so every
//! function here is safe to call from any thread.
//!
//! Electrobun's clipboard API only reads and writes plain text, so the
//! pasteboard work (snapshot of every type, change count, "transient" markers
//! for clipboard managers) stays here too.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow};

use crate::pasteboard as clipboard;

/// Bumped by `input.cancel`. Every insertion remembers the value it started
/// with and stops as soon as it changes.
static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);

pub fn cancel() {
    CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
}

/// A cheap "has this insertion been cancelled?" probe.
fn watcher() -> impl Fn() -> bool {
    let start = CANCEL_GEN.load(Ordering::SeqCst);
    move || CANCEL_GEN.load(Ordering::SeqCst) != start
}

// ---- Core Graphics event synthesis ----

type CGEventRef = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateKeyboardEvent(source: *const c_void, keycode: u16, key_down: bool) -> CGEventRef;
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGEventKeyboardSetUnicodeString(event: CGEventRef, len: usize, chars: *const u16);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
}

const HID_EVENT_TAP: u32 = 0;
const FLAG_COMMAND: u64 = 0x0010_0000;

const KEY_COMMAND: u16 = 55;
const KEY_C: u16 = 8;
const KEY_V: u16 = 9;
const KEY_RETURN: u16 = 36;
const KEY_TAB: u16 = 48;

/// Post one key event. `unicode` overrides the character the key produces
/// (used for typing text that has no physical key).
fn post_key(keycode: u16, down: bool, flags: u64, unicode: Option<&[u16]>) -> Result<()> {
    // SAFETY: the event is created, configured, posted and released here and never shared.
    unsafe {
        let ev = CGEventCreateKeyboardEvent(std::ptr::null(), keycode, down);
        if ev.is_null() {
            return Err(anyhow!("input simulation unavailable"));
        }
        CGEventSetFlags(ev, flags);
        if let Some(u) = unicode {
            CGEventKeyboardSetUnicodeString(ev, u.len(), u.as_ptr());
        }
        CGEventPost(HID_EVENT_TAP, ev);
        CFRelease(ev as *const c_void);
    }
    Ok(())
}

fn click(keycode: u16, flags: u64) -> Result<()> {
    post_key(keycode, true, flags, None)?;
    post_key(keycode, false, flags, None)
}

/// Press ⌘ + `key`, holding it briefly so slow apps don't drop it.
fn command_chord(key: u16) -> Result<()> {
    post_key(KEY_COMMAND, true, FLAG_COMMAND, None)?;
    std::thread::sleep(Duration::from_millis(15));
    click(key, FLAG_COMMAND)?;
    std::thread::sleep(Duration::from_millis(60));
    post_key(KEY_COMMAND, false, 0, None)
}

pub fn press_enter(with_command: bool) -> Result<()> {
    if with_command { command_chord(KEY_RETURN) } else { click(KEY_RETURN, 0) }
}

/// Type text as keystrokes. Cancellation is checked between chunks so Escape
/// can stop a long insertion part-way. Returns whether everything was typed.
pub fn type_text(text: &str) -> Result<bool> {
    let cancelled = watcher();
    // Typing very long strings in one go can drop characters in some apps.
    let chars: Vec<char> = text.chars().collect();
    for chunk in chars.chunks(64) {
        if cancelled() {
            return Ok(false);
        }
        let mut run: Vec<u16> = Vec::new();
        let flush = |run: &mut Vec<u16>| -> Result<()> {
            // CGEventKeyboardSetUnicodeString carries at most 20 UTF-16 units per event.
            for part in run.chunks(20) {
                post_key(0, true, 0, Some(part))?;
                post_key(0, false, 0, Some(part))?;
            }
            run.clear();
            Ok(())
        };
        for c in chunk {
            match c {
                '\n' | '\r' => {
                    flush(&mut run)?;
                    click(KEY_RETURN, 0)?;
                }
                '\t' => {
                    flush(&mut run)?;
                    click(KEY_TAB, 0)?;
                }
                c => {
                    let mut buf = [0u16; 2];
                    run.extend_from_slice(c.encode_utf16(&mut buf));
                }
            }
        }
        flush(&mut run)?;
        std::thread::sleep(Duration::from_millis(8));
    }
    Ok(true)
}

/// Insert text by pasting through the clipboard, restoring the previous
/// clipboard afterwards unless the user changed it in the meantime.
/// Cancellation is checked right before ⌘V, after the pasteboard settles.
/// Returns whether ⌘V was pressed.
pub fn paste_text(text: &str, restore: bool) -> Result<bool> {
    let cancelled = watcher();
    let snapshot = if restore { clipboard::snapshot() } else { None };
    let change = clipboard::set_text(text, true);
    std::thread::sleep(Duration::from_millis(40));
    if cancelled() {
        if let Some(snap) = snapshot
            && clipboard::change_count() == change
        {
            clipboard::restore(snap);
        }
        return Ok(false);
    }
    command_chord(KEY_V)?;
    if let Some(snap) = snapshot {
        // Give the target app time to read the pasteboard before restoring.
        std::thread::sleep(Duration::from_millis(350));
        if clipboard::change_count() == change {
            clipboard::restore(snap);
        }
    }
    Ok(true)
}

/// Copy the current selection in the focused app (via ⌘C), restoring the clipboard.
pub fn selected_text() -> Result<Option<String>> {
    let snap = clipboard::snapshot();
    let before = clipboard::change_count();
    command_chord(KEY_C)?;
    let mut text = None;
    for _ in 0..12 {
        std::thread::sleep(Duration::from_millis(25));
        if clipboard::change_count() != before {
            text = clipboard::get_text();
            break;
        }
    }
    if let Some(s) = snap {
        clipboard::restore(s);
    }
    Ok(text.filter(|t| !t.trim().is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_trips_only_watchers_created_before_it() {
        let before = watcher();
        assert!(!before());
        cancel();
        assert!(before());
        let after = watcher();
        assert!(!after());
    }
}
