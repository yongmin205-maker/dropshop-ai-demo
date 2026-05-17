/**
 * /api/scheduled/daily-briefing — Heartbeat cron handler (12:00 UTC).
 * Fires 4h after the daily pull so yesterday's POS rows are already
 * mirrored locally when the LLM summarizes them.
 */
import type { Express, Request, Response } from "express";
import { runDailyBriefing } from "./dailyBriefing";
import { ENV } from "../_core/env";

const CRON_HEADER = "x-manus-cron-task-uid";
const SHARED_SECRET_HEADER = "x-cleancloud-cron-secret";

/** "Yesterday" in NYC as YYYY-MM-DD. */
export function yesterdayInNYC(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayNYC = fmt.format(now);
  const [y, m, d] = todayNYC.split("-").map(Number);
  const yUTC = new Date(Date.UTC(y, m - 1, d - 1));
  return yUTC.toISOString().slice(0, 10);
}

export function registerDailyBriefingCron(app: Express) {
  app.post("/api/scheduled/daily-briefing", async (req: Request, res: Response) => {
    const expected = ENV.cleanCloudWebhookSecret;
    const provided =
      (req.headers[SHARED_SECRET_HEADER] as string | undefined) ??
      (req.query.secret as string | undefined);
    const cronTaskUid = req.headers[CRON_HEADER] as string | undefined;
    if (expected && provided !== expected && !cronTaskUid) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const briefingDate =
        (req.query.briefingDate as string | undefined) || yesterdayInNYC();
      const result = await runDailyBriefing({ briefingDate });
      const ok = result.errorMessage === null;
      return res.status(ok ? 200 : 500).json({
        ok,
        briefingDate: result.briefingDate,
        summaryMarkdown: result.summaryMarkdown,
        errorMessage: result.errorMessage,
        firedAt: new Date().toISOString(),
        taskUid: cronTaskUid ?? null,
      });
    } catch (err) {
      const e = err as Error;
      return res.status(500).json({
        error: e?.message ?? "unknown",
        stack: e?.stack ?? null,
        context: { url: req.originalUrl, taskUid: cronTaskUid ?? null },
        timestamp: new Date().toISOString(),
      });
    }
  });
}
