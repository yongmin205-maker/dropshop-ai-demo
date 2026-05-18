/**
 * Customer catch-up: fetch and upsert any customerExternalId that appears in
 * posOrders but is missing from posCustomers.
 *
 * Why this exists
 * ---------------
 * CleanCloud's `getCustomer` with `dateFrom/dateTo` returns customers
 * *updated* in that window — NOT customers who *placed orders* in it. So a
 * loyal regular who's been a customer for 2 years but whose profile hasn't
 * been edited recently never shows up in either the daily 28h pull or the
 * 6-month rolling-window backfill, even though their orders flow in fine.
 *
 * Result: ~65% of customers referenced by posOrders had no matching
 * posCustomers row. Owner Assistant tools that join orders → customers (e.g.
 * findInactiveCustomers) returned `name = null` for them and the UI rendered
 * "이름 미상".
 *
 * The fix
 * -------
 * Periodically (and once on demand) scan posOrders for customerExternalId's
 * that aren't in posCustomers, then call `getCustomer({customerID})` per
 * orphan. Single-ID mode is unbounded by date and returns the customer
 * regardless of last-update time.
 *
 * Failure handling: per-ID errors are recorded but don't abort the run. The
 * shared sync_log row tracks the whole pass.
 */

import {
  cleanCloud,
  type CleanCloudCustomer,
} from "../../messaging/cleanCloudTransport";
import { adaptCustomer } from "./adapter";
import {
  finishSyncLog,
  startSyncLog,
  upsertCustomers,
} from "./db";
import { getDb } from "../../db";
import { posCustomers, posOrders } from "../../../drizzle/schema";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import type { PosSyncTrigger } from "../../../drizzle/schema";

const SOURCE = "cleancloud" as const;

export type CustomerCatchupSummary = {
  orphansFound: number;
  fetched: number;
  upserted: number;
  errors: Array<{ customerExternalId: string; message: string }>;
  startedAt: Date;
  finishedAt: Date;
};

export type CustomerCatchupDeps = {
  getCustomer?: typeof cleanCloud.getCustomer;
  upsertCustomers?: typeof upsertCustomers;
  startSyncLog?: typeof startSyncLog;
  finishSyncLog?: typeof finishSyncLog;
  /** Override the orphan-id discovery (tests). */
  findOrphanIds?: () => Promise<string[]>;
  /** Hard cap on how many orphans to resolve per run, to keep the call
   *  inside Cloud Run's 180s budget. */
  maxPerRun?: number;
  /** Concurrency for the per-ID HTTP calls. */
  concurrency?: number;
  now?: () => Date;
};

const DEFAULT_MAX_PER_RUN = 200;
const DEFAULT_CONCURRENCY = 4;

/**
 * Find customerExternalId's that show up in posOrders but have no matching
 * row in posCustomers (same source). Capped to keep the catch-up bounded.
 */
export async function findOrphanCustomerIds(
  limit = DEFAULT_MAX_PER_RUN,
): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];

  // Drizzle doesn't have a clean LEFT-JOIN-IS-NULL helper for this dialect,
  // so issue two queries and diff client-side. Both rowsets are small (≤ a
  // few thousand) so the memory cost is negligible.
  const orderIdsRaw = await db
    .selectDistinct({ id: posOrders.customerExternalId })
    .from(posOrders)
    .where(and(eq(posOrders.source, SOURCE), isNotNull(posOrders.customerExternalId)));
  const orderIds = orderIdsRaw
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (orderIds.length === 0) return [];

  const mirrorRaw = await db
    .select({ id: posCustomers.externalId })
    .from(posCustomers)
    .where(eq(posCustomers.source, SOURCE));
  const mirrorSet = new Set(mirrorRaw.map((r) => r.id));

  const orphans = orderIds.filter((id) => !mirrorSet.has(id));
  return orphans.slice(0, limit);
}

/**
 * Fetch each orphan customerID via single-ID mode, adapt, upsert.
 *
 * Concurrency is capped so we don't hammer CleanCloud's per-account rate
 * limit. Errors are collected per-ID; one failure doesn't abort the rest.
 */
export async function runCustomerCatchup(
  trigger: PosSyncTrigger,
  deps: CustomerCatchupDeps = {},
): Promise<CustomerCatchupSummary> {
  const _now = deps.now ?? (() => new Date());
  const startedAt = _now();
  const _getCustomer = deps.getCustomer ?? cleanCloud.getCustomer;
  const _upsertCustomers = deps.upsertCustomers ?? upsertCustomers;
  const _startSyncLog = deps.startSyncLog ?? startSyncLog;
  const _finishSyncLog = deps.finishSyncLog ?? finishSyncLog;
  const _findOrphanIds =
    deps.findOrphanIds ?? (() => findOrphanCustomerIds(deps.maxPerRun ?? DEFAULT_MAX_PER_RUN));
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  const summary: CustomerCatchupSummary = {
    orphansFound: 0,
    fetched: 0,
    upserted: 0,
    errors: [],
    startedAt,
    finishedAt: startedAt,
  };

  const logId = await _startSyncLog({
    source: SOURCE,
    trigger,
    endpoint: "getCustomer",
    windowFrom: startedAt,
    windowTo: startedAt,
  });

  try {
    const orphans = await _findOrphanIds();
    summary.orphansFound = orphans.length;
    if (orphans.length === 0) {
      await _finishSyncLog(logId, { rowsFetched: 0, rowsUpserted: 0 });
      summary.finishedAt = _now();
      return summary;
    }

    const fetched: CleanCloudCustomer[] = [];

    // Simple promise pool — N at a time.
    let cursor = 0;
    const worker = async () => {
      while (cursor < orphans.length) {
        const idx = cursor++;
        const id = orphans[idx];
        try {
          const result = await _getCustomer({ customerID: id });
          if (!result.ok) {
            summary.errors.push({ customerExternalId: id, message: result.error });
            continue;
          }
          // Single-ID mode returns a flat object (per CleanCloud docs).
          const row = Array.isArray(result.data) ? result.data[0] : result.data;
          if (row) fetched.push(row);
        } catch (err) {
          summary.errors.push({
            customerExternalId: id,
            message: errorMessage(err),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, orphans.length) }, () => worker()),
    );

    summary.fetched = fetched.length;
    const rows = fetched.map(adaptCustomer).filter(notNull);
    summary.upserted = await _upsertCustomers(rows);

    await _finishSyncLog(logId, {
      rowsFetched: summary.fetched,
      rowsUpserted: summary.upserted,
    });
  } catch (err) {
    const msg = errorMessage(err);
    summary.errors.push({ customerExternalId: "*", message: msg });
    await _finishSyncLog(logId, { error: msg });
  }

  summary.finishedAt = _now();
  return summary;
}

/* ----- helpers --------------------------------------------------------- */

function notNull<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}
