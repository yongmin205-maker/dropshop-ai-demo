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


/* ============================================================
 * Phase 25a — Vendor-neutral mirror schema
 *
 * Stage 0 strategy: a single nightly pull at 03:00 America/New_York fetches
 * recent CleanCloud data (customers/orders/payments/products) and upserts
 * into the tables below. The schema is intentionally **vendor-neutral** so
 * that when DropShop ships its own POS later, it lands in the same
 * `customers`/`orders`/`payments`/`products` tables with `source =
 * "dropshop_pos"` and the analytics/Owner-Assistant layer above keeps
 * working unchanged. CleanCloud-specific keys live in `external_refs`.
 *
 * Naming convention to avoid collision with the demo's existing
 * `mockCustomers`/`mockOrders` (which model the CleanCloud-replacement POS
 * during the demo) and the legacy auth `users` table:
 *
 *   posCustomers / posOrders / posPayments / posProducts
 *
 * The vendor-neutral product names map to `customers`/`orders`/... at the
 * application/Owner-Assistant layer; the `pos` prefix is purely a SQL-level
 * disambiguation, not an architectural distinction.
 *
 * Detailed reasoning: docs/mainstreet-ai/integrations/cleancloud_data_strategy.md
 * Detailed schema discussion: docs/mainstreet-ai/integrations/cleancloud_pipeline.md
 * ============================================================ */

/** Source POS systems we mirror from. CleanCloud today, DropShop POS later. */
export const POS_SOURCES = ["cleancloud", "dropshop_pos"] as const;
export type PosSource = (typeof POS_SOURCES)[number];

/**
 * Normalized order status. CleanCloud's int statuses map here via
 * server/integrations/cleancloud/statusMap.ts. Future POS sources map
 * their own statuses into the same enum. The Owner Assistant + UI only
 * ever sees these values.
 */
export const POS_ORDER_STATUSES = [
  "received",     // Order created, not yet processed
  "cleaning",     // In wash/dryclean cycle
  "ready",        // Ready for pickup
  "out_for_delivery",
  "picked_up",    // Customer collected
  "completed",    // Settled + closed
  "cancelled",
  "unknown",      // Source returned a status we don't recognize yet
] as const;
export type PosOrderStatus = (typeof POS_ORDER_STATUSES)[number];

/** Normalized payment type — kept coarse on purpose so it survives schema drift. */
export const POS_PAYMENT_TYPES = [
  "cash",
  "card",
  "credit",        // store credit applied at checkout
  "stripe",
  "square",
  "loyalty_points",
  "other",
  "unknown",
] as const;
export type PosPaymentType = (typeof POS_PAYMENT_TYPES)[number];

/* ----- Mirrored entities ----- */

/**
 * Customer mirror. One row per (source, externalId).
 *
 * Why we store both `phoneE164` (normalized) and `phoneRaw` (as the source
 * gave it): the normalized form is for DB joins/lookups; the raw form is
 * for display + debugging when CleanCloud's input wasn't a valid US number
 * (e.g. test rows with "555-XXXX"). Owner Assistant should query phoneE164.
 */
export const posCustomers = mysqlTable(
  "posCustomers",
  {
    id: int("id").autoincrement().primaryKey(),
    source: mysqlEnum("source", POS_SOURCES).notNull(),
    externalId: varchar("externalId", { length: 64 }).notNull(),
    name: varchar("name", { length: 256 }),
    phoneE164: varchar("phoneE164", { length: 32 }),
    phoneRaw: varchar("phoneRaw", { length: 64 }),
    email: varchar("email", { length: 320 }),
    address: text("address"),
    notes: text("notes"),
    marketingOptIn: int("marketingOptIn").default(0).notNull(), // 0/1
    loyaltyPoints: int("loyaltyPoints").default(0).notNull(),
    creditCents: int("creditCents").default(0).notNull(),
    /** Verbatim source payload — JSON. Lets us re-derive any field later
     *  without a backfill. */
    rawPayload: json("rawPayload"),
    /** When this row was last refreshed from the source (UTC). */
    syncedAt: timestamp("syncedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    sourceExternalUnique: uniqueIndex("posCustomers_source_external_unique").on(
      t.source,
      t.externalId,
    ),
  }),
);
export type PosCustomer = typeof posCustomers.$inferSelect;
export type InsertPosCustomer = typeof posCustomers.$inferInsert;

/**
 * Order mirror. One row per (source, externalId).
 *
 * `customerExternalId` is denormalized (we store the source's customer id
 * directly, not the FK to posCustomers.id) so that a missing customer pull
 * doesn't block the order pull. Joining at query time is via
 * (source, externalId) on both tables.
 */
