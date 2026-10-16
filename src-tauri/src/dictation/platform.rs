//! OS integration for dictation: inserting text into the focused app, reading
//! the selection, frontmost app info, feedback sounds and permissions.

use std::time::Duration;

use anyhow::{Result, anyhow};
use enigo::{Direction, Enigo, Keyboard, Settings as EnigoSettings};
use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
pub struct FrontApp {
    pub name: String,
    pub bundle_id: String,
}

fn enigo() -> Result<Enigo> {
    Enigo::new(&EnigoSettings::default()).map_err(|e| anyhow!("input simulation unavailable: {e}"))
}

/// Press a modifier + key chord, holding it briefly so slow apps don't drop it.
fn chord(modifier: enigo::Key, key: enigo::Key) -> Result<()> {
    let mut e = enigo()?;
    e.key(modifier, Direction::Press)?;
    std::thread::sleep(Duration::from_millis(15));
    e.key(key, Direction::Click)?;
    std::thread::sleep(Duration::from_millis(60));
    e.key(modifier, Direction::Release)?;
    Ok(())
}

#[cfg(target_os = "macos")]
const PRIMARY: enigo::Key = enigo::Key::Meta;
#[cfg(not(target_os = "macos"))]
const PRIMARY: enigo::Key = enigo::Key::Control;

pub fn press_paste() -> Result<()> {
    chord(PRIMARY, enigo::Key::Unicode('v'))
}

pub fn press_copy() -> Result<()> {
    chord(PRIMARY, enigo::Key::Unicode('c'))
}

pub fn press_enter(with_primary: bool) -> Result<()> {
    if with_primary {
        chord(PRIMARY, enigo::Key::Return)
    } else {
        let mut e = enigo()?;
        e.key(enigo::Key::Return, Direction::Click)?;
        Ok(())
    }
}

pub fn type_text(text: &str) -> Result<()> {
    let mut e = enigo()?;
    // Typing very long strings in one call can drop characters in some apps.
    for chunk in text.chars().collect::<Vec<_>>().chunks(64) {
        let s: String = chunk.iter().collect();
        e.text(&s)?;
        std::thread::sleep(Duration::from_millis(8));
    }
    Ok(())
}

/// Insert text by pasting through the clipboard, restoring the previous
/// clipboard afterwards unless the user changed it in the meantime.
pub fn paste_text(text: &str, restore: bool) -> Result<()> {
    let snapshot = if restore { clipboard::snapshot() } else { None };
    let change = clipboard::set_text(text, true)?;
    std::thread::sleep(Duration::from_millis(40));
    press_paste()?;
    if let Some(snap) = snapshot {
        // Give the target app time to read the pasteboard before restoring.
        std::thread::sleep(Duration::from_millis(350));
        if clipboard::change_count() == change {
            clipboard::restore(snap);
        }
    }
    Ok(())
}

/// Copy the current selection in the focused app (via ⌘C), restoring the clipboard.
pub fn selected_text() -> Option<String> {
    let snap = clipboard::snapshot();
    let before = clipboard::change_count();
    press_copy().ok()?;
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
    text.filter(|t| !t.trim().is_empty())
}

pub fn copy_text(text: &str) -> Result<()> {
    clipboard::set_text(text, false).map(|_| ())
}

