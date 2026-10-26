// On-device transcription via transcribe.cpp (ggml, Metal on Apple Silicon).
//
// This is deliberately thin: it loads models, keeps the most recent two warm (loading a 700 MB
// GGUF takes a second or two, which would ruin dictation latency) and runs one chunk of audio at a
// time. Chunking, option policy and segment post-processing live on the Bun side.

import CTranscribe
import Foundation

/// Per-run options chosen by the caller.
public struct RunOptions: Decodable {
    /// ISO-639-1 code, or nil for auto-detect.
    public var language: String?
    /// Translate to English (Whisper-family only).
    public var translate = false
    /// Custom vocabulary / key terms to bias recognition.
    public var vocabulary: [String] = []
    /// Free-form context prompt.
    public var prompt: String?

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        language = try c.decodeIfPresent(String.self, forKey: .language)
        translate = try c.decodeIfPresent(Bool.self, forKey: .translate) ?? false
        vocabulary = try c.decodeIfPresent([String].self, forKey: .vocabulary) ?? []
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
    }

    enum CodingKeys: String, CodingKey { case language, translate, vocabulary, prompt }
}

public struct RawWord: Encodable {
    public let t0Ms: Int64
    public let t1Ms: Int64
    public let text: String
}

public struct RawSegment: Encodable {
    public let t0Ms: Int64
    public let t1Ms: Int64
    public let text: String
    public let speakerId: Int64
    public let firstWord: Int64
    public let nWords: Int64
}

/// What the engine produced for one chunk, before any post-processing.
public struct RawTranscript: Encodable {
    public let text: String
    public let language: String?
    public let segments: [RawSegment]
    public let words: [RawWord]

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        // Always present, null when unknown.
        try c.encode(language, forKey: .language)
        try c.encode(segments, forKey: .segments)
        try c.encode(words, forKey: .words)
    }

    enum CodingKeys: String, CodingKey { case text, language, segments, words }
}

public struct SttInfo: Encodable {
    public let arch: String
    public let backend: String
    /// Longest audio the model takes in one call, if it reports a limit.
    public let maxAudioMs: Int64?
    public let languages: [String]

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(arch, forKey: .arch)
        try c.encode(backend, forKey: .backend)
        try c.encode(maxAudioMs, forKey: .maxAudioMs)
        try c.encode(languages, forKey: .languages)
    }

    enum CodingKeys: String, CodingKey { case arch, backend, maxAudioMs, languages }
}

private func str(_ p: UnsafePointer<CChar>?) -> String {
    p.map { String(cString: $0) } ?? ""
}

private func statusMessage(_ status: transcribe_status, _ context: String) -> String {
    let code = Int32(bitPattern: status.rawValue)
    return "\(context): \(str(transcribe_status_string(code))) (status \(code))"
}

/// Set by `cancel`, polled by transcribe.cpp between decode steps.
final class CancelToken {
    private var flag = false
    private let lock = NSLock()

    func cancel() { lock.withLock { flag = true } }
    var isCancelled: Bool { lock.withLock { flag } }
}

private struct Capabilities {
    var languages: [String] = []
    var supportsTranslate = false
}

/// A loaded model plus a reusable session. The session is guarded by its own lock; one chunk
/// runs on it at a time.
final class Loaded {
    let key: String
    let model: OpaquePointer
    let session: OpaquePointer
    let sessionLock = NSLock()

    init(path: String) throws {
        var params = transcribe_model_load_params()
        transcribe_model_load_params_init(&params)
        var model: OpaquePointer?
        let status = transcribe_model_load_file(path, &params, &model)
        guard status == TRANSCRIBE_OK, let model else {
            throw HushError("failed to load model: \(statusMessage(status, "load \(path)"))")
        }
        var sp = transcribe_session_params()
        transcribe_session_params_init(&sp)
        var session: OpaquePointer?
        let st = transcribe_session_init(model, &sp, &session)
        guard st == TRANSCRIBE_OK, let session else {
            transcribe_model_free(model)
            throw HushError("failed to create session: \(statusMessage(st, "session init"))")
        }
        key = path
        self.model = model
        self.session = session
    }

    deinit {
        transcribe_session_free(session)
        transcribe_model_free(model)
    }

