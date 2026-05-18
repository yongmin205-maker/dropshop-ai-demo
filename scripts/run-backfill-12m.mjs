// One-shot 12-month CleanCloud → mirror backfill, run from the sandbox.
// Bypasses Cloud Run's 180s budget. Prints progress + final summary.
//
// Usage: cd /home/ubuntu/dropshop-ai-demo && node scripts/run-backfill-12m.mjs
import { tsImport } from "tsx/esm/api";

const t0 = Date.now();
console.log("[backfill-12m] starting…");

const mod = await tsImport(
  "../server/integrations/cleancloud/backfill.ts",
  import.meta.url,
);
const summary = await mod.runBackfill(12);

const dur = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[backfill-12m] DONE in ${dur}s\n`);
console.log(JSON.stringify(summary, null, 2));
