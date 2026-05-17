/**
 * dailyBriefing.test.ts — pure unit tests for buildBriefingPrompt
 * + extractTextContent + runDailyBriefing's flow, using DI to skip DB.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildBriefingPrompt,
  extractTextContent,
  runDailyBriefing,
} from "./dailyBriefing";
import type { DailyMetrics } from "../analytics/dailyMetrics";
import type { InvokeResult } from "../_core/llm";

vi.mock("../db", () => ({
  getDb: vi.fn(async () => null),
}));

function metricsFixture(overrides: Partial<DailyMetrics> = {}): DailyMetrics {
  return {
    briefingDate: "2026-05-15",
    periodStartMs: 1747900800000,
    periodEndMs: 1747987200000,
    orderCount: 12,
    revenueCents: 24500,
    avgOrderCents: 2042,
    paidCount: 10,
    uniqueCustomerCount: 9,
    newCustomerCount: 3,
    returningCustomerCount: 6,
    expressCount: 2,
    pickupTomorrowCount: 5,
    revenueDeltaPct: 12.5,
    orderCountDeltaPct: 9.1,
    largestOrderCents: 8500,
    topSpenders: [
      { externalId: "cust-aaa-bbb", revenueCents: 8500, orderCount: 1 },
    ],
    ...overrides,
  };
}

function llmResult(
  text: string,
  opts?: { model?: string; tokens?: [number, number] },
): InvokeResult {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
    model: opts?.model ?? "gpt-test",
    usage: opts?.tokens
      ? {
          prompt_tokens: opts.tokens[0],
          completion_tokens: opts.tokens[1],
          total_tokens: opts.tokens[0] + opts.tokens[1],
        }
      : undefined,
  } as unknown as InvokeResult;
}

describe("buildBriefingPrompt", () => {
  it("includes briefing date and order count in the user message", () => {
    const messages = buildBriefingPrompt(metricsFixture());
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    const userContent = messages[1].content as string;
    expect(userContent).toContain("2026-05-15");
    expect(userContent).toContain("12건");
    expect(userContent).toContain("$245.00");
  });

  it("formats positive delta with leading +", () => {
    const messages = buildBriefingPrompt(
      metricsFixture({ revenueDeltaPct: 12.5 }),
    );
    expect(messages[1].content).toContain("+12.5%");
  });

  it("preserves negative delta sign", () => {
    const messages = buildBriefingPrompt(
      metricsFixture({ revenueDeltaPct: -7.3 }),
    );
    expect(messages[1].content).toContain("-7.3%");
  });

  it("emits 비교 불가 when prev day data missing", () => {
    const messages = buildBriefingPrompt(
      metricsFixture({ revenueDeltaPct: null, orderCountDeltaPct: null }),
    );
    expect(messages[1].content).toContain("비교 불가");
  });

  it("includes top-spender summary line when data present", () => {
    const messages = buildBriefingPrompt(metricsFixture());
    expect(messages[1].content).toContain("cust-aaa");
  });

  it("falls back to placeholder when no top spenders", () => {
    const messages = buildBriefingPrompt(metricsFixture({ topSpenders: [] }));
    expect(messages[1].content).toContain("상위 고객 데이터 없음");
  });
});

describe("extractTextContent", () => {
  it("extracts plain string content", () => {
    expect(extractTextContent(llmResult("  hello  "))).toBe("hello");
  });

  it("returns '' on empty choices", () => {
    expect(
      extractTextContent({ choices: [] } as unknown as InvokeResult),
    ).toBe("");
  });

  it("extracts text parts from array content", () => {
    const arr = {
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "first" },
              { type: "image_url", image_url: { url: "x" } },
              { type: "text", text: "second" },
            ],
          },
        },
      ],
    } as unknown as InvokeResult;
    expect(extractTextContent(arr)).toBe("first\nsecond");
  });
});

describe("runDailyBriefing (DB-skipping path)", () => {
  it("returns LLM-generated summary on success", async () => {
    const loadMetrics = vi.fn().mockResolvedValue(metricsFixture());
    const invokeLLMFn = vi
      .fn()
      .mockResolvedValue(
        llmResult("# 어제 요약\n매출 $245", { tokens: [120, 80] }),
      );

    const result = await runDailyBriefing({
      briefingDate: "2026-05-15",
      loadMetrics,
      invokeLLMFn,
    });

    expect(loadMetrics).toHaveBeenCalledWith({
      briefingDate: "2026-05-15",
      source: "cleancloud",
    });
    expect(invokeLLMFn).toHaveBeenCalledOnce();
    expect(result.summaryMarkdown).toContain("매출 $245");
    expect(result.llmModel).toBe("gpt-test");
    expect(result.promptTokens).toBe(120);
    expect(result.completionTokens).toBe(80);
    expect(result.errorMessage).toBeNull();
  });

  it("falls back to placeholder + records errorMessage when LLM throws", async () => {
    const loadMetrics = vi.fn().mockResolvedValue(metricsFixture());
    const invokeLLMFn = vi.fn().mockRejectedValue(new Error("model down"));

    const result = await runDailyBriefing({
      briefingDate: "2026-05-15",
      loadMetrics,
      invokeLLMFn,
    });

    expect(result.summaryMarkdown).toContain("브리핑 생성 실패");
    expect(result.errorMessage).toContain("model down");
    expect(result.llmModel).toBeNull();
  });

  it("falls back when LLM returns empty content", async () => {
    const loadMetrics = vi.fn().mockResolvedValue(metricsFixture());
    const invokeLLMFn = vi.fn().mockResolvedValue(llmResult(""));

    const result = await runDailyBriefing({
      briefingDate: "2026-05-15",
      loadMetrics,
      invokeLLMFn,
    });
    expect(result.summaryMarkdown).toContain("브리핑 생성 실패");
  });

  it("propagates loadMetrics errors (no DB write attempted)", async () => {
    const loadMetrics = vi.fn().mockRejectedValue(new Error("query timeout"));
    const invokeLLMFn = vi.fn();

    await expect(
      runDailyBriefing({
        briefingDate: "2026-05-15",
        loadMetrics,
        invokeLLMFn,
      }),
    ).rejects.toThrow("query timeout");
    expect(invokeLLMFn).not.toHaveBeenCalled();
  });

  it("respects explicit source override (dropshop_pos)", async () => {
    const loadMetrics = vi.fn().mockResolvedValue(metricsFixture());
    const invokeLLMFn = vi.fn().mockResolvedValue(llmResult("ok"));

    await runDailyBriefing({
      briefingDate: "2026-05-15",
      source: "dropshop_pos",
      loadMetrics,
      invokeLLMFn,
    });

    expect(loadMetrics).toHaveBeenCalledWith({
      briefingDate: "2026-05-15",
      source: "dropshop_pos",
    });
  });

  it("truncates long error messages to 480 chars", async () => {
    const loadMetrics = vi.fn().mockResolvedValue(metricsFixture());
    const longMsg = "x".repeat(1000);
    const invokeLLMFn = vi.fn().mockRejectedValue(new Error(longMsg));

    const result = await runDailyBriefing({
      briefingDate: "2026-05-15",
      loadMetrics,
      invokeLLMFn,
    });
    expect(result.errorMessage?.length).toBeLessThanOrEqual(480);
  });
});
