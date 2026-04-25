import { and, desc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  conversations,
  escalations,
  messages,
  processingLogs,
  users,
  type InsertConversation,
  type InsertEscalation,
  type InsertMessage,
  type InsertProcessingLog,
  type InsertUser,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/** Transaction handle exposed to callers — same shape as the base drizzle
 *  client, scoped to one MySQL connection / one BEGIN..COMMIT block. */
export type DbTx = Parameters<
  Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]
>[0];

/**
 * Run a callback inside a single BEGIN..COMMIT transaction.
 * Throws if the database is unavailable so callers do not silently lose writes.
 *
 * Hot-path helpers (`appendMessageTx`, `appendProcessingLogsTx`, `insertDraftTx`,
 * `transitionDraftStatusTx`, `updateMessageDeliveryTx`, `updateConversationIntentTx`,
 * `createEscalationTx`, `supersedeOtherPendingDraftsTx`, `insertStyleExampleTx`,
 * `insertRejectionTx`) accept the `DbTx` so multi-row turns commit atomically.
 */
export async function withTransaction<T>(
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async (tx) => fn(tx as DbTx));
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) return;

  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/* ----- DropShop conversation helpers ----- */

export async function getOrCreateConversation(phone: string, customerName?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Race-safe upsert: relies on UNIQUE(phone). Two concurrent inbound webhooks
  // for the same brand-new phone both succeed; only one row is created.
  const insertValue: InsertConversation = { phone, customerName: customerName ?? null };
  await db
    .insert(conversations)
    .values(insertValue)
    .onDuplicateKeyUpdate({
      set: customerName ? { customerName } : { phone: sql`${conversations.phone}` },
    });
  const refetch = await db
    .select()
    .from(conversations)
    .where(eq(conversations.phone, phone))
    .limit(1);
  return refetch[0]!;
}

export async function getConversationById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return rows[0];
}

/** Tx-aware variant. Use inside `withTransaction(async (tx) => ...)`. */
export async function appendMessageTx(
  tx: DbTx,
  value: InsertMessage,
): Promise<typeof messages.$inferSelect> {
  const result = await tx.insert(messages).values(value);
  const insertId =
    (result as unknown as { insertId?: number }[])[0]?.insertId ??
    (result as unknown as { insertId?: number }).insertId;
  if (!insertId) throw new Error("Failed to insert message (no insertId)");
  const rows = await tx.select().from(messages).where(eq(messages.id, insertId)).limit(1);
  return rows[0]!;
}

export async function appendMessage(value: InsertMessage) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(messages).values(value);
  const insertId = (result as unknown as { insertId?: number }[])[0]?.insertId
    ?? (result as unknown as { insertId?: number }).insertId;
  if (insertId) {
    const rows = await db.select().from(messages).where(eq(messages.id, insertId)).limit(1);
    return rows[0]!;
  }
  // Fallback: latest message in conversation
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, value.conversationId))
    .orderBy(desc(messages.id))
    .limit(1);
  return rows[0]!;
}

export async function appendProcessingLog(value: InsertProcessingLog) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(processingLogs).values(value);
}

/** Bulk insert variant used by transactional turn writes. */
export async function appendProcessingLogs(values: InsertProcessingLog[]) {
  if (values.length === 0) return;
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(processingLogs).values(values);
}

/** Tx-aware variants. */
export async function appendProcessingLogTx(tx: DbTx, value: InsertProcessingLog) {
  await tx.insert(processingLogs).values(value);
}
export async function appendProcessingLogsTx(tx: DbTx, values: InsertProcessingLog[]) {
  if (values.length === 0) return;
  await tx.insert(processingLogs).values(values);
}
export async function updateConversationIntentTx(
  tx: DbTx,
  id: number,
  intent: string,
) {
  await tx.update(conversations).set({ lastIntent: intent }).where(eq(conversations.id, id));
}
export async function createEscalationTx(
  tx: DbTx,
  value: InsertEscalation,
): Promise<{ id: number }> {
  const result = await tx.insert(escalations).values(value);
  const insertId =
    (result as unknown as { insertId?: number }[])[0]?.insertId ??
    (result as unknown as { insertId?: number }).insertId ??
    0;
  // Mirror the escalated flag on the parent conversation.
  await tx.update(conversations).set({ escalated: 1 }).where(eq(conversations.id, value.conversationId));
  return { id: insertId };
}
export async function updateMessageDeliveryTx(
  tx: DbTx,
  id: number,
  delivery: {
    status: "queued" | "sent" | "failed" | "delivered";
    twilioSid?: string;
    sendError?: string;
  },
) {
  await tx
    .update(messages)
    .set({
      status: delivery.status,
      twilioSid: delivery.twilioSid ?? null,
      sendError: delivery.sendError ?? null,
    })
    .where(eq(messages.id, id));
}

