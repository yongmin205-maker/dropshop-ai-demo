import { and, count as drizzleCount, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  errorAlerts,
  errorLogs,
  type InsertErrorAlert,
} from "../drizzle/schema";
import { getDb } from "./db";
import { notifyOwner } from "./_core/notification";

/**
 * Phase 10 — Error alert engine
 * -----------------------------
 *
 * Two detectors, both fire `notifyOwner` and self-log into `errorLogs`:
 *
 *   1. SPIKE      — same `source` produced N or more error rows in the
 *                   last `spikeWindowSeconds`. Catches sudden incidents.
 *   2. FLAPPING   — same `(source + message-prefix)` repeated K or more
 *                   times in the last `flapWindowSeconds`. Catches a
 *                   single bug retrying forever.
 *
 * Cooldown — once an alert with a given `key` fires, the engine refuses to
 * fire again until `cooldownSeconds` have passed. Cooldown is enforced by
 * looking up the most recent matching row in `errorAlerts`, so it survives
 * server restarts (no in-memory state).
 *
 * Defaults are intentionally conservative for a low-volume pilot:
 *   - 5 errors / source / 5 min  → spike
 *   - 3 same-msg / 10 min        → flapping
 *   - 30 min cooldown
 *
 * `evaluateAlerts` is best-effort: any failure inside is swallowed so it
 * never re-throws into the caller path (same contract as `logServerError`).
 */

export type AlertConfig = {
  spikeThreshold: number;
  spikeWindowSeconds: number;
  flapThreshold: number;
  flapWindowSeconds: number;
  cooldownSeconds: number;
  /** When false, do not actually call notifyOwner (used in tests). */
  notify?: boolean;
};

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  spikeThreshold: 5,
  spikeWindowSeconds: 5 * 60,
  flapThreshold: 3,
  flapWindowSeconds: 10 * 60,
  cooldownSeconds: 30 * 60,
  notify: true,
};

