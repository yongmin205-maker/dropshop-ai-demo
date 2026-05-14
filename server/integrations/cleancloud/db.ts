/**
 * DB helpers for the Phase 25a vendor-neutral mirror.
 *
 * Two responsibilities:
 *   1. Idempotent upserts for posCustomers / posOrders / posPayments / posProducts
 *      (using MySQL ON DUPLICATE KEY UPDATE keyed on the (source, externalId)
 *      uniqueIndex declared on each table).
 *   2. Sync-log writes (start/finish/error) so the Owner Assistant can answer
 *      "how fresh is this data?" and "did the last pull succeed?".
 *
 * All helpers are no-ops when DATABASE_URL is unset (test sandbox path) so
 * unit tests for the *adapter* layer don't need a live DB.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  posCustomers,
  posExternalRefs,
  posOrders,
  posPayments,
  posProductChanges,
  posProducts,
  posSyncLog,
  type InsertPosCustomer,
  type InsertPosOrder,
  type InsertPosPayment,
  type InsertPosProduct,
  type InsertPosProductChange,
  type InsertPosSyncLog,
  type PosOrderStatus,
  type PosProduct,
  type PosSource,
  type PosSyncLog,
  type PosSyncTrigger,
} from "../../../drizzle/schema";
import { getDb } from "../../db";

/* ----- upserts -------------------------------------------------------- */

