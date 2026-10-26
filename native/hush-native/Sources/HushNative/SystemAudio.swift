// macOS system-audio capture via Core Audio process taps (macOS 14.2+).
//
// A global mono tap (excluding no processes) is attached to a private aggregate device. The
// aggregate device's IO proc (C, realtime-safe) downmixes whatever the tap delivers to mono f32
// and pushes it into a lock-free ring. A `Pump` drains the ring, resamples to 16 kHz and calls the
// user callback. Stopping tears everything down in the right order (stop device, destroy IO proc,
// destroy aggregate device, destroy tap).

import CHushAudio
import CoreAudio
import Foundation

/// Whether the OS supports process taps (macOS >= 14.2).
public func systemAudioSupported() -> Bool {
    ProcessInfo.processInfo.isOperatingSystemAtLeast(
        OperatingSystemVersion(majorVersion: 14, minorVersion: 2, patchVersion: 0))
}

/// Captures all system output audio as 16 kHz mono f32.
public final class SystemAudioCapture {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var ctx: OpaquePointer?
    private var pump: Pump?
    private var stopped = false

    /// Start capturing all system output audio. `onAudio` receives 16 kHz mono chunks (any size)
    /// on a background (non-realtime) thread.
    public init(onAudio: @escaping AudioCallback) throws {
        guard systemAudioSupported() else {
            throw HushError("system audio capture requires macOS 14.2 or later")
        }
        do {
            try build(onAudio)
        } catch {
            teardown()
            throw error
        }
    }

    private func build(_ onAudio: @escaping AudioCallback) throws {
        // Global mono tap that excludes nothing => everything that plays out.
        let desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        try check(AudioHardwareCreateProcessTap(desc, &tap), "create process tap")
        let tapUID = try stringProperty(tap, kAudioTapPropertyUID)
        let asbd = try property(tap, kAudioTapPropertyFormat, default: AudioStreamBasicDescription())

        let rate = Int(asbd.mSampleRate.rounded())
        guard rate > 0 else { throw HushError("tap reported a zero sample rate") }
        let format = hush_format(
            channels: max(asbd.mChannelsPerFrame, 1),
            interleaved: asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0,
            is_float: asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
            bits: asbd.mBitsPerChannel == 0 ? 32 : asbd.mBitsPerChannel)
        Log.debug(
            "system tap format: \(rate) Hz, \(format.channels) ch, \(format.bits) bit, float=\(format.is_float), interleaved=\(format.interleaved)"
        )

        var dict: [String: Any] = [
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceNameKey: "Hush System Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID]],
        ]
        // Use the default output device as clock source (if there is one).
        if let output = try? property(
            AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice,
            default: AudioObjectID(0)),
            output != kAudioObjectUnknown,
            let outputUID = try? stringProperty(output, kAudioDevicePropertyDeviceUID)
        {
            dict[kAudioAggregateDeviceMainSubDeviceKey] = outputUID
            dict[kAudioAggregateDeviceSubDeviceListKey] = [[kAudioSubDeviceUIDKey: outputUID]]
        }
        try check(AudioHardwareCreateAggregateDevice(dict as CFDictionary, &aggregate), "create aggregate device")

        let pump = try Pump(nativeRate: rate, onAudio: onAudio)
        self.pump = pump
        guard let ctx = hush_io_ctx_create(pump.ring, format) else { throw HushError("out of memory") }
        self.ctx = ctx
        try check(
            AudioDeviceCreateIOProcID(aggregate, hush_device_io_proc, UnsafeMutableRawPointer(ctx), &procID),
            "create IO proc")
        try check(AudioDeviceStart(aggregate, procID), "start aggregate device")

        let (aggregate, procID) = (aggregate, procID)
        pump.start(name: "hush-system-audio") { AudioDeviceStop(aggregate, procID) }
    }

    /// Stop capturing (also happens on deinit). Idempotent.
    public func stop() {
        guard !stopped else { return }
        stopped = true
        // Stops the hardware first so no more samples arrive, flushes what is left, then
        // destroys everything.
        pump?.stop()
        teardown()
    }

    private func teardown() {
        if let procID {
            AudioDeviceStop(aggregate, procID)
            AudioDeviceDestroyIOProcID(aggregate, procID)
            self.procID = nil
        }
        if aggregate != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregate)
            aggregate = AudioObjectID(kAudioObjectUnknown)
        }
        if tap != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tap)
            tap = AudioObjectID(kAudioObjectUnknown)
        }
        if let ctx {
            hush_io_ctx_destroy(ctx)
            self.ctx = nil
        }
        pump = nil
    }

    deinit { stop() }
}