/** Look up an inbound message by Twilio MessageSid for webhook idempotency. */
export async function getMessageByTwilioSid(twilioSid: string) {
  if (!twilioSid) return undefined;
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(messages).where(eq(messages.twilioSid, twilioSid)).limit(1);
  return rows[0];
}

/** Update outbound delivery state after Twilio response (two-phase send). */
export async function updateMessageDelivery(
  id: number,
  delivery: {
    status: "queued" | "sent" | "failed" | "delivered";
    twilioSid?: string;
    sendError?: string;
  },
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(messages)
    .set({
      status: delivery.status,
      twilioSid: delivery.twilioSid ?? null,
      sendError: delivery.sendError ?? null,
    })
    .where(eq(messages.id, id));
}

export async function createEscalation(value: InsertEscalation) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(escalations).values(value);
  // mark conversation
  await db
    .update(conversations)
    .set({ escalated: 1 })
    .where(eq(conversations.id, value.conversationId));
}

export async function listConversations(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(limit);
}

export async function getConversationMessages(conversationId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.id);
}

export async function getConversationLogs(conversationId: number, limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(processingLogs)
    .where(eq(processingLogs.conversationId, conversationId))
    .orderBy(desc(processingLogs.id))
    .limit(limit);
}

export async function getOpenEscalations() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(escalations)
    .where(eq(escalations.status, "open"))
    .orderBy(desc(escalations.createdAt));
}

export async function resolveEscalation(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // First resolve the escalation row.
  const targetRows = await db.select().from(escalations).where(eq(escalations.id, id)).limit(1);
  const target = targetRows[0];
  if (!target) return;
  await db
    .update(escalations)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(eq(escalations.id, id));
  // Then check for any *other* still-open escalation on the same conversation.
  const stillOpen = await db
    .select()
    .from(escalations)
    .where(and(eq(escalations.conversationId, target.conversationId), eq(escalations.status, "open")))
    .limit(1);
  if (stillOpen.length === 0) {
    await db
      .update(conversations)
      .set({ escalated: 0 })
      .where(eq(conversations.id, target.conversationId));
  }
}

export async function updateConversationIntent(id: number, intent: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(conversations).set({ lastIntent: intent }).where(eq(conversations.id, id));
}

/* ----- Human-in-the-Loop + RAG helpers ----- */

import {
  drafts,
  styleExamples,
  rejections,
  knowledgeChunks,
  type InsertDraft,
  type InsertStyleExample,
  type InsertRejection,
  type InsertKnowledgeChunk,
  type Draft,
  type StyleExample,
  type Rejection,
  type KnowledgeChunk,
} from "../drizzle/schema";

export async function insertDraft(value: InsertDraft): Promise<Draft> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(drafts).values(value);
  const insertId = (result as unknown as { insertId?: number }[])[0]?.insertId
    ?? (result as unknown as { insertId?: number }).insertId;
  if (insertId) {
    const rows = await db.select().from(drafts).where(eq(drafts.id, insertId)).limit(1);
    return rows[0]!;
  }
  const rows = await db
    .select()
    .from(drafts)
    .where(eq(drafts.inboundMessageId, value.inboundMessageId))
    .orderBy(desc(drafts.id))
    .limit(1);
  return rows[0]!;
}

export async function insertDraftTx(tx: DbTx, value: InsertDraft): Promise<Draft> {
  const result = await tx.insert(drafts).values(value);
  const insertId =
    (result as unknown as { insertId?: number }[])[0]?.insertId ??
    (result as unknown as { insertId?: number }).insertId;
  if (!insertId) throw new Error("Failed to insert draft (no insertId)");
  const rows = await tx.select().from(drafts).where(eq(drafts.id, insertId)).limit(1);
  return rows[0]!;
}

