// Sample-rate conversion and level metering shared by the capture backends.

import Accelerate
import Foundation

/// Every capture stream is delivered at this rate, mono.
public let sampleRate = 16_000

/// Downmix interleaved frames to mono.
public func toMono(_ interleaved: [Float], channels: Int) -> [Float] {
    guard channels > 1 else { return interleaved }
    return stride(from: 0, to: interleaved.count - channels + 1, by: channels).map { i in
        interleaved[i..<i + channels].reduce(0, +) / Float(channels)
    }
}

/// RMS level in 0..1 (roughly perceptual, for meters).
public func level(_ pcm: [Float]) -> Float {
    guard !pcm.isEmpty else { return 0 }
    var rms: Float = 0
    vDSP_rmsqv(pcm, 1, &rms, vDSP_Length(pcm.count))
    // Map roughly -60 dB..0 dB to 0..1.
    let db = 20 * log10(max(rms, 1e-6))
    return min(max((db + 60) / 60, 0), 1)
}

private func gcd(_ a: Int, _ b: Int) -> Int { b == 0 ? a : gcd(b, a % b) }

/// Zeroth-order modified Bessel function, for the Kaiser window.
private func besselI0(_ x: Double) -> Double {
    var sum = 1.0
    var term = 1.0
    for k in 1..<50 {
        term *= (x / (2 * Double(k))) * (x / (2 * Double(k)))
        sum += term
        if term < sum * 1e-12 { break }
    }
    return sum
}

/// Streaming mono resampler to 16 kHz (Kaiser-windowed sinc, polyphase). Feed arbitrary-sized
/// blocks.
///
/// Output sample `n` is the input interpolated at time `n / 16000` s, so the output is aligned
/// with the input (no filter delay), and `finish` flushes the tail so the total length matches the
/// input duration exactly.
public final class Resampler {
    let fromRate: Int
    /// Output n sits at input position `n * step / phases`.
    private let step: Int
    private let phases: Int
    /// Taps on each side of the interpolation point.
    private let half: Int
    /// `phases` rows of `2 * half` taps.
    private let table: [Float]
    /// Input samples from absolute index `bufStart` on (negative indices are leading silence).
    private var buf: [Float]
    private var bufStart: Int
    private var inTotal = 0
    private var outCount = 0

    public init(fromRate: Int) {
        self.fromRate = fromRate
        let g = gcd(fromRate, sampleRate)
        step = fromRate / g
        phases = sampleRate / g
        guard fromRate != sampleRate else {
            half = 0
            table = []
            buf = []
            bufStart = 0
            return
        }
        // Cutoff (relative to the input rate) just below the lower Nyquist frequency.
        let cutoff = 0.5 * min(1, Double(sampleRate) / Double(fromRate)) * 0.94
        let zeroCrossings = 16.0
        let half = Int((zeroCrossings / (2 * cutoff)).rounded(.up))
        let beta = 8.6
        let i0Beta = besselI0(beta)
        let taps = 2 * half
        var table = [Float](repeating: 0, count: phases * taps)
        for p in 0..<phases {
            let frac = Double(p) / Double(phases)
            var row = [Double](repeating: 0, count: taps)
            for j in 0..<taps {
                // Tap j multiplies input sample base + (j - half + 1).
                let t = Double(j - half + 1) - frac
                let x = 2 * cutoff * t
                let sinc = x == 0 ? 1 : sin(Double.pi * x) / (Double.pi * x)
                let r = t / Double(half)
                let window = abs(r) >= 1 ? 0 : besselI0(beta * (1 - r * r).squareRoot()) / i0Beta
                row[j] = sinc * window
            }
            let sum = row.reduce(0, +)
            for j in 0..<taps { table[p * taps + j] = Float(row[j] / sum) }
        }
        self.half = half
        self.table = table
        buf = [Float](repeating: 0, count: half)
        bufStart = -half
    }

    /// Emit every output sample whose input window ends before `available` (absolute index).
    private func emit(upTo available: Int, limit: Int = Int.max) -> [Float] {
        var out: [Float] = []
        let taps = 2 * half
        buf.withUnsafeBufferPointer { b in
            table.withUnsafeBufferPointer { tab in
                while outCount < limit {
                    let pos = outCount * step
                    let base = pos / phases
                    guard base + half < available else { break }
                    let row = tab.baseAddress! + (pos % phases) * taps
                    let first = b.baseAddress! + (base - half + 1 - bufStart)
                    var v: Float = 0
                    vDSP_dotpr(first, 1, row, 1, &v, vDSP_Length(taps))
                    out.append(v)
                    outCount += 1
                }
            }
        }
        // Drop input no future output needs.
        let keepFrom = (outCount * step) / phases - half + 1
        if keepFrom - bufStart > 8192 {
            buf.removeFirst(keepFrom - bufStart)
            bufStart = keepFrom
        }
        return out
    }

    public func process(_ input: [Float]) -> [Float] {
        guard fromRate != sampleRate else { return input }
        buf.append(contentsOf: input)
        inTotal += input.count
        return emit(upTo: inTotal)
    }

    /// Flush the tail: what is left is computed against trailing silence.
    public func finish() -> [Float] {
        guard fromRate != sampleRate else { return [] }
        let target = Int((Double(inTotal) * Double(sampleRate) / Double(fromRate)).rounded())
        guard outCount < target else { return [] }
        let lastBase = ((target - 1) * step) / phases
        let pad = max(0, lastBase + half + 1 - inTotal)
        buf.append(contentsOf: [Float](repeating: 0, count: pad))
        return emit(upTo: inTotal + pad, limit: target)
    }
}

/// One-shot resample of a full mono buffer.
public func resample(_ pcm: [Float], fromRate: Int) -> [Float] {
    let r = Resampler(fromRate: fromRate)
    return r.process(pcm) + r.finish()
}
