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
    topSpenderProfiles: [
      {
        externalId: "cust-aaa-bbb",
        revenueCents: 8500,
        orderCount: 1,
        lifetimeOrderCount: 14,
        lifetimeRevenueCents: 120000,
        firstOrderAt: "2025-09-01T12:00:00.000Z",
        lastOrderAt: "2026-05-14T18:00:00.000Z",
        isReturning: true,
        name: "Daniela Sassoun",
        phoneE164: "+19176897672",
      },
    ],
    serviceMix: [
      { category: "Shirts", quantity: 18, revenueCents: 9000 },
      { category: "Drycleaning", quantity: 6, revenueCents: 7800 },
      { category: "Wash & Fold", quantity: 4, revenueCents: 4400 },
    ],
    hourlyDistribution: [
      { hour: 9, orderCount: 2, revenueCents: 4000 },
      { hour: 10, orderCount: 5, revenueCents: 11000 },
      { hour: 17, orderCount: 5, revenueCents: 9500 },
    ],
    peakHour: 10,
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

  it("includes top-spender summary line with display name (never externalId)", () => {
    const messages = buildBriefingPrompt(metricsFixture());
    const userContent = messages[1].content as string;
    expect(userContent).toContain("Daniela Sassoun");
    // Should NOT leak the raw externalId into the prompt anymore.
    expect(userContent).not.toContain("cust-aaa");
  });

  it("falls back to masked phone tail when name is missing", () => {
    const userContent = buildBriefingPrompt(
      metricsFixture({
        topSpenderProfiles: [
          {
            externalId: "cust-no-name",
            revenueCents: 5000,
            orderCount: 1,
            lifetimeOrderCount: 4,
            lifetimeRevenueCents: 22000,
            firstOrderAt: "2025-12-01T12:00:00.000Z",
            lastOrderAt: "2026-05-15T10:00:00.000Z",
            isReturning: true,
            name: null,
            phoneE164: "+19175551234",
          },
        ],
      }),
    )[1].content as string;
    expect(userContent).toContain("…·1234".replace("·", "")); // "…1234"
    expect(userContent).not.toContain("cust-no-name");
  });

  it("falls back to '단골 손님' / '첫 방문 손님' when both name and phone are missing", () => {
    const userContent = buildBriefingPrompt(
      metricsFixture({
        topSpenderProfiles: [
          {
            externalId: "cust-anon-1",
            revenueCents: 5000,
            orderCount: 1,
            lifetimeOrderCount: 7,
            lifetimeRevenueCents: 30000,
            firstOrderAt: "2025-09-01T12:00:00.000Z",
            lastOrderAt: "2026-05-15T10:00:00.000Z",
            isReturning: true,
            name: null,
            phoneE164: null,
          },
          {
            externalId: "cust-anon-2",
            revenueCents: 4000,
            orderCount: 1,
            lifetimeOrderCount: 1,
            lifetimeRevenueCents: 4000,
            firstOrderAt: "2026-05-15T10:00:00.000Z",
            lastOrderAt: "2026-05-15T10:00:00.000Z",
            isReturning: false,
            name: null,
            phoneE164: null,
          },
        ],
      }),
    )[1].content as string;
    expect(userContent).toContain("단골 손님");
    expect(userContent).toContain("첫 방문 손님");
    expect(userContent).not.toContain("cust-anon");
  });

  it("falls back to placeholder when no top spenders", () => {
    const messages = buildBriefingPrompt(
      metricsFixture({ topSpenders: [], topSpenderProfiles: [] }),
    );
    expect(messages[1].content).toContain("상위 고객: 데이터 없음");
  });

  it("surfaces service mix with quantity and dollars", () => {
    const userContent = buildBriefingPrompt(metricsFixture())[1].content as string;
    expect(userContent).toContain("서비스 믹스 (상위 3)");
    expect(userContent).toContain("Shirts 18점/$90.00");
    expect(userContent).toContain("Drycleaning");
    expect(userContent).toContain("Wash & Fold");
  });

  it("emits empty-state mix line when no line items parsed", () => {
    const userContent = buildBriefingPrompt(metricsFixture({ serviceMix: [] }))[1]
      .content as string;
    expect(userContent).toContain("line item 데이터 없음");
  });

  it("reports peak hour in Korean morning/afternoon format", () => {
    const userContent = buildBriefingPrompt(metricsFixture())[1].content as string;
    expect(userContent).toContain("피크 시간: 오전 10시 (5건)");
  });

  it("reports peak-hour empty state when no orders", () => {
    const userContent = buildBriefingPrompt(
      metricsFixture({ peakHour: null, hourlyDistribution: [], orderCount: 0 }),
    )[1].content as string;
    expect(userContent).toContain("피크 시간: 주문 없음");
  });

  it("tags lifetime info on returning top spenders", () => {
    const userContent = buildBriefingPrompt(metricsFixture())[1].content as string;
    // "단골 (전체 14건/$1200.00)"
    expect(userContent).toContain("단골 (전체 14건/$1200.00)");
  });

  it("tags new customers as 신규 on top spenders (using their name)", () => {
    const userContent = buildBriefingPrompt(
      metricsFixture({
        topSpenderProfiles: [
          {
            externalId: "cust-new-001",
            revenueCents: 5000,
            orderCount: 1,
            lifetimeOrderCount: 1,
            lifetimeRevenueCents: 5000,
            firstOrderAt: "2026-05-15T10:00:00.000Z",
            lastOrderAt: "2026-05-15T10:00:00.000Z",
            isReturning: false,
            name: "Alice Newcomer",
            phoneE164: "+15555550100",
          },
        ],
      }),
    )[1].content as string;
    expect(userContent).toMatch(/Alice Newcomer.*· 신규/);
    expect(userContent).not.toContain("cust-new");
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


describe("runDailyBriefing — Monday weekly rollup", () => {
  const weeklyFixture = () => ({
    weekEndDate: "2026-05-18",
    weekStartDate: "2026-05-11",
    windowStartMs: 0,
    windowEndMs: 1,
    orderCount: 42,
    revenueCents: 250000,
    uniqueCustomerCount: 30,
    avgOrderCents: 5952,
    largestOrderCents: 18000,
    byDayOfWeek: [
      { dow: 0, name: "월", orderCount: 5, revenueCents: 30000 },
      { dow: 1, name: "화", orderCount: 6, revenueCents: 35000 },
      { dow: 2, name: "수", orderCount: 7, revenueCents: 40000 },
      { dow: 3, name: "목", orderCount: 8, revenueCents: 45000 },
      { dow: 4, name: "금", orderCount: 9, revenueCents: 50000 },
      { dow: 5, name: "토", orderCount: 4, revenueCents: 30000 },
      { dow: 6, name: "일", orderCount: 3, revenueCents: 20000 },
    ],
    vs4WeeksAgo: {
      revenueDeltaPct: 12.5,
      orderCountDeltaPct: 5,
      priorRevenueCents: 222222,
      priorOrderCount: 40,
    },
  });

  it("loads weeklyRollup on Mondays and embeds 지난주 돌아보기 facts in prompt", async () => {
    const loadMetrics = vi.fn().mockResolvedValue(
      metricsFixture({ briefingDate: "2026-05-18" }),
    );
    let capturedUserContent = "";
    const invokeLLMFn = vi.fn().mockImplementation(async (msgs) => {
      capturedUserContent = String(msgs[1].content);
      return llmResult("월요일 요약");
    });
    const loadWeeklyRollup = vi.fn().mockResolvedValue(weeklyFixture());

    const result = await runDailyBriefing({
      briefingDate: "2026-05-18",
      loadMetrics,
      invokeLLMFn,
      loadWeather: async () => null,
      loadWeeklyRollup,
    });

    expect(loadWeeklyRollup).toHaveBeenCalledOnce();
    expect(result.weeklyRollup).not.toBeNull();
    expect(result.weeklyRollup?.orderCount).toBe(42);
    expect(capturedUserContent).toContain("지난주 돌아보기");
    expect(capturedUserContent).toContain("4주 전 같은 기간 대비 매출");
    expect(capturedUserContent).toContain("+12.5%");
    expect(capturedUserContent).toContain("월=5건");
  });

  it("does NOT load weeklyRollup on a non-Monday (Tuesday)", async () => {
    const loadMetrics = vi.fn().mockResolvedValue(
      metricsFixture({ briefingDate: "2026-05-19" }),
    );
    const invokeLLMFn = vi.fn().mockResolvedValue(llmResult("ok"));
    const loadWeeklyRollup = vi.fn();

    const result = await runDailyBriefing({
      briefingDate: "2026-05-19",
      loadMetrics,
      invokeLLMFn,
      loadWeather: async () => null,
      loadWeeklyRollup,
    });

    expect(loadWeeklyRollup).not.toHaveBeenCalled();
    expect(result.weeklyRollup).toBeNull();
  });

  it("respects loadWeeklyRollup: null escape hatch even on Monday", async () => {
    const loadMetrics = vi.fn().mockResolvedValue(
      metricsFixture({ briefingDate: "2026-05-18" }),
    );
    const invokeLLMFn = vi.fn().mockResolvedValue(llmResult("ok"));

    const result = await runDailyBriefing({
      briefingDate: "2026-05-18",
      loadMetrics,
      invokeLLMFn,
      loadWeather: async () => null,
      loadWeeklyRollup: null,
    });

    expect(result.weeklyRollup).toBeNull();
  });
});