/** Stable prefix of the error message for flapping detection. */
export function messageFingerprint(msg: string): string {
  // Strip volatile parts: numbers, hex ids, timestamps. Keep first 80 chars.
  // Order matters: collapse hex-ish ids first (require >=1 digit so all-letter
  // strings like "aaaaaaaa" do NOT count as ids), then bare numbers, then
  // whitespace. The (?=...) lookahead ensures the run contains a digit so we
  // never collapse pure-letter words.
  return msg
    .replace(/(?=\w*\d)[0-9a-f]{8,}/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function spikeKey(source: string): string {
  return `spike:${source}`;
}

export function flapKey(source: string, msgPrefix: string): string {
  return `flap:${source}|${msgPrefix}`;
}

/**
 * Check whether an alert with `key` is still cooling down.
 * Returns the most recent alert row if cooldown is active, else null.
 */
export async function isCoolingDown(
  key: string,
  cooldownSeconds: number,
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownSeconds * 1000);
  const rows = await db
    .select({ id: errorAlerts.id })
    .from(errorAlerts)
    .where(and(eq(errorAlerts.key, key), gte(errorAlerts.createdAt, cutoff)))
    .orderBy(desc(errorAlerts.id))
    .limit(1);
  return rows.length > 0;
}

async function fireAlert(
  payload: InsertErrorAlert & { notify: boolean },
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
): Promise<void> {
  const { notify, ...row } = payload;
  await db.insert(errorAlerts).values(row);

  // Mirror into errorLogs so it shows up in the same admin tab.
  try {
    await db.insert(errorLogs).values({
      level: "warn",
      source: "alert.engine",
      message: `[${row.kind.toUpperCase()}] ${row.source} — ${row.count}× in ${Math.round(
        row.windowSeconds / 60,
      )}m${row.message ? ` :: ${row.message}` : ""}`,
      stack: null,
      context: { kind: row.kind, key: row.key, count: row.count },
      correlationId: null,
    });
  } catch {
    // best-effort
  }

  if (notify) {
    try {
      const minutes = Math.round(row.windowSeconds / 60);
      const title =
        row.kind === "spike"
          ? `[DropShop AI] Error spike — ${row.source}`
          : `[DropShop AI] Error flapping — ${row.source}`;
      const body =
        row.kind === "spike"
          ? `${row.count} errors from \`${row.source}\` in the last ${minutes} minutes.`
          : `Same error repeated ${row.count}× in ${minutes} minutes:\n\n> ${row.message ?? ""}\n\nSource: \`${row.source}\``;
      await notifyOwner({ title, content: body });
    } catch {
      // notifyOwner already logs internally; never let it bubble.
    }
  }
}

/**
 * Run both detectors against the most recent log row. Call this from
 * `logServerError` AFTER the row has been inserted (so the `>=` thresholds
 * include the just-arrived event).
 *
 * Returns an array describing alerts that were fired (empty if none).
 * Always resolves; never throws.
 */
export async function evaluateAlerts(
  ctx: { source: string; message: string },
  cfg: AlertConfig = DEFAULT_ALERT_CONFIG,
): Promise<Array<{ kind: "spike" | "flap"; key: string; count: number }>> {
  const fired: Array<{ kind: "spike" | "flap"; key: string; count: number }> =
    [];
  const db = await getDb().catch(() => null);
  if (!db) return fired;

  try {
    // SPIKE — count error-level rows for source in window
    const spikeCutoff = new Date(Date.now() - cfg.spikeWindowSeconds * 1000);
    const spikeRows = await db
      .select({ c: sql<number>`count(*)` })
      .from(errorLogs)
      .where(
        and(
          eq(errorLogs.source, ctx.source),
          eq(errorLogs.level, "error"),
          gte(errorLogs.createdAt, spikeCutoff),
        ),
      );
    const spikeCount = Number(spikeRows[0]?.c ?? 0);
    if (spikeCount >= cfg.spikeThreshold) {
      const key = spikeKey(ctx.source);
      if (!(await isCoolingDown(key, cfg.cooldownSeconds, db))) {
        await fireAlert(
          {
            key,
            kind: "spike",
            source: ctx.source,
            message: null,
            count: spikeCount,
            windowSeconds: cfg.spikeWindowSeconds,
            notify: cfg.notify ?? true,
          },
          db,
        );
        fired.push({ kind: "spike", key, count: spikeCount });
      }
    }

    // FLAPPING — count same fingerprint in window
    const fingerprint = messageFingerprint(ctx.message);
    if (fingerprint.length > 0) {
      const flapCutoff = new Date(Date.now() - cfg.flapWindowSeconds * 1000);
      // We approximate "same message" by exact prefix match using LIKE
      // against the truncated fingerprint. Cheap and good enough for
      // pilot-scale traffic.
      const flapRows = await db
        .select({ c: sql<number>`count(*)` })
        .from(errorLogs)
        .where(
          and(
            eq(errorLogs.source, ctx.source),
            gte(errorLogs.createdAt, flapCutoff),
            sql`${errorLogs.message} LIKE ${fingerprint + "%"}`,
          ),
        );
      const flapCount = Number(flapRows[0]?.c ?? 0);
      if (flapCount >= cfg.flapThreshold) {
        const key = flapKey(ctx.source, fingerprint);
        if (!(await isCoolingDown(key, cfg.cooldownSeconds, db))) {
          await fireAlert(
            {
              key,
              kind: "flap",
              source: ctx.source,
              message: fingerprint,
              count: flapCount,
              windowSeconds: cfg.flapWindowSeconds,
              notify: cfg.notify ?? true,
            },
            db,
          );
          fired.push({ kind: "flap", key, count: flapCount });
        }
      }
    }
  } catch {
    // swallow — alerting must never break the caller
  }

  return fired;
}

/** Admin-tab read helpers. */
export async function listErrorAlerts(
  opts: { limit?: number } = {},
): Promise<Array<typeof errorAlerts.$inferSelect>> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return db
    .select()
    .from(errorAlerts)
    .orderBy(desc(errorAlerts.id))
    .limit(limit);
}

/**
 * TTL purge for the alert history. Default 30 days. Returns affected count.
 * Same shape/contract as `purgeOldErrorLogs` so the admin UI can wire one
 * button to call both.
 */
export async function purgeOldErrorAlerts(
  olderThanDays = 30,
): Promise<number> {
  if (olderThanDays < 1) throw new Error("olderThanDays must be >= 1");
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(errorAlerts)
    .where(lt(errorAlerts.createdAt, cutoff));
  const affected =
    (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ??
    (result as unknown as { affectedRows?: number }).affectedRows ??
    0;
  return affected;
}