    fileprivate var capabilities: Capabilities? {
        var caps = transcribe_capabilities()
        transcribe_capabilities_init(&caps)
        guard transcribe_model_get_capabilities(model, &caps) == TRANSCRIBE_OK else { return nil }
        var out = Capabilities(supportsTranslate: caps.supports_translate)
        if let langs = caps.languages {
            for i in 0..<Int(max(caps.n_languages, 0)) { out.languages.append(str(langs[i])) }
        }
        return out
    }

    func supports(_ feature: transcribe_feature) -> Bool { transcribe_model_supports(model, feature) }
}

/// Owns every C string handed to a run until it returns.
private final class CStrings {
    private var owned: [UnsafeMutablePointer<CChar>] = []

    func add(_ s: String) -> UnsafePointer<CChar> {
        let p = strdup(s)!
        owned.append(p)
        return UnsafePointer(p)
    }

    deinit { owned.forEach { free($0) } }
}

public enum STT {
    private static let cacheSize = 2
    private static var cache: [Loaded] = []
    /// Cancel tokens of runs in flight, keyed by the caller's job id, so a cancel request (and
    /// `shutdown`) can stop them.
    private static var running: [String: CancelToken] = [:]
    /// Model loads and engine runs in progress; `shutdown` waits for them.
    private static var inFlight = 0
    private static var shuttingDown = false
    private static let lock = NSLock()

    /// Counts a blocking engine call as in flight for its whole duration.
    private static func whileInFlight<T>(_ body: () throws -> T) rethrows -> T {
        lock.withLock { inFlight += 1 }
        defer { lock.withLock { inFlight -= 1 } }
        return try body()
    }

    static func load(_ path: String) throws -> Loaded {
        try whileInFlight {
            let cached: Loaded? = try lock.withLock {
                if shuttingDown { throw HushError("Hush is quitting") }
                guard let pos = cache.firstIndex(where: { $0.key == path }) else { return nil }
                let l = cache.remove(at: pos)
                cache.insert(l, at: 0)
                return l
            }
            if let cached { return cached }
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else {
                throw HushError("model file not found: \(path)")
            }
            Log.info("loading local model \(path)")
            let loaded = try Loaded(path: path)
            return try lock.withLock {
                // Don't repopulate the cache after `shutdown` cleared it.
                if shuttingDown { throw HushError("Hush is quitting") }
                cache.insert(loaded, at: 0)
                if cache.count > cacheSize { cache.removeLast(cache.count - cacheSize) }
                return loaded
            }
        }
    }

    /// Load a model and report what it can do.
    public static func info(_ path: String) throws -> SttInfo {
        let l = try load(path)
        var limits = transcribe_session_limits()
        transcribe_session_limits_init(&limits)
        let maxAudio: Int64? = l.sessionLock.withLock {
            transcribe_session_get_limits(l.session, &limits) == TRANSCRIBE_OK && limits.effective_max_audio_ms > 0
                ? limits.effective_max_audio_ms : nil
        }
        return SttInfo(
            arch: str(transcribe_model_arch_string(l.model)), backend: str(transcribe_model_backend(l.model)),
            maxAudioMs: maxAudio, languages: l.capabilities?.languages ?? [])
    }

    /// Load a model ahead of time (e.g. when the dictation hotkey goes down).
    public static func preload(_ path: String) {
        Thread.detachNewThread {
            do {
                _ = try load(path)
            } catch {
                Log.warn("preload \(path): \(message(of: error))")
            }
        }
    }

    public static func evict(_ path: String) {
        lock.withLock { cache.removeAll { $0.key == path } }
    }

    /// Abort the run in flight for `job`, if any.
    public static func cancel(_ job: String) {
        lock.withLock { running[job] }?.cancel()
    }

    /// Release every loaded model. Must run before process exit: ggml's Metal backend asserts if
    /// buffers are still alive when its static teardown runs.
    public static func shutdown() {
        let tokens = lock.withLock {
            shuttingDown = true
            return Array(running.values)
        }
        tokens.forEach { $0.cancel() }
        // Aborted runs return between decode steps and model loads can't be interrupted; give
        // both a moment to finish.
        let deadline = Date().addingTimeInterval(5)
        while lock.withLock({ inFlight }) > 0 && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        lock.withLock { cache.removeAll() }
    }