export const posOrders = mysqlTable(
  "posOrders",
  {
    id: int("id").autoincrement().primaryKey(),
    source: mysqlEnum("source", POS_SOURCES).notNull(),
    externalId: varchar("externalId", { length: 64 }).notNull(),
    customerExternalId: varchar("customerExternalId", { length: 64 }),
    status: mysqlEnum("status", POS_ORDER_STATUSES).notNull(),
    /** Verbatim source status (e.g. CleanCloud's "0", "1", "4", "5") for
     *  debugging schema drift. */
    sourceStatusRaw: varchar("sourceStatusRaw", { length: 32 }),
    finalTotalCents: int("finalTotalCents").default(0).notNull(),
    paid: int("paid").default(0).notNull(), // 0/1
    completed: int("completed").default(0).notNull(), // 0/1
    express: int("express").default(0).notNull(), // 0/1
    /** UTC timestamp of when the order was placed at the source. */
    placedAt: timestamp("placedAt"),
    /** Pickup/delivery scheduled window — UTC. */
    pickupAt: timestamp("pickupAt"),
    deliveryAt: timestamp("deliveryAt"),
    notes: text("notes"),
    /** Order-level item summary, denormalized for cheap reads. JSON array. */
    itemsSummary: json("itemsSummary"),
    rawPayload: json("rawPayload"),
    syncedAt: timestamp("syncedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    sourceExternalUnique: uniqueIndex("posOrders_source_external_unique").on(
      t.source,
      t.externalId,
    ),
  }),
);
export type PosOrder = typeof posOrders.$inferSelect;
export type InsertPosOrder = typeof posOrders.$inferInsert;

/**
 * Payment mirror. One row per (source, externalId).
 *
 * Stage 0 note: CleanCloud's getPayments endpoint isn't always called —
 * payments are also embedded inside the getOrders payload. The pull job
 * extracts inline payments from order.payments[] when present; the
 * dedicated getPayments call is reserved for Stage 1.
 */
export const posPayments = mysqlTable(
  "posPayments",
  {
    id: int("id").autoincrement().primaryKey(),
    source: mysqlEnum("source", POS_SOURCES).notNull(),
    externalId: varchar("externalId", { length: 64 }).notNull(),
    orderExternalId: varchar("orderExternalId", { length: 64 }),
    customerExternalId: varchar("customerExternalId", { length: 64 }),
    amountCents: int("amountCents").notNull(),
    type: mysqlEnum("type", POS_PAYMENT_TYPES).default("unknown").notNull(),
    sourceTypeRaw: varchar("sourceTypeRaw", { length: 32 }),
    refunded: int("refunded").default(0).notNull(), // 0/1
    paidAt: timestamp("paidAt"),
    rawPayload: json("rawPayload"),
    syncedAt: timestamp("syncedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    sourceExternalUnique: uniqueIndex("posPayments_source_external_unique").on(
      t.source,
      t.externalId,
    ),
  }),
);
export type PosPayment = typeof posPayments.$inferSelect;
export type InsertPosPayment = typeof posPayments.$inferInsert;

/**
 * Product mirror — full snapshot replaced on each pull (not delta).
 * `priceListExternalId` denotes the price-list scope (CleanCloud supports
 * multiple lists for tiered pricing).
 */
export const posProducts = mysqlTable(
  "posProducts",
  {
    id: int("id").autoincrement().primaryKey(),
    source: mysqlEnum("source", POS_SOURCES).notNull(),
    externalId: varchar("externalId", { length: 64 }).notNull(),
    priceListExternalId: varchar("priceListExternalId", { length: 64 }),
    name: varchar("name", { length: 256 }).notNull(),
    category: varchar("category", { length: 128 }),
    priceCents: int("priceCents").default(0).notNull(),
    parentExternalId: varchar("parentExternalId", { length: 64 }),
    rawPayload: json("rawPayload"),
    syncedAt: timestamp("syncedAt").defaultNow().notNull(),
  },
  (t) => ({
    sourceExternalUnique: uniqueIndex("posProducts_source_external_unique").on(
      t.source,
      t.externalId,
    ),
  }),
);
export type PosProduct = typeof posProducts.$inferSelect;
export type InsertPosProduct = typeof posProducts.$inferInsert;

/**
 * Cross-vendor entity reference table. Lets the Owner Assistant ask
 * "what's the CleanCloud customerID for our internal customer #42?" and
 * future-proofs the migration from CleanCloud → DropShop POS.
 *
 * For Stage 0 we *also* keep the (source, externalId) unique index on
 * each pos* table itself — this table is additive, not the only mapping.
 */
