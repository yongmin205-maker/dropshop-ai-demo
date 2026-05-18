/**
 * One-time historical backfill (Phase 25a, revised 25-verify).
 *
 * Run once after first deploy to seed the mirror with the last N months of
 * CleanCloud data. After that the daily pull keeps it current.
 *
 * Why the windowing is what it is
 * -------------------------------
 * CleanCloud's API has two undocumented hard caps that broke the original
 * implementation:
 *
 *   1. `getCustomer` in date-range mode rejects windows > 31 days with
 *      `{"Error":"Date Range can not be longer than 31 days"}`.
 *   2. `getOrders` rejects "too many orders in one request"; empirically a
 *      busy NYC dry-cleaner exceeds the cap once the window goes past ~7
 *      days. Status is still 200 so the previous transport code happily
 *      treated the error envelope as a success-with-zero-orders, which is
 *      why the first backfill silently wrote 0 rows.
 *
 * The fix:
 *   - customers : 30-day windows, walked back month-by-month.
 *   - orders    : 7-day windows, walked back week-by-week, with adaptive
 *                 bisection if a single 7-day window still hits the cap.
 *   - products  : a single date-less call (CleanCloud's catalog endpoint
 *                 ignores date params).
 *
 * Each window writes its own `posSyncLog` row so partial failures stay
 * resumable and visible in the admin "POS 미러" tab. Every row finishes
 * with `finishSyncLog`, including the error path, so no row is left with
 * `finishedAt = NULL`.
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
import { toCleanCloudDate } from "./pullJob";

export type BackfillSummary = {
  monthsRequested: number;
  customers: { windowsCompleted: number; windowsFailed: number; upserted: number };
  orders: { windowsCompleted: number; windowsFailed: number; upserted: number; paymentsUpserted: number };
  products: { upserted: number; changesDetected: number; error: string | null };
  errors: Array<{ window: string; endpoint: string; message: string }>;
};

export type BackfillDeps = {
  getCustomer?: typeof cleanCloud.getCustomer;
  getOrders?: typeof cleanCloud.getOrders;
  getProducts?: typeof cleanCloud.getProducts;
  upsertCustomers?: typeof upsertCustomers;
  upsertOrders?: typeof upsertOrders;
  upsertPayments?: typeof upsertPayments;
  upsertProducts?: typeof upsertProducts;
  diffProductsAndRecordChanges?: typeof diffProductsAndRecordChanges;
  startSyncLog?: typeof startSyncLog;
  finishSyncLog?: typeof finishSyncLog;
  now?: () => Date;
  /** Maximum recursion depth when bisecting an over-capacity window. */
  maxBisectDepth?: number;
};

const DEFAULT_MAX_BISECT_DEPTH = 5; // 7d → ~5h at the deepest split.

/**
 * Customer-window length in days. CleanCloud's documented cap is 31, we use
 * 30 to stay safely inside it (and to align with calendar months).
 */
const CUSTOMER_WINDOW_DAYS = 30;

/**
 * Initial order-window length in days. Empirical cap before "too many
 * orders" begins on a busy store is ~7 days; we start there and bisect on
 * cap-error.
 */
