/**
 * Phase 25c — Owner Assistant conversation persistence helpers.
 *
 * Mirrors the no-DB-safe pattern from `server/integrations/cleancloud/db.ts`:
 * every function calls `getDb()` first and short-circuits with a sensible
 * empty value (null / [] / 0) when DATABASE_URL is unset. This keeps the
 * unit-test sandbox (which never sees a live MySQL) free of DB plumbing
 * while production paths get real persistence.
 *
 * The tRPC `ownerAssistant` sub-router (in server/routers.ts) is the only
 * production consumer; the agent orchestrator itself never writes to these
 * tables so it stays cheap to unit-test.
 */

import { and, desc, eq } from "drizzle-orm";
import {
  ownerConversations,
  ownerMessages,
  type OwnerConversation,
  type OwnerMessage,
} from "../../drizzle/schema";
import { getDb } from "../db";

/* ----- conversation create ------------------------------------------- */

export async function createOwnerConversation(args: {
  ownerOpenId: string;
  title?: string | null;
}): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(ownerConversations).values({
    ownerOpenId: args.ownerOpenId,
    title: args.title ?? null,
  });
  // mysql2 returns either OkPacket directly or [OkPacket, FieldPacket[]].
  // Mirror the cast pattern used elsewhere in the repo.
  if (Array.isArray(result)) {
    return (result as { insertId?: number }[])[0]?.insertId ?? null;
  }
  return (result as unknown as { insertId?: number })?.insertId ?? null;
}

/* ----- message append ------------------------------------------------ */

export async function appendOwnerMessage(args: {
  conversationId: number;
  role: "user" | "assistant";
  contentMarkdown: string;
  trace?: unknown;
  totalLatencyMs?: number | null;
}): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  // For role='user', trace + totalLatencyMs must be omitted (null) per
  // the schema contract — those fields only describe assistant turns.
  const isAssistant = args.role === "assistant";
  const result = await db.insert(ownerMessages).values({
    conversationId: args.conversationId,
    role: args.role,
    contentMarkdown: args.contentMarkdown,
    trace: isAssistant ? (args.trace ?? null) : null,
    totalLatencyMs: isAssistant ? (args.totalLatencyMs ?? null) : null,
  });
  if (Array.isArray(result)) {
    return (result as { insertId?: number }[])[0]?.insertId ?? null;
  }
  return (result as unknown as { insertId?: number })?.insertId ?? null;
}

/* ----- conversation load --------------------------------------------- */

export async function loadOwnerConversation(
  id: number,
  ownerOpenId: string,
  messageLimit?: number,
): Promise<{ conversation: OwnerConversation; messages: OwnerMessage[] } | null> {
  const db = await getDb();
  if (!db) return null;
  // Multi-tenant guard. Plan §0 says "권한 분리 없음" today, but the
  // helper signature must accept ownerOpenId NOW so it cannot grow a
  // cross-tenant read path. A second admin landing later must not be
  // able to load another owner's chats by guessing/incrementing id.
  const convRows = await db
    .select()
    .from(ownerConversations)
    .where(
      and(
        eq(ownerConversations.id, id),
        eq(ownerConversations.ownerOpenId, ownerOpenId),
      ),
    )
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return null;

  // asc by createdAt — natural turn order. Optional cap so very long
  // threads don't blow up the UI payload.
  const baseQuery = db
    .select()
    .from(ownerMessages)
    .where(eq(ownerMessages.conversationId, id))
    .orderBy(ownerMessages.createdAt);

  const messages =
    typeof messageLimit === "number" && messageLimit > 0
      ? await baseQuery.limit(messageLimit)
      : await baseQuery;

  return { conversation, messages };
}

/* ----- conversation list (sidebar) ----------------------------------- */

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;

export async function listOwnerConversations(
  ownerOpenId: string,
  limit: number = LIST_DEFAULT_LIMIT,
): Promise<OwnerConversation[]> {
  const db = await getDb();
  if (!db) return [];
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), LIST_MAX_LIMIT);
  return db
    .select()
    .from(ownerConversations)
    .where(and(eq(ownerConversations.ownerOpenId, ownerOpenId)))
    .orderBy(desc(ownerConversations.updatedAt))
    .limit(safeLimit);
}
