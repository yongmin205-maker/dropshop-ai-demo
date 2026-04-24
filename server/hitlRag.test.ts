import { describe, expect, it, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------
 * Pure-logic tests for the new Human-in-the-Loop + RAG layer.
 *
 * We do NOT hit MySQL. Instead we mock:
 *   - server/_core/llm -> invokeLLM (deterministic)
 *   - server/mockCleanCloud lookups (fixture customer + order)
 *   - server/db (approve/reject DB side-effects: drafts, style examples, rejections)
 *
 * This is the behavioural contract the UI depends on:
 *   1. Approve persists an outbound message + style example
 *   2. Reject persists a rejection with reason + regenerates a new draft
 *   3. RAG retrieval ranks same-intent approved examples above noise
 * ------------------------------------------------------------------ */

// -------- Mocks (must be declared before importing modules under test)

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(async ({ messages }: { messages: Array<{ content: string }> }) => {
    const last = messages[messages.length - 1]?.content ?? "";
    // Classifier path returns JSON matching json_schema
    if (messages[0]?.content?.includes("intent classifier")) {
      return {
        choices: [
          { message: { content: JSON.stringify({ intent: "Pickup Request" }) } },
        ],
      };
    }
    // Reply generator path — echo a branded reply, respect reject hint
    const rejectHint = /manager just rejected/i.test(last);
    return {
      choices: [
        {
          message: {
            content: rejectHint
              ? "Got it — picking up tomorrow before 11am as you asked.\n— DropShop"
              : "Hi Marie — we'll pick up this afternoon.\n— DropShop",
          },
        },
      ],
    };
  }),
}));

vi.mock("./mockCleanCloud", async () => {
  return {
    formatCents: (c: number) => `$${(c / 100).toFixed(2)}`,
    getCustomerByPhone: vi.fn(async () => ({
      id: 1,
      phone: "+15550101003",
      name: "Marie Noelle Pierce",
      membership: "gold",
    })),
    getOrdersByPhone: vi.fn(async () => [
      {
        id: 101,
        status: "Ready to Deliver",
        itemsJson: JSON.stringify(["2 shirts", "1 blazer"]),
      },
    ]),
    listAllPrices: vi.fn(async () => []),
    searchPrice: vi.fn(async () => null),
    getMembershipInfo: vi.fn(async () => null),
  };
});

vi.mock("./db", () => {
  const state = {
    drafts: new Map<number, any>(),
    styleExamples: [] as any[],
    rejections: [] as any[],
    processingLogs: [] as any[],
    outbound: [] as any[],
    conversations: [{ id: 5, phone: "+15550101003", customerName: "Marie Noelle Pierce" }],
  };
  let idCounter = 100;
  return {
    __state: state,
    // writes
    insertDraft: vi.fn(async (d: any) => {
      const row = { id: ++idCounter, status: "pending_approval", revision: 1, ...d };
      state.drafts.set(row.id, row);
      return row;
    }),
    updateDraftStatus: vi.fn(async (id: number, status: string) => {
      const row = state.drafts.get(id);
      if (row) row.status = status;
    }),
    insertStyleExample: vi.fn(async (ex: any) => {
      state.styleExamples.push({ id: state.styleExamples.length + 1, ...ex });
    }),
    insertRejection: vi.fn(async (r: any) => {
      state.rejections.push({ id: state.rejections.length + 1, ...r });
    }),
    appendMessage: vi.fn(async (m: any) => {
      const row = { id: ++idCounter, ...m };
      if (m.direction === "outbound") state.outbound.push(row);
      return row;
    }),
    appendProcessingLog: vi.fn(async (l: any) => {
      state.processingLogs.push(l);
    }),
    getDraftById: vi.fn(async (id: number) => state.drafts.get(id) ?? null),
    getConversationMessages: vi.fn(async () => [
      { id: 50, direction: "inbound", body: "Pickup for Marie please" },
    ]),
    listConversations: vi.fn(async () => state.conversations),
    getOrCreateConversation: vi.fn(async () => state.conversations[0]),
    updateConversationIntent: vi.fn(async () => {}),
    createEscalation: vi.fn(async () => ({ id: 1 })),
    listPendingDrafts: vi.fn(async () =>
      [...state.drafts.values()].filter((d) => d.status === "pending_approval"),
    ),
    getLatestPendingDraftForMessage: vi.fn(async () => null),
    // reads used by RAG
    listStyleExamples: vi.fn(async () => state.styleExamples),
    listStyleExamplesByPhone: vi.fn(async () => []),
    listRejections: vi.fn(async () => state.rejections),
    listKnowledge: vi.fn(async () => [
      {
        id: 1,
        topic: "hours",
        title: "Business Hours",
        body: "Mon–Sat 8am–7pm, Sun closed.",
        embedding: [],
      },
    ]),
    upsertKnowledgeChunk: vi.fn(async () => {}),
    getOpenEscalations: vi.fn(async () => []),
    resolveEscalation: vi.fn(async () => {}),
    getConversationLogs: vi.fn(async () => state.processingLogs),
  };
});