export async function transitionDraftStatusTx(
  tx: DbTx,
  draftId: number,
  next: "approved" | "rejected" | "superseded",
): Promise<Draft | null> {
  const result = await tx
    .update(drafts)
    .set({ status: next })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending_approval")));
  const affected =
    (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ??
    (result as unknown as { affectedRows?: number }).affectedRows ??
    0;
  if (!affected) return null;
  const fresh = await tx.select().from(drafts).where(eq(drafts.id, draftId)).limit(1);
  return fresh[0] ?? null;
}

export async function supersedeOtherPendingDraftsTx(
  tx: DbTx,
  inboundMessageId: number,
  keepDraftId: number,
) {
  await tx
    .update(drafts)
    .set({ status: "superseded" })
    .where(
      and(
        eq(drafts.inboundMessageId, inboundMessageId),
        eq(drafts.status, "pending_approval"),
        ne(drafts.id, keepDraftId),
      ),
    );
}

export async function updateDraftStatusTx(
  tx: DbTx,
  id: number,
  status: Draft["status"],
) {
  await tx.update(drafts).set({ status }).where(eq(drafts.id, id));
}

export async function insertStyleExampleTx(
  tx: DbTx,
  value: InsertStyleExample,
) {
  await tx.insert(styleExamples).values(value);
}

export async function insertRejectionTx(
  tx: DbTx,
  value: InsertRejection,
) {
  await tx.insert(rejections).values(value);
}

export async function getDraftById(id: number): Promise<Draft | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
  return rows[0];
}

export async function updateDraftStatus(
  id: number,
  status: Draft["status"],
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(drafts).set({ status }).where(eq(drafts.id, id));
}

export async function getLatestPendingDraftForMessage(
  messageId: number
): Promise<Draft | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(drafts)
    .where(
      and(
        eq(drafts.inboundMessageId, messageId),
        eq(drafts.status, "pending_approval"),
      ),
    )
    .orderBy(desc(drafts.id))
    .limit(1);
  return rows[0];
}

/** Latest draft regardless of status — for audit/timeline views. */
export async function getLatestDraftForMessage(
  messageId: number,
): Promise<Draft | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(drafts)
    .where(eq(drafts.inboundMessageId, messageId))
    .orderBy(desc(drafts.id))
    .limit(1);
  return rows[0];
}

/**
 * Atomic state transition for a draft. Returns the post-update row only when
 * the update actually changed `status` from `pending_approval` to `next`.
 * If another approver/rejecter beat us, returns null and the caller MUST treat
 * this as a 409 conflict (do not also send Twilio / write outbound).
 */
export async function transitionDraftStatus(
  draftId: number,
  next: "approved" | "rejected" | "superseded",
): Promise<Draft | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db
    .update(drafts)
    .set({ status: next })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending_approval")));
  const affected =
    (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ??
    (result as unknown as { affectedRows?: number }).affectedRows ??
    0;
  if (!affected) return null;
  const fresh = await db.select().from(drafts).where(eq(drafts.id, draftId)).limit(1);
  return fresh[0] ?? null;
}

/** Mark every other pending draft for the same inbound message as superseded. */
export async function supersedeOtherPendingDrafts(
  inboundMessageId: number,
  keepDraftId: number,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(drafts)
    .set({ status: "superseded" })
    .where(
      and(
        eq(drafts.inboundMessageId, inboundMessageId),
        eq(drafts.status, "pending_approval"),
        ne(drafts.id, keepDraftId),
      ),
    );
}

export async function listPendingDrafts(
  options: { conversationId?: number; limit?: number } = {},
): Promise<Draft[]> {
  const { conversationId, limit = 50 } = options;
  const db = await getDb();
  if (!db) return [];
  const where = conversationId
    ? and(eq(drafts.status, "pending_approval"), eq(drafts.conversationId, conversationId))
    : eq(drafts.status, "pending_approval");
  return db
    .select()
    .from(drafts)
    .where(where)
    .orderBy(desc(drafts.id))
    .limit(limit);
}

export async function insertStyleExample(value: InsertStyleExample): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(styleExamples).values(value);
}

export async function insertRejection(value: InsertRejection): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rejections).values(value);
}

export async function listStyleExamples(limit = 500): Promise<StyleExample[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(styleExamples).orderBy(desc(styleExamples.id)).limit(limit);
}

export async function listRejections(limit = 500): Promise<Rejection[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rejections).orderBy(desc(rejections.id)).limit(limit);
}

export async function listKnowledge(): Promise<KnowledgeChunk[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(knowledgeChunks).orderBy(desc(knowledgeChunks.id));
}

export async function upsertKnowledgeChunk(value: InsertKnowledgeChunk): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // UNIQUE(topic, title) means re-seeding across instances is a no-op.
  await db
    .insert(knowledgeChunks)
    .values(value)
    .onDuplicateKeyUpdate({
      set: {
        body: value.body,
        embedding: value.embedding,
        embeddingDim: value.embeddingDim ?? 0,
      },
    });
}


