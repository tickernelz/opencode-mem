// src/services/team-knowledge/extractors/coding-standard-extractor.ts

import { BaseExtractor } from "./base-extractor.js";
import type { KnowledgeExtractResult } from "../../../types/team-knowledge.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface PrettierConfig {
  semi?: boolean;
  singleQuote?: boolean;
  tabWidth?: number;
  useTabs?: boolean;
  trailingComma?: "none" | "es5" | "all";
  printWidth?: number;
  endOfLine?: "lf" | "crlf" | "cr" | "auto";
  bracketSpacing?: boolean;
  arrowParens?: "always" | "avoid";
}

interface TSConfig {
  compilerOptions?: {
    strict?: boolean;
    target?: string;
    module?: string;
    moduleResolution?: string;
    jsx?: string;
    paths?: Record<string, string[]>;
    baseUrl?: string;
    esModuleInterop?: boolean;
    skipLibCheck?: boolean;
    outDir?: string;
    rootDir?: string;
    declaration?: boolean;
    sourceMap?: boolean;
    noEmit?: boolean;
    isolatedModules?: boolean;
    resolveJsonModule?: boolean;
    allowJs?: boolean;
    checkJs?: boolean;
    noImplicitAny?: boolean;
    strictNullChecks?: boolean;
  };
  include?: string[];
  exclude?: string[];
}

interface BiomeConfig {
  formatter?: {
    enabled?: boolean;
    indentStyle?: "tab" | "space";
    indentWidth?: number;
    lineWidth?: number;
  };
  linter?: {
    enabled?: boolean;
    rules?: {
      recommended?: boolean;
      [category: string]: unknown;
    };
  };
  javascript?: {
    formatter?: {
      quoteStyle?: "single" | "double";
      trailingComma?: "none" | "es5" | "all";
      semicolons?: "always" | "asNeeded";
    };
  };
}

export class CodingStandardExtractor extends BaseExtractor {
  readonly type = "coding-standard" as const;
  readonly sourceType = "config" as const;

  async extract(directory: string): Promise<KnowledgeExtractResult> {
    const items: KnowledgeExtractResult["items"] = [];
    const errors: string[] = [];

    // Extract ESLint config
    try {
      const eslintResult = await this.extractESLint(directory);
      items.push(...eslintResult);
    } catch (e) {
      if (e instanceof Error && !e.message.includes("not found")) {
        errors.push(`ESLint: ${e.message}`);
      }
    }

    // Extract Prettier config
    try {
      const prettierResult = await this.extractPrettier(directory);
      items.push(...prettierResult);
    } catch (e) {
      if (e instanceof Error && !e.message.includes("not found")) {
        errors.push(`Prettier: ${e.message}`);
      }
    }

    // Extract TypeScript config
    try {
      const tsResult = await this.extractTypeScript(directory);
      items.push(...tsResult);
    } catch (e) {
      if (e instanceof Error && !e.message.includes("not found")) {
        errors.push(`TypeScript: ${e.message}`);
      }
    }

    // Extract EditorConfig
    try {
      const editorResult = await this.extractEditorConfig(directory);
      items.push(...editorResult);
    } catch (e) {
      if (e instanceof Error && !e.message.includes("not found")) {
        errors.push(`EditorConfig: ${e.message}`);
      }
    }

    // Extract Biome config
    try {
      const biomeResult = await this.extractBiome(directory);
      items.push(...biomeResult);
    } catch (e) {
      if (e instanceof Error && !e.message.includes("not found")) {
        errors.push(`Biome: ${e.message}`);
      }
    }

    return { items, errors };
  }

