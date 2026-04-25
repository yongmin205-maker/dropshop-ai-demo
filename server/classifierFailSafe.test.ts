import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The classifier MUST default to "Critical Escalation" (fail-safe), NOT to
 * "Membership & Pricing" (fail-open), when the LLM returns content we cannot
 * parse. This test pins that behavior so a future refactor cannot silently
 * regress to the old default.
 */

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(),
}));

import { invokeLLM } from "./_core/llm";
import { classifyIntent } from "./aiAgent";

const mockedInvokeLLM = invokeLLM as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
});

describe("aiAgent.classifyIntent fail-safe", () => {
  it("returns the parsed intent when the model returns valid JSON", async () => {
    mockedInvokeLLM.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ intent: "Pickup Request" }) } }],
    });
    const out = await classifyIntent("pickup for marie");
    expect(out).toBe("Pickup Request");
  });

  it("falls back to Critical Escalation when the model returns malformed JSON", async () => {
    mockedInvokeLLM.mockResolvedValueOnce({
      choices: [{ message: { content: "not json at all" } }],
    });
    const out = await classifyIntent("someone took my coat");
    expect(out).toBe("Critical Escalation");
  });

  it("falls back to Critical Escalation when the JSON has the wrong shape", async () => {
    mockedInvokeLLM.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ category: "pricing" }) } }],
    });
    expect(await classifyIntent("how much for a shirt")).toBe("Critical Escalation");
  });

  it("falls back to Critical Escalation when the JSON enum value is unknown", async () => {
    mockedInvokeLLM.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ intent: "Refund Request" }) } }],
    });
    expect(await classifyIntent("i want my money back")).toBe("Critical Escalation");
  });

  it("falls back to Critical Escalation when content is missing entirely", async () => {
    mockedInvokeLLM.mockResolvedValueOnce({ choices: [{ message: {} }] });
    expect(await classifyIntent("hi")).toBe("Critical Escalation");
  });
});
