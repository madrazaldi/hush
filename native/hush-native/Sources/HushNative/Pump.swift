// The non-realtime half of a capture: a worker thread that drains the ring the Core Audio
// callback fills, resamples to 16 kHz and hands the audio to the caller.

import CHushAudio
import Foundation

/// Receives captured 16 kHz mono audio on the capture's worker thread.
public typealias AudioCallback = ([Float]) -> Void

/// How often the worker drains the ring.
private let drainInterval: TimeInterval = 0.02
/// Ring capacity in seconds at the device's native rate.
private let ringSeconds = 10

final class Pump {
    let ring: OpaquePointer
    private let resampler: Resampler
    private let onAudio: AudioCallback
    private let stopRequested = DispatchSemaphore(value: 0)
    private let finished = DispatchSemaphore(value: 0)
    private var scratch = [Float](repeating: 0, count: 8192)
    private var thread: Thread?

    init(nativeRate: Int, onAudio: @escaping AudioCallback) throws {
        guard let ring = hush_ring_create(max(nativeRate, 1) * ringSeconds) else {
            throw HushError("out of memory")
        }
        self.ring = ring
        resampler = Resampler(fromRate: nativeRate)
        self.onAudio = onAudio
    }

    deinit {
        hush_ring_destroy(ring)
    }

    /// Start draining. `stopDevice` runs on the worker once stop is requested, before the last
    /// drain, so no samples arrive after the tail is flushed.
    func start(name: String, stopDevice: @escaping () -> Void) {
        let thread = Thread { [self] in
            while stopRequested.wait(timeout: .now() + drainInterval) == .timedOut {
                drain()
            }
            stopDevice()
            drain()
            let tail = resampler.finish()
            if !tail.isEmpty { onAudio(tail) }
            finished.signal()
        }
        thread.name = name
        self.thread = thread
        thread.start()
    }

    private func drain() {
        var pending: [Float] = []
        while true {
            let n = scratch.withUnsafeMutableBufferPointer { hush_ring_pop(ring, $0.baseAddress!, $0.count) }
            if n == 0 { break }
            pending.append(contentsOf: scratch[0..<n])
        }
        guard !pending.isEmpty else { return }
        let out = resampler.process(pending)
        if !out.isEmpty { onAudio(out) }
    }

    /// Stop and wait until all captured audio has been delivered. Idempotent.
    func stop() {
        guard thread != nil else { return }
        thread = nil
        stopRequested.signal()
        finished.wait()
    }
}
