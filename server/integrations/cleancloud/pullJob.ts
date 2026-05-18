/**
 * Daily-pull orchestrator (Phase 25a Stage 0).
 *
 * One call to `runDailyPull(trigger)` does the following, in order:
 *
 *   1. Pull recently-updated customers (window: last 28h to self-heal a
 *      missed pull) → adapt → upsertCustomers + sync_log row.
 *   2. Pull recently-placed orders (same 28h window) → adapt → upsertOrders +
 *      extract embedded payments → upsertPayments + sync_log row.
 *   3. Pull full price-list catalog → adapt → diffProductsAndRecordChanges
 *      (so price changes get logged) → upsertProducts + sync_log row.
 *
 * The 28h window matters: at 03:00 ET, we pull anything modified since
 * 23:00 the day BEFORE yesterday. That gives us a 4h overlap with the
 * previous day's pull so any single missed pull is automatically backfilled
 * by the next one. Two consecutive failed pulls do leave a gap, monitored
 * via sync_log.
 *
 * Each endpoint gets its own sync_log row — failures in one don't block the
 * others. The orchestrator returns a summary with counts so the admin
 * tRPC procedure / heartbeat handler can render a brief progress line.
 *
 * All side effects are isolated to:
 *   - server/integrations/cleancloud/db.ts (upserts + sync_log)
 *   - server/messaging/cleanCloudTransport.ts (HTTP)
 * Letting us substitute a stub transport in vitest.
 */

import {
  cleanCloud,
  type CleanCloudCustomer,
  type CleanCloudOrder,
  type CleanCloudProduct,
} from "../../messaging/cleanCloudTransport";
import {
  adaptCustomer,
  adaptOrder,
  adaptProduct,
  extractPaymentsFromOrder,
} from "./adapter";
import {
  diffProductsAndRecordChanges,
  finishSyncLog,
  startSyncLog,
  upsertCustomers,
  upsertOrders,
  upsertPayments,
  upsertProducts,
} from "./db";
import { runCustomerCatchup, type CustomerCatchupSummary } from "./customerCatchup";
import type { PosSyncTrigger } from "../../../drizzle/schema";

/** Self-healing overlap window — see file header. */
const PULL_WINDOW_HOURS = 28;

export type PullJobSummary = {
  customers: { fetched: number; upserted: number; error: string | null };
  orders: {
    fetched: number;
    upserted: number;
    paymentsUpserted: number;
    error: string | null;
  };
  products: {
    fetched: number;
    upserted: number;
    changesDetected: number;
    error: string | null;
  };
  /** Phase 25-enrich-2: backfill orphan customers (referenced by orders but
   *  missing from posCustomers because CleanCloud's date-windowed customer
   *  pull never returned them). Null when the catch-up is disabled. */
  customerCatchup: CustomerCatchupSummary | null;
  startedAt: Date;
  finishedAt: Date;
};

/**
 * Optional injection points for tests. In production this all defaults to
 * the live `cleanCloud` transport.
 */
export type PullJobDeps = {
  getCustomer?: typeof cleanCloud.getCustomer;
  getOrders?: typeof cleanCloud.getOrders;
  getProducts?: typeof cleanCloud.getProducts;
  getPriceLists?: typeof cleanCloud.getPriceLists;
  upsertCustomers?: typeof upsertCustomers;
  upsertOrders?: typeof upsertOrders;
  upsertPayments?: typeof upsertPayments;
  upsertProducts?: typeof upsertProducts;
  diffProducts?: typeof diffProductsAndRecordChanges;
  startSyncLog?: typeof startSyncLog;
  finishSyncLog?: typeof finishSyncLog;
  /** Phase 25-enrich-2: orphan-customer catch-up. Pass `null` to disable
   *  for tests; defaults to the real implementation in customerCatchup.ts. */
  runCustomerCatchup?: typeof runCustomerCatchup | null;
  /** Cap the catch-up per daily run so it stays inside the 180s request
   *  budget (each lookup is ~0.4s sequential, 4-wide concurrent). */
  customerCatchupMaxPerRun?: number;
  now?: () => Date;
};

