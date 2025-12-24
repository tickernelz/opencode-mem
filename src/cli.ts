#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";

const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_COMMAND_DIR = join(OPENCODE_CONFIG_DIR, "command");
const PLUGIN_NAME = "opencode-supermemory@latest";

const SUPERMEMORY_INIT_COMMAND = `---
description: Initialize Supermemory with comprehensive codebase knowledge
---

# Initializing Supermemory

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

Use the \`supermemory\` tool for each distinct insight:

\`\`\`
supermemory(mode: "add", content: "...", type: "...", scope: "project")
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
2. Check existing memories: \`supermemory(mode: "list", scope: "project")\`
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

async function installPlugin(): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  
  // Detect package manager
  let pm = "npm";
  try {
    execSync("bun --version", { stdio: "ignore" });
    pm = "bun";
  } catch {
    try {
      execSync("pnpm --version", { stdio: "ignore" });
      pm = "pnpm";
    } catch {
      // fallback to npm
    }
  }

  console.log(`Installing ${PLUGIN_NAME} with ${pm}...`);
  
  try {
    execSync(`${pm} install -g ${PLUGIN_NAME}`, { stdio: "inherit" });
    return true;
  } catch {
    console.error("Failed to install plugin globally.");
    return false;
  }
}

function createCommand(): boolean {
  mkdirSync(OPENCODE_COMMAND_DIR, { recursive: true });
  const commandPath = join(OPENCODE_COMMAND_DIR, "supermemory-init.md");

  if (existsSync(commandPath)) {
    console.log(`Command already exists at ${commandPath}`);
    return true;
  }

  writeFileSync(commandPath, SUPERMEMORY_INIT_COMMAND);
  console.log(`Created /supermemory-init command`);
  return true;
}

function findOpencodeConfig(): string | null {
  const candidates = [
    join(OPENCODE_CONFIG_DIR, "config.jsonc"),
    join(OPENCODE_CONFIG_DIR, "config.json"),
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
    
    // Check if plugin already registered
    if (content.includes("opencode-supermemory")) {
      console.log("Plugin already in config");
      return true;
    }

    // Parse JSONC (strip comments for parsing)
    const jsonContent = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    let config: Record<string, unknown>;
    
    try {
      config = JSON.parse(jsonContent);
    } catch {
      console.error("Failed to parse config file");
      return false;
    }

    // Add plugin to array
    const plugins = (config.plugin as string[]) || [];
    plugins.push(PLUGIN_NAME);
    config.plugin = plugins;

    // Write back (preserve formatting if possible)
    if (configPath.endsWith(".jsonc")) {
      // For JSONC, just append to plugin array in original content
      if (content.includes('"plugin"')) {
        // Find plugin array and add to it
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
        // No plugin key, add it
        const newContent = content.replace(
          /^(\s*\{)/,
          `$1\n  "plugin": ["${PLUGIN_NAME}"],`
        );
        writeFileSync(configPath, newContent);
      }
    } else {
      // For JSON, just write formatted
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    console.log(`Added ${PLUGIN_NAME} to ${configPath}`);
    return true;
  } catch (err) {
    console.error("Failed to update config:", err);
    return false;
  }
}

function createNewConfig(): boolean {
  const configPath = join(OPENCODE_CONFIG_DIR, "config.jsonc");
  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  
  const config = {
    plugin: [PLUGIN_NAME],
  };
  
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Created ${configPath} with plugin registered`);
  return true;
}

async function setup(): Promise<void> {
  const rl = createReadline();

  console.log("\nopencode-supermemory setup\n");

  // Step 1: Install plugin globally
  const shouldInstall = await confirm(rl, "Install opencode-supermemory globally?");
  if (!shouldInstall) {
    console.log("Aborted.");
    rl.close();
    process.exit(0);
  }

  const installed = await installPlugin();
  if (!installed) {
    console.log("Aborted.");
    rl.close();
    process.exit(1);
  }

  // Step 2: Create command
  const shouldCreateCommand = await confirm(rl, "Add /supermemory-init command?");
  if (!shouldCreateCommand) {
    console.log("Aborted.");
    rl.close();
    process.exit(0);
  }

  createCommand();

  // Step 3: Add to config
  const configPath = findOpencodeConfig();
  
  if (configPath) {
    const shouldModifyConfig = await confirm(rl, `Add plugin to ${configPath}?`);
    if (!shouldModifyConfig) {
      console.log("Aborted.");
      rl.close();
      process.exit(0);
    }
    addPluginToConfig(configPath);
  } else {
    const shouldCreateConfig = await confirm(rl, "No OpenCode config found. Create one?");
    if (!shouldCreateConfig) {
      console.log("Aborted.");
      rl.close();
      process.exit(0);
    }
    createNewConfig();
  }

  console.log("\nSetup complete!");
  console.log("Set SUPERMEMORY_API_KEY and restart OpenCode.");
  
  rl.close();
}

function printHelp(): void {
  console.log(`
opencode-supermemory CLI

Commands:
  setup    Interactive setup wizard

Examples:
  npx opencode-supermemory setup
  bunx opencode-supermemory setup
`);
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
  printHelp();
  process.exit(0);
}

if (args[0] === "setup") {
  setup();
} else {
  console.error(`Unknown command: ${args.join(" ")}`);
  printHelp();
  process.exit(1);
}
