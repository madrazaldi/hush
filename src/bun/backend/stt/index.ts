// Speech-to-text dispatch: provider profiles and the shared transcript types.

import type { SttProfile } from "../../../lib/types";
import * as cloud from "./cloud";
import * as local from "./local";
import type { SttOptions, Transcript } from "./types";

export * from "./types";
export { cloud, local };
export * as models from "./models";

/**
 * Transcribe 16 kHz mono f32 PCM with the given profile. Long audio is split at silences into
 * provider-appropriate chunks and stitched back together with corrected timestamps. `progress`
 * receives 0..1.
 */
export function transcribe(
  profile: SttProfile,
  pcm: Float32Array,
  opts: SttOptions,
  progress: (p: number) => void = () => {},
  signal?: AbortSignal,
): Promise<Transcript> {
  return profile.kind === "local" ? local.transcribe(profile.model, pcm, opts, progress, signal) : cloud.transcribe(profile, pcm, opts, progress, signal);
}
