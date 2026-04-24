import {
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

/** Each SMS message either sent by the customer or by DropShop (AI or human). */
export const messages = mysqlTable("messages", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversationId").notNull(),
  direction: mysqlEnum("direction", ["inbound", "outbound"]).notNull(),
  sender: mysqlEnum("sender", ["customer", "ai", "manager"]).notNull(),
  body: text("body").notNull(),
  intent: varchar("intent", { length: 64 }),
  mode: mysqlEnum("mode", ["simulator", "live"]).default("simulator").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
  ]).notNull(),
  label: varchar("label", { length: 256 }).notNull(),
  detail: json("detail"),
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
