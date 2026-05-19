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
 *
 * Fair-pace mode (`mode: "fair-pace"`): when comparing an in-progress
 * period ("이번 달") against a completed prior period ("지난 달"), a
 * naive full-month vs partial-month comparison is misleading. With
 * fair-pace, the tool truncates the LONGER window so both windows
 * span the same number of milliseconds, anchored to each window's
 * start. The returned `summary` includes a one-line disclaimer
 * ("같은 N일 기준으로 잘라 공정 비교") so the Synthesizer can pass
 * it through verbatim. Default mode is `as-given` (no truncation).
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

const modeEnum = z.enum(["as-given", "fair-pace"]);
type Mode = z.infer<typeof modeEnum>;

const input = z.object({
  windowA: windowSchema,
  windowB: windowSchema,
  metric: metricEnum,
  /**
   * `"fair-pace"` truncates the longer window so both windows span the
   * same duration anchored to each window's `from`. Use when comparing
   * an in-progress period ("이번 달") to a completed prior period.
   * Default `"as-given"` keeps both windows untouched.
   */
  mode: modeEnum.default("as-given").optional(),
});
type Input = z.infer<typeof input>;

const output = z.object({
  a: z.number(),
  b: z.number(),
  delta: z.number(),
  /** null when a === 0 (no defined percent change). */
  deltaPct: z.number().nullable(),
  summary: z.string(),
  /**
   * Resolved windows actually used for the math, after any fair-pace
   * truncation. Lets the Synthesizer + UI surface the real comparison
   * span instead of the raw caller intent.
   */
  effectiveWindowA: windowSchema,
  effectiveWindowB: windowSchema,
  /** True when fair-pace truncation was applied. */
  truncated: z.boolean(),
  /** Equal duration in days when truncation applied or windows match. */
  spanDays: z.number(),
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

function summarize(
  a: number,
  b: number,
  metric: Metric,
  truncated: boolean,
  spanDays: number,
): string {
  const fairNote = truncated
    ? ` (같은 ${spanDays}일 기준으로 잘라 공정 비교)`
    : "";
  if (a === 0 && b === 0)
    return `${METRIC_KO[metric]}: 두 기간 모두 0건${fairNote}`;
  if (a === 0)
    return `${METRIC_KO[metric]}: 기준 기간 0 → 새 기간 ${b}건 (신규 발생)${fairNote}`;
  const pct = ((b - a) / a) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${METRIC_KO[metric]}: ${a} → ${b} (${sign}${pct.toFixed(1)}%)${fairNote}`;
}

/**
 * Pure helper exposed for unit tests. Returns the windows we'll
 * actually query against, plus whether truncation happened.
 */
export function resolveWindows(
  windowA: { from: string; to: string },
  windowB: { from: string; to: string },
  mode: Mode,
) {
  const aFrom = new Date(windowA.from).getTime();
  const aTo = new Date(windowA.to).getTime();
  const bFrom = new Date(windowB.from).getTime();
  const bTo = new Date(windowB.to).getTime();
  const lenA = aTo - aFrom;
  const lenB = bTo - bFrom;
  if (mode !== "fair-pace" || lenA === lenB) {
    return {
      effectiveWindowA: windowA,
      effectiveWindowB: windowB,
      truncated: false,
      spanDays: Math.round(Math.min(lenA, lenB) / 86_400_000),
    };
  }
  const minLen = Math.min(lenA, lenB);
  const newA = { from: windowA.from, to: new Date(aFrom + minLen).toISOString() };
  const newB = { from: windowB.from, to: new Date(bFrom + minLen).toISOString() };
  return {
    effectiveWindowA: newA,
    effectiveWindowB: newB,
    truncated: true,
    spanDays: Math.round(minLen / 86_400_000),
  };
}

export const compareTimeWindows: ToolDefinition<Input, Output> = {
  name: "compareTimeWindows",
  category: "compare",
  description:
    "두 시간 구간(windowA=과거, windowB=현재)을 같은 지표(매출/주문수/신규손님수/단골재방문수)로 비교. " +
    "\"지난달 vs 이번달\" 같이 windowB가 진행 중인 기간이면 반드시 mode='fair-pace'로 호출해야 함 — " +
    "같은 일수로 잘라 공정 비교. 완료된 기간끼리 비교(예: 3월 vs 4월)면 mode 생략 또는 'as-given'.",
  inputSchema: input,
  outputSchema: output,
  argsExample: {
    windowA: { from: "2026-04-01T00:00:00Z", to: "2026-05-01T00:00:00Z" },
    windowB: { from: "2026-05-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
    metric: "revenue",
    mode: "fair-pace",
  },
  async invoke(args) {
    const mode: Mode = args.mode ?? "as-given";
    const resolved = resolveWindows(args.windowA, args.windowB, mode);
    const a = await computeMetric(
      new Date(resolved.effectiveWindowA.from),
      new Date(resolved.effectiveWindowA.to),
      args.metric,
    );
    const b = await computeMetric(
      new Date(resolved.effectiveWindowB.from),
      new Date(resolved.effectiveWindowB.to),
      args.metric,
    );
    const delta = b - a;
    const deltaPct = a === 0 ? null : ((b - a) / a) * 100;
    return {
      a,
      b,
      delta,
      deltaPct,
      summary: summarize(a, b, args.metric, resolved.truncated, resolved.spanDays),
      effectiveWindowA: resolved.effectiveWindowA,
      effectiveWindowB: resolved.effectiveWindowB,
      truncated: resolved.truncated,
      spanDays: resolved.spanDays,
    };
  },
};
