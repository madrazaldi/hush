// Prints the app version and fails if package.json and electrobun.config.ts disagree.
// Used by the release workflow to check the pushed tag (`v<version>`).

import config from "../electrobun.config";
import pkg from "../package.json";

if (pkg.version !== config.app.version) {
  console.error(`package.json is ${pkg.version} but electrobun.config.ts is ${config.app.version}`);
  process.exit(1);
}
console.log(pkg.version);
