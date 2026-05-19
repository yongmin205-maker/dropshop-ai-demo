/**
 * Phase 26 critic contract tests — TDD red on commit 1, green on commit 3.
 *
 * Each fixture maps to one entry in `phase26_architecture.md` §5 (test
 * matrix). The 7 cases pin:
 *   - I2 fair-pace ok (existing planner already emits this post-8f3e333).
 *   - I6 0-row legitimate ok with optional disclaimer.
 *   - I4 14-day window ok.
 *   - I3 dayOfWeek required (retry).
 *   - I6 0-row anomaly (retry).
 *   - S2 static zod-fail short-circuits to retry without calling the LLM.
 *   - History-aware: a retry verdict still fires when history shows a
 *     previous failed pass (orchestrator handles the abort, not critic).
 *
 * The orchestrator-level behavior (replan + 2-pass abort + disclaimer
 * threading into synth) is tested in `agent.test.ts` after commit 4.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeLLMMock } = vi.hoisted(() => ({ invokeLLMMock: vi.fn() }));
vi.mock("../_core/llm", () => ({
  invokeLLM: invokeLLMMock,
}));

import { evaluatePlan, staticPreCheck, PHASE26_BUDGETS } from "./critic";
import type { CriticCall, CriticInput } from "./critic";
import type { PlanStep, ToolCall, ToolName } from "./types";

const NOW = new Date("2026-05-18T16:00:00Z");

/** Build an LLM response envelope shaped like `invokeLLM` returns. */
function llmCriticResult(verdict: Partial<CriticCall> & { verdict: CriticCall["verdict"] }) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({
            verdict: verdict.verdict,
            reason: verdict.reason ?? "test reason",
            ...(verdict.replanHint !== undefined && verdict.replanHint !== null
              ? { replanHint: verdict.replanHint }
              : {}),
            ...(verdict.disclaimer !== undefined && verdict.disclaimer !== null
              ? { disclaimer: verdict.disclaimer }
              : {}),
            ...(verdict.failedInvariant
              ? { failedInvariant: verdict.failedInvariant }
              : {}),
          }),
        },
      },
    ],
  };
}

function makeStep(toolName: ToolName, args: object, reason = "test reason"): PlanStep {
  return { toolName, argsJson: JSON.stringify(args), reason };
}

function makeToolCall(
  toolName: ToolName,
  outputJson: string,
  errorMessage: string | null = null,
): ToolCall {
  return {
    toolName,
    inputJson: "{}",
    outputJson,
    startedAt: 0,
    finishedAt: 100,
    errorMessage,
  };
}

function makeInput(overrides: Partial<CriticInput> = {}): CriticInput {
  return {
    question: "default question",
    category: "aggregate",
    plan: [],
    toolResults: {},
    toolCalls: [],
    now: NOW,
    history: [],
    ...overrides,
  };
}

beforeEach(() => {
  invokeLLMMock.mockReset();
});

/* ----------------------------------------------------------------
 * Fixture 1 — fair-pace plan with valid results → verdict: "ok"
 * (Regression net for the 8f3e333 fair-pace fix.)
 * ---------------------------------------------------------------- */
describe("critic — fixture 1: 지난 달 대비 이번 달 매출 (fair-pace ok)", () => {
  it("emits verdict=ok when compareTimeWindows uses mode='fair-pace' on an in-progress comparison", async () => {
    invokeLLMMock.mockResolvedValueOnce(
      llmCriticResult({
        verdict: "ok",
        reason: "fair-pace 모드로 동일 일수 비교했고 결과도 정합적입니다.",
        disclaimer: "이번 달은 진행 중이라 지난달과 같은 일수만 잘라 비교했습니다.",
      }),
    );
    const input = makeInput({
      question: "지난 달 대비 이번 달 매출 어땠어?",
      category: "compare",
      plan: [
        makeStep("compareTimeWindows", {
          windowA: { from: "2026-04-01T00:00:00Z", to: "2026-04-19T00:00:00Z" },
          windowB: { from: "2026-05-01T00:00:00Z", to: "2026-05-19T00:00:00Z" },
          metric: "revenue",
          mode: "fair-pace",
        }),
      ],
      toolResults: {
        "compareTimeWindows#0": {
          a: 100000,
          b: 120000,
          delta: 20000,
          deltaPct: 20,
          effectiveWindowA: { from: "2026-04-01T00:00:00Z", to: "2026-04-19T00:00:00Z" },
          truncated: true,
        },
      },
      toolCalls: [makeToolCall("compareTimeWindows", JSON.stringify({ a: 100000, b: 120000 }))],
    });

    const result = await evaluatePlan(input);
    expect(result.verdict).toBe("ok");
    expect(result.usedLlm).toBe(true);
    expect(result.failedInvariant).toBeNull();
  });
});

