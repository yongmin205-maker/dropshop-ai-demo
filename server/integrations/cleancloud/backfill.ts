/**
 * One-time historical backfill (Phase 25a).
 *
 * Run once after first deploy to seed the mirror with the friend's last N
 * months of CleanCloud data. After that the daily pull keeps it current.
 *
 * Implementation note: we deliberately walk month-by-month instead of one
 * giant query, so:
 *   (a) each chunk fits comfortably in the CleanCloud 100-row response cap,
 *   (b) we get a sync_log row per month for visibility,
 *   (c) a partial failure leaves the earlier months intact and resumable.
 */

import {
  cleanCloud,
  type CleanCloudCustomer,
  type CleanCloudOrder,
} from "../../messaging/cleanCloudTransport";
import {
  adaptCustomer,
  adaptOrder,
  extractPaymentsFromOrder,
} from "./adapter";
import {
  finishSyncLog,
  startSyncLog,
  upsertCustomers,
  upsertOrders,
  upsertPayments,
} from "./db";
import { toCleanCloudDate } from "./pullJob";

export type BackfillSummary = {
  monthsRequested: number;
  monthsCompleted: number;
  customersUpserted: number;
  ordersUpserted: number;
  paymentsUpserted: number;
  errors: Array<{ month: string; endpoint: string; message: string }>;
};

export type BackfillDeps = {
  getCustomer?: typeof cleanCloud.getCustomer;
  getOrders?: typeof cleanCloud.getOrders;
  upsertCustomers?: typeof upsertCustomers;
  upsertOrders?: typeof upsertOrders;
  upsertPayments?: typeof upsertPayments;
  startSyncLog?: typeof startSyncLog;
  finishSyncLog?: typeof finishSyncLog;
  now?: () => Date;
};

/**
 * Backfill `monthsBack` calendar months ending at `now`. Default 12 months.
 * Customers: pulled once for the entire window (CleanCloud's getCustomer
 * date-range mode handles long ranges fine).
 * Orders: pulled per-month so a single bad month doesn't poison the whole
 * job.
 */
export async function runBackfill(
  monthsBack = 12,
  deps: BackfillDeps = {},
): Promise<BackfillSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const _getCustomer = deps.getCustomer ?? cleanCloud.getCustomer;
  const _getOrders = deps.getOrders ?? cleanCloud.getOrders;
  const _upsertCustomers = deps.upsertCustomers ?? upsertCustomers;
  const _upsertOrders = deps.upsertOrders ?? upsertOrders;
  const _upsertPayments = deps.upsertPayments ?? upsertPayments;
  const _startSyncLog = deps.startSyncLog ?? startSyncLog;
  const _finishSyncLog = deps.finishSyncLog ?? finishSyncLog;

  const summary: BackfillSummary = {
    monthsRequested: monthsBack,
    monthsCompleted: 0,
    customersUpserted: 0,
    ordersUpserted: 0,
    paymentsUpserted: 0,
    errors: [],
  };

  const overallFrom = startOfMonthUTC(now, monthsBack - 1);
  const overallTo = now;

  /* ----- customers (one big window) ------------------------------- */
  {
    const logId = await _startSyncLog({
      source: "cleancloud",
      trigger: "backfill",
      endpoint: "getCustomer",
      windowFrom: overallFrom,
      windowTo: overallTo,
    });
    try {
      const result = await _getCustomer({
        dateFrom: toCleanCloudDate(overallFrom),
        dateTo: toCleanCloudDate(overallTo),
        excludeDeactivated: 1,
      });
      if (!result.ok) {
        summary.errors.push({
          month: "*",
          endpoint: "getCustomer",
          message: result.error,
        });
        await _finishSyncLog(logId, { error: result.error });
      } else {
        const arr = Array.isArray(result.data)
          ? (result.data as CleanCloudCustomer[])
          : ([result.data] as CleanCloudCustomer[]);
        const rows = arr.map(adaptCustomer).filter(notNull);
        const upserted = await _upsertCustomers(rows);
        summary.customersUpserted += upserted;
        await _finishSyncLog(logId, {
          rowsFetched: arr.length,
          rowsUpserted: upserted,
        });
      }
    } catch (err) {
      const msg = errorMessage(err);
      summary.errors.push({
        month: "*",
        endpoint: "getCustomer",
        message: msg,
      });
      await _finishSyncLog(logId, { error: msg });
    }
  }

  /* ----- orders (month-by-month) ---------------------------------- */
  for (let i = monthsBack - 1; i >= 0; i--) {
    const monthStart = startOfMonthUTC(now, i);
    const monthEnd = startOfMonthUTC(now, i - 1);
    const monthLabel = monthStart.toISOString().slice(0, 7);

    const logId = await _startSyncLog({
      source: "cleancloud",
      trigger: "backfill",
      endpoint: "getOrders",
      windowFrom: monthStart,
      windowTo: monthEnd,
    });
    try {
      const result = await _getOrders({
        dateFrom: toCleanCloudDate(monthStart),
        dateTo: toCleanCloudDate(monthEnd),
        sendProductDetails: 1,
      });
      if (!result.ok) {
        summary.errors.push({
          month: monthLabel,
          endpoint: "getOrders",
          message: result.error,
        });
        await _finishSyncLog(logId, { error: result.error });
        continue;
      }
      const arr = result.data as CleanCloudOrder[];
      const orderRows = arr.map(adaptOrder).filter(notNull);
      const paymentRows = arr.flatMap(extractPaymentsFromOrder);
      const ordersUpserted = await _upsertOrders(orderRows);
      const paymentsUpserted = await _upsertPayments(paymentRows);
      summary.ordersUpserted += ordersUpserted;
      summary.paymentsUpserted += paymentsUpserted;
      summary.monthsCompleted += 1;
      await _finishSyncLog(logId, {
        rowsFetched: arr.length,
        rowsUpserted: ordersUpserted,
      });
    } catch (err) {
      const msg = errorMessage(err);
      summary.errors.push({
        month: monthLabel,
        endpoint: "getOrders",
        message: msg,
      });
      await _finishSyncLog(logId, { error: msg });
    }
  }

  return summary;
}

/* ----- helpers --------------------------------------------------------- */

function startOfMonthUTC(reference: Date, monthsAgo: number): Date {
  const y = reference.getUTCFullYear();
  const m = reference.getUTCMonth() - monthsAgo;
  return new Date(Date.UTC(y, m, 1, 0, 0, 0));
}

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