  private async extractESLint(directory: string): Promise<KnowledgeExtractResult["items"]> {
    // Check for various ESLint config file patterns
    const eslintPatterns = [
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yaml",
      ".eslintrc.yml",
      ".eslintrc",
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
    ];

    let configFile: string | null = null;
    let configContent: string | null = null;

    for (const pattern of eslintPatterns) {
      const filePath = join(directory, pattern);
      if (existsSync(filePath)) {
        configFile = pattern;
        configContent = readFileSync(filePath, "utf-8");
        break;
      }
    }

    if (!configFile || !configContent) {
      throw new Error("ESLint config not found");
    }

    // For JS/MJS/CJS files, we can only provide the file reference
    // For JSON/YAML, we can parse and summarize
    let summary = `## ESLint Configuration\n\nConfig file: \`${configFile}\`\n\n`;

    if (configFile.endsWith(".json") || configFile === ".eslintrc") {
      try {
        const config = JSON.parse(configContent);
        summary += this.summarizeESLintConfig(config);
      } catch {
        summary += "*(JSON parsing failed - see source file)*\n";
      }
    } else if (configFile.endsWith(".yaml") || configFile.endsWith(".yml")) {
      summary += "*(YAML config - see source file for details)*\n";
    } else {
      // JS config - extract key information via regex
      summary += this.extractESLintJSConfig(configContent);
    }

    return [
      this.createItem(
        "ESLint Configuration",
        summary,
        configFile,
        ["eslint", "linting", "code-quality"],
        0.85,
        "eslint"
      ),
    ];
  }

  private summarizeESLintConfig(config: Record<string, unknown>): string {
    const parts: string[] = [];

    if (config.extends) {
      const extendsArr = Array.isArray(config.extends) ? config.extends : [config.extends];
      parts.push(`### Extends\n${extendsArr.map((e) => `- ${e}`).join("\n")}`);
    }

    if (config.parser) {
      parts.push(`### Parser\n- ${config.parser}`);
    }

    if (config.plugins && Array.isArray(config.plugins) && config.plugins.length > 0) {
      parts.push(`### Plugins\n${config.plugins.map((p) => `- ${p}`).join("\n")}`);
    }

    if (config.rules && typeof config.rules === "object") {
      const rules = Object.entries(config.rules as Record<string, unknown>);
      if (rules.length > 0) {
        const ruleSummary = rules
          .slice(0, 15) // Limit to first 15 rules
          .map(([rule, value]) => {
            const severity = Array.isArray(value) ? value[0] : value;
            return `- \`${rule}\`: ${severity}`;
          })
          .join("\n");
        parts.push(
          `### Key Rules\n${ruleSummary}${rules.length > 15 ? `\n*(+${rules.length - 15} more rules)*` : ""}`
        );
      }
    }

    if (config.env && typeof config.env === "object") {
      const envs = Object.entries(config.env as Record<string, boolean>)
        .filter(([, enabled]) => enabled)
        .map(([env]) => env);
      if (envs.length > 0) {
        parts.push(`### Environments\n${envs.map((e) => `- ${e}`).join("\n")}`);
      }
    }

    return parts.join("\n\n") || "*(Empty or minimal config)*";
  }

  private extractESLintJSConfig(content: string): string {
    const parts: string[] = [];

    // Look for extends patterns
    const extendsMatch = content.match(/extends\s*:\s*\[([^\]]+)\]/);
    if (extendsMatch && extendsMatch[1]) {
      const extends_ = extendsMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/['"]/g, ""))
        .filter(Boolean);
      if (extends_.length > 0) {
        parts.push(`### Extends\n${extends_.map((e) => `- ${e}`).join("\n")}`);
      }
    }

    // Look for plugins
    const pluginsMatch = content.match(/plugins\s*:\s*\[([^\]]+)\]/);
    if (pluginsMatch && pluginsMatch[1]) {
      const plugins = pluginsMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/['"]/g, ""))
        .filter(Boolean);
      if (plugins.length > 0) {
        parts.push(`### Plugins\n${plugins.map((p) => `- ${p}`).join("\n")}`);
      }
    }

    // Look for TypeScript parser
    if (content.includes("@typescript-eslint/parser") || content.includes("typescript-eslint")) {
      parts.push("### TypeScript Support\n- Using TypeScript ESLint parser");
    }

    return parts.join("\n\n") || "*(JS/TS config - see source file for full details)*";
  }

