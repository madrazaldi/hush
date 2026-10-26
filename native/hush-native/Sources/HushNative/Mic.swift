// Microphone capture through an AUHAL input unit. The realtime callback (C) renders f32 frames,
// downmixes them and fills a ring; a `Pump` resamples to 16 kHz mono for the caller.

import AudioToolbox
import CHushAudio
import CoreAudio
import Foundation

public struct InputDevice: Encodable {
    public let name: String
    public let isDefault: Bool
}

private func inputChannels(_ device: AudioObjectID) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

private func inputDeviceIDs() -> [AudioObjectID] {
    let all =
        (try? arrayProperty(
            AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices, zero: AudioObjectID(0))) ?? []
    return all.filter { inputChannels($0) > 0 }
}

private func nameOf(_ device: AudioObjectID) -> String {
    (try? stringProperty(device, kAudioObjectPropertyName)) ?? ""
}

private func defaultInputDevice() -> AudioObjectID? {
    let id = try? property(
        AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice, default: AudioObjectID(0))
    guard let id, id != kAudioObjectUnknown else { return nil }
    return id
}

public func listInputDevices() -> [InputDevice] {
    let defaultName = defaultInputDevice().map(nameOf)
    return inputDeviceIDs()
        .map(nameOf)
        // Hide our own private tap aggregate devices.
        .filter { !$0.isEmpty && !$0.hasPrefix("Hush") }
        .map { InputDevice(name: $0, isDefault: $0 == defaultName) }
}

private func pickDevice(_ name: String?) throws -> AudioObjectID {
    if let want = name, !want.isEmpty {
        if let id = inputDeviceIDs().first(where: { nameOf($0) == want }) { return id }
        Log.warn("input device \"\(want)\" not found, using default")
    }
    guard let id = defaultInputDevice() else { throw HushError("No microphone found") }
    return id
}

private func setProperty<T: BitwiseCopyable>(
    _ unit: AudioUnit, _ id: AudioUnitPropertyID, _ scope: AudioUnitScope, _ element: AudioUnitElement, _ value: T
) -> OSStatus {
    var v = value
    return AudioUnitSetProperty(unit, id, scope, element, &v, UInt32(MemoryLayout<T>.size))
}

public final class MicCapture {
    public let deviceName: String
    private let unit: AudioUnit
    private let ctx: OpaquePointer
    private let pump: Pump
    private var stopped = false

    /// Start capturing. `onAudio` receives 16 kHz mono chunks on a worker thread. Returns once
    /// the device is actually running.
    public init(device: String?, onAudio: @escaping AudioCallback) throws {
        let id = try pickDevice(device)
        deviceName = nameOf(id)

        var desc = AudioComponentDescription(
            componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        guard let component = AudioComponentFindNext(nil, &desc) else {
            throw HushError("could not open microphone: no HAL output unit")
        }
        var maybeUnit: AudioUnit?
        try check(
            AudioComponentInstanceNew(component, &maybeUnit), "could not open microphone: AudioComponentInstanceNew")
        guard let unit = maybeUnit else { throw HushError("could not open microphone") }
        var ok = false
        defer { if !ok { AudioComponentInstanceDispose(unit) } }

        // Input on element 1, no output on element 0, bound to the chosen device.
        try check(
            setProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, UInt32(1)),
            "could not open microphone: enable input")
        try check(
            setProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, UInt32(0)),
            "could not open microphone: disable output")
        try check(
            setProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, id),
            "could not open microphone: select device")

        var hw = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(
            AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hw, &size),
            "mic config")
        let rate = Int(hw.mSampleRate.rounded())
        let channels = max(hw.mChannelsPerFrame, 1)
        guard rate > 0 else { throw HushError("mic config: the device reports no sample rate") }
        Log.debug("mic format: \(rate) Hz, \(channels) ch")

        // What the callback renders: f32 interleaved at the device's own rate.
        let client = AudioStreamBasicDescription(
            mSampleRate: hw.mSampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4 * channels, mFramesPerPacket: 1, mBytesPerFrame: 4 * channels,
            mChannelsPerFrame: channels, mBitsPerChannel: 32, mReserved: 0)
        try check(
            setProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, client),
            "could not open microphone: set format")

        let pump = try Pump(nativeRate: rate, onAudio: onAudio)
        var maxFrames: UInt32 = 4096
        size = UInt32(MemoryLayout<UInt32>.size)
        _ = AudioUnitGetProperty(
            unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, &size)
        guard let ctx = hush_mic_ctx_create(unit, pump.ring, channels, max(maxFrames, 8192)) else {
            throw HushError("out of memory")
        }
        var ctxOwned = false
        defer { if !ctxOwned { hush_mic_ctx_destroy(ctx) } }

        let callback = AURenderCallbackStruct(
            inputProc: hush_mic_input_proc, inputProcRefCon: UnsafeMutableRawPointer(ctx))
        try check(
            setProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, callback),
            "could not open microphone: set callback")
        try check(AudioUnitInitialize(unit), "could not open microphone")
        try check(AudioOutputUnitStart(unit), "could not start microphone")

        pump.start(name: "hush-mic") { AudioOutputUnitStop(unit) }
        self.unit = unit
        self.ctx = ctx
        self.pump = pump
        ok = true
        ctxOwned = true
    }

    /// Stop and wait until all captured audio has been delivered.
    public func stop() {
        guard !stopped else { return }
        stopped = true
        pump.stop()
        AudioUnitUninitialize(unit)
        AudioComponentInstanceDispose(unit)
        hush_mic_ctx_destroy(ctx)
    }

    deinit { stop() }
}
