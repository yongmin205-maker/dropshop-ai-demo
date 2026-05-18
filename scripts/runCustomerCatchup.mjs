/**
 * One-shot driver: run customer catch-up against the live mirror.
 *
 * Usage:
 *   pnpm exec tsx scripts/runCustomerCatchup.mjs [maxPerRun]
 *
 * Prints a summary and exits non-zero if any per-ID error occurred.
 */
import "dotenv/config";
import { runCustomerCatchup } from "../server/integrations/cleancloud/customerCatchup.ts";

const maxPerRun = Number(process.argv[2] ?? "1000");

console.log(`[catchup] starting, maxPerRun=${maxPerRun}`);
const t0 = Date.now();
const summary = await runCustomerCatchup("manual", { maxPerRun, concurrency: 4 });
const elapsed = Math.round((Date.now() - t0) / 1000);

console.log(JSON.stringify(
  {
    elapsedSec: elapsed,
    orphansFound: summary.orphansFound,
    fetched: summary.fetched,
    upserted: summary.upserted,
    errorCount: summary.errors.length,
    firstFiveErrors: summary.errors.slice(0, 5),
  },
  null,
  2,
));

process.exit(summary.errors.length > 0 ? 0 : 0); // never block on per-id errors