  private async extractPrettier(directory: string): Promise<KnowledgeExtractResult["items"]> {
    const prettierPatterns = [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.json5",
      ".prettierrc.yaml",
      ".prettierrc.yml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
    ];

    let configFile: string | null = null;
    let config: PrettierConfig | null = null;

    for (const pattern of prettierPatterns) {
      const filePath = join(directory, pattern);
      if (existsSync(filePath)) {
        configFile = pattern;
        const content = readFileSync(filePath, "utf-8");

        // Only parse JSON configs
        if (pattern.endsWith(".json") || pattern === ".prettierrc" || pattern.endsWith(".json5")) {
          try {
            config = JSON.parse(content);
          } catch {
            // Not valid JSON, might be JSON5 or another format
          }
        }
        break;
      }
    }

    // Also check package.json for prettier key
    if (!configFile) {
      const pkgPath = join(directory, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (pkg.prettier) {
            configFile = "package.json";
            config = pkg.prettier;
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!configFile) {
      throw new Error("Prettier config not found");
    }

    let summary = `## Prettier Configuration\n\nConfig file: \`${configFile}\`\n\n`;

    if (config) {
      const options: string[] = [];

      if (config.semi !== undefined) {
        options.push(`- **Semicolons**: ${config.semi ? "Yes" : "No"}`);
      }
      if (config.singleQuote !== undefined) {
        options.push(`- **Quote Style**: ${config.singleQuote ? "Single" : "Double"}`);
      }
      if (config.tabWidth !== undefined) {
        options.push(`- **Tab Width**: ${config.tabWidth}`);
      }
      if (config.useTabs !== undefined) {
        options.push(`- **Use Tabs**: ${config.useTabs ? "Yes" : "No (spaces)"}`);
      }
      if (config.trailingComma !== undefined) {
        options.push(`- **Trailing Comma**: ${config.trailingComma}`);
      }
      if (config.printWidth !== undefined) {
        options.push(`- **Print Width**: ${config.printWidth}`);
      }
      if (config.endOfLine !== undefined) {
        options.push(`- **End of Line**: ${config.endOfLine}`);
      }
      if (config.bracketSpacing !== undefined) {
        options.push(`- **Bracket Spacing**: ${config.bracketSpacing ? "Yes" : "No"}`);
      }
      if (config.arrowParens !== undefined) {
        options.push(`- **Arrow Parens**: ${config.arrowParens}`);
      }

      summary +=
        options.length > 0
          ? `### Formatting Options\n${options.join("\n")}`
          : "*(Using default options)*";
    } else {
      summary += "*(JS/YAML config - see source file for details)*";
    }

    return [
      this.createItem(
        "Prettier Configuration",
        summary,
        configFile,
        ["prettier", "formatting", "code-style"],
        0.9,
        "prettier"
      ),
    ];
  }

  private async extractTypeScript(directory: string): Promise<KnowledgeExtractResult["items"]> {
    const tsConfigPath = join(directory, "tsconfig.json");
    if (!existsSync(tsConfigPath)) {
      throw new Error("TypeScript config not found");
    }

    const content = readFileSync(tsConfigPath, "utf-8");
    let config: TSConfig;

    try {
      // First try plain JSON parse (works for most tsconfig files)
      config = JSON.parse(content);
    } catch {
      // If parsing fails, try stripping comments (but be careful with glob patterns like @/*)
      try {
        // Strip single-line comments only (safer than multi-line)
        const cleanContent = content
          .split("\n")
          .map((line) => {
            // Remove // comments only if not inside a string
            const commentIndex = line.indexOf("//");
            if (commentIndex === -1) return line;
            // Check if // is inside quotes by counting quotes before it
            const beforeComment = line.substring(0, commentIndex);
            const quoteCount = (beforeComment.match(/"/g) || []).length;
            if (quoteCount % 2 === 0) {
              // Even quotes = comment is outside strings
              return beforeComment;
            }
            return line;
          })
          .join("\n")
          .replace(/,(\s*[}\]])/g, "$1"); // Remove trailing commas
        config = JSON.parse(cleanContent);
      } catch {
        return [
          this.createItem(
            "TypeScript Configuration",
            `## TypeScript Configuration\n\nConfig file: \`tsconfig.json\`\n\n*(Config contains syntax that couldn't be parsed - see source file)*`,
            "tsconfig.json",
            ["typescript", "compiler", "type-checking"],
            0.7,
            "typescript"
          ),
        ];
      }
    }

    let summary = `## TypeScript Configuration\n\n`;

    const opts = config.compilerOptions;
    if (opts) {
      const compilerOpts: string[] = [];

      // Strictness
      if (opts.strict !== undefined) {
        compilerOpts.push(`- **Strict Mode**: ${opts.strict ? "Enabled" : "Disabled"}`);
      }
      if (opts.noImplicitAny !== undefined) {
        compilerOpts.push(`- **No Implicit Any**: ${opts.noImplicitAny}`);
      }
      if (opts.strictNullChecks !== undefined) {
        compilerOpts.push(`- **Strict Null Checks**: ${opts.strictNullChecks}`);
      }

      // Target & Module
      if (opts.target) {
        compilerOpts.push(`- **Target**: ${opts.target}`);
      }
      if (opts.module) {
        compilerOpts.push(`- **Module**: ${opts.module}`);
      }
      if (opts.moduleResolution) {
        compilerOpts.push(`- **Module Resolution**: ${opts.moduleResolution}`);
      }

      // JSX
      if (opts.jsx) {
        compilerOpts.push(`- **JSX**: ${opts.jsx}`);
      }

      // Path aliases
      if (opts.paths && Object.keys(opts.paths).length > 0) {
        const pathAliases = Object.entries(opts.paths)
          .map(([alias, paths]) => `  - \`${alias}\` → ${paths.join(", ")}`)
          .join("\n");
        compilerOpts.push(`- **Path Aliases**:\n${pathAliases}`);
      }
      if (opts.baseUrl) {
        compilerOpts.push(`- **Base URL**: ${opts.baseUrl}`);
      }

      // Output
      if (opts.outDir) {
        compilerOpts.push(`- **Output Dir**: ${opts.outDir}`);
      }
      if (opts.declaration !== undefined) {
        compilerOpts.push(`- **Declarations**: ${opts.declaration}`);
      }
      if (opts.sourceMap !== undefined) {
        compilerOpts.push(`- **Source Maps**: ${opts.sourceMap}`);
      }

      // Other common options
      if (opts.esModuleInterop !== undefined) {
        compilerOpts.push(`- **ES Module Interop**: ${opts.esModuleInterop}`);
      }
      if (opts.isolatedModules !== undefined) {
        compilerOpts.push(`- **Isolated Modules**: ${opts.isolatedModules}`);
      }

      summary += `### Compiler Options\n${compilerOpts.join("\n")}`;
    }

    // Include/Exclude
    const patterns: string[] = [];
    if (config.include && config.include.length > 0) {
      patterns.push(`- **Include**: ${config.include.join(", ")}`);
    }
    if (config.exclude && config.exclude.length > 0) {
      patterns.push(`- **Exclude**: ${config.exclude.join(", ")}`);
    }
    if (patterns.length > 0) {
      summary += `\n\n### File Patterns\n${patterns.join("\n")}`;
    }

    return [
      this.createItem(
        "TypeScript Configuration",
        summary,
        "tsconfig.json",
        ["typescript", "compiler", "type-checking"],
        0.9,
        "typescript"
      ),
    ];
  }

  private async extractEditorConfig(directory: string): Promise<KnowledgeExtractResult["items"]> {
    const editorConfigPath = join(directory, ".editorconfig");
    if (!existsSync(editorConfigPath)) {
      throw new Error("EditorConfig not found");
    }

    const content = readFileSync(editorConfigPath, "utf-8");
    const lines = content.split("\n");

    let summary = `## EditorConfig\n\n`;
    const sections: string[] = [];
    let currentSection = "";
    let currentOptions: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Section header [*], [*.js], etc.
      const sectionMatch = trimmed.match(/^\[(.+)\]$/);
      const sectionName = sectionMatch?.[1];
      if (sectionName) {
        if (currentSection && currentOptions.length > 0) {
          sections.push(`### \`${currentSection}\`\n${currentOptions.join("\n")}`);
        }
        currentSection = sectionName;
        currentOptions = [];
        continue;
      }

      // Key-value pair
      const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      const matchedKey = kvMatch?.[1];
      const matchedValue = kvMatch?.[2];
      if (matchedKey && matchedValue) {
        const formattedKey = this.formatEditorConfigKey(matchedKey);
        currentOptions.push(`- **${formattedKey}**: ${matchedValue}`);
      }
    }

    // Add last section
    if (currentSection && currentOptions.length > 0) {
      sections.push(`### \`${currentSection}\`\n${currentOptions.join("\n")}`);
    }

    // Handle root = true at the top
    if (content.includes("root = true") || content.includes("root=true")) {
      summary += "*Root config (stops searching in parent directories)*\n\n";
    }

    summary += sections.join("\n\n");

    return [
      this.createItem(
        "EditorConfig",
        summary,
        ".editorconfig",
        ["editorconfig", "editor", "formatting", "indentation"],
        0.85,
        "editorconfig"
      ),
    ];
  }

  private formatEditorConfigKey(key: string): string {
    const keyMap: Record<string, string> = {
      indent_style: "Indent Style",
      indent_size: "Indent Size",
      tab_width: "Tab Width",
      end_of_line: "End of Line",
      charset: "Charset",
      trim_trailing_whitespace: "Trim Trailing Whitespace",
      insert_final_newline: "Insert Final Newline",
      max_line_length: "Max Line Length",
    };
    return keyMap[key] || key;
  }

  private async extractBiome(directory: string): Promise<KnowledgeExtractResult["items"]> {
    const biomePath = join(directory, "biome.json");
    if (!existsSync(biomePath)) {
      throw new Error("Biome config not found");
    }

    const content = readFileSync(biomePath, "utf-8");
    let config: BiomeConfig;

    try {
      config = JSON.parse(content);
    } catch {
      return [
        this.createItem(
          "Biome Configuration",
          `## Biome Configuration\n\nConfig file: \`biome.json\`\n\n*(Config couldn't be parsed - see source file)*`,
          "biome.json",
          ["biome", "linting", "formatting"],
          0.7,
          "biome"
        ),
      ];
    }

    let summary = `## Biome Configuration\n\n`;
    const sections: string[] = [];

    // Formatter settings
    if (config.formatter) {
      const fmtOpts: string[] = [];
      if (config.formatter.enabled !== undefined) {
        fmtOpts.push(`- **Enabled**: ${config.formatter.enabled}`);
      }
      if (config.formatter.indentStyle) {
        fmtOpts.push(`- **Indent Style**: ${config.formatter.indentStyle}`);
      }
      if (config.formatter.indentWidth !== undefined) {
        fmtOpts.push(`- **Indent Width**: ${config.formatter.indentWidth}`);
      }
      if (config.formatter.lineWidth !== undefined) {
        fmtOpts.push(`- **Line Width**: ${config.formatter.lineWidth}`);
      }
      if (fmtOpts.length > 0) {
        sections.push(`### Formatter\n${fmtOpts.join("\n")}`);
      }
    }

    // Linter settings
    if (config.linter) {
      const lintOpts: string[] = [];
      if (config.linter.enabled !== undefined) {
        lintOpts.push(`- **Enabled**: ${config.linter.enabled}`);
      }
      if (config.linter.rules?.recommended !== undefined) {
        lintOpts.push(`- **Recommended Rules**: ${config.linter.rules.recommended}`);
      }
      if (lintOpts.length > 0) {
        sections.push(`### Linter\n${lintOpts.join("\n")}`);
      }
    }

    // JavaScript-specific settings
    if (config.javascript?.formatter) {
      const jsOpts: string[] = [];
      const fmt = config.javascript.formatter;
      if (fmt.quoteStyle) {
        jsOpts.push(`- **Quote Style**: ${fmt.quoteStyle}`);
      }
      if (fmt.trailingComma) {
        jsOpts.push(`- **Trailing Comma**: ${fmt.trailingComma}`);
      }
      if (fmt.semicolons) {
        jsOpts.push(`- **Semicolons**: ${fmt.semicolons}`);
      }
      if (jsOpts.length > 0) {
        sections.push(`### JavaScript Options\n${jsOpts.join("\n")}`);
      }
    }

    summary += sections.join("\n\n") || "*(Using default configuration)*";

    return [
      this.createItem(
        "Biome Configuration",
        summary,
        "biome.json",
        ["biome", "linting", "formatting", "code-quality"],
        0.9,
        "biome"
      ),
    ];
  }
}

export const codingStandardExtractor = new CodingStandardExtractor();
