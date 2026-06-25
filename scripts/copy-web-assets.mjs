import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/web", { recursive: true });
cpSync("src/web", "dist/web", { recursive: true });