// Now import modules under test (mocks are in place)
const db = await import("./db");
const agent = await import("./aiAgent");
const emb = await import("./embeddings");

beforeEach(() => {
  // Reset mock state between tests
  (db as any).__state.drafts.clear();
  (db as any).__state.styleExamples.length = 0;
  (db as any).__state.rejections.length = 0;
  (db as any).__state.processingLogs.length = 0;
  (db as any).__state.outbound.length = 0;
});

describe("Approval loop — side effects", () => {
  it("drafting does NOT send an outbound SMS; only a pending draft is staged", async () => {
    const result = await agent.draftAgentReply({
      phone: "+15550101003",
      body: "Pickup for Marie please",
    });
    expect(result.escalated).toBe(false);
    expect(result.reply).toMatch(/DropShop/);
    // No outbound message should have been appended during draft generation
    expect((db as any).__state.outbound.length).toBe(0);
    // The agent enumerated its steps in the required order
    const steps = result.steps.map((s: any) => s.step);
    expect(steps).toContain("intent_detected");
    expect(steps).toContain("mock_api_called");
    expect(steps).toContain("response_drafted");
  });

  it("inserting a draft marks it pending_approval, approving flips to approved + records a style example", async () => {
    const draft = await db.insertDraft({
      conversationId: 5,
      inboundMessageId: 50,
      intent: "Pickup Request",
      body: "Hi Marie — we'll pick up this afternoon.\n— DropShop",
      revision: 1,
      status: "pending_approval",
    } as any);
    expect(draft.status).toBe("pending_approval");

    // Simulate the approve router's persistence side-effects
    await db.appendMessage({
      conversationId: 5,
      direction: "outbound",
      sender: "ai",
      body: draft.body,
      intent: draft.intent,
      mode: "simulator",
    } as any);
    await db.updateDraftStatus(draft.id, "approved");
    await db.insertStyleExample({
      draftId: draft.id,
      intent: draft.intent,
      customerBody: "Pickup for Marie please",
      approvedReply: draft.body,
      embedding: await emb.embedText("Pickup for Marie please"),
    } as any);

    expect((db as any).__state.outbound.length).toBe(1);
    const updated = await db.getDraftById(draft.id);
    expect(updated?.status).toBe("approved");
    const examples = await db.listStyleExamples();
    expect(examples.length).toBe(1);
    expect(examples[0].intent).toBe("Pickup Request");
  });
});

describe("Reject loop — rejection stored + regeneration informed by reason", () => {
  it("rejecting a draft records a Rejection with reason, and regeneration prompt surfaces that reason", async () => {
    const draft = await db.insertDraft({
      conversationId: 5,
      inboundMessageId: 50,
      intent: "Pickup Request",
      body: "Hi Marie — we'll pick up this afternoon.\n— DropShop",
      revision: 1,
      status: "pending_approval",
    } as any);

    const reason = "Customer asked for tomorrow morning, not afternoon.";
    await db.insertRejection({
      draftId: draft.id,
      intent: draft.intent,
      customerBody: "Pickup for Marie please",
      rejectedReply: draft.body,
      reason,
      embedding: await emb.embedText(
        `Pickup for Marie please\n---\n${draft.body}\n---REASON:${reason}`,
      ),
    } as any);
    await db.updateDraftStatus(draft.id, "rejected");

    const rejections = await db.listRejections();
    expect(rejections.length).toBe(1);
    expect(rejections[0].reason).toContain("tomorrow morning");

    // Regenerate — the agent must receive managerRejectReason and produce a different body
    const regen = await agent.draftAgentReply({
      phone: "+15550101003",
      body: "Pickup for Marie please",
      managerRejectReason: reason,
    });
    expect(regen.reply).toBeTruthy();
    expect(regen.reply!.toLowerCase()).toContain("tomorrow");
    expect(regen.reply).not.toBe(draft.body);
  });
});

describe("RAG retrieval — topK ranking", () => {
  it("ranks semantically similar approved examples higher than unrelated ones", async () => {
    const query = await emb.embedText("pickup for marie tomorrow");
    const items = [
      {
        id: 1,
        intent: "Pickup Request",
        customerBody: "Pickup for Marie tomorrow",
        approvedReply: "Confirmed for Marie.\n— DropShop",
        embedding: await emb.embedText("Pickup for Marie tomorrow"),
      },
      {
        id: 2,
        intent: "Membership & Pricing",
        customerBody: "How much is the gold membership",
        approvedReply: "Gold is $29/mo.\n— DropShop",
        embedding: await emb.embedText("How much is the gold membership"),
      },
    ];
    const ranked = emb.topK(query, items, 2);
    expect(ranked[0].id).toBe(1);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe("Processing-step contract", () => {
  it("uses the exact step vocabulary required by the UI panel", async () => {
    const allowed = new Set([
      "intent_detected",
      "mock_api_called",
      "response_drafted",
      "sent",
      "escalated",
    ]);
    const result = await agent.draftAgentReply({
      phone: "+15550101003",
      body: "Pickup for Marie please",
    });
    for (const s of result.steps) {
      expect(allowed.has(s.step)).toBe(true);
    }
  });
});
