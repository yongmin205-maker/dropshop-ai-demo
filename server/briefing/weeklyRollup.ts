/**
 * server/briefing/weeklyRollup.ts
 *
 * Monday-only "지난주 톺아보기" rollup. Triggered when the daily briefing
 * runs on a Monday — produces a 7-day aggregate (last Mon 04:00 NYC →
 * this Mon 04:00 NYC) plus a 4-week-prior comparison and a per-DOW
 * breakdown.
 *
 * Pure split (computeWeeklyRollup) so unit tests don't touch the DB.
 * Loader (loadWeeklyRollup) handles range queries.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../db";
import { posOrders, type PosOrder } from "../../drizzle/schema";
import { nycDateToBusinessDayStart } from "../analytics/dailyMetrics";

const SOURCE_DEFAULT = "cleancloud" as const;

export interface WeeklyRollupInput {
  /** Orders in [windowStartMs, windowEndMs). */
  orders: PosOrder[];
  /** Same-shape window from 4 weeks earlier for delta math. Empty
   *  → comparison fields are null. */
  prior4wkOrders?: PosOrder[];
}

export interface WeeklyRollup {
  /** ISO date (YYYY-MM-DD NYC) of the Monday the rollup *ends* on
   *  — same as the briefingDate that triggered it. */
  weekEndDate: string;
  /** ISO date (YYYY-MM-DD NYC) of the Monday the rollup *starts* on
   *  (7 days earlier). */
  weekStartDate: string;
  /** Window epoch-ms half-open. */
  windowStartMs: number;
  windowEndMs: number;

  orderCount: number;
  revenueCents: number;
  uniqueCustomerCount: number;
  /** Average order value across the 7-day window, cents. */
  avgOrderCents: number;
  /** Largest single order in the window, cents. */
  largestOrderCents: number;

  /** Per-DOW breakdown, Mon..Sun (NYC clock-time). */
  byDayOfWeek: Array<{
    /** 0 = Monday … 6 = Sunday. */
    dow: number;
    /** Localized 3-letter name (월, 화, 수…). */
    name: string;
    orderCount: number;
    revenueCents: number;
  }>;

  /** Same metric vs. 4 weeks earlier. null when prior window empty. */
  vs4WeeksAgo: {
    revenueDeltaPct: number | null;
    orderCountDeltaPct: number | null;
    priorRevenueCents: number;
    priorOrderCount: number;
  };
}

const DOW_NAMES_KR = ["월", "화", "수", "목", "금", "토", "일"];

/** Get NYC weekday from a UTC ms timestamp. Mon=0…Sun=6. */
function nycWeekday(utcMs: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  const wd = fmt.format(new Date(utcMs));
  // en-US 'short' returns Mon, Tue, Wed, Thu, Fri, Sat, Sun.
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd);
  return idx;
}

/** Round half-away-from-zero to one decimal. Returns 0 for `0`. */
function pctDelta(current: number, prior: number): number | null {
  if (prior <= 0) return null;
  const raw = ((current - prior) / prior) * 100;
  return Math.round(raw * 10) / 10;
}

/**
 * Pure rollup — given orders + optional prior window, build the
 * WeeklyRollup. No DB access, no time-zone *lookup* — all timestamps
 * already in epoch-ms.
 */
