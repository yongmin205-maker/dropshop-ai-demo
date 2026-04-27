import { and, desc, eq, lt, sql } from "drizzle-orm";
import { errorLogs, type ErrorLog, type InsertErrorLog } from "../drizzle/schema";
import { getDb, readAffectedRows } from "./db";
import { redactPII } from "./pii";
import { evaluateAlerts } from "./alertEngine";

/**
 * Phase 9 — Admin error logging
 * -----------------------------
 *
 * `logServerError` is best-effort: an error inside the logger MUST NEVER
 * mask the original problem the caller was reporting. So we:
 *   - swallow DB-down by no-op
 *   - swallow any insert failure by `console.warn`
 *   - never throw out of this function
 *
 * PII in the `context` field is scrubbed via `redactPII` so phone numbers /
 * emails / addresses do not leak into the UI table.
 */
export type LogErrorInput = {
  source: string;
  err: unknown;
  /** Optional structured context (route, params, ids, etc). PII-scrubbed. */
  context?: Record<string, unknown>;
  correlationId?: string | null;
  level?: "error" | "warn";
};

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function toStack(err: unknown): string | null {
  if (err instanceof Error && typeof err.stack === "string") return err.stack;
  return null;
}

export async function logServerError(input: LogErrorInput): Promise<void> {
  // Always mirror to stderr first so we still see it in Cloud Run logs even
  // if the DB write below fails.
  // eslint-disable-next-line no-console
  console.error(`[${input.source}]`, input.err);

  const db = await getDb().catch(() => null);
  if (!db) return; // graceful no-op when DB unavailable

  try {
    const ctx = input.context ? redactPII(input.context) : null;
    const row: InsertErrorLog = {
      level: input.level ?? "error",
      source: input.source.slice(0, 128),
      message: toMessage(input.err).slice(0, 4000),
      stack: toStack(input.err),
      context: ctx as InsertErrorLog["context"],
      correlationId: input.correlationId ?? null,
    };
    await db.insert(errorLogs).values(row);
  } catch (writeErr) {
    // eslint-disable-next-line no-console
    console.warn("[errorLog] failed to persist error:", writeErr);
    return; // skip alert evaluation if the row never landed
  }

  // Phase 10 — fire spike/flapping alerts (best-effort, never throws)
  // Skip alert.engine self-loops: do not re-evaluate alerts triggered by
  // the alert engine writing its own mirror row.
  if (input.source !== "alert.engine") {
    await evaluateAlerts({
      source: input.source,
      message: toMessage(input.err),
    });
  }
}

/**
 * Cursor-paginated list (newest first). Mirrors the §4.3 list helpers so the
 * admin UI can scroll through history without OFFSET scans.
 *
 * Filters:
 *   - `level`: "error" | "warn" — exact match on level enum
 *   - `source`: exact match on source string (e.g., "twilio.webhook")
 *   - `beforeId`: cursor — return rows with id < beforeId (newest-first scroll)
 *
 * Empty filters means "all rows". Limit is clamped to [1, 200] (default 50).
 */
export async function listErrorLogs(
  opts: {
    limit?: number;
    beforeId?: number;
    level?: "error" | "warn";
    source?: string;
  } = {},
): Promise<ErrorLog[]> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = [] as ReturnType<typeof eq>[];
  if (opts.beforeId) conds.push(lt(errorLogs.id, opts.beforeId));
  if (opts.level) conds.push(eq(errorLogs.level, opts.level));
  if (opts.source) conds.push(eq(errorLogs.source, opts.source));
  let q = db.select().from(errorLogs).$dynamic();
  if (conds.length === 1) q = q.where(conds[0]);
  else if (conds.length > 1) q = q.where(and(...conds));
  return q.orderBy(desc(errorLogs.id)).limit(limit);
}

/**
 * Distinct sources currently present in the table — feeds the admin dropdown.
 * Capped at 64 to avoid runaway dropdowns.
 */
export async function listErrorSources(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .selectDistinct({ source: errorLogs.source })
    .from(errorLogs)
    .orderBy(errorLogs.source)
    .limit(64);
  return rows.map((r) => r.source);
}

/**
 * TTL purge — drop rows older than N days. Returns affected row count.
 * Default 30 days. Caller is responsible for scheduling (cron / admin button).
 *
 * Uses Date arithmetic in JS (not SQL NOW()) so the purge cut-off is
 * deterministic from the caller's POV — easier to reason about in tests and
 * cross-timezone. createdAt is stored as Unix ms (see schema.ts).
 */
export async function purgeOldErrorLogs(olderThanDays = 30): Promise<number> {
  if (olderThanDays < 1) throw new Error("olderThanDays must be >= 1");
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(errorLogs)
    .where(lt(errorLogs.createdAt, cutoff));
  return readAffectedRows(result);
}

export async function clearErrorLogs(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(errorLogs);
  return readAffectedRows(result);
}
