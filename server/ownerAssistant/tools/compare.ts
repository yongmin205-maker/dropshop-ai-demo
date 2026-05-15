/**
 * `compareTimeWindows` — runs the same metric against two time windows
 * and returns the delta in absolute + percent terms.
 *
 * Why not just two Planner calls + math in the Synthesizer: because
 * the Synthesizer is told never to compute — only to humanize. Pinning
 * the math in a tool keeps the audit trail honest and makes
 * "지난주 vs 이번주" deterministic across model rolls.
 *
 * Metrics supported:
 *   - "revenue"             — SUM(finalTotalCents) where paid=1
 *   - "order_count"         — COUNT(*) regardless of paid
 *   - "new_customer_count"  — customers whose first order is in the window
 *   - "repeat_visit_count"  — orders by customers who've been seen
 *                             ≥2 times lifetime
 *
 * deltaPct semantics: when a=0 we cannot divide — return null + the
 * Synthesizer reads the summary string ("기준치 0 → 신규 발생") instead
 * of trying to interpret +Infinity.
 */

import { z } from "zod";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { posOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { ToolDefinition } from "../types";

const SOURCE = "cleancloud" as const;

const metricEnum = z.enum([
  "revenue",
  "order_count",
  "new_customer_count",
  "repeat_visit_count",
]);
type Metric = z.infer<typeof metricEnum>;

const windowSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

const input = z.object({
  windowA: windowSchema,
  windowB: windowSchema,
  metric: metricEnum,
});
type Input = z.infer<typeof input>;

const output = z.object({
  a: z.number(),
  b: z.number(),
  delta: z.number(),
  /** null when a === 0 (no defined percent change). */
  deltaPct: z.number().nullable(),
  summary: z.string(),
});
type Output = z.infer<typeof output>;

async function computeMetric(
  from: Date,
  to: Date,
  metric: Metric,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const baseConds = [
    eq(posOrders.source, SOURCE),
    isNotNull(posOrders.placedAt),
    gte(posOrders.placedAt, from),
    lt(posOrders.placedAt, to),
  ];

  if (metric === "revenue") {
    const [row] = await db
      .select({
        s: sql<number>`COALESCE(SUM(${posOrders.finalTotalCents}), 0)`,
      })
      .from(posOrders)
      .where(and(...baseConds, eq(posOrders.paid, 1)));
    return Number(row?.s ?? 0);
  }
  if (metric === "order_count") {
    const [row] = await db
      .select({ c: sql<number>`COUNT(*)` })
      .from(posOrders)
      .where(and(...baseConds));
    return Number(row?.c ?? 0);
  }
  if (metric === "new_customer_count") {
    // First-seen logic: get every customer's MIN(placedAt) lifetime,
    // count those whose min falls in the window.
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
    let n = 0;
    for (const r of rows) {
      if (!r.firstSeen) continue;
      const t = new Date(r.firstSeen).getTime();
      if (t >= from.getTime() && t < to.getTime()) n += 1;
    }
    return n;
  }
  // repeat_visit_count
  const repeatExternalIds = new Set<string>();
  const lifetime = await db
    .select({
      externalId: posOrders.customerExternalId,
      visits: sql<number>`COUNT(*)`,
    })
    .from(posOrders)
    .where(
      and(
        eq(posOrders.source, SOURCE),
        isNotNull(posOrders.customerExternalId),
      ),
    )
    .groupBy(posOrders.customerExternalId);
  for (const r of lifetime) {
    if (r.externalId && Number(r.visits) >= 2) repeatExternalIds.add(r.externalId);
  }
  if (repeatExternalIds.size === 0) return 0;
  const inWindow = await db
    .select({ externalId: posOrders.customerExternalId })
    .from(posOrders)
    .where(and(...baseConds, isNotNull(posOrders.customerExternalId)));
  let n = 0;
  for (const r of inWindow) {
    if (r.externalId && repeatExternalIds.has(r.externalId)) n += 1;
  }
  return n;
}

const METRIC_KO: Record<Metric, string> = {
  revenue: "매출",
  order_count: "주문 수",
  new_customer_count: "신규 손님 수",
  repeat_visit_count: "단골 재방문 수",
};

function summarize(a: number, b: number, metric: Metric): string {
  if (a === 0 && b === 0) return `${METRIC_KO[metric]}: 두 기간 모두 0건`;
  if (a === 0) return `${METRIC_KO[metric]}: 기준 기간 0 → 새 기간 ${b}건 (신규 발생)`;
  const pct = ((b - a) / a) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${METRIC_KO[metric]}: ${a} → ${b} (${sign}${pct.toFixed(1)}%)`;
}

export const compareTimeWindows: ToolDefinition<Input, Output> = {
  name: "compareTimeWindows",
  category: "compare",
  description:
    "두 시간 구간(windowA, windowB)을 같은 지표(매출/주문수/신규손님수/단골재방문수)로 비교. delta + deltaPct + 한국어 한 줄 요약 반환.",
  inputSchema: input,
  outputSchema: output,
  async invoke(args) {
    const a = await computeMetric(
      new Date(args.windowA.from),
      new Date(args.windowA.to),
      args.metric,
    );
    const b = await computeMetric(
      new Date(args.windowB.from),
      new Date(args.windowB.to),
      args.metric,
    );
    const delta = b - a;
    const deltaPct = a === 0 ? null : ((b - a) / a) * 100;
    return {
      a,
      b,
      delta,
      deltaPct,
      summary: summarize(a, b, args.metric),
    };
  },
};