export function computeWeeklyRollup(args: {
  weekEndDate: string;
  weekStartDate: string;
  windowStartMs: number;
  windowEndMs: number;
  orders: PosOrder[];
  prior4wkOrders?: PosOrder[];
}): WeeklyRollup {
  const { weekEndDate, weekStartDate, windowStartMs, windowEndMs, orders } = args;
  const prior = args.prior4wkOrders ?? [];

  const orderCount = orders.length;
  const revenueCents = orders.reduce(
    (acc, o) => acc + (o.finalTotalCents ?? 0),
    0,
  );
  const customerIds = new Set<string>();
  for (const o of orders) {
    if (o.customerExternalId) customerIds.add(o.customerExternalId);
  }
  const avgOrderCents =
    orderCount > 0 ? Math.round(revenueCents / orderCount) : 0;
  const largestOrderCents = orders.reduce(
    (acc, o) => Math.max(acc, o.finalTotalCents ?? 0),
    0,
  );

  // Per-DOW buckets — initialize Mon..Sun then walk orders.
  const buckets = Array.from({ length: 7 }, (_, dow) => ({
    dow,
    name: DOW_NAMES_KR[dow]!,
    orderCount: 0,
    revenueCents: 0,
  }));
  for (const o of orders) {
    if (!o.placedAt) continue;
    const ms = new Date(o.placedAt).getTime();
    const dow = nycWeekday(ms);
    if (dow < 0 || dow > 6) continue;
    buckets[dow]!.orderCount += 1;
    buckets[dow]!.revenueCents += o.finalTotalCents ?? 0;
  }

  const priorRevenueCents = prior.reduce(
    (acc, o) => acc + (o.finalTotalCents ?? 0),
    0,
  );
  const priorOrderCount = prior.length;

  return {
    weekEndDate,
    weekStartDate,
    windowStartMs,
    windowEndMs,
    orderCount,
    revenueCents,
    uniqueCustomerCount: customerIds.size,
    avgOrderCents,
    largestOrderCents,
    byDayOfWeek: buckets,
    vs4WeeksAgo: {
      revenueDeltaPct: pctDelta(revenueCents, priorRevenueCents),
      orderCountDeltaPct: pctDelta(orderCount, priorOrderCount),
      priorRevenueCents,
      priorOrderCount,
    },
  };
}

/**
 * Returns true when briefingDate (NYC) is a Monday. Pure helper so
 * the orchestrator can decide whether to load weekly rollup at all.
 */
export function isMonday(briefingDate: string): boolean {
  const startMs = nycDateToBusinessDayStart(briefingDate).getTime();
  return nycWeekday(startMs + 5 * 60 * 60 * 1000) === 0; // probe 09:00 NYC
}

/**
 * Subtract n days from a YYYY-MM-DD (NYC) and return YYYY-MM-DD.
 * Naive: uses noon-UTC math which is DST-safe for ±days within a
 * single year (we never go backward more than 28 days).
 */
function addDaysIso(briefingDate: string, days: number): string {
  const [y, m, d] = briefingDate.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  probe.setUTCDate(probe.getUTCDate() + days);
  const yy = probe.getUTCFullYear();
  const mm = String(probe.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(probe.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * DB loader — fetches the 7-day window ending at briefingDate (which
 * must be a Monday) and the 4-weeks-prior 7-day window for delta.
 */
export async function loadWeeklyRollup(args: {
  briefingDate: string; // YYYY-MM-DD (NYC), must be Monday
  source?: "cleancloud" | "dropshop_pos";
}): Promise<WeeklyRollup> {
  const source = args.source ?? SOURCE_DEFAULT;
  const db = await getDb();
  if (!db) throw new Error("loadWeeklyRollup: getDb() returned null");

  const weekEndDate = args.briefingDate;
  const weekStartDate = addDaysIso(weekEndDate, -7);

  const windowEndMs = nycDateToBusinessDayStart(weekEndDate).getTime();
  const windowStartMs = nycDateToBusinessDayStart(weekStartDate).getTime();

  // Prior window: shift both endpoints 28 days earlier.
  const priorStartDate = addDaysIso(weekStartDate, -28);
  const priorEndDate = addDaysIso(weekEndDate, -28);
  const priorStartMs = nycDateToBusinessDayStart(priorStartDate).getTime();
  const priorEndMs = nycDateToBusinessDayStart(priorEndDate).getTime();

  const [orders, priorOrders] = await Promise.all([
    db
      .select()
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, source),
          gte(posOrders.placedAt, new Date(windowStartMs)),
          lt(posOrders.placedAt, new Date(windowEndMs)),
        ),
      ),
    db
      .select()
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, source),
          gte(posOrders.placedAt, new Date(priorStartMs)),
          lt(posOrders.placedAt, new Date(priorEndMs)),
        ),
      ),
  ]);

  return computeWeeklyRollup({
    weekEndDate,
    weekStartDate,
    windowStartMs,
    windowEndMs,
    orders,
    prior4wkOrders: priorOrders,
  });
}
