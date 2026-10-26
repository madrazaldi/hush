// Transcribe a media file with a local model: `bun run transcribe -- <file> [model-id]`
// (needs the native helper: `bun run build:native`, and the model downloaded in Hush).

import { decodeFile } from "../src/bun/backend/audio/decode";
import { SAMPLE_RATE } from "../src/bun/backend/audio/wav";
import { native } from "../src/bun/backend/native";
import { initPaths } from "../src/bun/backend/paths";
import * as stt from "../src/bun/backend/stt";
import { defaultSttOptions } from "../src/bun/backend/stt/types";

const [file, model = "parakeet-tdt-0.6b-v3"] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun run transcribe -- <file> [model-id]");
  process.exit(2);
}
initPaths();

try {
  let t = performance.now();
  const pcm = await decodeFile(file);
  console.log(`decoded ${(pcm.length / SAMPLE_RATE).toFixed(1)}s of audio in ${(performance.now() - t).toFixed(0)}ms`);

  t = performance.now();
  const out = await stt.local.transcribe(model, pcm, defaultSttOptions(), (p) => process.stderr.write(`\r${String(Math.round(p * 100)).padStart(3)}%`));
  process.stderr.write("\n");
  console.log(`transcribed with ${model} in ${(performance.now() - t).toFixed(0)}ms`);
  for (const s of out.segments) console.log(`[${String(s.start_ms).padStart(6)} - ${String(s.end_ms).padStart(6)}] ${s.text}`);
  console.log(`---\n${out.text}`);
} finally {
  // Releases the models, so ggml's Metal teardown doesn't assert at exit.
  await native().stop();
}
