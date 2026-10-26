// Builds the native helper (native/hush-native) and stages it at native/bin/hush-native, which
// electrobun.config.ts copies into the app bundle. `HUSH_NATIVE_PROFILE=debug` for a debug build.

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const crate = join(root, "native", "hush-native");
const profile = process.env.HUSH_NATIVE_PROFILE === "debug" ? "debug" : "release";

const args = ["cargo", "build", "--locked", ...(profile === "release" ? ["--release"] : [])];
console.log(`$ ${args.join(" ")}  (in native/hush-native)`);
const proc = Bun.spawnSync(args, { cwd: crate, stdout: "inherit", stderr: "inherit" });
if (proc.exitCode !== 0) {
  console.error("building the native helper failed");
  process.exit(proc.exitCode ?? 1);
}

const from = join(crate, "target", profile, "hush-native");
const to = join(root, "native", "bin", "hush-native");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
chmodSync(to, 0o755);
console.log(`staged ${to}`);