export async function runDailyPull(
  trigger: PosSyncTrigger,
  deps: PullJobDeps = {},
): Promise<PullJobSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const windowFrom = new Date(now.getTime() - PULL_WINDOW_HOURS * 3600 * 1000);
  const windowTo = now;

  const _getCustomer = deps.getCustomer ?? cleanCloud.getCustomer;
  const _getOrders = deps.getOrders ?? cleanCloud.getOrders;
  const _getProducts = deps.getProducts ?? cleanCloud.getProducts;
  const _upsertCustomers = deps.upsertCustomers ?? upsertCustomers;
  const _upsertOrders = deps.upsertOrders ?? upsertOrders;
  const _upsertPayments = deps.upsertPayments ?? upsertPayments;
  const _upsertProducts = deps.upsertProducts ?? upsertProducts;
  const _diffProducts = deps.diffProducts ?? diffProductsAndRecordChanges;
  const _startSyncLog = deps.startSyncLog ?? startSyncLog;
  const _finishSyncLog = deps.finishSyncLog ?? finishSyncLog;

  const startedAt = now;
  const summary: PullJobSummary = {
    customers: { fetched: 0, upserted: 0, error: null },
    orders: { fetched: 0, upserted: 0, paymentsUpserted: 0, error: null },
    products: { fetched: 0, upserted: 0, changesDetected: 0, error: null },
    customerCatchup: null,
    startedAt,
    finishedAt: startedAt,
  };

  /* ----- 1. customers --------------------------------------------- */
  {
    const logId = await _startSyncLog({
      source: "cleancloud",
      trigger,
      endpoint: "getCustomer",
      windowFrom,
      windowTo,
    });
    try {
      // CleanCloud's getCustomer with a date range returns recently-updated
      // customers as an array. We use ISO-date strings as the docs require.
      const result = await _getCustomer({
        dateFrom: toCleanCloudDate(windowFrom),
        dateTo: toCleanCloudDate(windowTo),
        excludeDeactivated: 1,
      });
      if (!result.ok) {
        summary.customers.error = result.error;
        await _finishSyncLog(logId, { error: result.error });
      } else {
        const arr = Array.isArray(result.data)
          ? (result.data as CleanCloudCustomer[])
          : ([result.data] as CleanCloudCustomer[]);
        const rows = arr.map(adaptCustomer).filter(notNull);
        summary.customers.fetched = arr.length;
        summary.customers.upserted = await _upsertCustomers(rows);
        await _finishSyncLog(logId, {
          rowsFetched: summary.customers.fetched,
          rowsUpserted: summary.customers.upserted,
        });
      }
    } catch (err) {
      summary.customers.error = errorMessage(err);
      await _finishSyncLog(logId, { error: summary.customers.error });
    }
  }

  /* ----- 2. orders + embedded payments --------------------------- */
  {
    const logId = await _startSyncLog({
      source: "cleancloud",
      trigger,
      endpoint: "getOrders",
      windowFrom,
      windowTo,
    });
    try {
      const result = await _getOrders({
        dateFrom: toCleanCloudDate(windowFrom),
        dateTo: toCleanCloudDate(windowTo),
        sendProductDetails: 1,
      });
      if (!result.ok) {
        summary.orders.error = result.error;
        await _finishSyncLog(logId, { error: result.error });
      } else {
        const arr = result.data as CleanCloudOrder[];
        const orderRows = arr.map(adaptOrder).filter(notNull);
        const paymentRows = arr.flatMap(extractPaymentsFromOrder);
        summary.orders.fetched = arr.length;
        summary.orders.upserted = await _upsertOrders(orderRows);
        summary.orders.paymentsUpserted = await _upsertPayments(paymentRows);
        await _finishSyncLog(logId, {
          rowsFetched: summary.orders.fetched,
          rowsUpserted: summary.orders.upserted,
        });
      }
    } catch (err) {
      summary.orders.error = errorMessage(err);
      await _finishSyncLog(logId, { error: summary.orders.error });
    }
  }

  /* ----- 3. products + price-change diff ------------------------- */
  {
    const logId = await _startSyncLog({
      source: "cleancloud",
      trigger,
      endpoint: "getProducts",
      windowFrom,
      windowTo,
    });
    try {
      const result = await _getProducts({ sendUpcharges: 1 });
      if (!result.ok) {
        summary.products.error = result.error;
        await _finishSyncLog(logId, { error: result.error });
      } else {
        const arr = result.data as CleanCloudProduct[];
        const rows = arr.map((p) => adaptProduct(p)).filter(notNull);
        summary.products.fetched = arr.length;
        // Diff BEFORE upsert so the comparison sees previous state.
        summary.products.changesDetected = await _diffProducts(
          "cleancloud",
          rows,
          logId,
        );
        summary.products.upserted = await _upsertProducts(rows);
        await _finishSyncLog(logId, {
          rowsFetched: summary.products.fetched,
          rowsUpserted: summary.products.upserted,
        });
      }
    } catch (err) {
      summary.products.error = errorMessage(err);
      await _finishSyncLog(logId, { error: summary.products.error });
    }
  }

  /* ----- 4. customer catch-up (orphan IDs from posOrders) ---------- *
   * After orders are upserted we know exactly which customerExternalId's
   * exist in this account. CleanCloud's getCustomer dateRange mode only
   * returns customers *updated* in the window, so loyal regulars whose
   * profile hasn't been edited recently are silently missing from the
   * mirror. We resolve them by single-ID lookup so findInactiveCustomers
   * etc. can join on real names. Disabled when deps.runCustomerCatchup is
   * explicitly null (tests). */
  const _runCatchup =
    deps.runCustomerCatchup === undefined ? runCustomerCatchup : deps.runCustomerCatchup;
  if (_runCatchup) {
    try {
      summary.customerCatchup = await _runCatchup(trigger, {
        maxPerRun: deps.customerCatchupMaxPerRun ?? 100,
        getCustomer: deps.getCustomer,
        upsertCustomers: deps.upsertCustomers,
        startSyncLog: deps.startSyncLog,
        finishSyncLog: deps.finishSyncLog,
        now: deps.now,
      });
    } catch (err) {
      // Catch-up failures are non-fatal; the daily pull still succeeded.
      const msg = errorMessage(err);
      summary.customerCatchup = {
        orphansFound: 0,
        fetched: 0,
        upserted: 0,
        errors: [{ customerExternalId: "*", message: msg }],
        startedAt,
        finishedAt: (deps.now ?? (() => new Date()))(),
      };
    }
  }

  summary.finishedAt = (deps.now ?? (() => new Date()))();
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

/**
 * CleanCloud's date params want "YYYY-MM-DD HH:MM:SS" UTC strings.
 */
export function toCleanCloudDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
