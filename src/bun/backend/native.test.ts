import { afterAll, expect, test } from "bun:test";
import { Native, resolveNativeBin } from "./native";

const bin = resolveNativeBin();
const n = new Native();
afterAll(() => n.stop());

// These talk to the real helper; they are skipped when it has not been built (`bun run build:native`).
const t = bin ? test : test.skip;

t("ping and unknown methods", async () => {
  const p = await n.ping();
  expect(p.pid).toBeGreaterThan(0);
  await expect(n.call("nope.nothing")).rejects.toThrow("unknown method");
});

t("hotkey spec validation", async () => {
  await n.hotkeysValidate("Cmd+Shift+K");
  await expect(n.hotkeysValidate("Banana+Nope")).rejects.toThrow();
});

t("requests overlap and the helper restarts after a crash", async () => {
  const [a, b] = await Promise.all([n.ping(), n.devices()]);
  expect(a.version).toBeTruthy();
  expect(Array.isArray(b)).toBe(true);
  const pid = (await n.ping()).pid;
  let restarted = false;
  n.onRestart(() => (restarted = true));
  process.kill(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 200));
  const again = await n.ping();
  expect(again.pid).not.toBe(pid);
  expect(restarted).toBe(true);
});

t("stt.run reports a bad model path", async () => {
  await expect(n.sttInfo("/nonexistent/model.gguf")).rejects.toThrow("model file not found");
});

test("missing helper is a clear error", async () => {
  const missing = new Native(() => null);
  await expect(missing.ping()).rejects.toThrow("native helper is missing");
});
