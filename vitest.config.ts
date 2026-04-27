import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Project routing (server=node, client=jsdom) lives in `vitest.workspace.ts`.
 * This file only carries shared options for tools that read the root config
 * directly (e.g., the coverage report when invoked without --workspace).
 */
const templateRoot = path.resolve(import.meta.dirname);
export default defineConfig({
  root: templateRoot,
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
});
