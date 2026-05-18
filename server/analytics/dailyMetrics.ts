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

import { and, eq, gte, inArray, lt } from "drizzle-orm";
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
  /** Customer external ids whose **earliest** posOrders.placedAt is
   *  *before* periodStartMs. Replaces the old createdAt heuristic
   *  which broke when a backfill imported every customer on the same
   *  day (everyone became "new"). */
  knownCustomerExternalIds: Set<string>;
  /** Optional lifetime profile lookup keyed by externalId, used to
   *  enrich top spenders. Empty map ⇒ profiles default to today's
   *  numbers + isReturning=false. */
  customerProfiles?: Map<
    string,
    {
      lifetimeOrderCount: number;
      lifetimeRevenueCents: number;
      firstOrderAt: string | null;
      lastOrderAt: string | null;
      /** Display name from posCustomers mirror. Null when the customer
       *  has no name on record — caller should fall back to phone or a
       *  generic placeholder, NEVER to externalId. */
      name: string | null;
      /** E.164 phone for masked fallback (e.g. "…·7672"). Null when
       *  not collected. */
      phoneE164: string | null;
    }
  >;
  /** Same-day-of-week trailing baseline. The loader passes in the
   *  last N (default 4) occurrences of the briefingDate's weekday
   *  *before* periodStartMs, already aggregated. Empty array ⇒ no
   *  baseline; dowVsAvg fields become null. */
  dowSamples?: Array<{ revenueCents: number; orderCount: number }>;
}

export interface ServiceMixEntry {
  /** Normalized item-name bucket: "Shirts", "Drycleaning", "Wash & Fold", "Bedding", "Alterations", "Other". */
  category: string;
  /** How many line-items of this kind shipped today. Sum of
   *  `products[].quantity`, or 1 per matching summary line if no
   *  quantity is present. */
  quantity: number;
  /** Cents booked under this category — uses `pricePerUnit * quantity`
   *  when both are present, otherwise 0 (we never invent revenue). */
  revenueCents: number;
}

export interface HourBucket {
  /** Hour of the NYC business day, 0-23 (clock-time, not offset). */
  hour: number;
  orderCount: number;
  revenueCents: number;
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
  /** Top spenders enriched with lifetime stats so the briefing can say
   *  "이 분은 작년 한 해 12번 오신 단골" instead of just an external id. */
  topSpenderProfiles: Array<{
    externalId: string;
    revenueCents: number;
    orderCount: number;
    lifetimeOrderCount: number;
    lifetimeRevenueCents: number;
    firstOrderAt: string | null;
    lastOrderAt: string | null;
    isReturning: boolean;
    /** Mirror display name. Null when missing — prompt builder must
     *  fall back to phoneE164 (masked) or a generic placeholder, NEVER
     *  to externalId. */
    name: string | null;
    /** E.164 phone for masked fallback. Null when missing. */
    phoneE164: string | null;
  }>;
  serviceMix: ServiceMixEntry[];
  hourlyDistribution: HourBucket[];
  /** The peak hour (mode of orderCount). Null if zero orders. */
  peakHour: number | null;
  /** Same-day-of-week trailing baseline (revenue + order count) and
   *  today's % delta vs that baseline. Null when no samples available. */
  dowVsAvg: {
    sampleCount: number;
    avgRevenueCents: number;
    avgOrderCount: number;
    revenueDeltaPct: number | null;
    orderCountDeltaPct: number | null;
  } | null;
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

/**
 * Map a free-form CleanCloud item label (e.g. "Shirt: Hand-Press",
 * "Pant", "Comforter (Queen)") into a small set of buckets the owner
 * actually thinks about. Lower-case substring scan keeps it cheap;
 * unknown items fall through to "Other" so we never lose revenue.
 */
export function classifyServiceItem(name: string): string {
  const n = name.toLowerCase();
  if (/(shirt|blouse|tuxedo)/.test(n)) return "Shirts";
  if (/(suit|jacket|blazer|coat|dress|skirt|pant|trouser|tie|silk)/.test(n)) {
    return "Drycleaning";
  }
  if (/(wash|fold|w\/f|w&f|laundry|w\.f|wnf)/.test(n)) return "Wash & Fold";
  if (/(comforter|duvet|blanket|sheet|pillow|bedding|quilt|cover)/.test(n)) {
    return "Bedding";
  }
  if (/(alter|hem|repair|stitch|button|zipper)/.test(n)) return "Alterations";
  if (/(rug|carpet|leather|suede|fur)/.test(n)) return "Specialty";
  return "Other";
}

/** Helper: extract a usable {name, quantity, pricePerUnitCents} list
 *  from a posOrders.itemsSummary blob. Tolerant to either an array
 *  payload or a JSON string, and of missing fields. */
function extractLineItems(
  raw: unknown,
): Array<{ name: string; quantity: number; pricePerUnitCents: number }> {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      /* keep arr = [] */
    }
  }
  return arr.flatMap((it) => {
    if (!it || typeof it !== "object") return [];
    const o = it as Record<string, unknown>;
    const name =
      (typeof o.name === "string" && o.name) ||
      (typeof o.itemName === "string" && o.itemName) ||
      "";
    if (!name) return [];
    const quantity =
      typeof o.quantity === "number"
        ? o.quantity
        : typeof o.quantity === "string"
          ? Number(o.quantity) || 1
          : 1;
    const pricePerUnitDollars =
      typeof o.pricePerUnit === "number"
        ? o.pricePerUnit
        : typeof o.pricePerUnit === "string"
          ? Number(o.pricePerUnit) || 0
          : 0;
    return [
      {
        name,
        quantity: Math.max(1, Math.floor(quantity)),
        pricePerUnitCents: Math.round(pricePerUnitDollars * 100),
      },
    ];
  });
}

