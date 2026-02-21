// src/services/team-knowledge/extractors/tech-stack-extractor.ts

import { BaseExtractor } from "./base-extractor.js";
import type { KnowledgeExtractResult } from "../../../types/team-knowledge.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

export class TechStackExtractor extends BaseExtractor {
  readonly type = "tech-stack" as const;
  readonly sourceType = "config" as const;

  async extract(directory: string): Promise<KnowledgeExtractResult> {
    const items: KnowledgeExtractResult["items"] = [];
    const errors: string[] = [];

    // Extract from package.json
    try {
      const pkgResult = await this.extractPackageJson(directory);
      items.push(...pkgResult);
    } catch (e) {
      errors.push(`package.json: ${e}`);
    }

    // Extract from go.mod
    try {
      const goResult = await this.extractGoMod(directory);
      items.push(...goResult);
    } catch (e) {
      // Silent - file may not exist
    }

    // Extract from Dockerfile
    try {
      const dockerResult = await this.extractDockerfile(directory);
      items.push(...dockerResult);
    } catch (e) {
      // Silent - file may not exist
    }

    // Extract from requirements.txt
    try {
      const pyResult = await this.extractRequirementsTxt(directory);
      items.push(...pyResult);
    } catch (e) {
      // Silent - file may not exist
    }

    return { items, errors };
  }

  private async extractPackageJson(directory: string): Promise<KnowledgeExtractResult["items"]> {
    const pkgPath = join(directory, "package.json");
    if (!existsSync(pkgPath)) return [];

    const content = readFileSync(pkgPath, "utf-8");
    const pkg: PackageJson = JSON.parse(content);

    const items: KnowledgeExtractResult["items"] = [];

    // Main dependencies
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      const deps = Object.entries(pkg.dependencies)
        .map(([name, version]) => `- ${name}: ${version}`)
        .join("\n");

      const majorDeps = this.identifyMajorFrameworks(pkg.dependencies);

      items.push(
        this.createItem(
          "Runtime Dependencies",
          `## Runtime Dependencies\n\n${deps}\n\n### Key Frameworks\n${majorDeps.join(", ") || "None identified"}`,
          "package.json",
          ["dependencies", "npm", ...majorDeps.map((d) => d.toLowerCase())],
          0.9,
          "dependencies"
        )
      );
    }

    // Dev dependencies
    if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
      const devDeps = Object.entries(pkg.devDependencies)
        .map(([name, version]) => `- ${name}: ${version}`)
        .join("\n");

      items.push(
        this.createItem(
          "Development Dependencies",
          `## Development Dependencies\n\n${devDeps}`,
          "package.json",
          ["devDependencies", "npm", "tooling"],
          0.8,
          "devDependencies"
        )
      );
    }

    // Engines
    if (pkg.engines) {
      const engines = Object.entries(pkg.engines)
        .map(([name, version]) => `- ${name}: ${version}`)
        .join("\n");

      items.push(
        this.createItem(
          "Runtime Engines",
          `## Required Engines\n\n${engines}`,
          "package.json",
          ["engines", "runtime", "node"],
          0.95,
          "engines"
        )
      );
    }

    return items;
  }

  private identifyMajorFrameworks(deps: Record<string, string>): string[] {
    const frameworks: string[] = [];
    const frameworkMap: Record<string, string> = {
      react: "React",
      vue: "Vue",
      angular: "Angular",
      next: "Next.js",
      nuxt: "Nuxt",
      express: "Express",
      fastify: "Fastify",
      nestjs: "NestJS",
      "@nestjs/core": "NestJS",
      typescript: "TypeScript",
      tailwindcss: "Tailwind CSS",
      prisma: "Prisma",
      "@prisma/client": "Prisma",
    };

    for (const dep of Object.keys(deps)) {
      for (const [key, name] of Object.entries(frameworkMap)) {
        if (dep === key || dep.startsWith(`${key}/`) || dep.startsWith(`@${key}/`)) {
          if (!frameworks.includes(name)) {
            frameworks.push(name);
          }
        }
      }
    }

    return frameworks;
  }

  private async extractGoMod(directory: string): Promise<KnowledgeExtractResult["items"]> {
    const modPath = join(directory, "go.mod");
    if (!existsSync(modPath)) return [];

    const content = readFileSync(modPath, "utf-8");
    const lines = content.split("\n");

    const moduleName = lines
      .find((l) => l.startsWith("module "))
      ?.replace("module ", "")
      .trim();
    const goVersion = lines
      .find((l) => l.startsWith("go "))
      ?.replace("go ", "")
      .trim();

    const requires: string[] = [];
    let inRequire = false;

    for (const line of lines) {
      if (line.startsWith("require (")) {
        inRequire = true;
        continue;
      }
      if (line.startsWith(")")) {
        inRequire = false;
        continue;
      }
      if (inRequire && line.trim()) {
        requires.push(`- ${line.trim()}`);
      }
      if (line.startsWith("require ") && !line.includes("(")) {
        requires.push(`- ${line.replace("require ", "").trim()}`);
      }
    }

    return [
      this.createItem(
        "Go Module",
        `## Go Module\n\n- Module: ${moduleName}\n- Go Version: ${goVersion}\n\n### Dependencies\n${requires.join("\n")}`,
        "go.mod",
        ["go", "golang", "module"],
        0.9,
        "go.mod"
      ),
    ];
  }

  private async extractDockerfile(directory: string): Promise<KnowledgeExtractResult["items"]> {
    const dockerPath = join(directory, "Dockerfile");
    if (!existsSync(dockerPath)) return [];

    const content = readFileSync(dockerPath, "utf-8");
    const fromLines = content
      .split("\n")
      .filter((l) => l.trim().toUpperCase().startsWith("FROM"))
      .map((l) => `- ${l.trim()}`);

    if (fromLines.length === 0) return [];

    return [
      this.createItem(
        "Docker Base Images",
        `## Docker Configuration\n\n### Base Images\n${fromLines.join("\n")}`,
        "Dockerfile",
        ["docker", "container", "deployment"],
        0.85,
        "dockerfile"
      ),
    ];
  }

  private async extractRequirementsTxt(
    directory: string
  ): Promise<KnowledgeExtractResult["items"]> {
    const reqPath = join(directory, "requirements.txt");
    if (!existsSync(reqPath)) return [];

    const content = readFileSync(reqPath, "utf-8");
    const deps = content
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => `- ${l.trim()}`)
      .join("\n");

    if (!deps) return [];

    return [
      this.createItem(
        "Python Dependencies",
        `## Python Dependencies\n\n${deps}`,
        "requirements.txt",
        ["python", "pip", "dependencies"],
        0.9,
        "requirements"
      ),
    ];
  }
}

export const techStackExtractor = new TechStackExtractor();
