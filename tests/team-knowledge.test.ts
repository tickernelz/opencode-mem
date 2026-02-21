// tests/team-knowledge.test.ts
// Unit tests for Team Knowledge Base extractors

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TechStackExtractor } from "../src/services/team-knowledge/extractors/tech-stack-extractor.js";
import { ArchitectureExtractor } from "../src/services/team-knowledge/extractors/architecture-extractor.js";
import { CodingStandardExtractor } from "../src/services/team-knowledge/extractors/coding-standard-extractor.js";

const createdDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// =============================================================================
// TechStackExtractor Tests
// =============================================================================
describe("TechStackExtractor", () => {
  const extractor = new TechStackExtractor();

  it("extracts dependencies from package.json", async () => {
    const dir = createTempDir();
    const packageJson = {
      name: "test-project",
      version: "1.0.0",
      dependencies: {
        react: "^18.2.0",
        "react-dom": "^18.2.0",
        typescript: "^5.0.0",
      },
      devDependencies: {
        vitest: "^1.0.0",
        eslint: "^8.0.0",
      },
      engines: {
        node: ">=18",
        npm: ">=9",
      },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson, null, 2));

    const result = await extractor.extract(dir);

    expect(result.errors).toHaveLength(0);
    expect(result.items.length).toBeGreaterThanOrEqual(3);

    // Check runtime dependencies
    const runtimeDeps = result.items.find((i) => i.title === "Runtime Dependencies");
    expect(runtimeDeps).toBeDefined();
    expect(runtimeDeps?.content).toContain("react");
    expect(runtimeDeps?.content).toContain("typescript");
    expect(runtimeDeps?.tags).toContain("dependencies");
    expect(runtimeDeps?.tags).toContain("react");
    expect(runtimeDeps?.tags).toContain("typescript");

    // Check dev dependencies
    const devDeps = result.items.find((i) => i.title === "Development Dependencies");
    expect(devDeps).toBeDefined();
    expect(devDeps?.content).toContain("vitest");
    expect(devDeps?.content).toContain("eslint");

    // Check engines
    const engines = result.items.find((i) => i.title === "Runtime Engines");
    expect(engines).toBeDefined();
    expect(engines?.content).toContain("node");
    expect(engines?.content).toContain(">=18");
  });

  it("identifies major frameworks from dependencies", async () => {
    const dir = createTempDir();
    const packageJson = {
      dependencies: {
        next: "^14.0.0",
        react: "^18.2.0",
        "@prisma/client": "^5.0.0",
        tailwindcss: "^3.4.0",
      },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson, null, 2));

    const result = await extractor.extract(dir);

    const runtimeDeps = result.items.find((i) => i.title === "Runtime Dependencies");
    expect(runtimeDeps).toBeDefined();
    expect(runtimeDeps?.content).toContain("Next.js");
    expect(runtimeDeps?.content).toContain("React");
    expect(runtimeDeps?.content).toContain("Prisma");
    expect(runtimeDeps?.content).toContain("Tailwind CSS");
  });

  it("extracts Go module information", async () => {
    const dir = createTempDir();
    const goMod = `module github.com/example/myapp

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/spf13/viper v1.17.0
)
`;
    writeFileSync(join(dir, "go.mod"), goMod);

    const result = await extractor.extract(dir);

    const goModule = result.items.find((i) => i.title === "Go Module");
    expect(goModule).toBeDefined();
    expect(goModule?.content).toContain("github.com/example/myapp");
    expect(goModule?.content).toContain("1.21");
    expect(goModule?.content).toContain("gin-gonic/gin");
    expect(goModule?.tags).toContain("go");
    expect(goModule?.tags).toContain("golang");
  });

  it("extracts Docker base images", async () => {
    const dir = createTempDir();
    const dockerfile = `FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN npm install

FROM node:20-alpine AS runner
COPY --from=builder /app /app
CMD ["node", "dist/index.js"]
`;
    writeFileSync(join(dir, "Dockerfile"), dockerfile);

    const result = await extractor.extract(dir);

    const docker = result.items.find((i) => i.title === "Docker Base Images");
    expect(docker).toBeDefined();
    expect(docker?.content).toContain("node:20-alpine");
    expect(docker?.tags).toContain("docker");
    expect(docker?.tags).toContain("container");
  });

  it("extracts Python requirements", async () => {
    const dir = createTempDir();
    const requirements = `flask==2.3.0
requests>=2.28.0
# Comment line
pandas==2.0.0
numpy>=1.24.0
`;
    writeFileSync(join(dir, "requirements.txt"), requirements);

    const result = await extractor.extract(dir);

    const pyDeps = result.items.find((i) => i.title === "Python Dependencies");
    expect(pyDeps).toBeDefined();
    expect(pyDeps?.content).toContain("flask");
    expect(pyDeps?.content).toContain("pandas");
    expect(pyDeps?.content).not.toContain("Comment");
    expect(pyDeps?.tags).toContain("python");
  });

  it("returns empty items for directory without config files", async () => {
    const dir = createTempDir();
    // Create an empty directory

    const result = await extractor.extract(dir);

    expect(result.errors).toHaveLength(0);
    expect(result.items).toHaveLength(0);
  });
});

