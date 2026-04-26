import { afterEach, describe, expect, it, vi } from "vitest";

// Mock LLM BEFORE importing the agent so it uses the stub.
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(),
}));

import { invokeLLM } from "./_core/llm";
import { classifySalonIntent, SALON_INTENT_LABELS } from "./salonIntents";
import {
  draftSalonReply,
  guessServiceCategory,
} from "./salonAgent";

const mockedInvokeLLM = invokeLLM as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
});

function intentJson(intent: string) {
  return {
    choices: [
      { message: { content: JSON.stringify({ intent }) } },
    ],
  };
}

function plainText(text: string) {
  return {
    choices: [{ message: { content: text } }],
  };
}

/* ====== classifier ====== */

describe("classifySalonIntent", () => {
  it("returns the parsed intent when the model returns valid JSON", async () => {
    mockedInvokeLLM.mockResolvedValueOnce(intentJson("Booking Request"));
    expect(await classifySalonIntent("can i book a cut tmrw")).toBe(
      "Booking Request",
    );
  });

  it("fails safe to Critical Escalation on invalid JSON", async () => {
    mockedInvokeLLM.mockResolvedValueOnce({
      choices: [{ message: { content: "not json" } }],
    });
    expect(await classifySalonIntent("anything")).toBe("Critical Escalation");
  });

  it("fails safe to Critical Escalation on unknown label", async () => {
    mockedInvokeLLM.mockResolvedValueOnce(intentJson("MakeMeCoffee"));
    expect(await classifySalonIntent("anything")).toBe("Critical Escalation");
  });

  it("fails safe when the LLM throws", async () => {
    mockedInvokeLLM.mockRejectedValueOnce(new Error("upstream down"));
    await expect(classifySalonIntent("anything")).rejects.toThrow();
    // (Throwing is a separate path from "parse failure"; the wrapping
    // procedure handles it. The contract here documents that the
    // classifier itself does NOT swallow infra errors.)
  });

  it("exports exactly the seven required labels", () => {
    expect(SALON_INTENT_LABELS).toEqual([
      "Booking Request",
      "Availability Check",
      "Reschedule",
      "Cancel",
      "Service Question",
      "Pricing",
      "Critical Escalation",
    ]);
  });
});

/* ====== service guesser ====== */

