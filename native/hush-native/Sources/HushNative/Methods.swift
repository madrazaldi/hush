// The RPC surface: one `switch` from method name to implementation.

import Foundation

/// Reported by `ping`; keep in step with package.json (scripts/version.ts checks).
public let helperVersion = "0.1.0"

private struct RunParams: Decodable {
    let job: String
    let model: String
    let path: String
    /// First sample and sample count within the raw f32 file; the whole file by default.
    let start: UInt64?
    let len: UInt64?
    let options: RunOptions?
}

private struct ModelParams: Decodable { let model: String }
private struct IDParams: Decodable { let id: String }
private struct JobParams: Decodable { let job: String }
private struct SpecParams: Decodable { let spec: String }
private struct EnabledParams: Decodable { let enabled: Bool }
private struct TextParams: Decodable { let text: String }
private struct PasteParams: Decodable {
    let text: String
    let restore: Bool?
}
private struct EnterParams: Decodable { let command: Bool? }
private struct BindParams: Decodable {
    struct Binding: Decodable {
        let action: Action
        let spec: String
    }
    let bindings: [Binding]
}

/// Read `len` samples starting at sample `start` from a raw little-endian f32 file.
public func readSamples(_ path: String, start: UInt64, len: UInt64?) throws -> [Float] {
    guard let f = FileHandle(forReadingAtPath: path) else {
        throw HushError("open \(path): \(String(cString: strerror(errno)))")
    }
    defer { try? f.close() }
    let total = try f.seekToEnd() / 4
    let start = min(start, total)
    let len = min(len ?? (total - start), total - start)
    try f.seek(toOffset: start * 4)
    let data = try f.read(upToCount: Int(len) * 4) ?? Data()
    guard data.count == Int(len) * 4 else { throw HushError("read \(path): file shrank while reading") }
    return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
}

public final class App: @unchecked Sendable {
    private let emitter: Emitter
    private let captures = Captures()
    private var hotkeysService: Hotkeys?
    private let lock = NSLock()

    public init(emitter: Emitter) {
        self.emitter = emitter
    }

    private func hotkeys() -> Hotkeys {
        lock.withLock {
            if let h = hotkeysService { return h }
            let emitter = self.emitter
            let h = Hotkeys { action, pressed in
                emitter.emit("hotkey", ["action": .string(action.rawValue), "pressed": .bool(pressed)] as JSON)
            }
            hotkeysService = h
            return h
        }
    }

    /// Stop everything that holds a device or a model. Also run when the parent goes away.
    public func cleanup() {
        captures.stopAll()
        STT.shutdown()
    }

    public func call(_ method: String, _ p: JSON) throws -> any Encodable {
        switch method {
        case "ping":
            return ["version": .string(helperVersion), "pid": .number(Double(getpid()))] as JSON
        case "shutdown":
            cleanup()
            // Let the reply reach the parent before exiting.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { exit(0) }
            return [:] as JSON

        case "permissions.get":
            return permissions()
        case "devices.list":
            return listInputDevices()
        case "audio.mic_users":
            return micUsers()

        case "capture.start":
            return try captures.start(params(p), emitter: emitter)
        case "capture.stop":
            return try captures.stop(params(p, as: IDParams.self).id)

        case "stt.info":
            return try STT.info(params(p, as: ModelParams.self).model)
        case "stt.preload":
            STT.preload(try params(p, as: ModelParams.self).model)
            return [:] as JSON
        case "stt.evict":
            STT.evict(try params(p, as: ModelParams.self).model)
            return [:] as JSON
        case "stt.cancel":
            STT.cancel(try params(p, as: JobParams.self).job)
            return [:] as JSON
        case "stt.run":
            let r = try params(p, as: RunParams.self)
            let pcm = try readSamples(r.path, start: r.start ?? 0, len: r.len)
            return try STT.run(job: r.job, model: r.model, pcm: pcm, options: r.options ?? RunOptions())

        case "hotkeys.bind":
            let b = try params(p, as: BindParams.self).bindings
            return hotkeys().bind(b.map { ($0.action, $0.spec) })
        case "hotkeys.validate":
            try validateHotkey(params(p, as: SpecParams.self).spec)
            return [:] as JSON
        case "hotkeys.set_cancel":
            hotkeys().setCancelEnabled(try params(p, as: EnabledParams.self).enabled)
            return [:] as JSON

        case "input.paste":
            let q = try params(p, as: PasteParams.self)
            return ["done": .bool(try Input.paste(q.text, restore: q.restore ?? false))] as JSON
        case "input.type":
            return ["done": .bool(try Input.type(params(p, as: TextParams.self).text))] as JSON
        case "input.enter":
            try Input.pressEnter(command: params(p, as: EnterParams.self).command ?? false)
            return [:] as JSON
        case "input.selected_text":
            return try Input.selectedText().map(JSON.string) ?? .null
        case "input.cancel":
            Input.cancel()
            return [:] as JSON

        default:
            throw HushError("unknown method \(method)")
        }
    }
}