const ORDER_WINDOW_DAYS = 7;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function runBackfill(
  monthsBack = 12,
  deps: BackfillDeps = {},
): Promise<BackfillSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const _getCustomer = deps.getCustomer ?? cleanCloud.getCustomer;
  const _getOrders = deps.getOrders ?? cleanCloud.getOrders;
  const _getProducts = deps.getProducts ?? cleanCloud.getProducts;
  const _upsertCustomers = deps.upsertCustomers ?? upsertCustomers;
  const _upsertOrders = deps.upsertOrders ?? upsertOrders;
  const _upsertPayments = deps.upsertPayments ?? upsertPayments;
  const _upsertProducts = deps.upsertProducts ?? upsertProducts;
  const _diffProducts = deps.diffProductsAndRecordChanges ?? diffProductsAndRecordChanges;
  const _startSyncLog = deps.startSyncLog ?? startSyncLog;
  const _finishSyncLog = deps.finishSyncLog ?? finishSyncLog;
  const maxBisectDepth = deps.maxBisectDepth ?? DEFAULT_MAX_BISECT_DEPTH;

  const summary: BackfillSummary = {
    monthsRequested: monthsBack,
    customers: { windowsCompleted: 0, windowsFailed: 0, upserted: 0 },
    orders: { windowsCompleted: 0, windowsFailed: 0, upserted: 0, paymentsUpserted: 0 },
    products: { upserted: 0, changesDetected: 0, error: null },
    errors: [],
  };

  const overallFrom = startOfMonthUTC(now, monthsBack - 1);
  const overallTo = endOfDayUTC(now);

  /* ----- 1. customers (30-day rolling windows) -------------------- */
  for (const win of rollingWindows(overallFrom, overallTo, CUSTOMER_WINDOW_DAYS)) {
    const label = `${isoDate(win.from)}…${isoDate(win.to)}`;
    const logId = await _startSyncLog({
      source: "cleancloud",
      trigger: "backfill",
      endpoint: "getCustomer",
      windowFrom: win.from,
      windowTo: win.to,
    });
    try {
      const result = await _getCustomer({
        dateFrom: toCleanCloudDate(win.from),
        dateTo: toCleanCloudDate(win.to),
        excludeDeactivated: 1,
      });
      if (!result.ok) {
        summary.customers.windowsFailed += 1;
        summary.errors.push({ window: label, endpoint: "getCustomer", message: result.error });
        await _finishSyncLog(logId, { error: result.error });
        continue;
      }
      const arr = Array.isArray(result.data)
        ? (result.data as CleanCloudCustomer[])
        : ([result.data] as CleanCloudCustomer[]);
      const rows = arr.map(adaptCustomer).filter(notNull);
      const upserted = await _upsertCustomers(rows);
      summary.customers.upserted += upserted;
      summary.customers.windowsCompleted += 1;
      await _finishSyncLog(logId, { rowsFetched: arr.length, rowsUpserted: upserted });
    } catch (err) {
      const msg = errorMessage(err);
      summary.customers.windowsFailed += 1;
      summary.errors.push({ window: label, endpoint: "getCustomer", message: msg });
      await _finishSyncLog(logId, { error: msg });
    }
  }

  /* ----- 2. orders (7-day windows, bisect on cap error) ----------- */
  for (const win of rollingWindows(overallFrom, overallTo, ORDER_WINDOW_DAYS)) {
    await fetchOrdersWindow({
      from: win.from,
      to: win.to,
      depth: 0,
      maxBisectDepth,
      summary,
      getOrders: _getOrders,
      upsertOrders: _upsertOrders,
      upsertPayments: _upsertPayments,
      startSyncLog: _startSyncLog,
      finishSyncLog: _finishSyncLog,
    });
  }

  /* ----- 3. products (single call) -------------------------------- */
  {
    const logId = await _startSyncLog({
      source: "cleancloud",
      trigger: "backfill",
      endpoint: "getProducts",
      windowFrom: overallFrom,
      windowTo: overallTo,
    });
    try {
      const result = await _getProducts({ sendUpcharges: 1 });
      if (!result.ok) {
        summary.products.error = result.error;
        summary.errors.push({ window: "*", endpoint: "getProducts", message: result.error });
        await _finishSyncLog(logId, { error: result.error });
      } else {
        const arr = result.data as CleanCloudProduct[];
        const rows = arr.map((p) => adaptProduct(p)).filter(notNull);
        // Diff before upsert so the comparison sees the previous state.
        summary.products.changesDetected = await _diffProducts("cleancloud", rows, logId);
        summary.products.upserted = await _upsertProducts(rows);
        await _finishSyncLog(logId, {
          rowsFetched: arr.length,
          rowsUpserted: summary.products.upserted,
        });
      }
    } catch (err) {
      const msg = errorMessage(err);
      summary.products.error = msg;
      summary.errors.push({ window: "*", endpoint: "getProducts", message: msg });
      await _finishSyncLog(logId, { error: msg });
    }
  }

  return summary;
}

/* ----- internal: orders fetch with adaptive bisection -------------- */

type OrdersFetchCtx = {
  from: Date;
  to: Date;
  depth: number;
  maxBisectDepth: number;
  summary: BackfillSummary;
  getOrders: typeof cleanCloud.getOrders;
  upsertOrders: typeof upsertOrders;
  upsertPayments: typeof upsertPayments;
  startSyncLog: typeof startSyncLog;
  finishSyncLog: typeof finishSyncLog;
};

