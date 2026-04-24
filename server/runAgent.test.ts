import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock LLM module BEFORE importing runAgent so the agent uses the stub.
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(),
}));
// Mock DB-backed mock POS helpers so we can run without MySQL.
vi.mock("./mockCleanCloud", async () => {
  const real = await vi.importActual<typeof import("./mockCleanCloud")>("./mockCleanCloud");
  return {
    ...real,
    ensureSeeded: vi.fn(async () => {}),
    getCustomerByPhone: vi.fn(async (phone: string) => {
      if (phone === "+15550101003") {
        return {
          id: 3,
          phone,
          name: "Peter Demarco",
          membership: "none" as const,
          address: "118 E 60th St, New York, NY",
          notes: null,
          createdAt: new Date(),
        };
      }
      return null;
    }),
    getOrdersByPhone: vi.fn(async () => [
      {
        id: 1,
        orderNumber: "DS-10233",
        customerPhone: "+15550101003",
        status: "Awaiting Pickup" as const,
        itemsSummary: "Repeat pickup",
        totalCents: 0,
        etaText: "Pickup scheduled today between 2–4 PM",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]),
    searchPrice: vi.fn(async () => []),
    listAllPrices: vi.fn(async () => []),
  };
});

import { invokeLLM } from "./_core/llm";
import { INTENT_LABELS, runAgent } from "./aiAgent";

const mockedInvokeLLM = invokeLLM as unknown as ReturnType<typeof vi.fn>;

function llmIntentResponse(intent: string) {
  return {
    choices: [
      { message: { content: JSON.stringify({ intent }) } },
    ],
  };
}

function llmReplyResponse(text: string) {
  return {
    choices: [
      { message: { content: text } },
    ],
  };
}

describe("runAgent — Critical Handoff & intent contract", () => {
  beforeEach(() => {
    mockedInvokeLLM.mockReset();
  });

  it("never auto-replies on Critical Escalation and creates an escalation step", async () => {
    mockedInvokeLLM.mockResolvedValueOnce(llmIntentResponse("Critical Escalation"));

    const result = await runAgent({
      phone: "+15553240000",
      body: "Apt 14D garment bag was taken from the lobby. CCTV stills incoming.",
    });

    expect(result.intent).toBe("Critical Escalation");
    expect(result.escalated).toBe(true);
    expect(result.reply).toBeNull();
    expect(result.steps.some((s) => s.step === "escalated")).toBe(true);
    // Should not call LLM a second time for a reply
    expect(mockedInvokeLLM).toHaveBeenCalledTimes(1);
  });

  it("returns a non-empty reply for a Pickup Request and surfaces customer + orders in tool context", async () => {
    mockedInvokeLLM
      .mockResolvedValueOnce(llmIntentResponse("Pickup Request"))
      .mockResolvedValueOnce(llmReplyResponse("Got it Peter — we'll be there 2–4 PM.\n— DropShop"));

    const result = await runAgent({
      phone: "+15550101003",
      body: "Pick up for Peter today please.",
    });

    expect(result.intent).toBe("Pickup Request");
    expect(result.escalated).toBe(false);
    expect(result.reply).toContain("DropShop");
    expect(result.toolContext.customer).toMatchObject({ name: "Peter Demarco" });
    expect(Array.isArray(result.toolContext.orders)).toBe(true);
    // Steps must include intent_detected, mock_api_called, response_drafted
    const stepKinds = new Set(result.steps.map((s) => s.step));
    expect(stepKinds.has("intent_detected")).toBe(true);
    expect(stepKinds.has("mock_api_called")).toBe(true);
    expect(stepKinds.has("response_drafted")).toBe(true);
  });

  it("classifier output is always coerced to one of the 5 exact intent labels (fallback safe)", async () => {
    // Simulate a malformed LLM response
    mockedInvokeLLM
      .mockResolvedValueOnce({ choices: [{ message: { content: "garbage not json" } }] })
      .mockResolvedValueOnce(llmReplyResponse("Member rates start at $5.95 / shirt.\n— DropShop"));

    const result = await runAgent({ phone: "+15550101003", body: "What's your member rate?" });
    expect(INTENT_LABELS).toContain(result.intent);
  });
});
