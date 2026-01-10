#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";
import { stripJsoncComments } from "./services/jsonc.js";

const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_COMMAND_DIR = join(OPENCODE_CONFIG_DIR, "command");
const OH_MY_OPENCODE_CONFIG = join(OPENCODE_CONFIG_DIR, "oh-my-opencode.json");
const PLUGIN_NAME = "opencode-mem@latest";

const MEM_INIT_COMMAND = `---
description: Initialize memory system with comprehensive codebase knowledge
---

# Initializing Memory System

You are initializing persistent memory for this codebase. This is not just data collection - you're building context that will make you significantly more effective across all future sessions.

## Understanding Context

You are a **stateful** coding agent. Users expect to work with you over extended periods - potentially the entire lifecycle of a project. Your memory is how you get better over time and maintain continuity.

## What to Remember

### 1. Procedures (Rules & Workflows)
Explicit rules that should always be followed:
- "Never commit directly to main - always use feature branches"
- "Always run lint before tests"
- "Use conventional commits format"

### 2. Preferences (Style & Conventions)  
Project and user coding style:
- "Prefer functional components over class components"
- "Use early returns instead of nested conditionals"
- "Always add JSDoc to exported functions"

### 3. Architecture & Context
How the codebase works and why:
- "Auth system was refactored in v2.0 - old patterns deprecated"
- "The monorepo used to have 3 modules before consolidation"
- "This pagination bug was fixed before - similar to PR #234"

## Memory Scopes

**Project-scoped** (\`scope: "project"\`):
- Build/test/lint commands
- Architecture and key directories
- Team conventions specific to this codebase
- Technology stack and framework choices
- Known issues and their solutions

**User-scoped** (\`scope: "user"\`):
- Personal coding preferences across all projects
- Communication style preferences
- General workflow habits

## Research Approach

This is a **deep research** initialization. Take your time and be thorough (~50+ tool calls). The goal is to genuinely understand the project, not just collect surface-level facts.

**What to uncover:**
- Tech stack and dependencies (explicit and implicit)
- Project structure and architecture
- Build/test/deploy commands and workflows
- Contributors & team dynamics (who works on what?)
- Commit conventions and branching strategy
- Code evolution (major refactors, architecture changes)
- Pain points (areas with lots of bug fixes)
- Implicit conventions not documented anywhere

## Research Techniques

### File-based
- README.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md
- Package manifests (package.json, Cargo.toml, pyproject.toml, go.mod)
- Config files (.eslintrc, tsconfig.json, .prettierrc)
- CI/CD configs (.github/workflows/)

### Git-based
- \`git log --oneline -20\` - Recent history
- \`git branch -a\` - Branching strategy  
- \`git log --format="%s" -50\` - Commit conventions
- \`git shortlog -sn --all | head -10\` - Main contributors

### Explore Agent
Fire parallel explore queries for broad understanding:
\`\`\`
Task(explore, "What is the tech stack and key dependencies?")
Task(explore, "What is the project structure? Key directories?")
Task(explore, "How do you build, test, and run this project?")
Task(explore, "What are the main architectural patterns?")
Task(explore, "What conventions or patterns are used?")
\`\`\`

## How to Do Thorough Research

**Don't just collect data - analyze and cross-reference.**

Bad (shallow):
- Run commands, copy output
- List facts without understanding

Good (thorough):
- Cross-reference findings (if inconsistent, dig deeper)
- Resolve ambiguities (don't leave questions unanswered)
- Read actual file content, not just names
- Look for patterns (what do commits tell you about workflow?)
- Think like a new team member - what would you want to know?

## Saving Memories

Use the \`memory\` tool for each distinct insight:

\`\`\`
memory(mode: "add", content: "...", type: "...", scope: "project")
\`\`\`

**Types:**
- \`project-config\` - tech stack, commands, tooling
- \`architecture\` - codebase structure, key components, data flow
- \`learned-pattern\` - conventions specific to this codebase
- \`error-solution\` - known issues and their fixes
- \`preference\` - coding style preferences (use with user scope)

**Guidelines:**
- Save each distinct insight as a separate memory
- Be concise but include enough context to be useful
- Include the "why" not just the "what" when relevant
- Update memories incrementally as you research (don't wait until the end)

**Good memories:**
- "Uses Bun runtime and package manager. Commands: bun install, bun run dev, bun test"
- "API routes in src/routes/, handlers in src/handlers/. Hono framework."
- "Auth uses Redis sessions, not JWT. Implementation in src/lib/auth.ts"
- "Never use \`any\` type - strict TypeScript. Use \`unknown\` and narrow."
- "Database migrations must be backward compatible - we do rolling deploys"

## Upfront Questions

Before diving in, ask:
1. "Any specific rules I should always follow?"
2. "Preferences for how I communicate? (terse/detailed)"

## Reflection Phase

Before finishing, reflect:
1. **Completeness**: Did you cover commands, architecture, conventions, gotchas?
2. **Quality**: Are memories concise and searchable?
3. **Scope**: Did you correctly separate project vs user knowledge?

Then ask: "I've initialized memory with X insights. Want me to continue refining, or is this good?"

## Your Task

1. Ask upfront questions (research depth, rules, preferences)
2. Check existing memories: \`memory(mode: "list", scope: "project")\`
3. Research based on chosen depth
4. Save memories incrementally as you discover insights
5. Reflect and verify completeness
6. Summarize what was learned and ask if user wants refinement
`;

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${question} (y/n) `, (answer) => {
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

function findOpencodeConfig(): string | null {
  const candidates = [
    join(OPENCODE_CONFIG_DIR, "opencode.jsonc"),
    join(OPENCODE_CONFIG_DIR, "opencode.json"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function addPluginToConfig(configPath: string): boolean {
  try {
    const content = readFileSync(configPath, "utf-8");
    
    if (content.includes("opencode-mem")) {
      console.log("✓ Plugin already registered in config");
      return true;
    }

    const jsonContent = stripJsoncComments(content);
    let config: Record<string, unknown>;
    
    try {
      config = JSON.parse(jsonContent);
    } catch {
      console.error("✗ Failed to parse config file");
      return false;
    }

    const plugins = (config.plugin as string[]) || [];
    plugins.push(PLUGIN_NAME);
    config.plugin = plugins;

    if (configPath.endsWith(".jsonc")) {
      if (content.includes('"plugin"')) {
        const newContent = content.replace(
          /("plugin"\s*:\s*\[)([^\]]*?)(\])/,
          (_match, start, middle, end) => {
            const trimmed = middle.trim();
            if (trimmed === "") {
              return `${start}\n    "${PLUGIN_NAME}"\n  ${end}`;
            }
            return `${start}${middle.trimEnd()},\n    "${PLUGIN_NAME}"\n  ${end}`;
          }
        );
        writeFileSync(configPath, newContent);
      } else {
        const newContent = content.replace(
          /^(\s*\{)/,
          `$1\n  "plugin": ["${PLUGIN_NAME}"],`
        );
        writeFileSync(configPath, newContent);
      }
    } else {
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    console.log(`✓ Added plugin to ${configPath}`);
    return true;
  } catch (err) {
    console.error("✗ Failed to update config:", err);
    return false;
  }
}

function createNewConfig(): boolean {
  const configPath = join(OPENCODE_CONFIG_DIR, "opencode.jsonc");
  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  
  const config = `{
  "plugin": ["${PLUGIN_NAME}"]
}
`;
  
  writeFileSync(configPath, config);
  console.log(`✓ Created ${configPath}`);
  return true;
}

function createCommand(): boolean {
  mkdirSync(OPENCODE_COMMAND_DIR, { recursive: true });
  const commandPath = join(OPENCODE_COMMAND_DIR, "mem-init.md");

  writeFileSync(commandPath, MEM_INIT_COMMAND);
  console.log(`✓ Created /mem-init command`);
  return true;
}

function isOhMyOpencodeInstalled(): boolean {
  const configPath = findOpencodeConfig();
  if (!configPath) return false;
  
  try {
    const content = readFileSync(configPath, "utf-8");
    return content.includes("oh-my-opencode");
  } catch {
    return false;
  }
}

function isAutoCompactAlreadyDisabled(): boolean {
  if (!existsSync(OH_MY_OPENCODE_CONFIG)) return false;
  
  try {
    const content = readFileSync(OH_MY_OPENCODE_CONFIG, "utf-8");
    const config = JSON.parse(content);
    const disabledHooks = config.disabled_hooks as string[] | undefined;
    return disabledHooks?.includes("anthropic-context-window-limit-recovery") ?? false;
  } catch {
    return false;
  }
}

function disableAutoCompactHook(): boolean {
  try {
    let config: Record<string, unknown> = {};
    
    if (existsSync(OH_MY_OPENCODE_CONFIG)) {
      const content = readFileSync(OH_MY_OPENCODE_CONFIG, "utf-8");
      config = JSON.parse(content);
    }
    
    const disabledHooks = (config.disabled_hooks as string[]) || [];
    if (!disabledHooks.includes("anthropic-context-window-limit-recovery")) {
      disabledHooks.push("anthropic-context-window-limit-recovery");
    }
    config.disabled_hooks = disabledHooks;
    
    writeFileSync(OH_MY_OPENCODE_CONFIG, JSON.stringify(config, null, 2));
    console.log(`✓ Disabled anthropic-context-window-limit-recovery hook in oh-my-opencode.json`);
    return true;
  } catch (err) {
    console.error("✗ Failed to update oh-my-opencode.json:", err);
    return false;
  }
}

interface InstallOptions {
  tui: boolean;
  disableAutoCompact: boolean;
}

async function install(options: InstallOptions): Promise<number> {
  console.log("\n🧠 opencode-mem installer\n");

  const rl = options.tui ? createReadline() : null;

  console.log("Step 1: Register plugin in OpenCode config");
  const configPath = findOpencodeConfig();
  
  if (configPath) {
    if (options.tui) {
      const shouldModify = await confirm(rl!, `Add plugin to ${configPath}?`);
      if (!shouldModify) {
        console.log("Skipped.");
      } else {
        addPluginToConfig(configPath);
      }
    } else {
      addPluginToConfig(configPath);
    }
  } else {
    if (options.tui) {
      const shouldCreate = await confirm(rl!, "No OpenCode config found. Create one?");
      if (!shouldCreate) {
        console.log("Skipped.");
      } else {
        createNewConfig();
      }
    } else {
      createNewConfig();
    }
  }

  console.log("\nStep 2: Create /mem-init command");
  if (options.tui) {
    const shouldCreate = await confirm(rl!, "Add /mem-init command?");
    if (!shouldCreate) {
      console.log("Skipped.");
    } else {
      createCommand();
    }
  } else {
    createCommand();
  }

  if (isOhMyOpencodeInstalled()) {
    console.log("\nStep 3: Configure Oh My OpenCode");
    console.log("Detected Oh My OpenCode plugin.");
    
    if (isAutoCompactAlreadyDisabled()) {
      console.log("✓ anthropic-context-window-limit-recovery hook already disabled");
    } else {
      if (options.tui) {
        const shouldDisable = await confirm(rl!, "Disable anthropic-context-window-limit-recovery hook?");
        if (!shouldDisable) {
          console.log("Skipped.");
        } else {
          disableAutoCompactHook();
        }
      } else if (options.disableAutoCompact) {
        disableAutoCompactHook();
      } else {
        console.log("Skipped. Use --disable-context-recovery to disable the hook in non-interactive mode.");
      }
    }
  }

  console.log("\n" + "─".repeat(50));
  console.log("\n✓ Setup complete! Restart OpenCode to activate.\n");
  console.log("The memory system runs locally with no API keys required.");
  console.log("Data is stored in: ~/.opencode-mem/data\n");
  console.log("Optional: Configure custom embedding model in ~/.config/opencode/opencode-mem.jsonc");
  console.log("\n" + "─".repeat(50) + "\n");

  if (rl) rl.close();
  return 0;
}

function printHelp(): void {
  console.log(`
opencode-mem - Local persistent memory for OpenCode agents

Commands:
  install                    Install and configure the plugin
    --no-tui                 Run in non-interactive mode (for LLM agents)
    --disable-context-recovery   Disable Oh My OpenCode's context-window-limit-recovery hook (use with --no-tui)

Examples:
  bunx opencode-mem@latest install
  bunx opencode-mem@latest install --no-tui
  bunx opencode-mem@latest install --no-tui --disable-context-recovery
`);
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
  printHelp();
  process.exit(0);
}

if (args[0] === "install") {
  const noTui = args.includes("--no-tui");
  const disableAutoCompact = args.includes("--disable-context-recovery");
  install({ tui: !noTui, disableAutoCompact }).then((code) => process.exit(code));
} else if (args[0] === "setup") {
  console.log("Note: 'setup' is deprecated. Use 'install' instead.\n");
  const noTui = args.includes("--no-tui");
  const disableAutoCompact = args.includes("--disable-context-recovery");
  install({ tui: !noTui, disableAutoCompact }).then((code) => process.exit(code));
} else {
  console.error(`Unknown command: ${args[0]}`);
  printHelp();
  process.exit(1);
}
