//! hush-native entry point: serve JSON-RPC on stdin/stdout until the parent closes it.

use std::io::BufReader;
use std::sync::Arc;

use hush_native::methods::App;
use hush_native::rpc::{self, Emitter, Handler};

fn main() {
    // Logs go to stderr only; stdout is the protocol channel.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .target(env_logger::Target::Stderr)
        .init();

    let emitter = Emitter::stdout();
    let app = App::new(emitter.clone());
    let handler: Arc<Handler> = {
        let app = app.clone();
        Arc::new(move |method, params| app.call(method, params))
    };
    rpc::serve(BufReader::new(std::io::stdin().lock()), &emitter, handler);
    // stdin closed: the parent is gone. Release devices and models, then exit.
    app.cleanup();
}