export async function upsertCustomers(
  rows: InsertPosCustomer[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  let count = 0;
  // MySQL has a 65k packet limit; chunk to be safe.
  for (const chunk of chunkArray(rows, 500)) {
    await db
      .insert(posCustomers)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          name: sql`VALUES(${posCustomers.name})`,
          phoneE164: sql`VALUES(${posCustomers.phoneE164})`,
          phoneRaw: sql`VALUES(${posCustomers.phoneRaw})`,
          email: sql`VALUES(${posCustomers.email})`,
          address: sql`VALUES(${posCustomers.address})`,
          notes: sql`VALUES(${posCustomers.notes})`,
          marketingOptIn: sql`VALUES(${posCustomers.marketingOptIn})`,
          loyaltyPoints: sql`VALUES(${posCustomers.loyaltyPoints})`,
          creditCents: sql`VALUES(${posCustomers.creditCents})`,
          rawPayload: sql`VALUES(${posCustomers.rawPayload})`,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
    count += chunk.length;
  }
  return count;
}

export async function upsertOrders(rows: InsertPosOrder[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  let count = 0;
  for (const chunk of chunkArray(rows, 500)) {
    await db
      .insert(posOrders)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          customerExternalId: sql`VALUES(${posOrders.customerExternalId})`,
          status: sql`VALUES(${posOrders.status})`,
          sourceStatusRaw: sql`VALUES(${posOrders.sourceStatusRaw})`,
          finalTotalCents: sql`VALUES(${posOrders.finalTotalCents})`,
          paid: sql`VALUES(${posOrders.paid})`,
          completed: sql`VALUES(${posOrders.completed})`,
          express: sql`VALUES(${posOrders.express})`,
          placedAt: sql`VALUES(${posOrders.placedAt})`,
          pickupAt: sql`VALUES(${posOrders.pickupAt})`,
          deliveryAt: sql`VALUES(${posOrders.deliveryAt})`,
          notes: sql`VALUES(${posOrders.notes})`,
          itemsSummary: sql`VALUES(${posOrders.itemsSummary})`,
          rawPayload: sql`VALUES(${posOrders.rawPayload})`,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
    count += chunk.length;
  }
  return count;
}

export async function upsertPayments(
  rows: InsertPosPayment[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  let count = 0;
  for (const chunk of chunkArray(rows, 500)) {
    await db
      .insert(posPayments)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          orderExternalId: sql`VALUES(${posPayments.orderExternalId})`,
          customerExternalId: sql`VALUES(${posPayments.customerExternalId})`,
          amountCents: sql`VALUES(${posPayments.amountCents})`,
          type: sql`VALUES(${posPayments.type})`,
          sourceTypeRaw: sql`VALUES(${posPayments.sourceTypeRaw})`,
          refunded: sql`VALUES(${posPayments.refunded})`,
          paidAt: sql`VALUES(${posPayments.paidAt})`,
          rawPayload: sql`VALUES(${posPayments.rawPayload})`,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
    count += chunk.length;
  }
  return count;
}

export async function upsertProducts(
  rows: InsertPosProduct[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  let count = 0;
  for (const chunk of chunkArray(rows, 500)) {
    await db
      .insert(posProducts)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          priceListExternalId: sql`VALUES(${posProducts.priceListExternalId})`,
          name: sql`VALUES(${posProducts.name})`,
          category: sql`VALUES(${posProducts.category})`,
          priceCents: sql`VALUES(${posProducts.priceCents})`,
          parentExternalId: sql`VALUES(${posProducts.parentExternalId})`,
          rawPayload: sql`VALUES(${posProducts.rawPayload})`,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
    count += chunk.length;
  }
  return count;
}

/* ----- product diff (price-change tracking) --------------------------- */

/**
 * Compare a freshly-pulled product snapshot against the current DB state
 * and write `posProductChanges` rows for added / removed / price-changed
 * entries. Returns the number of change rows written.
 *
 * Called *before* upsertProducts so the comparison sees the previous state.
 */
export async function diffProductsAndRecordChanges(
  source: PosSource,
  fresh: InsertPosProduct[],
  syncLogId: number,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const existing: PosProduct[] = await db
    .select()
    .from(posProducts)
    .where(eq(posProducts.source, source));

  const byExtId = new Map<string, PosProduct>();
  for (const e of existing) byExtId.set(e.externalId, e);

  const changes: InsertPosProductChange[] = [];
  const seenIds = new Set<string>();
  for (const f of fresh) {
    seenIds.add(f.externalId);
    const e = byExtId.get(f.externalId);
    if (!e) {
      changes.push({
        source,
        externalId: f.externalId,
        kind: "added",
        oldPriceCents: null,
        newPriceCents: f.priceCents ?? 0,
        productName: f.name,
        syncLogId,
      });
    } else if (e.priceCents !== (f.priceCents ?? 0)) {
      changes.push({
        source,
        externalId: f.externalId,
        kind: "price_changed",
        oldPriceCents: e.priceCents,
        newPriceCents: f.priceCents ?? 0,
        productName: f.name ?? e.name,
        syncLogId,
      });
    }
  }
  for (const e of existing) {
    if (!seenIds.has(e.externalId)) {
      changes.push({
        source,
        externalId: e.externalId,
        kind: "removed",
        oldPriceCents: e.priceCents,
        newPriceCents: null,
        productName: e.name,
        syncLogId,
      });
    }
  }

  if (changes.length > 0) {
    await db.insert(posProductChanges).values(changes);
  }
  return changes.length;
}

/* ----- sync log ------------------------------------------------------- */

export async function startSyncLog(
  row: Omit<InsertPosSyncLog, "id" | "startedAt" | "finishedAt"> & {
    startedAt?: Date;
  },
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.insert(posSyncLog).values({
    ...row,
    startedAt: row.startedAt ?? new Date(),
  });
  // mysql2 returns insertId on the OkPacket-like object.
  const insertId =
    (result as unknown as { insertId?: number })?.insertId ?? 0;
  return insertId;
}

export async function finishSyncLog(
  id: number,
  patch: {
    rowsFetched?: number;
    rowsUpserted?: number;
    rowsFailed?: number;
    error?: string | null;
  },
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(posSyncLog)
    .set({
      finishedAt: new Date(),
      rowsFetched: patch.rowsFetched ?? 0,
      rowsUpserted: patch.rowsUpserted ?? 0,
      rowsFailed: patch.rowsFailed ?? 0,
      error: patch.error ?? null,
    })
    .where(eq(posSyncLog.id, id));
}

export async function latestSyncLogForEndpoint(
  source: PosSource,
  endpoint: string,
): Promise<PosSyncLog | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(posSyncLog)
    .where(and(eq(posSyncLog.source, source), eq(posSyncLog.endpoint, endpoint)))
    .orderBy(desc(posSyncLog.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function recentSyncLogs(
  source: PosSource,
  limit = 20,
): Promise<PosSyncLog[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(posSyncLog)
    .where(eq(posSyncLog.source, source))
    .orderBy(desc(posSyncLog.startedAt))
    .limit(limit);
}

/* ----- helpers -------------------------------------------------------- */

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Only for tests — not used by production code paths.
export {
  posCustomers,
  posOrders,
  posPayments,
  posProducts,
  posExternalRefs,
  posSyncLog,
  posProductChanges,
};
export type {
  PosOrderStatus,
};
