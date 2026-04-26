import { desc, lt } from "drizzle-orm";
import { errorLogs, type ErrorLog, type InsertErrorLog } from "../drizzle/schema";
import { getDb } from "./db";
import { redactPII } from "./pii";

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
  }
}

/**
 * Cursor-paginated list (newest first). Mirrors the §4.3 list helpers so the
 * admin UI can scroll through history without OFFSET scans.
 */
export async function listErrorLogs(
  opts: { limit?: number; beforeId?: number } = {},
): Promise<ErrorLog[]> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let q = db.select().from(errorLogs).$dynamic();
  if (opts.beforeId) {
    q = q.where(lt(errorLogs.id, opts.beforeId));
  }
  return q.orderBy(desc(errorLogs.id)).limit(limit);
}

export async function clearErrorLogs(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(errorLogs);
  const affected = (result as unknown as { affectedRows?: number }[])[0]?.affectedRows
    ?? (result as unknown as { affectedRows?: number }).affectedRows
    ?? 0;
  return affected;
}
