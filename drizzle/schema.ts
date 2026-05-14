import {
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/* ============================================================
 * DropShop AI SMS demo schema
 * ============================================================ */

/** Conversations are grouped by customer phone number. */
export const conversations = mysqlTable("conversations", {
  id: int("id").autoincrement().primaryKey(),
  phone: varchar("phone", { length: 32 }).notNull().unique(),
  customerName: varchar("customerName", { length: 128 }),
  lastIntent: varchar("lastIntent", { length: 64 }),
  escalated: int("escalated").default(0).notNull(), // 0/1
  /**
   * Phase 10 — Shadow mode flag. When 1, this conversation belongs to a
   * shadow forwarding source (e.g., friend's OpenPhone forwarding into our
   * /api/shadow/inbound endpoint). The pipeline still runs and drafts are
   * still produced, but `sendSms` MUST be a no-op for these conversations
   * — we never reply to the customer because we are not the sender.
   */
  shadowMode: int("shadowMode").default(0).notNull(),
  /** Free-form label like "openphone" / "twilio" so we can group shadow drafts in the UI. */
  shadowSource: varchar("shadowSource", { length: 32 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

/** Each SMS message either sent by the customer or by DropShop (AI or human). */
export const messages = mysqlTable(
  "messages",
  {
    id: int("id").autoincrement().primaryKey(),
    conversationId: int("conversationId").notNull(),
    direction: mysqlEnum("direction", ["inbound", "outbound"]).notNull(),
    sender: mysqlEnum("sender", ["customer", "ai", "manager"]).notNull(),
    body: text("body").notNull(),
    intent: varchar("intent", { length: 64 }),
    mode: mysqlEnum("mode", ["simulator", "live", "shadow"]).default("simulator").notNull(),
    /** Two-phase send tracking. queued = persisted but not yet handed to Twilio. sent = Twilio accepted. failed = upstream error. delivered = optional later state. */
    status: mysqlEnum("status", ["queued", "sent", "failed", "delivered"]).default("sent").notNull(),
    /** Twilio MessageSid — outbound: returned by Messages.create; inbound: provided by Twilio webhook. UNIQUE so duplicate webhook deliveries become no-ops. */
    twilioSid: varchar("twilioSid", { length: 64 }),
    /** Stable correlation id grouping every row tied to one inbound → draft → reply chain. */
    correlationId: varchar("correlationId", { length: 64 }),
    /** Captured Twilio API error string when status='failed'. */
    sendError: varchar("sendError", { length: 256 }),
    /** MMS media URLs (and content types) provided by Twilio for inbound messages. JSON array. */
    attachments: json("attachments"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    twilioSidUnique: uniqueIndex("messages_twilioSid_unique").on(t.twilioSid),
  }),
);

export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

/** Transparent log of every step the AI takes for a given inbound message. */
export const processingLogs = mysqlTable("processingLogs", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversationId").notNull(),
  messageId: int("messageId").notNull(),
  step: mysqlEnum("step", [
    "intent_detected",
    "mock_api_called",
    "response_drafted",
    "sent",
    "escalated",
    "send_failed",
  ]).notNull(),
  label: varchar("label", { length: 256 }).notNull(),
  detail: json("detail"),
  /** Stable correlation id grouping every row tied to one inbound → draft → reply chain. */
  correlationId: varchar("correlationId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ProcessingLog = typeof processingLogs.$inferSelect;
export type InsertProcessingLog = typeof processingLogs.$inferInsert;

/** Critical escalations that require manager attention. */
export const escalations = mysqlTable("escalations", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversationId").notNull(),
  messageId: int("messageId").notNull(),
  reason: varchar("reason", { length: 256 }).notNull(),
  severity: mysqlEnum("severity", ["high", "critical"]).default("critical").notNull(),
  status: mysqlEnum("status", ["open", "resolved"]).default("open").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  resolvedAt: timestamp("resolvedAt"),
});

export type Escalation = typeof escalations.$inferSelect;
export type InsertEscalation = typeof escalations.$inferInsert;

/* ----- Mock CleanCloud POS tables ----- */

export const mockCustomers = mysqlTable("mockCustomers", {
  id: int("id").autoincrement().primaryKey(),
  phone: varchar("phone", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  membership: mysqlEnum("membership", ["none", "silver", "gold"]).default("none").notNull(),
  address: varchar("address", { length: 256 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type MockCustomer = typeof mockCustomers.$inferSelect;
export type InsertMockCustomer = typeof mockCustomers.$inferInsert;

export const mockOrders = mysqlTable("mockOrders", {
  id: int("id").autoincrement().primaryKey(),
  orderNumber: varchar("orderNumber", { length: 32 }).notNull().unique(),
  customerPhone: varchar("customerPhone", { length: 32 }).notNull(),
  status: mysqlEnum("status", [
    "Awaiting Pickup",
    "Cleaning",
    "Ready to Deliver",
    "Completed",
  ]).notNull(),
  itemsSummary: varchar("itemsSummary", { length: 256 }).notNull(),
  totalCents: int("totalCents").default(0).notNull(),
  etaText: varchar("etaText", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type MockOrder = typeof mockOrders.$inferSelect;
export type InsertMockOrder = typeof mockOrders.$inferInsert;

export const mockPriceList = mysqlTable("mockPriceList", {
  id: int("id").autoincrement().primaryKey(),
  category: varchar("category", { length: 64 }).notNull(), // dryClean / alteration / laundry
  itemName: varchar("itemName", { length: 128 }).notNull(),
  priceCents: int("priceCents").notNull(),
  notes: varchar("notes", { length: 256 }),
});

export type MockPrice = typeof mockPriceList.$inferSelect;
export type InsertMockPrice = typeof mockPriceList.$inferInsert;

/* ============================================================
 * Human-in-the-Loop + RAG tables
 * ============================================================ */

/**
 * Drafts are AI-generated replies awaiting human approval.
 * One inbound message can have multiple drafts (original + regenerations after Reject).
 */
export const drafts = mysqlTable("drafts", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversationId").notNull(),
  inboundMessageId: int("inboundMessageId").notNull(),
  intent: varchar("intent", { length: 64 }).notNull(),
  body: text("body").notNull(),
  revision: int("revision").default(1).notNull(), // 1 = original, 2+ = regenerated after rejection
  status: mysqlEnum("status", ["pending_approval", "approved", "rejected", "superseded"])
    .default("pending_approval")
    .notNull(),
  ragContext: json("ragContext"), // { styleExamples: [], rejectionLessons: [], knowledge: [] }
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Draft = typeof drafts.$inferSelect;
export type InsertDraft = typeof drafts.$inferInsert;

/**
 * Tier 2 (RAG): Approved (customer message ↔ AI reply) pairs.
 * Used as few-shot style examples for future drafts.
 */
export const styleExamples = mysqlTable("styleExamples", {
  id: int("id").autoincrement().primaryKey(),
  draftId: int("draftId").notNull(),
  intent: varchar("intent", { length: 64 }).notNull(),
  customerBody: text("customerBody").notNull(),
  approvedReply: text("approvedReply").notNull(),
  embedding: json("embedding").notNull(), // number[] (cosine sim)
  embeddingDim: int("embeddingDim").default(0).notNull(), // 256 (hash fallback) or 1536 (OpenAI)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type StyleExample = typeof styleExamples.$inferSelect;
export type InsertStyleExample = typeof styleExamples.$inferInsert;

/**
 * Tier 3 (RAG): Rejected drafts + manager reason.
 * Used as "don't do this" lessons injected into future prompts.
 */
export const REJECT_CATEGORIES = [
  "wrong_information",
  "tone_too_formal",
  "tone_too_casual",
  "too_long",
  "too_short",
  "missing_context",
  "should_escalate",
  "other",
] as const;
export type RejectCategory = (typeof REJECT_CATEGORIES)[number];

export const rejections = mysqlTable("rejections", {
  id: int("id").autoincrement().primaryKey(),
  draftId: int("draftId").notNull(),
  intent: varchar("intent", { length: 64 }).notNull(),
  customerBody: text("customerBody").notNull(),
  rejectedReply: text("rejectedReply").notNull(),
  category: mysqlEnum("category", REJECT_CATEGORIES).default("other").notNull(),
  reason: text("reason").notNull(),
  embedding: json("embedding").notNull(),
  embeddingDim: int("embeddingDim").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Rejection = typeof rejections.$inferSelect;
export type InsertRejection = typeof rejections.$inferInsert;

/**
 * Tier 1 (RAG): Editable knowledge facts (price list, membership policy, hours, pickup rules).
 * Manager can edit these directly; seeded on first run.
 */
export const knowledgeChunks = mysqlTable(
  "knowledgeChunks",
  {
    id: int("id").autoincrement().primaryKey(),
    topic: varchar("topic", { length: 64 }).notNull(),
    title: varchar("title", { length: 256 }).notNull(),
    body: text("body").notNull(),
    embedding: json("embedding").notNull(),
    embeddingDim: int("embeddingDim").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    topicTitleUnique: uniqueIndex("knowledge_topic_title_unique").on(t.topic, t.title),
  }),
);

export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type InsertKnowledgeChunk = typeof knowledgeChunks.$inferInsert;


/* ============================================================
 * Phase 9 — Admin error logging
 * ============================================================
 *
 * `errorLogs` captures unexpected server-side failures (DB write blowups,
 * Twilio webhook crashes, OAuth callback errors, draft persist failures, …)
 * so an owner-only "Errors" tab in the UI can surface them at a glance,
 * without needing access to the underlying Cloud Run console.
 *
 * Writes are best-effort — see `server/errorLog.ts`. Reads are gated by
 * `adminProcedure`.
 */
export const errorLogs = mysqlTable("errorLogs", {
  id: int("id").autoincrement().primaryKey(),
  level: mysqlEnum("level", ["error", "warn"]).default("error").notNull(),
  source: varchar("source", { length: 128 }).notNull(),
  message: text("message").notNull(),
  stack: text("stack"),
  context: json("context"),
  correlationId: varchar("correlationId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ErrorLog = typeof errorLogs.$inferSelect;
export type InsertErrorLog = typeof errorLogs.$inferInsert;


/**
 * Phase 10 — Error alert engine
 * -----------------------------
 *
 * `errorAlerts` records every alert the spike/flapping detectors fire. The
 * table doubles as the cooldown ledger: before firing we look up the most
 * recent alert with the same `key` and skip if it is still within the
 * cooldown window. Each fired alert is also `notifyOwner`-pushed and
 * mirrored back into `errorLogs` (level=warn, source="alert.engine") so it
 * shows up in the same admin Errors tab.
 *
 *   key examples:
 *     "spike:TwilioWebhook"
 *     "flap:drafts.approve|TRPCError: rate limited"
 */
export const errorAlerts = mysqlTable("errorAlerts", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("key", { length: 256 }).notNull(),
  kind: mysqlEnum("kind", ["spike", "flap"]).notNull(),
  source: varchar("source", { length: 128 }).notNull(),
  message: text("message"),
  count: int("count").notNull(), // how many errors triggered this alert
  windowSeconds: int("windowSeconds").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ErrorAlert = typeof errorAlerts.$inferSelect;
export type InsertErrorAlert = typeof errorAlerts.$inferInsert;


/**
 * Phase 23f-7 — CleanCloud webhook event log
 * -------------------------------------------
 *
 * CleanCloud POS POSTs webhook events to `POST /api/cleancloud/webhook` with a
 * shared-secret URL query parameter (`?token=...`). The handler verifies the
 * secret, then writes a row here for every event regardless of dispatch
 * outcome — that way we have a forensic record even if dispatch logic later
 * has a bug.
 *
 *   eventType examples (from cleancloudapp.com admin Webhooks panel):
 *     "order.created"                  (In Store)
 *     "order.created"                  (Pickup and Delivery)
 *     "order.status_changed"
 *     "order.pickup_rescheduled"
 *     "order.delivery_rescheduled"
 *     "order.nothing_to_pickup"
 *     "order.deleted"
 *     "customer.created"
 *     "customer.updated"
 *     "customer.deleted"
 *
 *   processedAt is non-null once dispatch logic has finished (success or
 *   failure). When dispatch fails we still set processedAt and write the
 *   error message to `dispatchError` so retries are explicit.
 *
 *   `eventId` is CleanCloud's own id when present (used for idempotency),
 *   otherwise a synthesized hash of (eventType + payload) so duplicate
 *   webhook retries don't double-fire downstream actions.
 */
export const cleanCloudWebhookEvents = mysqlTable("cleanCloudWebhookEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventType: varchar("eventType", { length: 64 }).notNull(),
  eventId: varchar("eventId", { length: 128 }).notNull(),
  payload: json("payload").notNull(),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
  processedAt: timestamp("processedAt"),
  dispatchError: text("dispatchError"),
}, t => ({
  // Idempotency: the same (eventType, eventId) pair must only ever be
  // recorded once. Duplicate POSTs from CleanCloud retries short-circuit at
  // INSERT time and we don't re-dispatch downstream actions.
  uniqEventTypeId: uniqueIndex("uniq_event_type_id").on(t.eventType, t.eventId),
}));
export type CleanCloudWebhookEvent = typeof cleanCloudWebhookEvents.$inferSelect;
export type InsertCleanCloudWebhookEvent = typeof cleanCloudWebhookEvents.$inferInsert;