// =============================================================================
// ArchitectureExtractor Tests
// =============================================================================
describe("ArchitectureExtractor", () => {
  const extractor = new ArchitectureExtractor();

  it("extracts project directory structure", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "src", "components"));
    mkdirSync(join(dir, "src", "services"));
    writeFileSync(join(dir, "src", "index.ts"), "// entry");
    writeFileSync(join(dir, "src", "components", "Button.tsx"), "// button");
    writeFileSync(join(dir, "package.json"), "{}");

    const result = await extractor.extract(dir);

    const structure = result.items.find((i) => i.title === "Project Structure");
    expect(structure).toBeDefined();
    expect(structure?.content).toContain("src/");
    expect(structure?.content).toContain("components/");
    expect(structure?.content).toContain("services/");
    expect(structure?.tags).toContain("structure");
  });

  it("ignores node_modules and other common directories", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, "node_modules", "some-package"));
    mkdirSync(join(dir, "dist"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "src", "index.ts"), "// entry");
    writeFileSync(join(dir, "node_modules", "some-package", "index.js"), "// pkg");

    const result = await extractor.extract(dir);

    const structure = result.items.find((i) => i.title === "Project Structure");
    expect(structure).toBeDefined();
    expect(structure?.content).toContain("src/");
    expect(structure?.content).not.toContain("node_modules");
    expect(structure?.content).not.toContain("dist");
    expect(structure?.content).not.toContain(".git");
  });

  it("detects MVC architecture pattern", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "src", "controllers"), { recursive: true });
    mkdirSync(join(dir, "src", "models"), { recursive: true });
    mkdirSync(join(dir, "src", "views"), { recursive: true });
    writeFileSync(join(dir, "src", "controllers", "user.ts"), "// controller");
    writeFileSync(join(dir, "src", "models", "user.ts"), "// model");
    writeFileSync(join(dir, "src", "views", "user.ts"), "// view");

    const result = await extractor.extract(dir);

    const patterns = result.items.find((i) => i.title === "Architecture Patterns");
    expect(patterns).toBeDefined();
    expect(patterns?.content).toContain("MVC");
    expect(patterns?.content).toContain("Model-View-Controller");
    expect(patterns?.tags).toContain("mvc");
  });

  it("detects Clean Architecture pattern", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "src", "domain"), { recursive: true });
    mkdirSync(join(dir, "src", "application"), { recursive: true });
    mkdirSync(join(dir, "src", "infrastructure"), { recursive: true });
    writeFileSync(join(dir, "src", "domain", "user.ts"), "// entity");
    writeFileSync(join(dir, "src", "application", "create-user.ts"), "// usecase");
    writeFileSync(join(dir, "src", "infrastructure", "db.ts"), "// adapter");

    const result = await extractor.extract(dir);

    const patterns = result.items.find((i) => i.title === "Architecture Patterns");
    expect(patterns).toBeDefined();
    expect(patterns?.content).toContain("Clean Architecture");
    expect(patterns?.tags).toContain("clean-architecture");
  });

  it("detects Feature-based architecture", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "src", "features", "auth"), { recursive: true });
    mkdirSync(join(dir, "src", "features", "users"), { recursive: true });
    writeFileSync(join(dir, "src", "features", "auth", "index.ts"), "// auth");
    writeFileSync(join(dir, "src", "features", "users", "index.ts"), "// users");

    const result = await extractor.extract(dir);

    const patterns = result.items.find((i) => i.title === "Architecture Patterns");
    expect(patterns).toBeDefined();
    expect(patterns?.content).toContain("Feature-based");
    expect(patterns?.tags).toContain("feature-based");
  });

  it("detects Next.js App Router structure", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "page.tsx"), "// home page");
    writeFileSync(join(dir, "app", "layout.tsx"), "// root layout");

    const result = await extractor.extract(dir);

    const patterns = result.items.find((i) => i.title === "Architecture Patterns");
    expect(patterns).toBeDefined();
    expect(patterns?.content).toContain("Next.js App Router");
    expect(patterns?.tags).toContain("nextjs-app");
  });

  it("detects Service Layer pattern", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "src", "services"), { recursive: true });
    writeFileSync(join(dir, "src", "services", "user-service.ts"), "// service");

    const result = await extractor.extract(dir);

    const patterns = result.items.find((i) => i.title === "Architecture Patterns");
    expect(patterns).toBeDefined();
    expect(patterns?.content).toContain("Service Layer");
    expect(patterns?.tags).toContain("service-layer");
  });

  it("detects entry points", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export const main = () => {};");
    writeFileSync(join(dir, "package.json"), "{}");

    const result = await extractor.extract(dir);

    const entryPoints = result.items.find((i) => i.title === "Entry Points");
    expect(entryPoints).toBeDefined();
    expect(entryPoints?.content).toContain("src/index.ts");
    expect(entryPoints?.content).toContain("Main TypeScript entry");
    expect(entryPoints?.tags).toContain("entry");
  });

  it("detects multiple entry points", async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "layout.tsx"), "// layout");
    writeFileSync(join(dir, "app", "page.tsx"), "// page");

    const result = await extractor.extract(dir);

    const entryPoints = result.items.find((i) => i.title === "Entry Points");
    expect(entryPoints).toBeDefined();
    expect(entryPoints?.content).toContain("app/layout.tsx");
    expect(entryPoints?.content).toContain("app/page.tsx");
  });
});

