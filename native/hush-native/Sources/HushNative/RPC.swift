// Newline-delimited JSON-RPC 2.0 over stdio.
//
// * stdin: one request object per line (`{"jsonrpc":"2.0","id":1,"method":"x","params":{}}`).
// * stdout: one response (`result` or `error`) per request, plus notifications (no `id`) for
//   pushed events such as audio levels. Nothing else is written to stdout; logs go to stderr.
//
// Each request runs on its own thread, so a long transcription never blocks a level meter or a
// hotkey rebind. Responses may therefore arrive out of order and are matched by `id`.

import Foundation

/// An error whose message goes back to the caller as is.
public struct HushError: Error, CustomStringConvertible {
    public let description: String

    public init(_ message: String) { description = message }
}

/// The message sent back for any error.
func message(of error: Error) -> String {
    switch error {
    case let e as HushError: e.description
    case let e as DecodingError: describe(e)
    default: error.localizedDescription
    }
}

private func describe(_ e: DecodingError) -> String {
    func path(_ ctx: DecodingError.Context) -> String {
        ctx.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
    }
    switch e {
    case .keyNotFound(let key, let ctx):
        let at = path(ctx)
        return "missing field `\(key.stringValue)`" + (at.isEmpty ? "" : " in `\(at)`")
    case .typeMismatch(let type, let ctx), .valueNotFound(let type, let ctx):
        return "invalid type for `\(path(ctx))`, expected \(type)"
    case .dataCorrupted(let ctx):
        return path(ctx).isEmpty ? ctx.debugDescription : "invalid value for `\(path(ctx))`: \(ctx.debugDescription)"
    @unknown default:
        return "\(e)"
    }
}

/// Writes whole JSON lines to the shared output, one at a time.
public final class Emitter: @unchecked Sendable {
    private let out: (Data) -> Void
    private let lock = NSLock()

    public init(_ out: @escaping (Data) -> Void) { self.out = out }

    /// Writes to stdout. A closed pipe means the parent is gone; the read loop notices EOF too.
    public static func stdout() -> Emitter {
        Emitter { data in
            data.withUnsafeBytes { raw in
                var p = raw.baseAddress!
                var left = raw.count
                while left > 0 {
                    let n = Darwin.write(1, p, left)
                    if n < 0 {
                        if errno == EINTR { continue }
                        return
                    }
                    p += n
                    left -= n
                }
            }
        }
    }

    func writeLine(_ text: String) {
        lock.lock()
        defer { lock.unlock() }
        out(Data((text + "\n").utf8))
    }

    /// Push an event to the parent.
    public func emit(_ method: String, _ params: any Encodable) {
        do {
            writeLine(#"{"jsonrpc":"2.0","method":\#(try Coders.text(method)),"params":\#(try Coders.text(params))}"#)
        } catch {
            Log.error("could not encode \(method) event: \(error)")
        }
    }

    func respond(_ id: JSON, _ result: Result<any Encodable, Error>) {
        let idText = (try? Coders.text(id)) ?? "null"
        switch result {
        case .success(let value):
            do {
                writeLine(#"{"jsonrpc":"2.0","id":\#(idText),"result":\#(try Coders.text(value))}"#)
            } catch {
                respond(id, .failure(HushError("could not encode the result: \(error)")))
            }
        case .failure(let error):
            let msg = (try? Coders.text(message(of: error))) ?? #""error""#
            writeLine(#"{"jsonrpc":"2.0","id":\#(idText),"error":{"code":-32000,"message":\#(msg)}}"#)
        }
    }
}

public typealias Handler = @Sendable (String, JSON) throws -> any Encodable

/// A line that is not a usable request, with whatever id it carried.
struct BadRequest: Error {
    let id: JSON
    let message: String
}

/// Parse one input line into `(id, method, params)`.
func parse(_ line: String) -> Result<(JSON, String, JSON), BadRequest> {
    let value: JSON
    do {
        value = try JSONDecoder().decode(JSON.self, from: Data(line.utf8))
    } catch {
        return .failure(BadRequest(id: .null, message: "parse error: \(message(of: error))"))
    }
    let id = value["id"] ?? .null
    guard let method = value["method"]?.string else { return .failure(BadRequest(id: id, message: "missing method")) }
    return .success((id, method, value["params"] ?? .null))
}

/// Read requests until EOF, answering each on its own thread.
public func serve(lines: AnyIterator<String>, emitter: Emitter, handler: @escaping Handler) {
    for line in lines {
        if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        switch parse(line) {
        case .failure(let bad):
            emitter.respond(bad.id, .failure(HushError(bad.message)))
        case .success(let (id, method, params)):
            let thread = Thread {
                emitter.respond(id, Result { try handler(method, params) })
            }
            thread.name = "rpc-\(method)"
            // ggml and Core Audio setup can recurse deeper than the 512 KB default.
            thread.stackSize = 8 << 20
            thread.start()
        }
    }
}

/// Lines from stdin until EOF.
public func stdinLines() -> AnyIterator<String> {
    AnyIterator { readLine(strippingNewline: true) }
}

/// Decode a request's params, with a readable error.
public func params<T: Decodable>(_ value: JSON, as type: T.Type = T.self) throws -> T {
    do {
        let data = try Coders.encoder().encode(value == .null ? [:] : value)
        return try Coders.decoder().decode(T.self, from: data)
    } catch {
        throw HushError("bad params: \(message(of: error))")
    }
}
