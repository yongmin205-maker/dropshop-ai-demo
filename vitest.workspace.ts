import { defineWorkspace } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);
const sharedAlias = {
  "@": path.resolve(templateRoot, "client", "src"),
  "@shared": path.resolve(templateRoot, "shared"),
  "@assets": path.resolve(templateRoot, "attached_assets"),
};
const esbuildOpts = { jsx: "automatic" as const, jsxImportSource: "react" };

/**
 * Vitest v2 workspace — one config per environment so server (Node) and
 * client (jsdom) tests run side-by-side without env bleed-over.
 *
 *   • server  → existing 247 backend tests (DB helpers, agents, RAG, etc.)
 *   • client  → jsdom + Testing Library, plus shared/** so cross-cutting
 *               utils get coverage in the env the client uses them in.
 *
 * Created in CODE_AUDIT P2: the Approve nested-anchor bug that crashed
 * the live deploy never had a unit test because the original config was
 * server-only. With this split, any future React render regression in
 * `client/src/pages/dropshop/*` or `shared/*` lights up CI.
 */
export default defineWorkspace([
  {
    resolve: { alias: sharedAlias },
    esbuild: esbuildOpts,
    test: {
      name: "server",
      environment: "node",
      include: ["server/**/*.test.ts", "server/**/*.spec.ts"],
    },
  },
  {
    resolve: { alias: sharedAlias },
    esbuild: esbuildOpts,
    test: {
      name: "client",
      environment: "jsdom",
      globals: true,
      setupFiles: ["./client/src/test/setup.ts"],
      include: [
        "client/**/*.test.ts",
        "client/**/*.test.tsx",
        "shared/**/*.test.ts",
      ],
    },
  },
]);
