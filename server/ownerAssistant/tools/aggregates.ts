/**
 * Aggregate tools — the "how is the store doing" questions.
 *
 *   - aggregateRevenue        ($ per day/week/month/dayOfWeek)
 *   - aggregateNewCustomers   (first-seen this window)
 *   - aggregateRepeatCustomers (regulars: ≥minVisits in a lookback window)
 *   - findInactiveCustomers   (haven't visited in ≥N days)
 *
 * All queries run against posOrders / posCustomers in the
 * vendor-neutral mirror. SOURCE is hardcoded "cleancloud" for Phase
 * 25c. When DropShop POS launches, threading `source` through the
 * input schemas opens the mirror for multi-vendor reads.
 *
 * Timezone: bucket boundaries (day, dayOfWeek) are NYC local because
 * the friend's store is NYC. MySQL's `CONVERT_TZ('+00:00','America/New_York')`
 * relies on the mysql.time_zone tables being loaded; PlanetScale /
 * Vitess have them by default. If we ever run against a base MySQL
 * without those tables loaded, swap to `DATE_FORMAT(placedAt -
 * INTERVAL 4 HOUR ...)` and accept the DST silliness.
 *
 * `paid` filter: we count only paid=1 orders in revenue by default.
 * `includeUnpaid` flips that for "promised but not yet collected"
 * questions.
 */

import { z } from "zod";
import { and, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { posCustomers, posOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { AgentContext, ToolDefinition } from "../types";

const SOURCE = "cleancloud" as const;

/* ----------------- aggregateRevenue ----------------- */

const groupByEnum = z.enum(["day", "week", "month", "dayOfWeek"]);
type GroupBy = z.infer<typeof groupByEnum>;

const revenueInput = z.object({
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
  groupBy: groupByEnum,
  includeUnpaid: z.boolean().default(false),
});
type RevenueInput = z.infer<typeof revenueInput>;

const revenueBucket = z.object({
  bucket: z.string(),
  revenueCents: z.number(),
  orderCount: z.number(),
});
const revenueOutput = z.object({
  series: z.array(revenueBucket),
  totalRevenueCents: z.number(),
  totalOrderCount: z.number(),
});
type RevenueOutput = z.infer<typeof revenueOutput>;

function nycBucketExpr(groupBy: GroupBy) {
  // posOrders.placedAt is UTC; convert to NYC then format.
  const tz = sql`CONVERT_TZ(${posOrders.placedAt}, '+00:00', 'America/New_York')`;
  switch (groupBy) {
    case "day":
      return sql<string>`DATE_FORMAT(${tz}, '%Y-%m-%d')`;
    case "week":
      return sql<string>`DATE_FORMAT(${tz}, '%x-W%v')`;
    case "month":
      return sql<string>`DATE_FORMAT(${tz}, '%Y-%m')`;
    case "dayOfWeek":
      return sql<string>`DAYNAME(${tz})`;
  }
}

export const aggregateRevenue: ToolDefinition<RevenueInput, RevenueOutput> = {
  name: "aggregateRevenue",
  category: "aggregate",
  description:
    "기간 내 매출을 day / week / month / dayOfWeek 단위로 집계. dateFrom/To는 ISO. 기본은 paid=1만 매출에 포함. includeUnpaid=true면 미결제 주문도 포함.",
  inputSchema: revenueInput,
  outputSchema: revenueOutput,
  argsExample: {
    dateFrom: "2026-04-01T00:00:00Z",
    dateTo: "2026-05-01T00:00:00Z",
    groupBy: "day",
    includeUnpaid: false,
  },
  async invoke(input) {
    const db = await getDb();
    if (!db)
      return { series: [], totalRevenueCents: 0, totalOrderCount: 0 };

    const conds = [
      eq(posOrders.source, SOURCE),
      isNotNull(posOrders.placedAt),
      gte(posOrders.placedAt, new Date(input.dateFrom)),
      lt(posOrders.placedAt, new Date(input.dateTo)),
    ];
    if (!input.includeUnpaid) conds.push(eq(posOrders.paid, 1));

    const bucketExpr = nycBucketExpr(input.groupBy);
    const rows = await db
      .select({
        bucket: bucketExpr,
        revenueCents: sql<number>`COALESCE(SUM(${posOrders.finalTotalCents}), 0)`,
        orderCount: sql<number>`COUNT(*)`,
      })
      .from(posOrders)
      .where(and(...conds))
      .groupBy(bucketExpr)
      .orderBy(bucketExpr);

    const series = rows.map((r) => ({
      bucket: String(r.bucket ?? ""),
      revenueCents: Number(r.revenueCents ?? 0),
      orderCount: Number(r.orderCount ?? 0),
    }));
    const totalRevenueCents = series.reduce((s, r) => s + r.revenueCents, 0);
    const totalOrderCount = series.reduce((s, r) => s + r.orderCount, 0);
    return { series, totalRevenueCents, totalOrderCount };
  },
};

/* ----------------- aggregateNewCustomers ----------------- */

const newCustomersInput = z.object({
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
});
type NewCustomersInput = z.infer<typeof newCustomersInput>;

const newCustomersOutput = z.object({
  count: z.number(),
  customers: z.array(
    z.object({
      externalId: z.string(),
      name: z.string().nullable(),
      phoneE164: z.string().nullable(),
      firstSeenAt: z.string(),
    }),
  ),
});
type NewCustomersOutput = z.infer<typeof newCustomersOutput>;

export const aggregateNewCustomers: ToolDefinition<
  NewCustomersInput,
  NewCustomersOutput
> = {
  name: "aggregateNewCustomers",
  category: "aggregate",
  description:
    "기간 내에 처음 주문한 신규 손님 목록. 신규 = 그 손님의 가장 이른 주문이 dateFrom~dateTo 안에 있는 경우.",
  inputSchema: newCustomersInput,
  outputSchema: newCustomersOutput,
  argsExample: {
    dateFrom: "2026-05-01T00:00:00Z",
    dateTo: "2026-05-18T00:00:00Z",
  },
  async invoke(input) {
    const db = await getDb();
    if (!db) return { count: 0, customers: [] };

    // For each customer, take MIN(placedAt) and filter to the window.
    // Drizzle subquery is awkward here; use a single grouping query.
    const rows = await db
      .select({
        externalId: posOrders.customerExternalId,
        firstSeen: sql<Date>`MIN(${posOrders.placedAt})`,
      })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, SOURCE),
          isNotNull(posOrders.placedAt),
          isNotNull(posOrders.customerExternalId),
        ),
      )
      .groupBy(posOrders.customerExternalId);

    const from = new Date(input.dateFrom);
    const to = new Date(input.dateTo);
    const filtered = rows.filter((r) => {
      const t = r.firstSeen ? new Date(r.firstSeen).getTime() : NaN;
      return t >= from.getTime() && t < to.getTime();
    });

    const customers = await Promise.all(
      filtered.map(async (r) => {
        const c = r.externalId
          ? await db
              .select()
              .from(posCustomers)
              .where(
                and(
                  eq(posCustomers.source, SOURCE),
                  eq(posCustomers.externalId, r.externalId),
                ),
              )
              .limit(1)
          : [];
        return {
          externalId: r.externalId ?? "",
          name: c[0]?.name ?? null,
          phoneE164: c[0]?.phoneE164 ?? null,
          firstSeenAt: r.firstSeen
            ? new Date(r.firstSeen).toISOString()
            : new Date(0).toISOString(),
        };
      }),
    );
    return { count: customers.length, customers };
  },
};

