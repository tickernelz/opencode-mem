import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import ts from "typescript-eslint";

export default ts.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "out/**",
      "github-site/.astro/**",
      "github-site/dist/**",
      "github-site/node_modules/**",
      "github-site/src/content/docs/**",
      "github-site/src/generated/**",
      "web/dist/**",
      "web/node_modules/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.bun,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: [
      "web/src/**/*.svelte.ts",
      "web/src/**/*.svelte.js",
      "github-site/src/**/*.svelte.ts",
      "github-site/src/**/*.svelte.js",
    ],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: [".svelte"],
      },
    },
  }
);