/* ----------------------------------------------------------------
 * Fixture 2 — findInactiveCustomers returns 0 rows → I6 legitimate ok
 * (Critic distinguishes "nobody is inactive" from a sync bug.)
 * ---------------------------------------------------------------- */
describe("critic — fixture 2: 60일 이상 안 온 손님 0건 (I6 legitimate)", () => {
  it("emits verdict=ok with optional disclaimer when 0 rows is plausibly legitimate", async () => {
    invokeLLMMock.mockResolvedValueOnce(
      llmCriticResult({
        verdict: "ok",
        reason: "지난 60일 안에 모든 단골이 한 번 이상 방문했습니다.",
        disclaimer: "최근 60일간 모든 손님이 한 번 이상 다녀가셨어요. 결과 0건이 정상입니다.",
      }),
    );
    const input = makeInput({
      question: "60일 이상 안 온 손님 알려줘",
      category: "aggregate",
      plan: [makeStep("findInactiveCustomers", { inactiveDays: 60, minPriorVisits: 3 })],
      toolResults: { "findInactiveCustomers#0": { customers: [], totalCount: 0 } },
      toolCalls: [makeToolCall("findInactiveCustomers", JSON.stringify({ customers: [] }))],
    });

    const result = await evaluatePlan(input);
    expect(result.verdict).toBe("ok");
    expect(result.usedLlm).toBe(true);
    // Disclaimer is optional but the prompt asks the LLM to populate one
    // when the result is unusual; we verify the wiring respects it.
    expect(result.disclaimer).not.toBeNull();
  });
});

/* ----------------------------------------------------------------
 * Fixture 3 — aggregateRepeatCustomers 14-day window → I4 ok
 * ---------------------------------------------------------------- */
describe("critic — fixture 3: 최근 2주 단골 동향 (I4 window ok)", () => {
  it("emits verdict=ok when the window length matches the temporal modifier", async () => {
    invokeLLMMock.mockResolvedValueOnce(
      llmCriticResult({
        verdict: "ok",
        reason: "최근 2주(14일) 단골 방문 데이터가 정상 윈도우로 집계됐습니다.",
      }),
    );
    const input = makeInput({
      question: "최근 2주 동안 단골 손님 동향",
      category: "aggregate",
      plan: [
        makeStep("aggregateRepeatCustomers", {
          windowFrom: "2026-05-04T00:00:00Z",
          windowTo: "2026-05-18T16:00:00Z",
          lookbackDays: 90,
        }),
      ],
      toolResults: {
        "aggregateRepeatCustomers#0": { customers: [{ externalId: "c1", visits: 4 }], totalCount: 1 },
      },
      toolCalls: [makeToolCall("aggregateRepeatCustomers", JSON.stringify({ totalCount: 1 }))],
    });

    const result = await evaluatePlan(input);
    expect(result.verdict).toBe("ok");
    expect(result.usedLlm).toBe(true);
  });
});

/* ----------------------------------------------------------------
 * Fixture 4 — "지난 주 어떤 요일" with groupBy='day' → I3 retry
 * (The motivating bug for Phase 26: planner currently emits groupBy='day'.)
 * ---------------------------------------------------------------- */
