// Prints the app version and fails if package.json, electrobun.config.ts and the native helper disagree.
// Used by the release workflow to check the pushed tag (`v<version>`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../electrobun.config";
import pkg from "../package.json";

if (pkg.version !== config.app.version) {
  console.error(`package.json is ${pkg.version} but electrobun.config.ts is ${config.app.version}`);
  process.exit(1);
}
const methods = readFileSync(join(import.meta.dir, "../native/hush-native/Sources/HushNative/Methods.swift"), "utf8");
const helper = methods.match(/helperVersion = "([^"]+)"/)?.[1];
if (pkg.version !== helper) {
  console.error(`package.json is ${pkg.version} but the native helper (Methods.swift) is ${helper}`);
  process.exit(1);
}
console.log(pkg.version);
