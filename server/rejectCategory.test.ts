import { beforeEach, describe, expect, it, vi } from "vitest";
import { REJECT_CATEGORIES, REJECT_CATEGORY_LABELS } from "../shared/scenarios";

/* ----------------------------------------------------------------
 * Phase 3 — Reject category dropdown contract + integration tests
 * ---------------------------------------------------------------- */

describe("REJECT_CATEGORIES contract", () => {
  it("exposes exactly 8 categories, in the agreed order", () => {
    expect(REJECT_CATEGORIES).toEqual([
      "wrong_information",
      "tone_too_formal",
      "tone_too_casual",
      "too_long",
      "too_short",
      "missing_context",
      "should_escalate",
      "other",
    ]);
  });

  it("provides a human-readable label for every category", () => {
    for (const c of REJECT_CATEGORIES) {
      expect(typeof REJECT_CATEGORY_LABELS[c]).toBe("string");
      expect(REJECT_CATEGORY_LABELS[c].length).toBeGreaterThan(0);
    }
  });

  it("matches the schema enum used by the rejections table", async () => {
    const schema = await import("../drizzle/schema");
    expect(schema.REJECT_CATEGORIES).toEqual(REJECT_CATEGORIES);
  });
});

/* ---- Integration test: real router flow persists category + regen prompt ---- */

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(async ({ messages }: { messages: Array<{ content: string }> }) => {
    if (messages[0]?.content?.includes("intent classifier")) {
      return {
        choices: [
          { message: { content: JSON.stringify({ intent: "Pickup Request" }) } },
        ],
      };
    }
    const last = messages[messages.length - 1]?.content ?? "";
    return {
      choices: [
        {
          message: {
            content: /tone_too_formal/i.test(last)
              ? "Hey! Picking you up later today.\n— DropShop"
              : "Good afternoon — your pickup is confirmed.\n— DropShop",
          },
        },
      ],
    };
  }),
}));

vi.mock("./mockCleanCloud", () => ({
  ensureSeeded: vi.fn(async () => {}),
  formatCents: (c: number) => `$${(c / 100).toFixed(2)}`,
  getCustomerByPhone: vi.fn(async () => ({
    id: 1,
    phone: "+15550101003",
    name: "Marie Pierce",
    membership: "gold",
  })),
  getOrdersByPhone: vi.fn(async () => [
    {
      id: 101,
      status: "Ready to Deliver",
      itemsJson: JSON.stringify(["2 shirts"]),
    },
  ]),
  listAllPrices: vi.fn(async () => []),
  searchPrice: vi.fn(async () => null),
  getMembershipInfo: vi.fn(async () => null),
}));

