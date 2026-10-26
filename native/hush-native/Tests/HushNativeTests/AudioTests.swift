import Foundation
import Testing

@testable import HushNative

private func tone(_ rate: Int, _ secs: Double, _ hz: Double) -> [Float] {
    (0..<Int(Double(rate) * secs)).map { i in Float(sin(Double(i) * hz * 2 * .pi / Double(rate)) * 0.5) }
}

@Test(arguments: [44_100, 48_000, 22_050, 8_000])
func resamplePreservesLengthInOddBlocks(rate: Int) {
    let input = tone(rate, 3.7, 440)
    let r = Resampler(fromRate: rate)
    var out: [Float] = []
    for start in stride(from: 0, to: input.count, by: 777) {
        out += r.process(Array(input[start..<min(start + 777, input.count)]))
    }
    out += r.finish()
    let expected = Int((Double(input.count) * Double(sampleRate) / Double(rate)).rounded())
    #expect(out.count == expected)
}

@Test func resampleIsTimeAligned() {
    // A click at 1.0 s must land at 1.0 s after resampling (no filter delay).
    let rate = 48_000
    var input = [Float](repeating: 0, count: rate * 2)
    input[rate] = 1
    let out = resample(input, fromRate: rate)
    let peak = out.indices.max { abs(out[$0]) < abs(out[$1]) }!
    #expect(abs(peak - sampleRate) <= 2)
}

@Test func resampleHandlesShortInput() {
    #expect(resample(tone(44_100, 0.01, 440), fromRate: 44_100).count == 160)
}

@Test func resampleKeepsInBandToneAndRejectsAliases() {
    func rms(_ x: ArraySlice<Float>) -> Float { (x.map { $0 * $0 }.reduce(0, +) / Float(x.count)).squareRoot() }
    // 1 kHz passes at full level; 12 kHz (above the new 8 kHz Nyquist) is filtered out.
    let pass = resample(tone(48_000, 1, 1_000), fromRate: 48_000)
    let stop = resample(tone(48_000, 1, 12_000), fromRate: 48_000)
    #expect(abs(rms(pass[1000..<15000]) - 0.5 / Float(2).squareRoot()) < 0.01)
    #expect(rms(stop[1000..<15000]) < 0.001)
}

@Test func sameRateIsPassthrough() {
    let input = tone(16_000, 0.5, 300)
    #expect(resample(input, fromRate: 16_000) == input)
}

@Test func levelMapsDecibels() {
    #expect(level([]) == 0)
    #expect(level([Float](repeating: 0, count: 100)) == 0)
    #expect(abs(level([Float](repeating: 1, count: 100)) - 1) < 1e-6)
    // -30 dBFS sits half-way.
    #expect(abs(level([Float](repeating: 0.031_622_8, count: 100)) - 0.5) < 0.01)
}

@Test func downmixAveragesChannels() {
    #expect(toMono([1, 3, -1, 1], channels: 2) == [2, 0])
    #expect(toMono([0.5, 0.25], channels: 1) == [0.5, 0.25])
}
