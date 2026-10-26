// Smoke test for macOS system-audio capture through the native helper: `bun run systap`.
// Plays a system sound while it records the system mix, so it needs the "System Audio Recording"
// permission; whatever else is playing is captured too, so keep the machine quiet. Nothing is kept.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { readF32File } from "../src/bun/backend/audio/wav";
import { native } from "../src/bun/backend/native";
import { scratchDir } from "../src/bun/backend/paths";

const n = native();
const perms = await n.permissions();
console.log(`system_audio_supported: ${perms.system_audio_supported}`);

for (const round of [1, 2]) {
  const id = `systap-${round}`;
  const path = join(scratchDir(), `${id}.f32`);
  const t0 = performance.now();
  await n.captureStart({ id, source: "system", path, rotate_ms: 0 });
  console.log(`[round ${round}] started in ${(performance.now() - t0).toFixed(0)}ms`);

  // Play a few sounds during the capture.
  for (let i = 0; i < 2; i++) {
    Bun.spawn(["afplay", "/System/Library/Sounds/Glass.aiff"], { stdout: "ignore", stderr: "ignore" }).unref();
    await Bun.sleep(2000);
  }

  const t1 = performance.now();
  const { samples } = await n.captureStop(id);
  console.log(`[round ${round}] stop took ${(performance.now() - t1).toFixed(0)}ms`);
  const pcm = readF32File(path);
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  rmSync(path, { force: true });
  console.log(`[round ${round}] samples@16k=${samples} (~${(samples / 16000).toFixed(2)}s) peak=${peak.toFixed(4)}`);
}
await n.stop();
