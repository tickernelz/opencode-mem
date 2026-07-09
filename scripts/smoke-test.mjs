import assert from "node:assert/strict";

const pluginModule = await import("opencode-mem");
const tagsModule = await import("opencode-mem/tags");

assert.equal(typeof pluginModule.default, "object", "default export must be a plugin object");
assert.equal(pluginModule.default.id, "opencode-mem", "plugin id must match package name");
assert.equal(typeof pluginModule.default.server, "function", "plugin server must be callable");

assert.equal(typeof tagsModule.getTags, "function", "getTags export must be callable");
assert.equal(
  typeof tagsModule.getProjectTagInfo,
  "function",
  "getProjectTagInfo export must be callable"
);
assert.equal(
  typeof tagsModule.getUserTagInfo,
  "function",
  "getUserTagInfo export must be callable"
);

console.log("opencode-mem package smoke test passed");
