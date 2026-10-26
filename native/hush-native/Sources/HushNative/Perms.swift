// Permission state the UI shows in onboarding and settings.

import AVFoundation
import ApplicationServices
import CoreAudio
import Foundation

public struct Permissions: Encodable {
    public let accessibility: Bool
    /// "granted" | "denied" | "undetermined" | "unknown"
    public let microphone: String
    public let systemAudioSupported: Bool
}

public func permissions() -> Permissions {
    Permissions(
        accessibility: AXIsProcessTrusted(), microphone: microphoneStatus(),
        systemAudioSupported: systemAudioSupported())
}

private func microphoneStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: "granted"
    case .denied, .restricted: "denied"
    case .notDetermined: "undetermined"
    @unknown default: "unknown"
    }
}

/// Bundle ids of the processes currently capturing from an input device. The caller decides which
/// of them look like meeting apps.
public func micUsers() -> [String] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard let procs = try? arrayProperty(system, kAudioHardwarePropertyProcessObjectList, zero: AudioObjectID(0)) else {
        return []
    }
    var out: [String] = []
    for p in procs {
        guard (try? property(p, kAudioProcessPropertyIsRunningInput, default: UInt32(0))) ?? 0 != 0,
            let bundle = try? stringProperty(p, kAudioProcessPropertyBundleID),
            !bundle.isEmpty, !out.contains(bundle)
        else { continue }
        out.append(bundle)
    }
    return out
}