/* ----------------- aggregateRepeatCustomers ----------------- */

const repeatInput = z.object({
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
  minVisits: z.number().int().min(2).max(50).default(2),
  lookbackDays: z.number().int().min(7).max(365).default(90),
});
type RepeatInput = z.infer<typeof repeatInput>;

const repeatOutput = z.object({
  count: z.number(),
  customers: z.array(
    z.object({
      externalId: z.string(),
      name: z.string().nullable(),
      phoneE164: z.string().nullable(),
      visitCountInWindow: z.number(),
      lastSeenAt: z.string().nullable(),
      totalSpendInWindow: z.number(),
    }),
  ),
});
type RepeatOutput = z.infer<typeof repeatOutput>;

export const aggregateRepeatCustomers: ToolDefinition<RepeatInput, RepeatOutput> = {
  name: "aggregateRepeatCustomers",
  category: "aggregate",
  description:
    "단골 손님 (lookbackDays 안에 minVisits번 이상 방문). dateFrom~To 기간 내 주문이 있는 사람만 카운트. 방문수 desc 정렬.",
  inputSchema: repeatInput,
  outputSchema: repeatOutput,
  argsExample: {
    dateFrom: "2026-05-01T00:00:00Z",
    dateTo: "2026-05-18T00:00:00Z",
    minVisits: 2,
    lookbackDays: 90,
  },
  async invoke(input, ctx) {
    const db = await getDb();
    if (!db) return { count: 0, customers: [] };

    const lookbackStart = new Date(
      ctx.now.getTime() - input.lookbackDays * 24 * 60 * 60 * 1000,
    );

    // Lookback aggregation: visits + spend in the lookback window.
    const lookbackRows = await db
      .select({
        externalId: posOrders.customerExternalId,
        visits: sql<number>`COUNT(*)`,
        spend: sql<number>`COALESCE(SUM(${posOrders.finalTotalCents}), 0)`,
        lastSeen: sql<Date>`MAX(${posOrders.placedAt})`,
      })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, SOURCE),
          isNotNull(posOrders.customerExternalId),
          isNotNull(posOrders.placedAt),
          gte(posOrders.placedAt, lookbackStart),
        ),
      )
      .groupBy(posOrders.customerExternalId);

    // Window check: who has at least one order in [dateFrom, dateTo)?
    const windowFrom = new Date(input.dateFrom);
    const windowTo = new Date(input.dateTo);
    const windowSet = new Set<string>();
    const windowRows = await db
      .select({ externalId: posOrders.customerExternalId })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, SOURCE),
          isNotNull(posOrders.customerExternalId),
          gte(posOrders.placedAt, windowFrom),
          lt(posOrders.placedAt, windowTo),
        ),
      );
    for (const r of windowRows) if (r.externalId) windowSet.add(r.externalId);

    const regulars = lookbackRows
      .filter(
        (r) =>
          r.externalId !== null &&
          Number(r.visits) >= input.minVisits &&
          windowSet.has(r.externalId),
      )
      .sort((a, b) => Number(b.visits) - Number(a.visits));

    const customers = await Promise.all(
      regulars.map(async (r) => {
        const c = await db
          .select()
          .from(posCustomers)
          .where(
            and(
              eq(posCustomers.source, SOURCE),
              eq(posCustomers.externalId, r.externalId!),
            ),
          )
          .limit(1);
        return {
          externalId: r.externalId!,
          name: c[0]?.name ?? null,
          phoneE164: c[0]?.phoneE164 ?? null,
          visitCountInWindow: Number(r.visits),
          lastSeenAt: r.lastSeen ? new Date(r.lastSeen).toISOString() : null,
          totalSpendInWindow: Number(r.spend ?? 0),
        };
      }),
    );
    return { count: customers.length, customers };
  },
};

