//! Permission state the UI shows in onboarding and settings.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Permissions {
    pub accessibility: bool,
    /// "granted" | "denied" | "undetermined" | "unknown"
    pub microphone: String,
}

pub fn get() -> Permissions {
    Permissions { accessibility: handy_keys::check_accessibility(), microphone: microphone_status() }
}

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

/// Bundle ids of the processes currently capturing from an input device.
/// The caller decides which of them look like meeting apps.
pub fn mic_users() -> Vec<String> {
    use cidre::core_audio::System;
    let Ok(procs) = System::processes() else { return vec![] };
    let mut out = Vec::new();
    for p in procs {
        if !p.is_running_input().unwrap_or(false) {
            continue;
        }
        let Ok(bundle) = p.bundle_id() else { continue };
        let bundle = bundle.to_string();
        if !bundle.is_empty() && !out.contains(&bundle) {
            out.push(bundle);
        }
    }
    out
}