/**
 * Detect CleanCloud's "too many orders" envelope so we can bisect instead of
 * surfacing it as a hard failure. The string is stable across all stores
 * we've observed; we keep the match loose so a future minor wording tweak
 * still fires the bisection path.
 */
function isOrdersCapError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("too many orders") || lower.includes("narrow or restructure");
}

async function fetchOrdersWindow(ctx: OrdersFetchCtx): Promise<void> {
  const label = `${isoDate(ctx.from)}…${isoDate(ctx.to)}`;
  const logId = await ctx.startSyncLog({
    source: "cleancloud",
    trigger: "backfill",
    endpoint: "getOrders",
    windowFrom: ctx.from,
    windowTo: ctx.to,
  });
  try {
    const result = await ctx.getOrders({
      dateFrom: toCleanCloudDate(ctx.from),
      dateTo: toCleanCloudDate(ctx.to),
      sendProductDetails: 1,
    });
    if (!result.ok) {
      // Bisect when CleanCloud reports the window is over capacity, but only
      // up to `maxBisectDepth` levels so a runaway can't blow up the job.
      if (
        isOrdersCapError(result.error) &&
        ctx.depth < ctx.maxBisectDepth &&
        ctx.to.getTime() - ctx.from.getTime() > ONE_DAY_MS / 4 // > 6h, otherwise give up
      ) {
        await ctx.finishSyncLog(logId, {
          error: `bisecting (depth ${ctx.depth + 1}): ${result.error}`,
        });
        const mid = new Date((ctx.from.getTime() + ctx.to.getTime()) / 2);
        await fetchOrdersWindow({ ...ctx, to: mid, depth: ctx.depth + 1 });
        await fetchOrdersWindow({ ...ctx, from: mid, depth: ctx.depth + 1 });
        return;
      }
      ctx.summary.orders.windowsFailed += 1;
      ctx.summary.errors.push({ window: label, endpoint: "getOrders", message: result.error });
      await ctx.finishSyncLog(logId, { error: result.error });
      return;
    }
    const arr = result.data as CleanCloudOrder[];
    const orderRows = arr.map(adaptOrder).filter(notNull);
    const paymentRows = arr.flatMap(extractPaymentsFromOrder);
    const ordersUpserted = await ctx.upsertOrders(orderRows);
    const paymentsUpserted = await ctx.upsertPayments(paymentRows);
    ctx.summary.orders.upserted += ordersUpserted;
    ctx.summary.orders.paymentsUpserted += paymentsUpserted;
    ctx.summary.orders.windowsCompleted += 1;
    await ctx.finishSyncLog(logId, {
      rowsFetched: arr.length,
      rowsUpserted: ordersUpserted,
    });
  } catch (err) {
    const msg = errorMessage(err);
    ctx.summary.orders.windowsFailed += 1;
    ctx.summary.errors.push({ window: label, endpoint: "getOrders", message: msg });
    await ctx.finishSyncLog(logId, { error: msg });
  }
}

/* ----- helpers ----------------------------------------------------- */

function startOfMonthUTC(reference: Date, monthsAgo: number): Date {
  const y = reference.getUTCFullYear();
  const m = reference.getUTCMonth() - monthsAgo;
  return new Date(Date.UTC(y, m, 1, 0, 0, 0));
}

function endOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
}

/**
 * Produce contiguous, non-overlapping windows of `lengthDays` days, oldest
 * first, covering `[from, to]` inclusive. The final window is clamped to
 * `to` so we never emit a window in the future. We deliberately do NOT
 * dedupe across calls — each invocation gets its own `posSyncLog` rows so
 * the admin dashboard can show progress per-window.
 */
export function rollingWindows(
  from: Date,
  to: Date,
  lengthDays: number,
): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  if (to.getTime() <= from.getTime()) return out;
  const stepMs = lengthDays * ONE_DAY_MS;
  let cursor = from.getTime();
  const end = to.getTime();
  while (cursor < end) {
    const winEnd = Math.min(cursor + stepMs, end);
    out.push({ from: new Date(cursor), to: new Date(winEnd) });
    cursor = winEnd;
  }
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