export const posExternalRefs = mysqlTable(
  "posExternalRefs",
  {
    id: int("id").autoincrement().primaryKey(),
    entityType: mysqlEnum("entityType", [
      "customer",
      "order",
      "payment",
      "product",
    ]).notNull(),
    source: mysqlEnum("source", POS_SOURCES).notNull(),
    externalId: varchar("externalId", { length: 64 }).notNull(),
    /** FK into the corresponding pos* table (posCustomers.id, etc).
     *  Not a SQL FK — Drizzle MySQL doesn't enforce them by default. */
    internalId: int("internalId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    typeSourceExternalUnique: uniqueIndex(
      "posExternalRefs_type_source_external_unique",
    ).on(t.entityType, t.source, t.externalId),
  }),
);
export type PosExternalRef = typeof posExternalRefs.$inferSelect;
export type InsertPosExternalRef = typeof posExternalRefs.$inferInsert;

/**
 * Sync log — one row per pull invocation per endpoint. Owner Assistant
 * reads the latest finished row to answer "how fresh is this data?".
 */
export const POS_SYNC_TRIGGERS = [
  "daily_pull_03am_et",
  "manual",
  "backfill",
  "webhook",         // reserved for Stage 1
] as const;
export type PosSyncTrigger = (typeof POS_SYNC_TRIGGERS)[number];

