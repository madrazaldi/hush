import Foundation
import Testing

@testable import HushNative

private func waitFor(_ cond: () -> Bool) {
    let deadline = Date().addingTimeInterval(5)
    while !cond() && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
}

@Test func answersRequestsAndReportsErrors() {
    let out = Lines()
    let input = [
        #"{"id":1,"method":"echo","params":{"a":1,"snake_key":[true,null,"x"]}}"#, "",
        #"{"id":"two","method":"boom"}"#, "not json", #"{"id":4}"#,
    ]
    serve(lines: AnyIterator(input.makeIterator()), emitter: out.emitter) { method, params in
        switch method {
        case "echo": return params
        default: throw HushError("nope")
        }
    }
    // Request threads are detached; wait for every reply.
    waitFor { out.count >= 4 }
    let lines = out.all
    func reply(_ id: JSON) -> JSON { lines.first { $0["id"] == id }! }
    #expect(reply(1)["result"] == ["a": 1, "snake_key": [true, nil, "x"]])
    #expect(reply("two")["error"]?["message"] == "nope")
    #expect(reply(4)["error"]?["message"] == "missing method")
    #expect(reply(nil)["error"]?["message"]?.string?.hasPrefix("parse error") == true)
    #expect(lines.allSatisfy { $0["jsonrpc"] == "2.0" })
}

@Test func eventsAreNotifications() {
    let out = Lines()
    out.emitter.emit("capture.level", LevelEvent(id: "a", level: 0.5))
    let v = out.all[0]
    #expect(v["method"] == "capture.level")
    #expect(v["params"]?["level"] == 0.5)
    #expect(v["id"] == nil)
}

@Test func unknownMethodsAndBadParamsAreErrors() throws {
    let app = App(emitter: Emitter { _ in })
    #expect(throws: HushError.self) { try app.call("nope", nil) }
    do {
        _ = try app.call("stt.run", ["job": 1])
        Issue.record("expected an error")
    } catch {
        #expect(message(of: error).hasPrefix("bad params"))
    }
    let ping = try Coders.text(app.call("ping", nil))
    #expect(ping.contains(#""version":"\#(helperVersion)""#))
}

@Test func paramsUseSnakeCase() throws {
    let p: StartParams = try params(["id": "a", "source": "system", "path": "/tmp/x", "rotate_ms": 30_000])
    #expect(p.rotateMs == 30_000)
    #expect(p.source == .system)
    #expect(p.device == nil)
}

@Test func transcriptsEncodeLikeBefore() throws {
    let t = RawTranscript(
        text: "hi", language: nil,
        segments: [RawSegment(t0Ms: 0, t1Ms: 10, text: "hi", speakerId: 0, firstWord: 0, nWords: 1)],
        words: [RawWord(t0Ms: 0, t1Ms: 10, text: "hi")])
    #expect(
        try Coders.text(t)
            == #"{"language":null,"segments":[{"first_word":0,"n_words":1,"speaker_id":0,"t0_ms":0,"t1_ms":10,"text":"hi"}],"text":"hi","words":[{"t0_ms":0,"t1_ms":10,"text":"hi"}]}"#
    )
}

@Test func missingModelIsAClearError() {
    do {
        _ = try STT.info("/nonexistent/model.gguf")
        Issue.record("expected an error")
    } catch {
        #expect(message(of: error) == "model file not found: /nonexistent/model.gguf")
    }
}