#[cfg(target_os = "macos")]
mod clipboard {
    use anyhow::Result;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeString};
    use objc2_foundation::{NSArray, NSData, NSString};

    pub struct Snapshot(Vec<Vec<(Retained<NSString>, Retained<NSData>)>>);

    fn pb() -> Retained<NSPasteboard> {
        NSPasteboard::generalPasteboard()
    }

    pub fn change_count() -> isize {
        pb().changeCount()
    }

    pub fn snapshot() -> Option<Snapshot> {
        let pb = pb();
        let items = pb.pasteboardItems()?;
        let mut out = Vec::new();
        for item in items.iter() {
            let mut entries = Vec::new();
            for ty in item.types().iter() {
                if let Some(data) = item.dataForType(&ty) {
                    entries.push((ty.clone(), data));
                }
            }
            out.push(entries);
        }
        Some(Snapshot(out))
    }

    pub fn restore(snap: Snapshot) {
        let pb = pb();
        pb.clearContents();
        if snap.0.is_empty() {
            return;
        }
        let items: Vec<Retained<NSPasteboardItem>> = snap
            .0
            .into_iter()
            .map(|entries| {
                let item = NSPasteboardItem::new();
                for (ty, data) in entries {
                    item.setData_forType(&data, &ty);
                }
                item
            })
            .collect();
        let refs: Vec<&objc2::runtime::ProtocolObject<dyn objc2_app_kit::NSPasteboardWriting>> =
            items.iter().map(|i| objc2::runtime::ProtocolObject::from_ref(&**i)).collect();
        let arr = NSArray::from_slice(&refs);
        pb.writeObjects(&arr);
    }

    /// Put text on the pasteboard. `transient` marks it so clipboard managers skip it.
    pub fn set_text(text: &str, transient: bool) -> Result<isize> {
        let pb = pb();
        pb.clearContents();
        let item = NSPasteboardItem::new();
        let s = NSString::from_str(text);
        unsafe {
            item.setString_forType(&s, NSPasteboardTypeString);
        }
        if transient {
            let marker = NSData::new();
            for ty in ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType", "org.nspasteboard.AutoGeneratedType"] {
                item.setData_forType(&marker, &NSString::from_str(ty));
            }
        }
        let proto = objc2::runtime::ProtocolObject::from_ref(&*item);
        pb.writeObjects(&NSArray::from_slice(&[proto]));
        Ok(pb.changeCount())
    }

    pub fn get_text() -> Option<String> {
        unsafe { pb().stringForType(NSPasteboardTypeString) }.map(|s| s.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod clipboard {
    use anyhow::Result;
    pub struct Snapshot(String);
    pub fn change_count() -> isize {
        0
    }
    pub fn snapshot() -> Option<Snapshot> {
        None
    }
    pub fn restore(_: Snapshot) {}
    pub fn set_text(_text: &str, _transient: bool) -> Result<isize> {
        anyhow::bail!("clipboard paste not supported on this platform; use typing")
    }
    pub fn get_text() -> Option<String> {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn front_app() -> FrontApp {
    use objc2_app_kit::NSWorkspace;
    let ws = NSWorkspace::sharedWorkspace();
    match ws.frontmostApplication() {
        Some(app) => FrontApp {
            name: app.localizedName().map(|s| s.to_string()).unwrap_or_default(),
            bundle_id: app.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default(),
        },
        None => FrontApp::default(),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn front_app() -> FrontApp {
    FrontApp::default()
}

#[derive(Debug, Clone, Copy)]
pub enum Sound {
    Start,
    Stop,
    Cancel,
    Error,
}

#[cfg(target_os = "macos")]
pub fn play(sound: Sound) {
    use objc2_app_kit::NSSound;
    use objc2_foundation::NSString;
    let name = match sound {
        Sound::Start => "Tink",
        Sound::Stop => "Pop",
        Sound::Cancel => "Bottle",
        Sound::Error => "Basso",
    };
    if let Some(s) = NSSound::soundNamed(&NSString::from_str(name)) {
        s.setVolume(0.35);
        s.play();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn play(_sound: Sound) {}

/// Mute/unmute system output. Returns the previous muted state.
#[cfg(target_os = "macos")]
pub fn set_output_muted(muted: bool) -> Option<bool> {
    let prev = std::process::Command::new("osascript")
        .args(["-e", "output muted of (get volume settings)"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true");
    let _ = std::process::Command::new("osascript")
        .args(["-e", &format!("set volume output muted {muted}")])
        .status();
    prev
}

#[cfg(not(target_os = "macos"))]
pub fn set_output_muted(_muted: bool) -> Option<bool> {
    None
}

#[derive(Debug, Clone, Serialize)]
pub struct Permissions {
    pub accessibility: bool,
    pub microphone: String,
    pub system_audio_supported: bool,
}

pub fn permissions() -> Permissions {
    Permissions {
        accessibility: accessibility_granted(),
        microphone: microphone_status(),
        system_audio_supported: system_audio_supported(),
    }
}

#[cfg(target_os = "macos")]
fn system_audio_supported() -> bool {
    crate::audio::system_macos::is_supported()
}
#[cfg(not(target_os = "macos"))]
fn system_audio_supported() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn accessibility_granted() -> bool {
    handy_keys::check_accessibility()
}
#[cfg(not(target_os = "macos"))]
pub fn accessibility_granted() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn microphone_status() -> String {
    use cidre::av;
    match av::CaptureDevice::authorization_status_for_media_type(av::MediaType::audio()) {
        Ok(av::AuthorizationStatus::Authorized) => "granted",
        Ok(av::AuthorizationStatus::Denied) | Ok(av::AuthorizationStatus::Restricted) => "denied",
        Ok(av::AuthorizationStatus::NotDetermined) => "undetermined",
        _ => "unknown",
    }
    .into()
}
#[cfg(not(target_os = "macos"))]
fn microphone_status() -> String {
    "granted".into()
}

/// Open a System Settings privacy pane.
pub fn open_privacy_pane(pane: &str) {
    #[cfg(target_os = "macos")]
    {
        let anchor = match pane {
            "accessibility" => "Privacy_Accessibility",
            "microphone" => "Privacy_Microphone",
            "system_audio" => "Privacy_AudioCapture",
            "input_monitoring" => "Privacy_ListenEvent",
            _ => "Privacy",
        };
        let _ = std::process::Command::new("open")
            .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pane;
}
