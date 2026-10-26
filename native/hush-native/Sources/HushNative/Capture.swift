// Capture sessions: microphone or system audio, delivered as 16 kHz mono f32 and written to disk.
//
// Audio never travels over the JSON channel. A session writes raw little-endian f32 samples to a
// file and tells the parent about it:
//
// * `rotate_ms == 0`: one file at `path`, finished by `capture.stop`.
// * `rotate_ms > 0`: a new file `<path>.<seq>` roughly every `rotate_ms`; each finished file is
//   announced with a `capture.chunk` event and owned by the parent from then on (it deletes it
//   once consumed), so a long meeting never piles up on disk. The last, partial chunk is
//   announced before `capture.stop` replies.
//
// `capture.level` events (0..1) are pushed about 20 times a second.

import Foundation

public enum Source: String, Decodable {
    case mic
    case system
}

public struct StartParams: Decodable {
    public let id: String
    public let source: Source
    /// Input device name for the mic; the default device when absent.
    public let device: String?
    public let path: String
    public let rotateMs: Int?
}

struct ChunkEvent: Encodable {
    let id: String
    let seq: Int
    let path: String
    let samples: Int
}

struct LevelEvent: Encodable {
    let id: String
    let level: Float
}

/// Writes captured samples to the current file and announces finished chunks.
final class Sink {
    let id: String
    let base: String
    let rotateSamples: Int
    private(set) var seq = 0
    private var file: FileHandle?
    private var buffer = Data()
    private(set) var inFile = 0
    private(set) var total = 0
    private var lastLevel = Date.distantPast
    private let emitter: Emitter
    var error: String?

    init(id: String, base: String, rotateSamples: Int, emitter: Emitter) {
        self.id = id
        self.base = base
        self.rotateSamples = rotateSamples
        self.emitter = emitter
    }

    var filePath: String { rotateSamples == 0 ? base : "\(base).\(seq)" }

    func open() throws {
        let path = filePath
        guard FileManager.default.createFile(atPath: path, contents: nil),
            let f = FileHandle(forWritingAtPath: path)
        else {
            throw HushError("cannot write \(path): \(String(cString: strerror(errno)))")
        }
        file = f
        inFile = 0
    }

    private func flush() {
        guard let file, !buffer.isEmpty else { return }
        do {
            try file.write(contentsOf: buffer)
        } catch {
            if self.error == nil { self.error = "writing audio failed: \(error.localizedDescription)" }
        }
        buffer.removeAll(keepingCapacity: true)
    }

    /// Close the current file and, when rotating, announce it.
    func closeChunk() {
        guard let f = file else { return }
        flush()
        try? f.close()
        file = nil
        if rotateSamples > 0 {
            if inFile > 0 {
                emitter.emit("capture.chunk", ChunkEvent(id: id, seq: seq, path: filePath, samples: inFile))
            } else {
                try? FileManager.default.removeItem(atPath: filePath)
            }
            seq += 1
        }
    }

    func push(_ pcm: [Float]) {
        if error != nil || pcm.isEmpty { return }
        if file == nil {
            do {
                try open()
            } catch {
                self.error = message(of: error)
                return
            }
        }
        // Apple Silicon is little-endian, so the in-memory floats are the file format.
        pcm.withUnsafeBytes { buffer.append(contentsOf: $0) }
        if buffer.count >= 1 << 16 { flush() }
        inFile += pcm.count
        total += pcm.count
        if rotateSamples > 0 && inFile >= rotateSamples { closeChunk() }
        if Date().timeIntervalSince(lastLevel) >= 0.045 {
            lastLevel = Date()
            emitter.emit("capture.level", LevelEvent(id: id, level: level(pcm)))
        }
    }
}

private enum Backend {
    case mic(MicCapture)
    case system(SystemAudioCapture)

    func stop() {
        switch self {
        case .mic(let m): m.stop()
        case .system(let s): s.stop()
        }
    }
}

private struct Session {
    let backend: Backend
    let sink: Sink
    let lock: NSLock
}

public final class Captures: @unchecked Sendable {
    private var sessions: [String: Session] = [:]
    private var starting: Set<String> = []
    private let lock = NSLock()

    public init() {}

    /// Start a session. Returns once the device is running, which for the system tap can take as
    /// long as the permission prompt stays open.
    public func start(_ p: StartParams, emitter: Emitter) throws -> JSON {
        try lock.withLock {
            if sessions[p.id] != nil || starting.contains(p.id) {
                throw HushError("capture \(p.id) is already running")
            }
            starting.insert(p.id)
        }
        defer { _ = lock.withLock { starting.remove(p.id) } }

        let sink = Sink(
            id: p.id, base: p.path, rotateSamples: max(p.rotateMs ?? 0, 0) * sampleRate / 1000, emitter: emitter)
        try sink.open()
        let sinkLock = NSLock()
        let onAudio: AudioCallback = { pcm in sinkLock.withLock { sink.push(pcm) } }
        let backend: Backend
        var device: JSON = nil
        switch p.source {
        case .mic:
            let m = try MicCapture(device: p.device, onAudio: onAudio)
            device = .string(m.deviceName)
            backend = .mic(m)
        case .system:
            backend = .system(try SystemAudioCapture(onAudio: onAudio))
        }
        lock.withLock { sessions[p.id] = Session(backend: backend, sink: sink, lock: sinkLock) }
        return ["device": device, "sample_rate": .number(Double(sampleRate))]
    }

    /// Stop a session and wait until every captured sample is on disk.
    public func stop(_ id: String) throws -> JSON {
        guard let session = lock.withLock({ sessions.removeValue(forKey: id) }) else {
            throw HushError("no capture named \(id)")
        }
        // Joins the capture worker, which delivers the resampler tail first.
        session.backend.stop()
        return try session.lock.withLock {
            session.sink.closeChunk()
            if let e = session.sink.error {
                session.sink.error = nil
                throw HushError(e)
            }
            return ["samples": .number(Double(session.sink.total))]
        }
    }

    public func stopAll() {
        for id in lock.withLock({ Array(sessions.keys) }) {
            _ = try? stop(id)
        }
    }
}