// =============================================================================
// CodingStandardExtractor Tests
// =============================================================================
describe("CodingStandardExtractor", () => {
  const extractor = new CodingStandardExtractor();

  it("extracts ESLint configuration from JSON file", async () => {
    const dir = createTempDir();
    const eslintConfig = {
      extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
      parser: "@typescript-eslint/parser",
      plugins: ["@typescript-eslint"],
      rules: {
        "no-unused-vars": "error",
        "@typescript-eslint/explicit-function-return-type": "warn",
      },
      env: {
        node: true,
        browser: true,
      },
    };
    writeFileSync(join(dir, ".eslintrc.json"), JSON.stringify(eslintConfig, null, 2));

    const result = await extractor.extract(dir);

    const eslint = result.items.find((i) => i.title === "ESLint Configuration");
    expect(eslint).toBeDefined();
    expect(eslint?.content).toContain(".eslintrc.json");
    expect(eslint?.content).toContain("eslint:recommended");
    expect(eslint?.content).toContain("@typescript-eslint/parser");
    expect(eslint?.content).toContain("@typescript-eslint");
    expect(eslint?.tags).toContain("eslint");
    expect(eslint?.tags).toContain("linting");
  });

  it("extracts Prettier configuration", async () => {
    const dir = createTempDir();
    const prettierConfig = {
      semi: false,
      singleQuote: true,
      tabWidth: 2,
      useTabs: false,
      trailingComma: "es5",
      printWidth: 100,
      bracketSpacing: true,
    };
    writeFileSync(join(dir, ".prettierrc"), JSON.stringify(prettierConfig, null, 2));

    const result = await extractor.extract(dir);

    const prettier = result.items.find((i) => i.title === "Prettier Configuration");
    expect(prettier).toBeDefined();
    expect(prettier?.content).toContain("Semicolons");
    expect(prettier?.content).toContain("No");
    expect(prettier?.content).toContain("Single");
    expect(prettier?.content).toContain("Tab Width");
    expect(prettier?.content).toContain("2");
    expect(prettier?.content).toContain("Trailing Comma");
    expect(prettier?.content).toContain("es5");
    expect(prettier?.tags).toContain("prettier");
    expect(prettier?.tags).toContain("formatting");
  });

  it("extracts TypeScript configuration", async () => {
    const dir = createTempDir();
    const tsConfig = {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        baseUrl: ".",
        paths: {
          "@/*": ["src/*"],
          "@components/*": ["src/components/*"],
        },
        outDir: "dist",
        declaration: true,
        esModuleInterop: true,
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"],
    };
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsConfig, null, 2));

    const result = await extractor.extract(dir);

    const tsconfig = result.items.find((i) => i.title === "TypeScript Configuration");
    expect(tsconfig).toBeDefined();
    expect(tsconfig?.content).toContain("Strict Mode");
    expect(tsconfig?.content).toContain("Enabled");
    expect(tsconfig?.content).toContain("ES2022");
    expect(tsconfig?.content).toContain("ESNext");
    expect(tsconfig?.content).toContain("bundler");
    expect(tsconfig?.content).toContain("@/*");
    expect(tsconfig?.content).toContain("src/*");
    expect(tsconfig?.content).toContain("src/**/*");
    expect(tsconfig?.tags).toContain("typescript");
    expect(tsconfig?.tags).toContain("compiler");
  });

  it("extracts EditorConfig", async () => {
    const dir = createTempDir();
    const editorConfig = `root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
`;
    writeFileSync(join(dir, ".editorconfig"), editorConfig);

    const result = await extractor.extract(dir);

    const editorCfg = result.items.find((i) => i.title === "EditorConfig");
    expect(editorCfg).toBeDefined();
    expect(editorCfg?.content).toContain("Root config");
    expect(editorCfg?.content).toContain("Indent Style");
    expect(editorCfg?.content).toContain("space");
    expect(editorCfg?.content).toContain("Indent Size");
    expect(editorCfg?.content).toContain("2");
    expect(editorCfg?.content).toContain("End of Line");
    expect(editorCfg?.content).toContain("lf");
    expect(editorCfg?.tags).toContain("editorconfig");
  });

  it("extracts Biome configuration", async () => {
    const dir = createTempDir();
    const biomeConfig = {
      formatter: {
        enabled: true,
        indentStyle: "space",
        indentWidth: 2,
        lineWidth: 100,
      },
      linter: {
        enabled: true,
        rules: {
          recommended: true,
        },
      },
      javascript: {
        formatter: {
          quoteStyle: "single",
          trailingComma: "es5",
          semicolons: "asNeeded",
        },
      },
    };
    writeFileSync(join(dir, "biome.json"), JSON.stringify(biomeConfig, null, 2));

    const result = await extractor.extract(dir);

    const biome = result.items.find((i) => i.title === "Biome Configuration");
    expect(biome).toBeDefined();
    expect(biome?.content).toContain("Formatter");
    expect(biome?.content).toContain("Enabled");
    expect(biome?.content).toContain("space");
    expect(biome?.content).toContain("Linter");
    expect(biome?.content).toContain("Recommended Rules");
    expect(biome?.content).toContain("Quote Style");
    expect(biome?.content).toContain("single");
    expect(biome?.tags).toContain("biome");
  });

  it("extracts multiple coding standards from same project", async () => {
    const dir = createTempDir();

    // ESLint
    writeFileSync(join(dir, ".eslintrc.json"), JSON.stringify({ extends: ["eslint:recommended"] }));

    // Prettier
    writeFileSync(join(dir, ".prettierrc"), JSON.stringify({ semi: true }));

    // TypeScript
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } })
    );

    const result = await extractor.extract(dir);

    expect(result.items.length).toBeGreaterThanOrEqual(3);

    const eslint = result.items.find((i) => i.title === "ESLint Configuration");
    const prettier = result.items.find((i) => i.title === "Prettier Configuration");
    const tsconfig = result.items.find((i) => i.title === "TypeScript Configuration");

    expect(eslint).toBeDefined();
    expect(prettier).toBeDefined();
    expect(tsconfig).toBeDefined();
  });

  it("returns empty items for directory without config files", async () => {
    const dir = createTempDir();
    // Create an empty directory

    const result = await extractor.extract(dir);

    expect(result.items).toHaveLength(0);
    // No errors since missing configs are silently skipped
  });

  it("handles tsconfig with comments", async () => {
    const dir = createTempDir();
    // TypeScript config with single-line comments (common pattern)
    const tsConfigWithComments = `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022"
  }
}`;
    writeFileSync(join(dir, "tsconfig.json"), tsConfigWithComments);

    const result = await extractor.extract(dir);

    const tsconfig = result.items.find((i) => i.title === "TypeScript Configuration");
    expect(tsconfig).toBeDefined();
    expect(tsconfig?.content).toContain("Strict Mode");
    expect(tsconfig?.content).toContain("ES2022");
  });

  it("gracefully handles tsconfig with complex comments", async () => {
    const dir = createTempDir();
    // TypeScript config with comments that may fail to parse
    const tsConfigWithComments = `{
  // This is a single-line comment
  "compilerOptions": {
    "strict": true,
    /* Multi-line
       comment */
    "target": "ES2022"
  }
}`;
    writeFileSync(join(dir, "tsconfig.json"), tsConfigWithComments);

    const result = await extractor.extract(dir);

    // Should still extract something even if parsing partially fails
    const tsconfig = result.items.find((i) => i.title === "TypeScript Configuration");
    expect(tsconfig).toBeDefined();
    expect(tsconfig?.tags).toContain("typescript");
  });
});