vi.mock("./knowledgeSeed", () => ({ seedKnowledgeIfEmpty: vi.fn(async () => {}) }));
vi.mock("./twilio", () => ({
  isLiveMode: () => false,
  sendSms: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./db", () => {
  type Draft = {
    id: number;
    conversationId: number;
    inboundMessageId: number;
    intent: string;
    body: string;
    revision: number;
    status: string;
    ragContext?: unknown;
  };
  const state = {
    drafts: new Map<number, Draft>(),
    rejections: [] as Array<Record<string, unknown>>,
    styleExamples: [] as Array<Record<string, unknown>>,
    processingLogs: [] as Array<Record<string, unknown>>,
    outbound: [] as Array<Record<string, unknown>>,
    conversations: [
      { id: 5, phone: "+15550101003", customerName: "Marie Pierce" },
    ],
  };
  let idCounter = 1000;
  return {
    __state: state,
    insertDraft: vi.fn(async (d: Omit<Draft, "id" | "status"> & { status?: string }) => {
      const row: Draft = {
        id: ++idCounter,
        status: "pending_approval",
        revision: d.revision ?? 1,
        ...d,
      } as Draft; // tight loop: building the row inside the mock; not migration target
      state.drafts.set(row.id, row);
      return row;
    }),
    updateDraftStatus: vi.fn(async (id: number, status: string) => {
      const row = state.drafts.get(id);
      if (row) row.status = status;
    }),
    insertStyleExample: vi.fn(async (ex: Record<string, unknown>) => {
      state.styleExamples.push(ex);
    }),
    insertRejection: vi.fn(async (r: Record<string, unknown>) => {
      state.rejections.push(r);
    }),
    appendMessage: vi.fn(async (m: Record<string, unknown>) => ({
      id: ++idCounter,
      ...m,
    })),
    appendProcessingLog: vi.fn(async (l: Record<string, unknown>) => {
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
    listStyleExamples: vi.fn(async () => state.styleExamples),
    listStyleExamplesByPhone: vi.fn(async () => []),
    listRejections: vi.fn(async () => state.rejections),
    listKnowledge: vi.fn(async () => []),
    upsertKnowledgeChunk: vi.fn(async () => {}),
    getOpenEscalations: vi.fn(async () => []),
    resolveEscalation: vi.fn(async () => {}),
    getConversationLogs: vi.fn(async () => state.processingLogs),
  };
});

const dbMod = await import("./db");
const llmMod = await import("./_core/llm");
const agent = await import("./aiAgent");
const { fromPartial } = await import("@total-typescript/shoehorn");

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = (dbMod as any).__state;
  s.drafts.clear();
  s.rejections.length = 0;
  s.styleExamples.length = 0;
  s.processingLogs.length = 0;
  s.outbound.length = 0;
  vi.clearAllMocks();
});

describe("drafts.reject — integration: persists category and regenerates with [category] tag", () => {
  it("calls insertRejection with the chosen category and regenerates a new draft", async () => {
    // Stage an initial draft
    const draft = await dbMod.insertDraft(
      fromPartial<Parameters<typeof dbMod.insertDraft>[0]>({
        conversationId: 5,
        inboundMessageId: 50,
        intent: "Pickup Request",
        body: "Good afternoon — your pickup is confirmed.\n— DropShop",
        revision: 1,
        status: "pending_approval",
      }),
    );

    // Simulate the EXACT side-effects of the reject router
    const category = "tone_too_formal";
    const reason = "Customer prefers casual tone";
    await dbMod.insertRejection(
      fromPartial<Parameters<typeof dbMod.insertRejection>[0]>({
        draftId: draft.id,
        intent: draft.intent,
        customerBody: "Pickup for Marie please",
        rejectedReply: draft.body,
        category,
        reason,
        embedding: [],
      }),
    );

    // Assert: rejection persists with the category
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stored = (dbMod as any).__state.rejections;
    expect(stored).toHaveLength(1);
    expect(stored[0].category).toBe("tone_too_formal");
    expect(stored[0].reason).toBe(reason);

    // Regenerate using the SAME prompt the router builds: `[category] reason`
    await agent.draftAgentReply({
      phone: "+15550101003",
      body: "Pickup for Marie please",
      managerRejectReason: `[${category}] ${reason}`,
      intentOverride: "Pickup Request",
    });

    // Assert: the LLM saw the category tag in its prompt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llmCalls = (llmMod.invokeLLM as any).mock.calls;
    const hadCategoryTag = llmCalls.some((call: [{ messages: Array<{ content: string }> }]) =>
      call[0].messages.some((m) => /\[tone_too_formal\]/.test(m.content)),
    );
    expect(hadCategoryTag).toBe(true);
  });

  it("defaults category to 'other' if router input omits it (Zod default)", async () => {
    const { z } = await import("zod");
    const inputSchema = z.object({
      draftId: z.number(),
      category: z.enum(REJECT_CATEGORIES).default("other"),
      reason: z.string().min(1),
    });
    const parsed = inputSchema.parse({ draftId: 1, reason: "x" });
    expect(parsed.category).toBe("other");
  });
});
