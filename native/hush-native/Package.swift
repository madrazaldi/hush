// swift-tools-version: 6.0
//
// hush-native: the native helper behind Hush (audio capture, on-device speech-to-text, global
// hotkeys, paste). transcribe.cpp is built with CMake by `scripts/build-native.ts` and installed
// into vendor/transcribe, which this manifest links against.

import PackageDescription

let vendor = Context.packageDirectory + "/vendor/transcribe"

let package = Package(
    name: "hush-native",
    platforms: [.macOS("14.2")],
    products: [
        .executable(name: "hush-native", targets: ["hush-native"])
    ],
    targets: [
        // transcribe.cpp's C API (header and static libraries in vendor/transcribe).
        .systemLibrary(name: "CTranscribe", path: "Sources/CTranscribe"),
        // Realtime audio callbacks and the lock-free ring they feed; kept in C so the
        // Core Audio threads never touch Swift reference counting or allocation.
        .target(name: "CHushAudio", path: "Sources/CHushAudio"),
        .target(
            name: "HushNative",
            dependencies: ["CTranscribe", "CHushAudio"],
            path: "Sources/HushNative",
            linkerSettings: [
                .unsafeFlags(["-L\(vendor)/lib"]),
                .linkedFramework("Accelerate"),
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("Foundation"),
                .linkedFramework("Metal"),
                .linkedFramework("MetalKit"),
            ]
        ),
        .executableTarget(name: "hush-native", dependencies: ["HushNative"], path: "Sources/hush-native"),
        .testTarget(name: "HushNativeTests", dependencies: ["HushNative"], path: "Tests/HushNativeTests"),
    ],
    swiftLanguageModes: [.v5]
)
