import { desc, eq } from "drizzle-orm";
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
  const existing = await db.select().from(conversations).where(eq(conversations.phone, phone)).limit(1);
  if (existing.length > 0) return existing[0];

  const insertValue: InsertConversation = { phone, customerName: customerName ?? null };
  const result = await db.insert(conversations).values(insertValue);
  // mysql2 driver returns insertId on the first element
  const insertId = (result as unknown as { insertId?: number }[])[0]?.insertId
    ?? (result as unknown as { insertId?: number }).insertId;
  if (insertId) {
    const fresh = await db.select().from(conversations).where(eq(conversations.id, insertId)).limit(1);
    if (fresh[0]) return fresh[0];
  }
  // Fallback: re-query by phone
  const refetch = await db.select().from(conversations).where(eq(conversations.phone, phone)).limit(1);
  return refetch[0]!;
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
  await db
    .update(escalations)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(eq(escalations.id, id));
}

export async function updateConversationIntent(id: number, intent: string) {
  const db = await getDb();
  if (!db) return;
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

export async function getDraftById(id: number): Promise<Draft | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
  return rows[0];
}

export async function updateDraftStatus(
  id: number,
  status: Draft["status"]
): Promise<void> {
  const db = await getDb();
  if (!db) return;
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
    .where(eq(drafts.inboundMessageId, messageId))
    .orderBy(desc(drafts.id))
    .limit(1);
  return rows[0];
}

export async function listPendingDrafts(limit = 50): Promise<Draft[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(drafts)
    .where(eq(drafts.status, "pending_approval"))
    .orderBy(desc(drafts.id))
    .limit(limit);
}

export async function insertStyleExample(value: InsertStyleExample): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(styleExamples).values(value);
}

export async function insertRejection(value: InsertRejection): Promise<void> {
  const db = await getDb();
  if (!db) return;
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
  if (!db) return;
  await db.insert(knowledgeChunks).values(value);
}