// =============================================================================
// Integration Tests - Multiple Extractors Together
// =============================================================================
describe("Extractors Integration", () => {
  it("extracts knowledge from a typical Node.js project", async () => {
    const dir = createTempDir();

    // Create project structure
    mkdirSync(join(dir, "src", "services"), { recursive: true });
    mkdirSync(join(dir, "src", "components"), { recursive: true });

    // package.json
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "test-app",
        dependencies: { react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      })
    );

    // tsconfig.json
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } })
    );

    // Entry point
    writeFileSync(join(dir, "src", "index.ts"), "// entry");

    // Create all extractors
    const techStackExtractor = new TechStackExtractor();
    const architectureExtractor = new ArchitectureExtractor();
    const codingStandardExtractor = new CodingStandardExtractor();

    // Run all extractors
    const [techResult, archResult, codeResult] = await Promise.all([
      techStackExtractor.extract(dir),
      architectureExtractor.extract(dir),
      codingStandardExtractor.extract(dir),
    ]);

    // Verify tech stack extraction
    expect(techResult.items.length).toBeGreaterThan(0);
    expect(techResult.items.some((i) => i.title === "Runtime Dependencies")).toBe(true);

    // Verify architecture extraction
    expect(archResult.items.length).toBeGreaterThan(0);
    expect(archResult.items.some((i) => i.title === "Project Structure")).toBe(true);
    expect(archResult.items.some((i) => i.title === "Entry Points")).toBe(true);

    // Verify coding standards extraction
    expect(codeResult.items.length).toBeGreaterThan(0);
    expect(codeResult.items.some((i) => i.title === "TypeScript Configuration")).toBe(true);
  });

  it("all extractors produce items with required fields", async () => {
    const dir = createTempDir();

    // Minimal setup
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } })
    );
    mkdirSync(join(dir, "src", "services"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "// entry");

    const techStackExtractor = new TechStackExtractor();
    const architectureExtractor = new ArchitectureExtractor();

    const [techResult, archResult] = await Promise.all([
      techStackExtractor.extract(dir),
      architectureExtractor.extract(dir),
    ]);

    const allItems = [...techResult.items, ...archResult.items];

    for (const item of allItems) {
      // Check required fields exist
      expect(item.type).toBeDefined();
      expect(item.title).toBeDefined();
      expect(item.content).toBeDefined();
      expect(item.sourceKey).toBeDefined();
      expect(item.sourceType).toBeDefined();
      expect(item.confidence).toBeDefined();
      expect(item.tags).toBeDefined();

      // Check field types
      expect(typeof item.type).toBe("string");
      expect(typeof item.title).toBe("string");
      expect(typeof item.content).toBe("string");
      expect(typeof item.sourceKey).toBe("string");
      expect(typeof item.confidence).toBe("number");
      expect(Array.isArray(item.tags)).toBe(true);

      // Check confidence is in valid range
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);

      // Check sourceKey is a hash (16 hex characters)
      expect(item.sourceKey).toMatch(/^[a-f0-9]{16}$/);
    }
  });
});
