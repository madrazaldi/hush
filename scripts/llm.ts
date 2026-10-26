// Clean up a dictation with each installed agent CLI: `bun run llm`

import { BUILTIN_STYLES, dictationRequest } from "../src/bun/backend/ai";
import * as llm from "../src/bun/backend/llm";
import type { LlmProfile } from "../src/lib/types";

const raw = "um so i think we should uh move the launch to next tuesday no wait wednesday and tell sarah";
const style = BUILTIN_STYLES.find((s) => s.id === "message");
if (!style) throw new Error("the 'message' style is missing");
const req = dictationRequest(style, raw, { appName: "Slack", vocabulary: [] });

for (const cli of await llm.detectClis()) {
  console.log(`${cli.kind}: ${cli.path} ${cli.version}`);
  if (!cli.path) continue;
  const profile: LlmProfile = { id: "t", name: "t", kind: cli.kind, model: "", base_url: "", api_key: "", bin_path: "", effort: "" };
  const t = performance.now();
  try {
    const out = await llm.complete(profile, req);
    console.log(`  -> ${JSON.stringify(out)} (${((performance.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.log(`  !! ${e instanceof Error ? e.message : e}`);
  }
}