/** NYC clock hour for a given UTC ms. DST-aware. */
function nycHourOf(utcMs: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NYC_TZ,
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  // "24" is what Intl returns for midnight in some locales — normalize.
  const hh = Number(h) % 24;
  return Number.isFinite(hh) ? hh : 0;
}

/** Pure metrics computation. No DB access. */
export function computeDailyMetrics(
  briefingDate: string,
  periodStartMs: number,
  periodEndMs: number,
  input: DailyMetricsInput,
): DailyMetrics {
  const { orders, prevOrders, knownCustomerExternalIds, customerProfiles, dowSamples } = input;

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

  // Top-spender profiles: enrich with lifetime stats when we have
  // them, otherwise fall back to today's numbers so the field is
  // never undefined.
  const topSpenderProfiles = topSpenders.map((s) => {
    const p = customerProfiles?.get(s.externalId);
    return {
      externalId: s.externalId,
      revenueCents: s.revenueCents,
      orderCount: s.orderCount,
      lifetimeOrderCount: p?.lifetimeOrderCount ?? s.orderCount,
      lifetimeRevenueCents: p?.lifetimeRevenueCents ?? s.revenueCents,
      firstOrderAt: p?.firstOrderAt ?? null,
      lastOrderAt: p?.lastOrderAt ?? null,
      isReturning: knownCustomerExternalIds.has(s.externalId),
      name: p?.name ?? null,
      phoneE164: p?.phoneE164 ?? null,
    };
  });

  // Service mix — sum line items across orders, classify each.
  const serviceMixMap = new Map<string, ServiceMixEntry>();
  for (const o of orders) {
    const items = extractLineItems(o.itemsSummary);
    for (const it of items) {
      const cat = classifyServiceItem(it.name);
      const cur =
        serviceMixMap.get(cat) ?? { category: cat, quantity: 0, revenueCents: 0 };
      cur.quantity += it.quantity;
      cur.revenueCents += it.quantity * it.pricePerUnitCents;
      serviceMixMap.set(cat, cur);
    }
  }
  const serviceMix = Array.from(serviceMixMap.values()).sort(
    (a, b) => b.revenueCents - a.revenueCents || b.quantity - a.quantity,
  );

  // Hourly distribution — only fill hours that actually saw orders
  // (sparse). The owner doesn't need a 24-row table when 18 of them
  // are zero.
  const hourMap = new Map<number, HourBucket>();
  for (const o of orders) {
    if (!o.placedAt) continue;
    const h = nycHourOf(new Date(o.placedAt).getTime());
    const cur = hourMap.get(h) ?? { hour: h, orderCount: 0, revenueCents: 0 };
    cur.orderCount += 1;
    cur.revenueCents += o.finalTotalCents ?? 0;
    hourMap.set(h, cur);
  }
  const hourlyDistribution = Array.from(hourMap.values()).sort(
    (a, b) => a.hour - b.hour,
  );
  let peakHour: number | null = null;
  let peakOrders = 0;
  for (const b of hourlyDistribution) {
    if (b.orderCount > peakOrders) {
      peakOrders = b.orderCount;
      peakHour = b.hour;
    }
  }

  // Same-DOW trailing baseline.
  let dowVsAvg: DailyMetrics["dowVsAvg"] = null;
  if (dowSamples && dowSamples.length > 0) {
    const totalRevenue = dowSamples.reduce((s, x) => s + x.revenueCents, 0);
    const totalOrders = dowSamples.reduce((s, x) => s + x.orderCount, 0);
    const avgRevenueCents = Math.round(totalRevenue / dowSamples.length);
    const avgOrderCount = totalOrders / dowSamples.length;
    const revenueDeltaPct =
      avgRevenueCents > 0
        ? +(((revenueCents - avgRevenueCents) / avgRevenueCents) * 100).toFixed(1)
        : null;
    const orderCountDeltaPct =
      avgOrderCount > 0
        ? +(((orderCount - avgOrderCount) / avgOrderCount) * 100).toFixed(1)
        : null;
    dowVsAvg = {
      sampleCount: dowSamples.length,
      avgRevenueCents,
      avgOrderCount: +avgOrderCount.toFixed(2),
      revenueDeltaPct,
      orderCountDeltaPct,
    };
  }

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
    topSpenderProfiles,
    serviceMix,
    hourlyDistribution,
    peakHour,
    dowVsAvg,
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

  // "Known" / returning = the customer's earliest order is *before*
  // periodStart. Replaces the old createdAt heuristic which broke
  // when a backfill imported every customer on the same day.
  const priorOrders = await db
    .select({
      customerExternalId: posOrders.customerExternalId,
      placedAt: posOrders.placedAt,
      finalTotalCents: posOrders.finalTotalCents,
    })
    .from(posOrders)
    .where(
      and(
        eq(posOrders.source, args.source),
        lt(posOrders.placedAt, start),
      ),
    );
  const knownCustomerExternalIds = new Set<string>();
  for (const r of priorOrders) {
    if (r.customerExternalId) knownCustomerExternalIds.add(r.customerExternalId);
  }

  // Build lifetime profiles for each top-spender candidate. We keep
  // this scoped to today's customer ids so the query stays small even
  // on years-long mirrors.
  const todaysCustomerIds = new Set<string>();
  for (const o of orders) {
    if (o.customerExternalId) todaysCustomerIds.add(o.customerExternalId);
  }
  const profileAccumulator = new Map<
    string,
    {
      lifetimeOrderCount: number;
      lifetimeRevenueCents: number;
      firstOrderAt: number | null;
      lastOrderAt: number | null;
    }
  >();
  // Bootstrap from prior-period orders.
  for (const r of priorOrders) {
    if (!r.customerExternalId || !todaysCustomerIds.has(r.customerExternalId)) {
      continue;
    }
    const cur = profileAccumulator.get(r.customerExternalId) ?? {
      lifetimeOrderCount: 0,
      lifetimeRevenueCents: 0,
      firstOrderAt: null,
      lastOrderAt: null,
    };
    cur.lifetimeOrderCount += 1;
    cur.lifetimeRevenueCents += r.finalTotalCents ?? 0;
    const t = r.placedAt ? new Date(r.placedAt).getTime() : null;
    if (t !== null) {
      cur.firstOrderAt =
        cur.firstOrderAt === null ? t : Math.min(cur.firstOrderAt, t);
      cur.lastOrderAt = cur.lastOrderAt === null ? t : Math.max(cur.lastOrderAt, t);
    }
    profileAccumulator.set(r.customerExternalId, cur);
  }
  // Layer in today's orders.
  for (const o of orders) {
    if (!o.customerExternalId) continue;
    const cur = profileAccumulator.get(o.customerExternalId) ?? {
      lifetimeOrderCount: 0,
      lifetimeRevenueCents: 0,
      firstOrderAt: null,
      lastOrderAt: null,
    };
    cur.lifetimeOrderCount += 1;
    cur.lifetimeRevenueCents += o.finalTotalCents ?? 0;
    const t = o.placedAt ? new Date(o.placedAt).getTime() : null;
    if (t !== null) {
      cur.firstOrderAt =
        cur.firstOrderAt === null ? t : Math.min(cur.firstOrderAt, t);
      cur.lastOrderAt = cur.lastOrderAt === null ? t : Math.max(cur.lastOrderAt, t);
    }
    profileAccumulator.set(o.customerExternalId, cur);
  }
  // Look up display name + phone from the posCustomers mirror so
  // top-spender lines never show "고객 196번". Mirror is small (≤1475
  // rows for cleancloud) and we only need today's customer ids.
  const todaysCustomerIdList = Array.from(todaysCustomerIds);
  const mirrorRows =
    todaysCustomerIdList.length > 0
      ? await db
          .select({
            externalId: posCustomers.externalId,
            name: posCustomers.name,
            phoneE164: posCustomers.phoneE164,
          })
          .from(posCustomers)
          .where(
            and(
              eq(posCustomers.source, args.source),
              inArray(posCustomers.externalId, todaysCustomerIdList),
            ),
          )
      : [];
  const mirrorByExternalId = new Map<
    string,
    { name: string | null; phoneE164: string | null }
  >();
  for (const r of mirrorRows) {
    mirrorByExternalId.set(r.externalId, {
      name: r.name?.trim() ? r.name.trim() : null,
      phoneE164: r.phoneE164?.trim() ? r.phoneE164.trim() : null,
    });
  }

  const customerProfiles = new Map(
    Array.from(profileAccumulator.entries()).map(([id, p]) => {
      const mirror = mirrorByExternalId.get(id);
      return [
        id,
        {
          lifetimeOrderCount: p.lifetimeOrderCount,
          lifetimeRevenueCents: p.lifetimeRevenueCents,
          firstOrderAt: p.firstOrderAt
            ? new Date(p.firstOrderAt).toISOString()
            : null,
          lastOrderAt: p.lastOrderAt
            ? new Date(p.lastOrderAt).toISOString()
            : null,
          name: mirror?.name ?? null,
          phoneE164: mirror?.phoneE164 ?? null,
        },
      ];
    }),
  );

  // Same-DOW trailing baseline: 4 most recent prior occurrences of
  // the briefingDate's NYC weekday. We compute each window
  // independently so DST flips don't drag a sample across the
  // 04:00-rollover line.
  const DOW_SAMPLES = 4;
  const dowWindows: Array<{ start: Date; end: Date }> = [];
  for (let i = 1; i <= DOW_SAMPLES; i += 1) {
    const sampleDate = new Date(Date.UTC(y, m - 1, d - 7 * i)).toISOString().slice(0, 10);
    const sampleNext = new Date(Date.UTC(y, m - 1, d - 7 * i + 1)).toISOString().slice(0, 10);
    dowWindows.push({
      start: nycDateToBusinessDayStart(sampleDate),
      end: nycDateToBusinessDayStart(sampleNext),
    });
  }
  const dowSampleQueries = dowWindows.map((w) =>
    db
      .select({
        finalTotalCents: posOrders.finalTotalCents,
      })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, args.source),
          gte(posOrders.placedAt, w.start),
          lt(posOrders.placedAt, w.end),
        ),
      ),
  );
  const dowResults = await Promise.all(dowSampleQueries);
  const dowSamples = dowResults
    .map((rows) => ({
      revenueCents: rows.reduce((s, r) => s + (r.finalTotalCents ?? 0), 0),
      orderCount: rows.length,
    }))
    // Drop empty days from the baseline so a one-off closure (snow,
    // holiday) doesn't pull the average to zero.
    .filter((x) => x.orderCount > 0);

  return computeDailyMetrics(args.briefingDate, start.getTime(), end.getTime(), {
    orders,
    prevOrders,
    knownCustomerExternalIds,
    customerProfiles,
    dowSamples,
  });
}
