// src/services/team-knowledge/extractors/architecture-extractor.ts

import { BaseExtractor } from "./base-extractor.js";
import type { KnowledgeExtractResult } from "../../../types/team-knowledge.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface DirectoryNode {
  name: string;
  type: "file" | "directory";
  children?: DirectoryNode[];
}

interface ArchitecturePattern {
  name: string;
  description: string;
  tag: string;
}

interface EntryPoint {
  file: string;
  description: string;
}

export class ArchitectureExtractor extends BaseExtractor {
  readonly type = "architecture" as const;
  readonly sourceType = "code" as const;

  private readonly ignoreDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    "tmp",
    "temp",
    "__pycache__",
    ".venv",
    "vendor",
    "target",
    "out",
    ".idea",
    ".vscode",
  ]);

  private readonly ignoreFiles = new Set([
    ".DS_Store",
    "Thumbs.db",
    ".gitignore",
    ".npmrc",
    ".env",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "pnpm-lock.yaml",
  ]);

  async extract(directory: string): Promise<KnowledgeExtractResult> {
    const items: KnowledgeExtractResult["items"] = [];
    const errors: string[] = [];

    try {
      // 1. Scan and format directory structure (max depth 3)
      const structure = this.scanDirectory(directory, 3);
      const structureContent = this.formatStructure(structure);

      items.push(
        this.createItem(
          "Project Structure",
          `## Project Directory Structure\n\n\`\`\`\n${structureContent}\`\`\``,
          ".",
          ["structure", "organization", "layout"],
          0.85,
          "structure"
        )
      );

      // 2. Detect architecture patterns
      const patterns = this.detectPatterns(directory);
      if (patterns.length > 0) {
        items.push(
          this.createItem(
            "Architecture Patterns",
            `## Detected Architecture Patterns\n\n${patterns.map((p) => `- **${p.name}**: ${p.description}`).join("\n")}`,
            ".",
            ["patterns", "architecture", ...patterns.map((p) => p.tag)],
            0.8,
            "patterns"
          )
        );
      }

      // 3. Detect entry points
      const entryPoints = this.detectEntryPoints(directory);
      if (entryPoints.length > 0) {
        items.push(
          this.createItem(
            "Entry Points",
            `## Application Entry Points\n\n${entryPoints.map((e) => `- \`${e.file}\`: ${e.description}`).join("\n")}`,
            ".",
            ["entry", "main", "startup"],
            0.9,
            "entry-points"
          )
        );
      }
    } catch (e) {
      errors.push(`Architecture extraction failed: ${e}`);
    }

    return { items, errors };
  }

  /**
   * Recursively scans a directory up to maxDepth levels
   */
  private scanDirectory(dir: string, maxDepth: number, currentDepth: number = 0): DirectoryNode[] {
    if (currentDepth >= maxDepth) return [];

    try {
      const entries = readdirSync(dir);
      const nodes: DirectoryNode[] = [];

      for (const entry of entries) {
        // Skip ignored directories and files
        if (this.ignoreDirs.has(entry) || this.ignoreFiles.has(entry)) continue;
        // Skip hidden files except .github
        if (entry.startsWith(".") && entry !== ".github") continue;

        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          nodes.push({
            name: entry,
            type: "directory",
            children: this.scanDirectory(fullPath, maxDepth, currentDepth + 1),
          });
        } else {
          nodes.push({ name: entry, type: "file" });
        }
      }

      // Sort: directories first, then alphabetically
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return [];
    }
  }

  /**
   * Formats directory structure as an ASCII tree
   */
  private formatStructure(nodes: DirectoryNode[], indent: string = ""): string {
    let result = "";

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const isLast = i === nodes.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const childIndent = indent + (isLast ? "    " : "│   ");

      result += `${indent}${prefix}${node.name}${node.type === "directory" ? "/" : ""}\n`;

      if (node.children && node.children.length > 0) {
        result += this.formatStructure(node.children, childIndent);
      }
    }

    return result;
  }

  /**
   * Detects common architecture patterns based on directory structure
   */
  private detectPatterns(directory: string): ArchitecturePattern[] {
    const patterns: ArchitecturePattern[] = [];

    const hasDir = (name: string) => existsSync(join(directory, name));
    const hasSrcDir = (name: string) => existsSync(join(directory, "src", name));

    // MVC Pattern (controllers + models + views)
    if (
      (hasSrcDir("controllers") || hasSrcDir("controller")) &&
      (hasSrcDir("models") || hasSrcDir("model")) &&
      (hasSrcDir("views") || hasSrcDir("view"))
    ) {
      patterns.push({
        name: "MVC",
        description: "Model-View-Controller pattern detected",
        tag: "mvc",
      });
    }

    // Clean Architecture / Layered (domain + usecases + infrastructure)
    if (
      (hasSrcDir("domain") || hasSrcDir("entities")) &&
      (hasSrcDir("usecases") || hasSrcDir("application")) &&
      (hasSrcDir("infrastructure") || hasSrcDir("adapters"))
    ) {
      patterns.push({
        name: "Clean Architecture",
        description: "Domain-driven layered architecture",
        tag: "clean-architecture",
      });
    }

    // Feature-based / Module-based (features/ or modules/)
    if (hasSrcDir("features") || hasSrcDir("modules")) {
      patterns.push({
        name: "Feature-based",
        description: "Code organized by feature/module",
        tag: "feature-based",
      });
    }

    // Next.js App Router (app/ with page.tsx)
    if (hasDir("app") && existsSync(join(directory, "app", "page.tsx"))) {
      patterns.push({
        name: "Next.js App Router",
        description: "Next.js 13+ App Router structure",
        tag: "nextjs-app",
      });
    }

    // Next.js Pages Router (pages/ with index.tsx or _app.tsx)
    if (
      hasDir("pages") &&
      (existsSync(join(directory, "pages", "index.tsx")) ||
        existsSync(join(directory, "pages", "_app.tsx")))
    ) {
      patterns.push({
        name: "Next.js Pages Router",
        description: "Next.js Pages Router structure",
        tag: "nextjs-pages",
      });
    }

    // API Routes (routes/ or api/ or pages/api/)
    if (hasSrcDir("routes") || hasSrcDir("api") || hasDir("pages/api")) {
      patterns.push({
        name: "API Layer",
        description: "Dedicated API/routes directory",
        tag: "api-routes",
      });
    }

    // Service Layer (services/)
    if (hasSrcDir("services") || hasSrcDir("service")) {
      patterns.push({
        name: "Service Layer",
        description: "Business logic encapsulated in services",
        tag: "service-layer",
      });
    }

    // Repository Pattern (repositories/)
    if (hasSrcDir("repositories") || hasSrcDir("repository")) {
      patterns.push({
        name: "Repository Pattern",
        description: "Data access abstraction layer",
        tag: "repository",
      });
    }

    // Components-based (common in React/Vue projects)
    if (hasSrcDir("components") || hasDir("components")) {
      patterns.push({
        name: "Component-based",
        description: "UI organized as reusable components",
        tag: "component-based",
      });
    }

    // Hooks pattern (React hooks)
    if (hasSrcDir("hooks") || hasDir("hooks")) {
      patterns.push({
        name: "Hooks Pattern",
        description: "Custom React hooks for shared logic",
        tag: "hooks",
      });
    }

    // Store/State management (store/ or stores/)
    if (hasSrcDir("store") || hasSrcDir("stores") || hasDir("store") || hasDir("stores")) {
      patterns.push({
        name: "State Management",
        description: "Centralized state management layer",
        tag: "state-management",
      });
    }

    // Utils/Helpers pattern
    if (hasSrcDir("utils") || hasSrcDir("helpers") || hasSrcDir("lib")) {
      patterns.push({
        name: "Utilities Layer",
        description: "Shared utility functions and helpers",
        tag: "utilities",
      });
    }

    return patterns;
  }

  /**
   * Detects common entry point files
   */
  private detectEntryPoints(directory: string): EntryPoint[] {
    const entryPoints: EntryPoint[] = [];

    const checkFile = (path: string, description: string) => {
      if (existsSync(join(directory, path))) {
        entryPoints.push({ file: path, description });
      }
    };

    // Node.js / TypeScript entry points
    checkFile("src/index.ts", "Main TypeScript entry");
    checkFile("src/index.js", "Main JavaScript entry");
    checkFile("src/main.ts", "Main TypeScript entry");
    checkFile("src/main.js", "Main JavaScript entry");
    checkFile("index.ts", "Root TypeScript entry");
    checkFile("index.js", "Root JavaScript entry");

    // Next.js App Router
    checkFile("app/layout.tsx", "Next.js root layout");
    checkFile("app/page.tsx", "Next.js home page");

    // Next.js Pages Router
    checkFile("pages/_app.tsx", "Next.js Pages Router app");
    checkFile("pages/_app.js", "Next.js Pages Router app");
    checkFile("pages/index.tsx", "Next.js Pages Router home");
    checkFile("pages/index.js", "Next.js Pages Router home");

    // Plugin entry points (OpenCode-specific)
    checkFile("src/plugin.ts", "Plugin entry point");
    checkFile("src/plugin.js", "Plugin entry point");

    // Vite/Webpack
    checkFile("vite.config.ts", "Vite configuration");
    checkFile("vite.config.js", "Vite configuration");
    checkFile("webpack.config.js", "Webpack configuration");

    // Python entry points
    checkFile("main.py", "Python main entry");
    checkFile("app.py", "Python app entry");
    checkFile("src/__main__.py", "Python package entry");
    checkFile("__main__.py", "Python package entry");

    // Go entry points
    checkFile("main.go", "Go main entry");
    checkFile("cmd/main.go", "Go cmd entry");

    // Rust entry points
    checkFile("src/main.rs", "Rust main entry");
    checkFile("src/lib.rs", "Rust library entry");

    // Java/Kotlin entry points
    checkFile("src/main/java/Main.java", "Java main entry");
    checkFile("src/main/kotlin/Main.kt", "Kotlin main entry");

    return entryPoints;
  }
}

export const architectureExtractor = new ArchitectureExtractor();
