/**
 * server/analytics/dailyMetrics.ts
 *
 * Pure analytics helpers for the Daily Briefing. Two layers:
 *
 *   1. **Pure** — `computeDailyMetrics(...)` works on already-loaded
 *      rows so it's trivially unit-testable. No DB access.
 *
 *   2. **DB loader** — `loadDailyMetrics({ briefingDate, source })`
 *      fetches the right slice of `posOrders` and `posCustomers` for
 *      the briefing's NYC business-day window, plus the prior day
 *      for comparison, then delegates to `computeDailyMetrics`.
 *
 * Business-day window
 *   We treat the NYC business day as `[04:00 ET, 04:00 ET next day)`
 *   so very-late-night drop-offs still count under the same trading
 *   date the owner thinks of. 04:00 was chosen over midnight because
 *   by then every NYC drycleaner is closed.
 *
 * Timezone math
 *   We convert YYYY-MM-DD `briefingDate` (in NYC) to UTC ms by
 *   re-using `Intl.DateTimeFormat` to find the local offset on that
 *   date — handles DST flips correctly without a tz library.
 */

import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../db";
import { posCustomers, posOrders, type PosOrder } from "../../drizzle/schema";

const NYC_BUSINESS_DAY_ROLL_HOUR = 4;
const NYC_TZ = "America/New_York";

export interface DailyMetricsInput {
  /** Orders placed in `[periodStartMs, periodEndMs)`. */
  orders: PosOrder[];
  /** Same window for the *previous* business day. When absent or
   *  empty, comparison fields are null. */
  prevOrders?: PosOrder[];
  /** Customer ids (posCustomers.externalId) that existed *before*
   *  periodStartMs. Used to classify "new" vs "returning". */
  knownCustomerExternalIds: Set<string>;
}

export interface DailyMetrics {
  briefingDate: string;
  periodStartMs: number;
  periodEndMs: number;
  orderCount: number;
  revenueCents: number;
  avgOrderCents: number;
  paidCount: number;
  uniqueCustomerCount: number;
  newCustomerCount: number;
  returningCustomerCount: number;
  expressCount: number;
  pickupTomorrowCount: number;
  revenueDeltaPct: number | null;
  orderCountDeltaPct: number | null;
  largestOrderCents: number;
  topSpenders: Array<{ externalId: string; revenueCents: number; orderCount: number }>;
}

/**
 * Convert a NYC YYYY-MM-DD date to a UTC `Date` representing
 * `04:00:00 America/New_York` on that date (DST-aware).
 */
export function nycDateToBusinessDayStart(briefingDate: string): Date {
  const [y, m, d] = briefingDate.split("-").map(Number);
  // Probe at noon UTC to discover the NYC offset on this date.
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NYC_TZ,
    timeZoneName: "shortOffset",
    hour: "numeric",
  });
  const tzPart =
    fmt.formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m2 = tzPart.match(/GMT([+-]?\d{1,2})(?::(\d{2}))?/);
  const offsetHours = m2 ? Number(m2[1]) + (m2[2] ? Number(m2[2]) / 60 : 0) : -5;
  // 04:00 NYC ⇒ (04 - offsetHours) UTC. e.g. EDT(GMT-4) ⇒ 08:00 UTC.
  return new Date(Date.UTC(y, m - 1, d, NYC_BUSINESS_DAY_ROLL_HOUR - offsetHours));
}

