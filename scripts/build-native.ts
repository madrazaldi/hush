// Builds the native helper (native/hush-native, Swift) and stages it at native/bin/hush-native, which
// electrobun.config.ts copies into the app bundle. `HUSH_NATIVE_PROFILE=debug` for a debug build.
//
// The helper links transcribe.cpp (ggml with Metal). The first run clones the pinned release and builds
// it with CMake into native/hush-native/vendor/transcribe; later runs reuse it. `--deps-only` stops
// after that (CI uses it before `swift test`).

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TRANSCRIBE_REPO = "https://github.com/handy-computer/transcribe.cpp";
const TRANSCRIBE_TAG = "v0.4.0";
const TRANSCRIBE_COMMIT = "f1dcd15858c4bbba87ca97862b4e448b2cf15b8f";

const root = join(import.meta.dir, "..");
const pkg = join(root, "native", "hush-native");
const vendor = join(pkg, "vendor");
const prefix = join(vendor, "transcribe");
const profile = process.env.HUSH_NATIVE_PROFILE === "debug" ? "debug" : "release";

function run(args: string[], cwd: string) {
  console.log(`$ ${args.join(" ")}`);
  const proc = Bun.spawnSync(args, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`${args[0]} failed`);
    process.exit(proc.exitCode ?? 1);
  }
}

function buildTranscribe() {
  const stamp = join(prefix, "BUILT");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === TRANSCRIBE_COMMIT) return;
  console.log(`building transcribe.cpp ${TRANSCRIBE_TAG} (first build is slow)`);
  const src = join(vendor, "src");
  const build = join(vendor, "build");
  rmSync(src, { recursive: true, force: true });
  rmSync(build, { recursive: true, force: true });
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(vendor, { recursive: true });
  run(["git", "clone", "--quiet", "--depth", "1", "--branch", TRANSCRIBE_TAG, TRANSCRIBE_REPO, src], vendor);
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: src }).stdout.toString().trim();
  if (head !== TRANSCRIBE_COMMIT) {
    console.error(`transcribe.cpp ${TRANSCRIBE_TAG} is ${head}, expected ${TRANSCRIBE_COMMIT}`);
    process.exit(1);
  }
  run(
    [
      "cmake", "-S", src, "-B", build,
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_INSTALL_PREFIX=${prefix}`,
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.2",
      "-DCMAKE_OSX_ARCHITECTURES=arm64",
      "-DTRANSCRIBE_INSTALL=ON",
      "-DTRANSCRIBE_BUILD_TESTS=OFF",
      "-DTRANSCRIBE_BUILD_EXAMPLES=OFF",
      "-DTRANSCRIBE_BUILD_TOOLS=OFF",
      "-DTRANSCRIBE_BUILD_SHARED=OFF",
      "-DTRANSCRIBE_METAL=ON",
      "-DGGML_METAL_EMBED_LIBRARY=ON",
      "-DGGML_NATIVE=OFF",
      "-DTRANSCRIBE_USE_OPENMP=OFF",
    ],
    vendor,
  );
  run(["cmake", "--build", build, "--parallel"], vendor);
  run(["cmake", "--install", build], vendor);
  // Package.swift and the CTranscribe module map link exactly these.
  const link = JSON.parse(readFileSync(join(prefix, "lib", "transcribe-link.json"), "utf8"));
  const expected = ["transcribe", "ggml", "ggml-cpu", "ggml-metal", "ggml-base"];
  if (JSON.stringify(link.libraries) !== JSON.stringify(expected)) {
    console.error(`transcribe.cpp now links ${link.libraries.join(", ")}; update Sources/CTranscribe/module.modulemap`);
    process.exit(1);
  }
  rmSync(build, { recursive: true, force: true });
  writeFileSync(stamp, `${TRANSCRIBE_COMMIT}\n`);
}

buildTranscribe();
if (process.argv.includes("--deps-only")) process.exit(0);

const swiftArgs = ["swift", "build", "--configuration", profile, "--product", "hush-native"];
run(swiftArgs, pkg);
// SwiftPM's output layout differs between versions; ask it.
const binDir = Bun.spawnSync([...swiftArgs, "--show-bin-path"], { cwd: pkg }).stdout.toString().trim();
const from = join(binDir, "hush-native");
const to = join(root, "native", "bin", "hush-native");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
chmodSync(to, 0o755);
console.log(`staged ${to}`);
