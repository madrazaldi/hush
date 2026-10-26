// hush-native entry point: serve JSON-RPC on stdin/stdout until the parent closes it.

import Foundation
import HushNative

// A closed stdout must not kill us before cleanup; writes just fail.
signal(SIGPIPE, SIG_IGN)

let emitter = Emitter.stdout()
let app = App(emitter: emitter)
serve(lines: stdinLines(), emitter: emitter) { method, params in try app.call(method, params) }
// stdin closed: the parent is gone. Release devices and models, then exit.
app.cleanup()
exit(0)
