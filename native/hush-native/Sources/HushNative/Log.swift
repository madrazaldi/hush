// Logging to stderr only; stdout is the protocol channel. The level comes from HUSH_NATIVE_LOG
// (error, warn, info, debug), info by default.

import Foundation

public enum Log {
    enum Level: Int, Comparable {
        case error, warn, info, debug

        static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
    }

    static let level: Level = {
        switch ProcessInfo.processInfo.environment["HUSH_NATIVE_LOG"]?.lowercased() {
        case "error": .error
        case "warn": .warn
        case "debug", "trace": .debug
        default: .info
        }
    }()

    private static let lock = NSLock()

    public static func error(_ message: @autoclosure () -> String) { write(.error, message) }
    public static func warn(_ message: @autoclosure () -> String) { write(.warn, message) }
    public static func info(_ message: @autoclosure () -> String) { write(.info, message) }
    public static func debug(_ message: @autoclosure () -> String) { write(.debug, message) }

    private static func write(_ lvl: Level, _ message: () -> String) {
        guard lvl <= level else { return }
        let name = ["ERROR", "WARN", "INFO", "DEBUG"][lvl.rawValue]
        let line = "[\(Date().ISO8601Format()) \(name) hush_native] \(message())\n"
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardError.write(Data(line.utf8))
    }
}