describe("critic — fixture 4: 지난 주 요일별 매출, groupBy='day' (I3 retry)", () => {
  it("emits verdict=retry with I3 + replanHint when groupBy is 'day' on a 요일 question", async () => {
    invokeLLMMock.mockResolvedValueOnce(
      llmCriticResult({
        verdict: "retry",
        reason: "질문에 '요일'이 포함되어 있는데 groupBy가 'day'로 설정되어 일별 매출만 나옵니다.",
        replanHint:
          "aggregateRevenue 호출에서 groupBy를 'dayOfWeek'로 바꾸세요. 윈도우는 last 7 days로 유지.",
        failedInvariant: "I3",
      }),
    );
    const input = makeInput({
      question: "지난 주 어떤 요일에 매출이 제일 높았어?",
      category: "aggregate",
      plan: [
        makeStep("aggregateRevenue", {
          windowFrom: "2026-04-01T00:00:00Z",
          windowTo: "2026-05-01T00:00:00Z",
          groupBy: "day",
        }),
      ],
      toolResults: {
        "aggregateRevenue#0": { buckets: [{ bucket: "2026-04-01", revenue: 1234 }] },
      },
      toolCalls: [makeToolCall("aggregateRevenue", JSON.stringify({ buckets: [] }))],
    });

    const result = await evaluatePlan(input);
    expect(result.verdict).toBe("retry");
    expect(result.failedInvariant).toBe("I3");
    expect(result.replanHint).toContain("dayOfWeek");
    expect(result.usedLlm).toBe(true);
  });
});

/* ----------------------------------------------------------------
 * Fixture 5 — weekday-lunch 0-row → I6 anomaly retry
 * ---------------------------------------------------------------- */
describe("critic — fixture 5: 평일 점심 매출 0 (I6 anomaly retry)", () => {
  it("emits verdict=retry with I6 + replanHint when rowCount=0 looks like a mirror-sync failure", async () => {
    invokeLLMMock.mockResolvedValueOnce(
      llmCriticResult({
        verdict: "retry",
        reason: "평일 점심 시간대 매출이 0인 것은 영업 패턴 상 비정상입니다. 미러 동기화 누락 의심.",
        replanHint:
          "윈도우를 어제로 넓혀 다시 aggregateRevenue를 호출하거나, aggregateRevenueLive 사용을 검토하세요.",
        failedInvariant: "I6",
      }),
    );
    const input = makeInput({
      question: "오늘 점심시간 매출 어땠어?",
      category: "aggregate",
      plan: [
        makeStep("aggregateRevenue", {
          windowFrom: "2026-05-18T11:00:00Z",
          windowTo: "2026-05-18T14:00:00Z",
          groupBy: "hour",
        }),
      ],
      toolResults: {
        "aggregateRevenue#0": { buckets: [], totalRevenue: 0 },
      },
      toolCalls: [
        makeToolCall("aggregateRevenue", JSON.stringify({ buckets: [], totalRevenue: 0 })),
      ],
    });

    const result = await evaluatePlan(input);
    expect(result.verdict).toBe("retry");
    expect(result.failedInvariant).toBe("I6");
    expect(result.replanHint).toBeTruthy();
  });
});

/* ----------------------------------------------------------------
 * Fixture 6 — compareTimeWindows({}) → S2 static fires, NO LLM call
 * ---------------------------------------------------------------- */
describe("critic — fixture 6: compareTimeWindows with empty args (S2 static retry, no LLM)", () => {
  it("short-circuits to retry via staticPreCheck without calling invokeLLM", async () => {
    // Note: we do NOT mockResolvedValueOnce here — the test asserts the
    // LLM was not called.
    const input = makeInput({
      question: "지난 달 vs 이번 달",
      category: "compare",
      plan: [makeStep("compareTimeWindows", {})], // empty args → zod fail
      toolResults: {},
      toolCalls: [],
    });

    const result = await evaluatePlan(input);
    expect(result.verdict).toBe("retry");
    expect(result.usedLlm).toBe(false);
    expect(result.failedInvariant).toMatch(/^S\d$/);
    expect(invokeLLMMock).not.toHaveBeenCalled();
  });

  it("staticPreCheck called directly returns the same shape (verdict=retry, usedLlm=false)", () => {
    const input = makeInput({
      question: "지난 달 vs 이번 달",
      category: "compare",
      plan: [makeStep("compareTimeWindows", {})],
    });
    const result = staticPreCheck(input);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("retry");
    expect(result!.usedLlm).toBe(false);
  });
});

