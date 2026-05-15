/**
 * Order-shaped lookup tools. Three are exported:
 *
 *   - getCustomerRecentOrders(externalId, limit) — by-customer feed
 *   - getOrderDetails(externalId)                — single-row hydrate
 *   - getActiveOrdersByStatus(status, limit)     — store-wide filter
 *
 * All three read from posOrders. itemsSummary is JSON; we ship it as
 * received and let the Synthesizer humanize it. productName lookup
 * against posProducts is left-joined when an item has productExternalId.
 *
 * Status enum mirrors POS_ORDER_STATUSES (from drizzle/schema.ts) and
 * is the *neutral* set, not CleanCloud's raw "0/1/4/5" strings — the
 * pull job already mapped them.
 */

import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  POS_ORDER_STATUSES,
  posOrders,
  type PosOrderStatus,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { ToolDefinition } from "../types";

const SOURCE = "cleancloud" as const;

/* --------------- getCustomerRecentOrders --------------- */

const recentInput = z.object({
  externalId: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(50).default(10),
});
type RecentInput = z.infer<typeof recentInput>;

const orderRow = z.object({
  externalId: z.string(),
  status: z.enum(POS_ORDER_STATUSES),
  finalTotalCents: z.number(),
  paid: z.boolean(),
  placedAt: z.string().nullable(),
  pickupAt: z.string().nullable(),
  notes: z.string().nullable(),
  items: z.array(z.unknown()),
});
const recentOutput = z.object({
  orders: z.array(orderRow),
});
type RecentOutput = z.infer<typeof recentOutput>;

export const getCustomerRecentOrders: ToolDefinition<RecentInput, RecentOutput> = {
  name: "getCustomerRecentOrders",
  category: "lookup",
  description:
    "특정 손님의 최근 주문 목록 (최신순). externalId는 posCustomers.externalId. limit 기본 10.",
  inputSchema: recentInput,
  outputSchema: recentOutput,
  async invoke(input) {
    const db = await getDb();
    if (!db) return { orders: [] };
    const rows = await db
      .select()
      .from(posOrders)
      .where(
        and(
          eq(posOrders.source, SOURCE),
          eq(posOrders.customerExternalId, input.externalId),
        ),
      )
      .orderBy(desc(posOrders.placedAt))
      .limit(input.limit);
    return { orders: rows.map(serializeOrder) };
  },
};

/* --------------- getOrderDetails --------------- */

const detailsInput = z.object({
  externalId: z.string().min(1).max(64),
});
type DetailsInput = z.infer<typeof detailsInput>;

const detailsOutput = z.object({
  order: orderRow.nullable(),
});
type DetailsOutput = z.infer<typeof detailsOutput>;

export const getOrderDetails: ToolDefinition<DetailsInput, DetailsOutput> = {
  name: "getOrderDetails",
  category: "lookup",
  description:
    "주문 외부 ID로 단일 주문 상세 (상태, 금액, 픽업 시간, 메모, 아이템 목록).",
  inputSchema: detailsInput,
  outputSchema: detailsOutput,
  async invoke(input) {
    const db = await getDb();
    if (!db) return { order: null };
    const rows = await db
      .select()
      .from(posOrders)
      .where(
        and(eq(posOrders.source, SOURCE), eq(posOrders.externalId, input.externalId)),
      )
      .limit(1);
    return { order: rows[0] ? serializeOrder(rows[0]) : null };
  },
};

/* --------------- getActiveOrdersByStatus --------------- */

const activeInput = z.object({
  status: z.enum(POS_ORDER_STATUSES),
  limit: z.number().int().min(1).max(200).default(50),
});
type ActiveInput = z.infer<typeof activeInput>;

const activeOutput = z.object({
  orders: z.array(orderRow),
  totalCount: z.number(),
});
type ActiveOutput = z.infer<typeof activeOutput>;

export const getActiveOrdersByStatus: ToolDefinition<ActiveInput, ActiveOutput> = {
  name: "getActiveOrdersByStatus",
  category: "lookup",
  description:
    "주어진 상태의 주문을 매장 전체에서 조회. 예: 'ready' = 픽업 대기, 'cleaning' = 작업 중. limit 기본 50, 같이 totalCount(전체 매칭 개수)도 반환.",
  inputSchema: activeInput,
  outputSchema: activeOutput,
  async invoke(input) {
    const db = await getDb();
    if (!db) return { orders: [], totalCount: 0 };

    const where = and(eq(posOrders.source, SOURCE), eq(posOrders.status, input.status));
    const [countRow] = await db
      .select({ c: sql<number>`COUNT(*)` })
      .from(posOrders)
      .where(where);
    const rows = await db
      .select()
      .from(posOrders)
      .where(where)
      .orderBy(desc(posOrders.placedAt))
      .limit(input.limit);
    return {
      orders: rows.map(serializeOrder),
      totalCount: Number(countRow?.c ?? 0),
    };
  },
};

/* --------------- helpers --------------- */

function serializeOrder(o: typeof posOrders.$inferSelect): z.infer<typeof orderRow> {
  let items: unknown[] = [];
  if (Array.isArray(o.itemsSummary)) {
    items = o.itemsSummary as unknown[];
  } else if (typeof o.itemsSummary === "string") {
    try {
      const parsed = JSON.parse(o.itemsSummary);
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  }
  return {
    externalId: o.externalId,
    status: o.status as PosOrderStatus,
    finalTotalCents: o.finalTotalCents,
    paid: o.paid === 1,
    placedAt: o.placedAt ? new Date(o.placedAt).toISOString() : null,
    pickupAt: o.pickupAt ? new Date(o.pickupAt).toISOString() : null,
    notes: o.notes ?? null,
    items,
  };
}