/** Pure metrics computation. No DB access. */
export function computeDailyMetrics(
  briefingDate: string,
  periodStartMs: number,
  periodEndMs: number,
  input: DailyMetricsInput,
): DailyMetrics {
  const { orders, prevOrders, knownCustomerExternalIds } = input;

  const orderCount = orders.length;
  const revenueCents = orders.reduce((s, o) => s + (o.finalTotalCents ?? 0), 0);
  const avgOrderCents = orderCount > 0 ? Math.round(revenueCents / orderCount) : 0;
  const paidCount = orders.filter((o) => o.paid === 1).length;
  const expressCount = orders.filter((o) => o.express === 1).length;

  // Unique customers + new vs returning split.
  const customerIds = new Set<string>();
  for (const o of orders) {
    if (o.customerExternalId) customerIds.add(o.customerExternalId);
  }
  const uniqueCustomerCount = customerIds.size;
  let newCustomerCount = 0;
  let returningCustomerCount = 0;
  for (const id of Array.from(customerIds)) {
    if (knownCustomerExternalIds.has(id)) returningCustomerCount += 1;
    else newCustomerCount += 1;
  }

  // Pickup-tomorrow count.
  const tomorrowStart = periodEndMs;
  const tomorrowEnd = periodEndMs + (periodEndMs - periodStartMs);
  const pickupTomorrowCount = orders.filter((o) => {
    if (!o.pickupAt) return false;
    const t = new Date(o.pickupAt).getTime();
    return t >= tomorrowStart && t < tomorrowEnd;
  }).length;

  // Comparison vs previous day (null when prev day had zero data).
  let revenueDeltaPct: number | null = null;
  let orderCountDeltaPct: number | null = null;
  if (prevOrders && prevOrders.length > 0) {
    const prevRevenue = prevOrders.reduce((s, o) => s + (o.finalTotalCents ?? 0), 0);
    if (prevRevenue > 0) {
      revenueDeltaPct = +(((revenueCents - prevRevenue) / prevRevenue) * 100).toFixed(1);
    }
    orderCountDeltaPct = +(
      ((orderCount - prevOrders.length) / prevOrders.length) *
      100
    ).toFixed(1);
  }

  // Largest single order + top 3 spenders.
  let largestOrderCents = 0;
  const spendByCustomer = new Map<string, { revenueCents: number; orderCount: number }>();
  for (const o of orders) {
    const total = o.finalTotalCents ?? 0;
    if (total > largestOrderCents) largestOrderCents = total;
    if (o.customerExternalId) {
      const cur = spendByCustomer.get(o.customerExternalId) ?? {
        revenueCents: 0,
        orderCount: 0,
      };
      cur.revenueCents += total;
      cur.orderCount += 1;
      spendByCustomer.set(o.customerExternalId, cur);
    }
  }
  const topSpenders = Array.from(spendByCustomer.entries())
    .map(([externalId, v]) => ({ externalId, ...v }))
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 3);

  return {
    briefingDate,
    periodStartMs,
    periodEndMs,
    orderCount,
    revenueCents,
    avgOrderCents,
    paidCount,
    uniqueCustomerCount,
    newCustomerCount,
    returningCustomerCount,
    expressCount,
    pickupTomorrowCount,
    revenueDeltaPct,
    orderCountDeltaPct,
    largestOrderCents,
    topSpenders,
  };
}

/** DB loader — fetches windows + delegates to computeDailyMetrics. */
export async function loadDailyMetrics(args: {
  briefingDate: string;
  source: "cleancloud" | "dropshop_pos";
}): Promise<DailyMetrics> {
  const db = await getDb();
  if (!db) throw new Error("loadDailyMetrics: getDb() returned null");

  const start = nycDateToBusinessDayStart(args.briefingDate);
  const [y, m, d] = args.briefingDate.split("-").map(Number);
  const nextDateStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = nycDateToBusinessDayStart(nextDateStr);
  const prevDateStr = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const prevStart = nycDateToBusinessDayStart(prevDateStr);
  const prevEnd = start;

  const [orders, prevOrders] = await Promise.all([
    db
      .select()
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, args.source),
          gte(posOrders.placedAt, start),
          lt(posOrders.placedAt, end),
        ),
      ),
    db
      .select()
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, args.source),
          gte(posOrders.placedAt, prevStart),
          lt(posOrders.placedAt, prevEnd),
        ),
      ),
  ]);

  // "Known" customer = mirror row created before periodStart.
  const knownRows = await db
    .select({ externalId: posCustomers.externalId })
    .from(posCustomers)
    .where(
      and(
        eq(posCustomers.source, args.source),
        lt(posCustomers.createdAt, start),
      ),
    );
  const knownCustomerExternalIds = new Set(knownRows.map((r) => r.externalId));

  return computeDailyMetrics(args.briefingDate, start.getTime(), end.getTime(), {
    orders,
    prevOrders,
    knownCustomerExternalIds,
  });
}
