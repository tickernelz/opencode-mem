import { WebServer } from "../src/services/web-server.js";
import { WebAuth } from "../src/services/web-auth.js";
import { resolveSecretValue } from "../src/services/secret-resolver.js";

const PORT = Number(process.env.PORT ?? 14747);
const HOST = process.env.HOST ?? "127.0.0.1";

// Mirrors how src/index.ts plumbs the opencode-mem config through to WebAuth:
// both values are optional in the config file, and `webServerAuthPassword`
// accepts the same env:// / file:// shorthand as `memoryApiKey`.
const password = resolveSecretValue(process.env.WEB_AUTH_PASSWORD);
const username = process.env.WEB_AUTH_USERNAME ?? "";

const auth = new WebAuth({ password, username });
const server = new WebServer({
  port: PORT,
  host: HOST,
  enabled: true,
  auth,
});

await server.start();

const url = server.getUrl();
const config = auth.getConfig();
const enabledTag = config.enabled ? "ENABLED" : "DISABLED";

console.log("============================================================");
console.log(" OpenCode Memory Explorer — auth test harness");
console.log("============================================================");
console.log(` URL              : ${url}`);
console.log(` Auth             : ${enabledTag}`);
if (config.enabled) {
  console.log(` Username         : ${config.username}`);
  console.log(` Password         : (see WEB_AUTH_PASSWORD env var —`);
  console.log(`                   supports literal, env://, file://)`);
}
console.log("------------------------------------------------------------");
console.log(" Try these in a fresh browser window:");
console.log(`   1. Open ${url}            → should pop the Basic Auth dialog`);
console.log(`   2. Cancel → 401 page             → auth failed`);
console.log(`   3. Wrong password → 401 page     → auth failed`);
console.log(`   4. Right password → app loads    → auth ok`);
console.log("   5. /api/health includes authEnabled flag for the warning banner");
console.log("------------------------------------------------------------");
console.log(" Press Ctrl-C to stop.");

process.on("SIGINT", async () => {
  console.log("\nStopping…");
  await server.stop();
  process.exit(0);
});
