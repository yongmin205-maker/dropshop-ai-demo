#!/usr/bin/env node
// Regenerate the daily briefing for a given NYC date using current
// code (now includes serviceMix / peakHour / topSpenderProfiles +
// first-order based returning classification). Idempotent:
// onDuplicateKeyUpdate overwrites the existing row.

import "dotenv/config";

const date = process.argv[2] ?? "2026-05-16";

console.log(`[regen-briefing] regenerating ${date}...`);
const { runDailyBriefing } = await import(
  "../server/briefing/dailyBriefing.ts"
);
const start = Date.now();
const result = await runDailyBriefing({ briefingDate: date });
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`[regen-briefing] done in ${elapsed}s`);
console.log("metrics:", {
  orderCount: result.metrics.orderCount,
  revenueCents: result.metrics.revenueCents,
  uniqueCustomerCount: result.metrics.uniqueCustomerCount,
  newCustomerCount: result.metrics.newCustomerCount,
  returningCustomerCount: result.metrics.returningCustomerCount,
  peakHour: result.metrics.peakHour,
  serviceMixTop3: result.metrics.serviceMix.slice(0, 3),
  topSpenderProfiles: result.metrics.topSpenderProfiles,
});
console.log("\n========== SUMMARY MARKDOWN ==========\n");
console.log(result.summaryMarkdown);
console.log("\n======================================");
console.log({ llmModel: result.llmModel, errorMessage: result.errorMessage });
process.exit(0);