/* ---- Demo reset: wipe all conversation/draft data (NOT users / NOT knowledge) ---- */
export async function resetDemoData(): Promise<{ ok: boolean }> {
  const db = await getDb();
  if (!db) return { ok: false };
  // Wrapped in a transaction so a partial failure cannot leave the system in
  // an orphaned state (e.g. rejections without their parent drafts).
  await db.transaction(async (tx) => {
    await tx.delete(rejections);
    await tx.delete(styleExamples);
    await tx.delete(drafts);
    await tx.delete(processingLogs);
    await tx.delete(escalations);
    await tx.delete(messages);
    await tx.delete(conversations);
  });
  return { ok: true };
}


/* ---- Customer profile aggregation (for "this customer usually asks X") ---- */

export type CustomerProfile = {
  conversationId: number;
  phone: string;
  customerName: string | null;
  totalMessages: number;
  totalDrafts: number;
  approvedCount: number;
  rejectedCount: number;
  approvalRate: number; // 0..1
  avgReplyChars: number;
  topIntents: Array<{ intent: string; count: number }>;
  topRejectCategories: Array<{ category: string; count: number }>;
  lastSeen: Date | null;
};

export async function getCustomerProfile(
  conversationId: number,
): Promise<CustomerProfile | null> {
  const db = await getDb();
  if (!db) return null;
  const convRows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const conv = convRows[0];
  if (!conv) return null;

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  const dRows = await db
    .select()
    .from(drafts)
    .where(eq(drafts.conversationId, conversationId));

  // Rejections for drafts in this conversation
  const draftIds = dRows.map((d) => d.id);
  const rejRows: typeof rejections.$inferSelect[] = [];
  if (draftIds.length > 0) {
    const all = await db.select().from(rejections);
    for (const r of all) if (draftIds.includes(r.draftId)) rejRows.push(r);
  }
  // Style examples (approved replies) for this conversation
  const seRows: typeof styleExamples.$inferSelect[] = [];
  if (draftIds.length > 0) {
    const all = await db.select().from(styleExamples);
    for (const s of all) if (draftIds.includes(s.draftId)) seRows.push(s);
  }

  // Intent distribution from inbound messages (and draft.intent as fallback)
  const intentCounts = new Map<string, number>();
  for (const m of msgs) {
    if (m.direction === "inbound" && m.intent) {
      intentCounts.set(m.intent, (intentCounts.get(m.intent) ?? 0) + 1);
    }
  }
  if (intentCounts.size === 0) {
    for (const d of dRows) {
      intentCounts.set(d.intent, (intentCounts.get(d.intent) ?? 0) + 1);
    }
  }
  const topIntents = Array.from(intentCounts.entries())
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const catCounts = new Map<string, number>();
  for (const r of rejRows) {
    catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 1);
  }
  const topRejectCategories = Array.from(catCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const approvedCount = seRows.length;
  const rejectedCount = rejRows.length;
  const decided = approvedCount + rejectedCount;
  const approvalRate = decided === 0 ? 0 : approvedCount / decided;
  const avgReplyChars =
    seRows.length === 0
      ? 0
      : Math.round(seRows.reduce((s, x) => s + x.approvedReply.length, 0) / seRows.length);

  let lastSeen: Date | null = null;
  for (const m of msgs) {
    if (!lastSeen || m.createdAt > lastSeen) lastSeen = m.createdAt;
  }

  return {
    conversationId: conv.id,
    phone: conv.phone,
    customerName: conv.customerName,
    totalMessages: msgs.length,
    totalDrafts: dRows.length,
    approvedCount,
    rejectedCount,
    approvalRate,
    avgReplyChars,
    topIntents,
    topRejectCategories,
    lastSeen,
  };
}

/* ---- Customer-specific style examples (for personalized RAG) ---- */
export async function listStyleExamplesByPhone(
  phone: string,
  limit = 50,
): Promise<StyleExample[]> {
  const db = await getDb();
  if (!db) return [];
  // join via drafts.conversationId → conversations.phone
  const convRows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.phone, phone))
    .limit(1);
  const conv = convRows[0];
  if (!conv) return [];
  const draftRows = await db
    .select()
    .from(drafts)
    .where(eq(drafts.conversationId, conv.id));
  const ids = draftRows.map((d) => d.id);
  if (ids.length === 0) return [];
  const all = await db.select().from(styleExamples).orderBy(desc(styleExamples.id)).limit(500);
  return all.filter((s) => ids.includes(s.draftId)).slice(0, limit);
}