export const posSyncLog = mysqlTable("posSyncLog", {
  id: int("id").autoincrement().primaryKey(),
  source: mysqlEnum("source", POS_SOURCES).notNull(),
  trigger: mysqlEnum("trigger", POS_SYNC_TRIGGERS).notNull(),
  endpoint: varchar("endpoint", { length: 64 }).notNull(),
  /** UTC. Time window the pull was responsible for (inclusive both ends). */
  windowFrom: timestamp("windowFrom"),
  windowTo: timestamp("windowTo"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
  rowsFetched: int("rowsFetched").default(0).notNull(),
  rowsUpserted: int("rowsUpserted").default(0).notNull(),
  rowsFailed: int("rowsFailed").default(0).notNull(),
  /** When non-null, the pull ended in error. Owner Assistant surfaces these. */
  error: text("error"),
});
export type PosSyncLog = typeof posSyncLog.$inferSelect;
export type InsertPosSyncLog = typeof posSyncLog.$inferInsert;

/**
 * Product-change diff log. Each daily pull compares the new product
 * snapshot against the previous one and writes a row per added/removed/
 * price-changed product. Useful for the Owner Assistant question
 * "did our drop-off prices change last month?".
 */
export const POS_PRODUCT_CHANGE_KINDS = ["added", "removed", "price_changed"] as const;
export type PosProductChangeKind = (typeof POS_PRODUCT_CHANGE_KINDS)[number];

export const posProductChanges = mysqlTable("posProductChanges", {
  id: int("id").autoincrement().primaryKey(),
  source: mysqlEnum("source", POS_SOURCES).notNull(),
  externalId: varchar("externalId", { length: 64 }).notNull(),
  kind: mysqlEnum("kind", POS_PRODUCT_CHANGE_KINDS).notNull(),
  /** Cents. Nullable because added/removed have no "old" price. */
  oldPriceCents: int("oldPriceCents"),
  newPriceCents: int("newPriceCents"),
  /** Snapshot of name at change time so we can render a human label
   *  even if the product is later removed. */
  productName: varchar("productName", { length: 256 }),
  /** FK into posSyncLog.id of the pull that detected the change. */
  syncLogId: int("syncLogId").notNull(),
  detectedAt: timestamp("detectedAt").defaultNow().notNull(),
});
export type PosProductChange = typeof posProductChanges.$inferSelect;
export type InsertPosProductChange = typeof posProductChanges.$inferInsert;

/* ============================================================
 * Phase 25c — Owner Assistant conversation persistence
 * ============================================================
 *
 * One ownerConversations row per chat thread. ownerMessages stores
 * every user + assistant turn. assistant rows additionally carry the
 * agent's trace JSON (router decision, plan, per-tool calls + timings)
 * so the UI can render a collapsible "what did the agent do?" box.
 *
 * Why a separate table from the existing `conversations` table:
 *   - `conversations` is keyed by Customer phone for SMS threads — the
 *     domain is Customer ↔ Store. This is Owner ↔ Agent and has no
 *     phone, no escalations, no drafts.
 *   - Owner Assistant turns produce large structured `trace` blobs that
 *     would bloat the SMS message table. Keep the surfaces orthogonal.
 *
 * Single-tenant assumption: ownerOpenId is stored but no procedure
 * filters on it today. When multi-owner ships, every read adds a
 * WHERE ownerOpenId = ? clause and the existing rows backfill against
 * ENV.ownerOpenId.
 */

export const ownerConversations = mysqlTable("ownerConversations", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  /** First-question summary, optional. Filled by the orchestrator on
   *  the first turn so the listConversations sidebar has a label
   *  beyond the timestamp. */
  title: varchar("title", { length: 256 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type OwnerConversation = typeof ownerConversations.$inferSelect;
export type InsertOwnerConversation = typeof ownerConversations.$inferInsert;

export const OWNER_MESSAGE_ROLES = ["user", "assistant"] as const;
export type OwnerMessageRole = (typeof OWNER_MESSAGE_ROLES)[number];

export const ownerMessages = mysqlTable("ownerMessages", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversationId").notNull(),
  role: mysqlEnum("role", OWNER_MESSAGE_ROLES).notNull(),
  contentMarkdown: text("contentMarkdown").notNull(),
  /** AgentTrace JSON — present only on assistant rows. */
  trace: json("trace"),
  /** End-to-end orchestrator latency in ms. Present only on assistant
   *  rows. */
  totalLatencyMs: int("totalLatencyMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type OwnerMessage = typeof ownerMessages.$inferSelect;
export type InsertOwnerMessage = typeof ownerMessages.$inferInsert;


/* ────────────────────────────────────────────────────────────
 * Phase 25b — Daily Briefing
 *
 * LLM-generated overnight summary of yesterday's POS activity.
 * Generated at 07:00 ET by a Heartbeat cron after the 03:00 ET daily
 * pull lands.
 *
 * Schema notes:
 *   - `briefingDate` is the local NYC business day the briefing
 *     summarises (the *previous* business day relative to when the
 *     cron fires), formatted YYYY-MM-DD. UNIQUE — only one briefing
 *     per date; subsequent generations overwrite via
 *     ON DUPLICATE KEY UPDATE.
 *   - `periodStartMs/periodEndMs` are stored as varchar(20) (rather
 *     than bigint) because TiDB/Drizzle's bigint round-trip is lossy
 *     when values approach the 2^53 boundary in JSON; we always
 *     parse them with Number() at read time.
 *   - LLM observability (`llmModel`, `promptTokens`, `completionTokens`)
 *     is best-effort — null when invokeLLM doesn't surface them.
 *   - Failure mode: if the LLM call fails we still insert a row with
 *     a fallback summary "(브리핑 생성 실패 — 잠시 후 다시 시도)"
 *     and the upstream error in `errorMessage`.
 *   - `deliveredAt` is set when notifyOwner has pushed the briefing,
 *     so we don't double-push on retries.
 * ──────────────────────────────────────────────────────────── */

export const dailyBriefings = mysqlTable("dailyBriefings", {
  id: int("id").autoincrement().primaryKey(),
  /** Local NYC date the briefing summarises. Format `YYYY-MM-DD`. UNIQUE. */
  briefingDate: varchar("briefingDate", { length: 10 }).notNull().unique(),
  /** Inclusive UNIX-ms start of the NYC business-day window
   *  (04:00 ET on briefingDate). Stored as string. */
  periodStartMs: varchar("periodStartMs", { length: 20 }).notNull(),
  /** Exclusive UNIX-ms end of the window (04:00 ET on the day after
   *  briefingDate). Stored as string. */
  periodEndMs: varchar("periodEndMs", { length: 20 }).notNull(),
  /** Snapshot of metrics used to build the summary so the UI chip
   *  row renders without re-querying. Shape: `DailyMetrics`. */
  metrics: json("metrics").notNull(),
  /** Markdown summary in Korean (point-of-view: 점주). 4–7 sentences,
   *  optional pipe table. */
  summaryMarkdown: text("summaryMarkdown").notNull(),
  /** Best-effort observability — null when not surfaced. */
  llmModel: varchar("llmModel", { length: 64 }),
  promptTokens: int("promptTokens"),
  completionTokens: int("completionTokens"),
  /** When the LLM call started. */
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
  /** When notifyOwner successfully pushed this briefing. */
  deliveredAt: timestamp("deliveredAt"),
  /** Set when generation failed. */
  errorMessage: text("errorMessage"),
});

export type DailyBriefing = typeof dailyBriefings.$inferSelect;
export type InsertDailyBriefing = typeof dailyBriefings.$inferInsert;