/* ----------------- findInactiveCustomers ----------------- */

const inactiveInput = z.object({
  inactiveSinceDays: z.number().int().min(7).max(365).default(60),
  minPriorVisits: z.number().int().min(1).max(50).default(3),
  limit: z.number().int().min(1).max(200).default(50),
});
type InactiveInput = z.infer<typeof inactiveInput>;

const inactiveOutput = z.object({
  customers: z.array(
    z.object({
      externalId: z.string(),
      name: z.string().nullable(),
      phoneE164: z.string().nullable(),
      lastSeenAt: z.string().nullable(),
      totalLifetimeOrders: z.number(),
      totalLifetimeSpendCents: z.number(),
    }),
  ),
});
type InactiveOutput = z.infer<typeof inactiveOutput>;

export const findInactiveCustomers: ToolDefinition<InactiveInput, InactiveOutput> = {
  name: "findInactiveCustomers",
  category: "aggregate",
  description:
    "최근 N일 동안 방문 안 한 손님 (이전엔 minPriorVisits번 이상 방문). 재방문 권유 타겟 리스트. 최근 방문 desc 정렬.",
  inputSchema: inactiveInput,
  outputSchema: inactiveOutput,
  argsExample: {
    inactiveSinceDays: 60,
    minPriorVisits: 3,
    limit: 50,
  },
  async invoke(input, ctx) {
    const db = await getDb();
    if (!db) return { customers: [] };

    const cutoff = new Date(
      ctx.now.getTime() - input.inactiveSinceDays * 24 * 60 * 60 * 1000,
    );

    const rows = await db
      .select({
        externalId: posOrders.customerExternalId,
        orderCount: sql<number>`COUNT(*)`,
        totalSpend: sql<number>`COALESCE(SUM(${posOrders.finalTotalCents}), 0)`,
        lastSeen: sql<Date>`MAX(${posOrders.placedAt})`,
      })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, SOURCE),
          isNotNull(posOrders.customerExternalId),
          isNotNull(posOrders.placedAt),
        ),
      )
      .groupBy(posOrders.customerExternalId);

    const filtered = rows
      .filter((r) => {
        if (!r.externalId) return false;
        if (Number(r.orderCount) < input.minPriorVisits) return false;
        if (!r.lastSeen) return false;
        return new Date(r.lastSeen).getTime() < cutoff.getTime();
      })
      .sort(
        (a, b) =>
          new Date(b.lastSeen!).getTime() - new Date(a.lastSeen!).getTime(),
      )
      .slice(0, input.limit);

    const customers = await Promise.all(
      filtered.map(async (r) => {
        const c = await db
          .select()
          .from(posCustomers)
          .where(
            and(
              eq(posCustomers.source, SOURCE),
              eq(posCustomers.externalId, r.externalId!),
            ),
          )
          .limit(1);
        return {
          externalId: r.externalId!,
          name: c[0]?.name ?? null,
          phoneE164: c[0]?.phoneE164 ?? null,
          lastSeenAt: r.lastSeen ? new Date(r.lastSeen).toISOString() : null,
          totalLifetimeOrders: Number(r.orderCount),
          totalLifetimeSpendCents: Number(r.totalSpend ?? 0),
        };
      }),
    );
    return { customers };
  },
};
