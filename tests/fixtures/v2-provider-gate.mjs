/**
 * Mini subprocess gate proof for Phase2 R1: the connectivity ids produced by
 * the fixed v2 bridge flow through setConnectedProviders → isProviderConnected
 * so an active provider id passes the gate and a disabled one does not.
 *
 * No LLM/generate call is made; module state is loaded in a fresh process
 * with HOME/XDG redirected to an isolated sandbox (no real auth/memory).
 */
import { createLegacyClient } from "../../src/v2/legacy-client.js";
import { setConnectedProviders, isProviderConnected } from "../../src/ai/opencode-provider.js";

const ctx = {
  location: { directory: "/workspace/project", project: { directory: "/workspace/project" } },
  provider: {
    list: async () => ({
      location: { directory: "/workspace/project" },
      data: [
        { id: "newapi", name: "NewAPI", activation: "enabled", package: "newapi-pkg" },
        { id: "opencode", name: "OpenCode", activation: "auto", package: "opencode-pkg" },
        { id: "legacy-off", name: "Off", activation: "disabled", package: "off-pkg" },
      ],
    }),
  },
  model: {
    list: async () => {
      throw new Error("model.list must not be called");
    },
  },
};

const client = createLegacyClient(ctx);
const result = await client.provider.list();
setConnectedProviders(result.data.connected);

const output = {
  connected: result.data.connected,
  enabledNewapi: isProviderConnected("newapi"),
  autoOpencode: isProviderConnected("opencode"),
  disabledLegacyOff: isProviderConnected("legacy-off"),
  unknown: isProviderConnected("does-not-exist"),
};
console.log(JSON.stringify(output));
if (output.connected.includes("legacy-off")) process.exit(2);
if (!output.enabledNewapi || !output.autoOpencode || output.disabledLegacyOff) process.exit(3);
