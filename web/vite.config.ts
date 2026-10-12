import path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { opencodeMemSimPlugin } from "./vite-plugins/opencode-mem-sim.ts";

const webRoot = import.meta.dirname;
const simEnabled = process.env.OPENCODE_MEM_SIM === "1";

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    ...(simEnabled ? [opencodeMemSimPlugin(path.resolve(webRoot, "sim"))] : []),
  ],
  resolve: {
    alias: {
      $lib: path.resolve(webRoot, "src/lib"),
      $shared: path.resolve(webRoot, "../src/shared"),
      "@": path.resolve(webRoot, "src"),
    },
  },
  optimizeDeps: {
    exclude: [
      "codemirror",
      "svelte-codemirror-editor",
      "@codemirror/lang-markdown",
      "@codemirror/theme-one-dark",
      "@codemirror/view",
      "@codemirror/state",
    ],
  },
  server: {
    // When SIM is on, the plugin handles /api before the proxy.
    proxy: simEnabled
      ? undefined
      : {
          "/api": {
            target: "http://127.0.0.1:4747",
            changeOrigin: true,
          },
          "/skills": {
            target: "http://127.0.0.1:4747",
            changeOrigin: true,
          },
        },
  },
  build: {
    outDir: path.resolve(webRoot, "../dist/web"),
    emptyOutDir: true,
  },
  base: "/",
});
