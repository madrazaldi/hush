// Small typed wrappers over the Core Audio HAL property API.

import CoreAudio
import Foundation

func address(
    _ selector: AudioObjectPropertySelector,
    _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr { throw HushError("\(what) failed (OSStatus \(status))") }
}

/// A fixed-size property value.
func property<T: BitwiseCopyable>(
    _ object: AudioObjectID,
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    default value: T
) throws -> T {
    var addr = address(selector, scope)
    var out = value
    var size = UInt32(MemoryLayout<T>.size)
    try check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &out), "reading audio property")
    return out
}

/// An array property (device or process lists).
func arrayProperty<T: BitwiseCopyable>(
    _ object: AudioObjectID,
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    zero: T
) throws -> [T] {
    var addr = address(selector, scope)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size), "reading audio property size")
    var out = [T](repeating: zero, count: Int(size) / MemoryLayout<T>.stride)
    if out.isEmpty { return [] }
    try check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &out), "reading audio property")
    return Array(out.prefix(Int(size) / MemoryLayout<T>.stride))
}

/// A CFString property.
func stringProperty(
    _ object: AudioObjectID,
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) throws -> String {
    var addr = address(selector, scope)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    try check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value), "reading audio property")
    return value?.takeRetainedValue() as String? ?? ""
}