describe("guessServiceCategory", () => {
  it("matches obvious keywords", () => {
    expect(guessServiceCategory("can I book a cut")).toBe("cut");
    expect(guessServiceCategory("perm tomorrow?")).toBe("perm");
    expect(guessServiceCategory("balayage with Jisoo please")).toBe("balayage");
    expect(guessServiceCategory("nails before the wedding")).toBe("manicure");
  });

  it("returns null when nothing matches", () => {
    expect(guessServiceCategory("are you guys open Sunday?")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(guessServiceCategory("Need a PERM")).toBe("perm");
  });
});

/* ====== draft generation ====== */

describe("draftSalonReply", () => {
  it("escalates without drafting on Critical Escalation", async () => {
    mockedInvokeLLM.mockResolvedValueOnce(intentJson("Critical Escalation"));
    const r = await draftSalonReply({
      phone: "+15550999999",
      body: "my scalp is burning",
    });
    expect(r.escalated).toBe(true);
    expect(r.reply).toBeNull();
    expect(r.intent).toBe("Critical Escalation");
    expect(r.steps.find((s) => s.step === "escalated")).toBeTruthy();
    // No reply LLM call was made — only classifier.
    expect(mockedInvokeLLM).toHaveBeenCalledTimes(1);
  });

  it("calls findOverlapSlots on Booking Request and surfaces results", async () => {
    mockedInvokeLLM
      .mockResolvedValueOnce(intentJson("Booking Request"))
      .mockResolvedValueOnce(plainText("Hi Jessica, I have a 2:30 PM Wed cut with Hayley.\n— the salon"));
    const r = await draftSalonReply({
      phone: "+15550201001", // Jessica
      body: "any opening for a cut this week?",
    });
    expect(r.intent).toBe("Booking Request");
    expect(r.escalated).toBe(false);
    expect(r.overlapSlots.length).toBeGreaterThan(0);
    // overlap_search step recorded
    expect(r.steps.find((s) => s.step === "overlap_search")).toBeTruthy();
    // tool context populated with stylists + services + customer
    expect(r.toolContext.stylists).toBeTruthy();
    expect(r.toolContext.serviceCatalog).toBeTruthy();
    expect((r.toolContext.customer as { name: string }).name).toBe("Jessica Kim");
  });

  it("skips overlap search when the message has no service keyword (Availability Check)", async () => {
    mockedInvokeLLM
      .mockResolvedValueOnce(intentJson("Availability Check"))
      .mockResolvedValueOnce(plainText("Yes, we're open Sunday 10–8.\n— the salon"));
    const r = await draftSalonReply({
      phone: "+15559990000",
      body: "are you open sunday?",
    });
    expect(r.overlapSlots).toEqual([]);
    const step = r.steps.find((s) => s.step === "overlap_search");
    expect(step?.label).toMatch(/skipped/);
  });

  it("dispatches existing-appointments lookup on Reschedule", async () => {
    mockedInvokeLLM
      .mockResolvedValueOnce(intentJson("Reschedule"))
      .mockResolvedValueOnce(plainText("Sure, let's move it.\n— the salon"));
    const r = await draftSalonReply({
      phone: "+15550201001", // Jessica → has 1 perm appt
      body: "can we move my perm to next week",
    });
    expect(r.intent).toBe("Reschedule");
    const existing = r.toolContext.existingAppointments as Array<unknown>;
    expect(existing).toBeTruthy();
    expect(existing.length).toBe(1);
  });

  it("dispatches existing-appointments lookup on Cancel even for unknown phone (returns empty list)", async () => {
    mockedInvokeLLM
      .mockResolvedValueOnce(intentJson("Cancel"))
      .mockResolvedValueOnce(plainText("Cancelled.\n— the salon"));
    const r = await draftSalonReply({
      phone: "+15558887777",
      body: "cancel my balayage",
    });
    expect(r.intent).toBe("Cancel");
    const existing = r.toolContext.existingAppointments as Array<unknown>;
    expect(existing).toEqual([]);
    // customer marked not found
    expect((r.toolContext.customer as { found?: boolean }).found).toBe(false);
  });

  it("respects intentOverride and does not re-classify", async () => {
    mockedInvokeLLM.mockResolvedValueOnce(plainText("$40 to $80, depending on length.\n— the salon"));
    const r = await draftSalonReply({
      phone: "+15550201001",
      body: "how much for a cut",
      intentOverride: "Pricing",
    });
    expect(r.intent).toBe("Pricing");
    // Only one LLM call — the reply (no classifier).
    expect(mockedInvokeLLM).toHaveBeenCalledTimes(1);
  });

  it("forwards managerRejectReason into the reply prompt", async () => {
    mockedInvokeLLM
      .mockResolvedValueOnce(intentJson("Pricing"))
      .mockResolvedValueOnce(plainText("Updated reply.\n— the salon"));
    await draftSalonReply({
      phone: "+15550201001",
      body: "how much",
      managerRejectReason: "Too pushy, soften the tone",
    });
    const calls = mockedInvokeLLM.mock.calls;
    const replyCall = calls[calls.length - 1][0];
    const userMsg = replyCall.messages[replyCall.messages.length - 1].content;
    expect(userMsg).toContain("Too pushy, soften the tone");
  });

  it("falls back to a generic apology when the LLM returns non-string content", async () => {
    mockedInvokeLLM
      .mockResolvedValueOnce(intentJson("Service Question"))
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    const r = await draftSalonReply({
      phone: "+15550201001",
      body: "do you do keratin",
    });
    expect(r.reply).toMatch(/Thanks for reaching the salon/);
  });
});
