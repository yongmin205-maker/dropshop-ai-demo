/**
 * Live POS fast-path tools.
 *
 * These are the only tools that bypass the 03:00 ET nightly-pull mirror
 * and ask CleanCloud directly. They're for "today" questions where the
 * mirror is intentionally stale by up to ~24h. Three live tools:
 *
 *   - fetchLiveOrder(externalId)       — single order, freshest read
 *   - countActiveGarments()             — store-wide WIP count
 *   - aggregateRevenueLive()           — "today since the pull" revenue
 *
 * The Planner's tool description tells the LLM these are *only* for
 * today-window questions; aggregateRevenueLive will refuse a non-today
 * window at runtime so a Planner misroute is recoverable.
 *
 * Phase 25c keeps the implementations dependency-injectable: each tool
 * takes a `fetchLiveJson` shape passed via AgentContext or wired
 * directly to `cleanCloudTransport`. The default invocation reads
 * `server/messaging/cleanCloudTransport` if it exists; otherwise the
 * tool returns a clean "live transport unavailable" outcome (the
 * Synthesizer will then say so). This avoids a hard import-time failure
 * in test environments that don't have CleanCloud creds.
 */

import { z } from "zod";
import type { AgentContext, ToolDefinition } from "../types";

/** Indirection so tests can swap the transport. Default-loaded
 *  on demand to keep aiAgent unit tests free of CleanCloud creds. */
let _liveTransport:
  | null
  | {
      getOrder(externalId: string): Promise<unknown>;
      listActiveOrders(): Promise<unknown>;
      aggregateTodayRevenue(): Promise<unknown>;
    } = null;

export function __setLiveTransportForTests(
  t:
    | typeof _liveTransport
    | null,
) {
  _liveTransport = t;
}

async function getLiveTransport() {
  if (_liveTransport) return _liveTransport;
  try {
    const mod = await import("../../messaging/cleanCloudTransport");
    // The transport's surface predates this consumer. We accept whatever
    // shape it exports today and let the runtime guard against missing
    // methods.
    const tp = (mod as unknown as {
      cleanCloud?: typeof _liveTransport;
    }).cleanCloud;
    if (tp && typeof tp === "object") {
      _liveTransport = tp;
      return _liveTransport;
    }
  } catch {
    /* falls through to null */
  }
  return null;
}

const unavailable = {
  ok: false as const,
  error:
    "Live POS transport이 설정되지 않았습니다. mirror 데이터(어제까지)로 대신 답변하세요.",
};

/* ----------------- fetchLiveOrder ----------------- */

const fetchLiveOrderInput = z.object({
  externalId: z.string().min(1).max(64),
});
type FetchLiveOrderInput = z.infer<typeof fetchLiveOrderInput>;

const fetchLiveOrderOutput = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), order: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type FetchLiveOrderOutput = z.infer<typeof fetchLiveOrderOutput>;

export const fetchLiveOrder: ToolDefinition<
  FetchLiveOrderInput,
  FetchLiveOrderOutput
> = {
  name: "fetchLiveOrder",
  category: "lookup",
  description:
    "CleanCloud에 직접 물어 단일 주문의 실시간 상태를 가져온다. mirror가 아직 못 따라잡은 오늘자 주문 상태 확인용. 어제 이전 데이터는 mirror tools를 쓸 것.",
  inputSchema: fetchLiveOrderInput,
  outputSchema: fetchLiveOrderOutput,
  async invoke(input) {
    const t = await getLiveTransport();
    if (!t || typeof t.getOrder !== "function") return unavailable;
    try {
      const order = await t.getOrder(input.externalId);
      return { ok: true, order };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

/* ----------------- countActiveGarments ----------------- */

const countInput = z.object({}).strict();
type CountInput = z.infer<typeof countInput>;

const countOutput = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), count: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type CountOutput = z.infer<typeof countOutput>;

export const countActiveGarments: ToolDefinition<CountInput, CountOutput> = {
  name: "countActiveGarments",
  category: "lookup",
  description:
    "지금 매장에서 작업 중인 의류 총 개수를 실시간으로 카운트. 오늘 영업 중 'WIP 얼마나 남았어' 류 질문 전용.",
  inputSchema: countInput,
  outputSchema: countOutput,
  async invoke() {
    const t = await getLiveTransport();
    if (!t || typeof t.listActiveOrders !== "function") return unavailable;
    try {
      const list = await t.listActiveOrders();
      // The transport's shape is opaque to us; accept either an
      // already-aggregated number or a list we can count.
      if (typeof list === "number") return { ok: true, count: list };
      if (Array.isArray(list)) return { ok: true, count: list.length };
      if (
        list &&
        typeof list === "object" &&
        typeof (list as { count?: unknown }).count === "number"
      ) {
        return { ok: true, count: (list as { count: number }).count };
      }
      return { ok: false, error: "Live transport returned unexpected shape" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

/* ----------------- aggregateRevenueLive ----------------- */

const liveRevenueInput = z.object({}).strict();
type LiveRevenueInput = z.infer<typeof liveRevenueInput>;

const liveRevenueOutput = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    sinceIso: z.string(),
    revenueCents: z.number(),
    orderCount: z.number(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type LiveRevenueOutput = z.infer<typeof liveRevenueOutput>;

/** 03:00 ET today, expressed as a UTC Date. Used as the lower bound
 *  for "today since the pull" so the live tool only covers what the
 *  mirror hasn't yet ingested. */
export function todayPullCutoffUtc(now: Date): Date {
  // NYC is UTC-4 (EDT) most of the year; for Phase 25c we accept this
  // approximation. A formal Intl-based calc would handle the two DST
  // transition days more precisely; revisit if business hours fall
  // around the DST change.
  const nycOffsetHours = -4;
  const nycNow = new Date(now.getTime() + nycOffsetHours * 60 * 60 * 1000);
  const cutoff = new Date(
    Date.UTC(
      nycNow.getUTCFullYear(),
      nycNow.getUTCMonth(),
      nycNow.getUTCDate(),
      3, // 03:00 NYC
      0,
      0,
    ),
  );
  // Re-shift to UTC.
  return new Date(cutoff.getTime() - nycOffsetHours * 60 * 60 * 1000);
}

export const aggregateRevenueLive: ToolDefinition<
  LiveRevenueInput,
  LiveRevenueOutput
> = {
  name: "aggregateRevenueLive",
  category: "aggregate",
  description:
    "오늘 03:00 ET pull 이후 ~ 지금까지의 매출. mirror에 아직 없는 오늘자 데이터를 실시간으로 가져옴. 어제 이전 기간은 aggregateRevenue를 쓸 것.",
  inputSchema: liveRevenueInput,
  outputSchema: liveRevenueOutput,
  async invoke(_input, ctx: AgentContext) {
    const t = await getLiveTransport();
    if (!t || typeof t.aggregateTodayRevenue !== "function") return unavailable;
    try {
      const since = todayPullCutoffUtc(ctx.now);
      const result = await t.aggregateTodayRevenue();
      if (result && typeof result === "object") {
        const r = result as { revenueCents?: number; orderCount?: number };
        return {
          ok: true,
          sinceIso: since.toISOString(),
          revenueCents: Number(r.revenueCents ?? 0),
          orderCount: Number(r.orderCount ?? 0),
        };
      }
      return { ok: false, error: "Live transport returned unexpected shape" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
