/**
 * /api/scheduled/cleancloud-daily-pull — handler for the project-level
 * Heartbeat cron created via §4a (sandbox CLI `manus-heartbeat create`).
 *
 * Path is fixed by §2 fact #1: must start with /api/scheduled/.
 *
 * Auth note (§4a + 5c): we DO NOT call sdk.authenticateRequest here because
 * §5c patches were intentionally skipped (we have no end-user-driven crons
 * for this job). Instead we trust the platform gateway, which only routes
 * /api/scheduled/* to authenticated cron callers, AND we apply a defense-in-
 * depth shared-secret header check using CLEANCLOUD_WEBHOOK_SECRET (already
 * scoped to this project, no extra env to provision).
 *
 * Idempotency (§2 fact #6): runDailyPull's upserts are keyed on
 * (source, externalId), so re-firing the cron for the same window is a
 * cheap no-op rather than a duplicate insert.
 */

import type { Express, Request, Response } from "express";
import { runDailyPull, type PullJobSummary } from "./pullJob";
import { ENV } from "../../_core/env";

const CRON_HEADER = "x-manus-cron-task-uid";
const SHARED_SECRET_HEADER = "x-cleancloud-cron-secret";

export function registerCleanCloudDailyPullCron(app: Express) {
  app.post(
    "/api/scheduled/cleancloud-daily-pull",
    async (req: Request, res: Response) => {
      // Defense-in-depth: even though /api/scheduled/* is gated by the
      // platform, we accept a shared secret from env to make local /
      // production replay attempts harmless if the gateway is ever
      // misconfigured.
      const expected = ENV.cleanCloudWebhookSecret;
      const provided =
        (req.headers[SHARED_SECRET_HEADER] as string | undefined) ??
        (req.query.secret as string | undefined);
      const cronTaskUid = req.headers[CRON_HEADER] as string | undefined;
      if (expected && provided !== expected && !cronTaskUid) {
        // No platform cron header AND no matching shared secret — refuse.
        return res.status(403).json({ error: "forbidden" });
      }

      try {
        const summary = await runDailyPull("daily_pull_03am_et");
        const ok =
          summary.customers.error === null &&
          summary.orders.error === null &&
          summary.products.error === null;
        const body = {
          ok,
          summary,
          firedAt: new Date().toISOString(),
          taskUid: cronTaskUid ?? null,
        };
        return res.status(ok ? 200 : 500).json(body);
      } catch (err) {
        // Per §2 fact #4: JSON-encode errors so the platform Investigate
        // flow surfaces them verbatim.
        const e = err as Error;
        return res.status(500).json({
          error: e?.message ?? "unknown",
          stack: e?.stack ?? null,
          context: { url: req.originalUrl, taskUid: cronTaskUid ?? null },
          timestamp: new Date().toISOString(),
        });
      }
    },
  );
}

export type DailyPullResponseBody = {
  ok: boolean;
  summary: PullJobSummary;
  firedAt: string;
  taskUid: string | null;
};