/* ----------------------------------------------------------------
 * Fixture 7 — critic with non-empty history still emits retry honestly
 * (Orchestrator decides the 2-retry abort; critic doesn't refuse.)
 * ---------------------------------------------------------------- */
describe("critic — fixture 7: history-aware retry (orchestrator handles abort)", () => {
  it("emits verdict=retry even when the previous pass also retried; critic is stateless on its own verdict", async () => {
    invokeLLMMock.mockResolvedValueOnce(
      llmCriticResult({
        verdict: "retry",
        reason: "이전 replanHint대로 수정했지만 여전히 groupBy가 day로 남아 있습니다.",
        replanHint: "두 번째 시도: aggregateRevenue groupBy='dayOfWeek'로 명시적으로 변경하세요.",
        disclaimer:
          "요일별 분석이 두 번 모두 실패했습니다. 일별 결과로 대신 보여드릴게요.",
        failedInvariant: "I3",
      }),
    );
    const previousPass: CriticCall = {
      pass: 1,
      verdict: "retry",
      reason: "groupBy 잘못 설정됨",
      replanHint: "dayOfWeek로 바꾸세요",
      disclaimer: null,
      failedInvariant: "I3",
      startedAt: 0,
      finishedAt: 100,
      usedLlm: true,
    };
    const input = makeInput({
      question: "지난 주 어떤 요일에 매출이 제일 높았어?",
      category: "aggregate",
      plan: [
        makeStep("aggregateRevenue", {
          windowFrom: "2026-05-11T00:00:00Z",
          windowTo: "2026-05-18T00:00:00Z",
          groupBy: "day", // planner still got it wrong
        }),
      ],
      toolResults: { "aggregateRevenue#0": { buckets: [] } },
      toolCalls: [makeToolCall("aggregateRevenue", JSON.stringify({ buckets: [] }))],
      history: [previousPass],
    });

    const result = await evaluatePlan(input);
    expect(result.verdict).toBe("retry");
    expect(result.disclaimer).toBeTruthy(); // schema-required when verdict=retry
    expect(result.pass).toBe(2); // 1-indexed; pass after the 1 in history
  });
});

/* ----------------------------------------------------------------
 * Sanity — exported constants exist and have the documented shape
 * (Coder hand-off contract §9.1; this guards against accidental rename.)
 * ---------------------------------------------------------------- */
describe("critic — Phase 26 timing constants surface", () => {
  it("exports PHASE26_BUDGETS with the documented numeric ms values", () => {
    expect(PHASE26_BUDGETS.WALL_MS).toBe(25_000);
    expect(PHASE26_BUDGETS.PLANNER_MS).toBe(4_000);
    expect(PHASE26_BUDGETS.EXECUTOR_MS).toBe(8_000);
    expect(PHASE26_BUDGETS.CRITIC_MS).toBe(3_000);
    expect(PHASE26_BUDGETS.REPLAN_MS).toBe(4_000);
    expect(PHASE26_BUDGETS.PREFLIGHT_BAIL_MS).toBe(22_000);
    // Per-stage budgets must sum to ≤ PREFLIGHT_BAIL_MS so the math holds.
    const stageSum =
      PHASE26_BUDGETS.PLANNER_MS +
      PHASE26_BUDGETS.EXECUTOR_MS +
      PHASE26_BUDGETS.CRITIC_MS * 2 +
      PHASE26_BUDGETS.REPLAN_MS;
    expect(stageSum).toBeLessThanOrEqual(PHASE26_BUDGETS.PREFLIGHT_BAIL_MS);
  });
});