    /// Run one chunk of 16 kHz mono audio on the model's shared session. The session is locked per
    /// chunk, so a dictation can slip in between the chunks of a long file instead of waiting for
    /// all of it.
    public static func run(job: String, model path: String, pcm: [Float], options: RunOptions) throws -> RawTranscript {
        let token = CancelToken()
        lock.withLock { running[job] = token }
        defer { lock.withLock { if running[job] === token { running[job] = nil } } }

        let loaded = try load(path)
        return try whileInFlight {
            if token.isCancelled { throw HushError("Cancelled") }
            loaded.sessionLock.lock()
            defer { loaded.sessionLock.unlock() }
            // Checked again: the session may have been busy (another job) while we waited.
            if token.isCancelled { throw HushError("Cancelled") }

            let strings = CStrings()
            var params = runParams(loaded, options, strings)
            var vocab = options.vocabulary.map { Optional(strings.add($0)) }
            let abort: transcribe_abort_callback = { data in
                Unmanaged<CancelToken>.fromOpaque(data!).takeUnretainedValue().isCancelled
            }
            transcribe_set_abort_callback(loaded.session, abort, Unmanaged.passUnretained(token).toOpaque())
            defer { transcribe_set_abort_callback(loaded.session, nil, nil) }
            let status = vocab.withUnsafeMutableBufferPointer { v in
                if !v.isEmpty && params.n_vocabulary > 0 { params.vocabulary = UnsafePointer(v.baseAddress) }
                return pcm.withUnsafeBufferPointer {
                    transcribe_run(loaded.session, $0.baseAddress, Int32(pcm.count), &params)
                }
            }

            if status == TRANSCRIBE_OK { return transcript(loaded.session) }
            if token.isCancelled { throw HushError("Cancelled") }
            // Truncated/repetition still carries a usable partial transcript.
            if status == TRANSCRIBE_ERR_OUTPUT_TRUNCATED || status == TRANSCRIBE_ERR_OUTPUT_REPETITION
                || status == TRANSCRIBE_ERR_ABORTED
            {
                return transcript(loaded.session)
            }
            throw HushError("transcription failed: \(statusMessage(status, "run"))")
        }
    }

    private static func runParams(_ l: Loaded, _ opts: RunOptions, _ strings: CStrings) -> transcribe_run_params {
        var p = transcribe_run_params()
        transcribe_run_params_init(&p)
        p.timestamps = TRANSCRIBE_TIMESTAMPS_AUTO
        let caps = l.capabilities

        if let lang = opts.language, let caps {
            let multilingual = caps.languages.count > 1
            if multilingual && caps.languages.contains(lang) { p.language = strings.add(lang) }
        }
        if opts.translate && caps?.supportsTranslate == true {
            p.task = TRANSCRIBE_TASK_TRANSLATE
            p.target_language = strings.add("en")
        }
        let vocabulary = l.supports(TRANSCRIBE_FEATURE_VOCABULARY)
        if !opts.vocabulary.isEmpty && vocabulary {
            // The pointer array itself is filled in by `run`, which keeps it alive.
            p.n_vocabulary = Int32(opts.vocabulary.count)
        }
        var prompt = opts.prompt ?? ""
        if !opts.vocabulary.isEmpty && !vocabulary {
            // Whisper-style models take vocabulary through the initial prompt.
            if !prompt.isEmpty { prompt += " " }
            prompt += opts.vocabulary.joined(separator: ", ")
        }
        if !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (l.supports(TRANSCRIBE_FEATURE_CONTEXT_PROMPT) || l.supports(TRANSCRIBE_FEATURE_INITIAL_PROMPT))
        {
            p.prompt = strings.add(prompt)
        }
        return p
    }

    private static func transcript(_ s: OpaquePointer) -> RawTranscript {
        let segments = (0..<max(transcribe_n_segments(s), 0)).map { i in
            var seg = transcribe_segment()
            transcribe_segment_init(&seg)
            _ = transcribe_get_segment(s, i, &seg)
            return RawSegment(
                t0Ms: seg.t0_ms, t1Ms: seg.t1_ms, text: str(seg.text), speakerId: Int64(seg.speaker_id),
                firstWord: Int64(seg.first_word), nWords: Int64(seg.n_words))
        }
        let words = (0..<max(transcribe_n_words(s), 0)).map { i in
            var w = transcribe_word()
            transcribe_word_init(&w)
            _ = transcribe_get_word(s, i, &w)
            return RawWord(t0Ms: w.t0_ms, t1Ms: w.t1_ms, text: str(w.text))
        }
        let language = str(transcribe_detected_language(s))
        return RawTranscript(
            text: str(transcribe_full_text(s)).trimmingCharacters(in: .whitespacesAndNewlines),
            language: language.isEmpty ? nil : language, segments: segments, words: words)
    }
}
