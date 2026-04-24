import { describe, expect, it } from "vitest";
import {
  appendMessage,
  getCustomerProfile,
  getOrCreateConversation,
  insertDraft,
  insertRejection,
  insertStyleExample,
  listStyleExamplesByPhone,
  resetDemoData,
} from "./db";

const PHONE = "+15550109901";

async function seed() {
  await resetDemoData();
  const conv = await getOrCreateConversation(PHONE, "Test Customer");
  if (!conv) throw new Error("DB unavailable");

  const inbound = await appendMessage({
    conversationId: conv.id,
    direction: "inbound",
    sender: "customer",
    body: "Where is my order?",
    intent: "ETA/Order Status",
  });

  const draft = await insertDraft({
    conversationId: conv.id,
    inboundMessageId: inbound.id,
    intent: "ETA/Order Status",
    body: "Hi, your order is out for delivery.",
    status: "pending_approval",
    revision: 1,
    ragContext: { knowledge: [], styleExamples: [], rejectionLessons: [] },
  });

  // simulate one approval and one rejection
  await insertStyleExample({
    draftId: draft.id,
    intent: "ETA/Order Status",
    customerBody: "Where is my order?",
    approvedReply: "Hi, your order is out for delivery.",
    embedding: [0, 0, 0],
  });
  await insertRejection({
    draftId: draft.id,
    intent: "ETA/Order Status",
    customerBody: "Where is my order?",
    rejectedReply: "Order out.",
    category: "too_short",
    reason: "Too terse for this customer.",
    embedding: [0, 0, 0],
  });

  return conv.id;
}

describe("customer profile aggregation", () => {
  it("returns intent distribution, approval rate, and reject categories", async () => {
    const convId = await seed();
    const profile = await getCustomerProfile(convId);
    expect(profile).not.toBeNull();
    if (!profile) return;
    expect(profile.phone).toBe(PHONE);
    expect(profile.totalMessages).toBe(1);
    expect(profile.totalDrafts).toBe(1);
    expect(profile.approvedCount).toBe(1);
    expect(profile.rejectedCount).toBe(1);
    expect(profile.approvalRate).toBeCloseTo(0.5, 5);
    expect(profile.topIntents[0]?.intent).toBe("ETA/Order Status");
    expect(profile.topRejectCategories[0]?.category).toBe("too_short");
    expect(profile.avgReplyChars).toBeGreaterThan(0);
  });

  it("returns null for unknown conversation id", async () => {
    const profile = await getCustomerProfile(999_999);
    expect(profile).toBeNull();
  });

  it("listStyleExamplesByPhone returns only this customer's approved replies", async () => {
    await seed();
    const examples = await listStyleExamplesByPhone(PHONE);
    expect(examples.length).toBe(1);
    expect(examples[0]?.approvedReply).toContain("out for delivery");

    const empty = await listStyleExamplesByPhone("+15550100000");
    expect(empty.length).toBe(0);
  });
});
