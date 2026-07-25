/**
 * OpenCode V2 plugin entrypoint stub (#173).
 *
 * NOT wired into package.json main/exports. The V2 plugin surface
 * (`@opencode-ai/plugin/v2/promise`) is domain-based (agent/skill/command/…)
 * and has no stable 1:1 replacement yet for V1 hooks used by opencode-mem
 * (`chat.message`, `event` / session.idle|compacted, `tool.memory`).
 *
 * Keep V1 (`src/plugin.ts`) as the only published entrypoint until the V2
 * API finalizes those capabilities. See docs/opencode-v2-plugin-gap.md.
 */
import { define } from "@opencode-ai/plugin/v2/promise";

export const openCodeMemV2Plugin = define({
  id: "opencode-mem",
  async setup(context) {
    // Spike only: confirm the V2 contract loads. Domains available today:
    // context.agent | aisdk | catalog | command | integration | plugin |
    // reference | skill — none of these map cleanly to memory injection /
    // session idle capture / custom memory tool yet.
    void context;
  },
});

export default openCodeMemV2Plugin;
