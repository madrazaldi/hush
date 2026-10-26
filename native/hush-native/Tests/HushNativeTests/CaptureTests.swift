import Foundation
import Testing

@testable import HushNative

private func tempDir(_ name: String) -> String {
    let d = NSTemporaryDirectory() + "hush-native-\(name)-\(getpid())"
    try? FileManager.default.removeItem(atPath: d)
    try! FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
}

private func floats(_ path: String) -> [Float] {
    let data = FileManager.default.contents(atPath: path)!
    return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
}

/// Collects emitted lines.
final class Lines: @unchecked Sendable {
    private var lines: [String] = []
    private let lock = NSLock()

    lazy var emitter = Emitter { [unowned self] data in
        lock.withLock { lines += String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init) }
    }

    var all: [JSON] {
        lock.withLock { lines.map { try! JSONDecoder().decode(JSON.self, from: Data($0.utf8)) } }
    }

    var count: Int { lock.withLock { lines.count } }
}

@Test func singleFileHoldsEverySample() throws {
    let d = tempDir("single")
    defer { try? FileManager.default.removeItem(atPath: d) }
    let s = Sink(id: "t", base: d + "/t.f32", rotateSamples: 0, emitter: Emitter { _ in })
    try s.open()
    s.push([0.5, -0.5])
    s.push([0.25])
    s.closeChunk()
    #expect(floats(d + "/t.f32") == [0.5, -0.5, 0.25])
    #expect(s.total == 3)
}

@Test func rotationSplitsIntoNumberedChunks() throws {
    let d = tempDir("rotate")
    defer { try? FileManager.default.removeItem(atPath: d) }
    let out = Lines()
    let s = Sink(id: "t", base: d + "/t.f32", rotateSamples: 4, emitter: out.emitter)
    try s.open()
    s.push([1, 2, 3])
    s.push([4, 5])
    s.push([6])
    s.closeChunk()
    #expect(s.total == 6)
    #expect(floats(d + "/t.f32.0") == [1, 2, 3, 4, 5])
    #expect(floats(d + "/t.f32.1") == [6])
    // The empty trailing chunk is not left behind.
    #expect(!FileManager.default.fileExists(atPath: d + "/t.f32.2"))
    let chunks = out.all.filter { $0["method"] == "capture.chunk" }
    #expect(chunks.map { $0["params"]?["seq"] } == [0, 1])
    #expect(chunks.map { $0["params"]?["samples"] } == [5, 1])
    #expect(chunks[0]["params"]?["path"]?.string == d + "/t.f32.0")
}

@Test func readsASampleRange() throws {
    let path = NSTemporaryDirectory() + "hush-native-read-\(getpid()).f32"
    defer { try? FileManager.default.removeItem(atPath: path) }
    let samples = (0..<10).map(Float.init)
    FileManager.default.createFile(atPath: path, contents: samples.withUnsafeBytes { Data($0) })
    #expect(try readSamples(path, start: 3, len: 2) == [3, 4])
    #expect(try readSamples(path, start: 8, len: nil) == [8, 9])
    // Out-of-range requests clamp instead of failing.
    #expect(try readSamples(path, start: 9, len: 50) == [9])
    #expect(try readSamples(path, start: 20, len: nil).isEmpty)
}

@Test func cancelTripsOnlyWatchersCreatedBeforeIt() {
    let before = Input.watcher()
    #expect(!before())
    Input.cancel()
    #expect(before())
    let after = Input.watcher()
    #expect(!after())
}
