/// <reference types="vitest" />

/**
 * Orchestrator tests for `ask()` in agent.ts.
 *
 * Every LLM hook (router, planner, synthesizer) is dependency-injected.
 * The Executor itself runs against the real TOOL_REGISTRY but the DB
 * mock returns null from `getDb()`, so every mirror-backed tool
 * short-circuits to its safe-empty shape — fast and deterministic.
 *
 * For cases that need a specific tool behavior (best-effort failure,
 * live-tool freshness), we use `vi.spyOn(TOOL_REGISTRY.<name>, "invoke")`
 * to swap a single tool's body without disturbing the rest of the
 * registry. The plan is stubbed via `planTools` to point at that tool.
 *
 * llmCallCount invariants (per agent.ts comments):
 *   - smalltalk / out_of_scope  → 2  (Router + Synthesizer)
 *   - happy-path tool turn       → 3  (Router + Planner + Synthesizer)
 *   - Planner-overproduce retry → 4  (Router + Planner ×2 + Synth)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// The real registry pulls in CleanCloud SDK + db imports. The findCustomer
// / aggregate tests both `vi.mock("../db", ...)` to return null so the
// tool invocations safe-empty. We do the same.
vi.mock("../db", () => ({
  getDb: vi.fn(async () => null),
}));

import { ask } from "./agent";
import { TOOL_REGISTRY } from "./tools";
import type {
  AgentContext,
  PlanStep,
  QuestionCategory,
} from "./types";

/* ----- helpers ------------------------------------------------------- */

function makeRoute(category: QuestionCategory, reasoning = "stub") {
  return vi.fn(async (_q: string) => ({ category, reasoning }));
}

function makePlan(steps: PlanStep[], llmCalls = 1) {
  return vi.fn(
    async (_q: string, _c: QuestionCategory, _now: Date) => ({
      steps,
      llmCalls,
    }),
  );
}

function makeSynth(text = "answer") {
  return vi.fn(
    async (args: {
      question: string;
      category: QuestionCategory;
      results: Record<string, unknown>;
      toolCalls: unknown[];
      freshnessHint: string;
    }) => `[${text} for ${args.question}]`,
  );
}

/**
 * Sequential clock — each call returns the next timestamp in the list,
 * looping on the last value. This gives deterministic latency math.
 */
function makeSequentialClock(starts: number[]): () => Date {
  let i = 0;
  return () => new Date(starts[Math.min(i++, starts.length - 1)]!);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/* ----- 1. smalltalk -------------------------------------------------- */

describe("ask — smalltalk path", () => {
  it("skips Planner+Executor, llmCallCount=2, synthesizer sees empty results", async () => {
    const route = makeRoute("smalltalk");
    const plan = makePlan([{ toolName: "findCustomerByPhoneOrName", argsJson: "{}", reason: "" }]);
    const synth = makeSynth("hello");

    const res = await ask("안녕", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
      resolveFreshnessHint: async () => "test-fresh",
    });

    expect(res.trace.category).toBe("smalltalk");
    expect(res.trace.plan).toEqual([]);
    expect(res.trace.toolCalls).toEqual([]);
    expect(res.trace.llmCallCount).toBe(2);
    expect(plan).not.toHaveBeenCalled();
    expect(synth).toHaveBeenCalledTimes(1);
    expect(synth).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "smalltalk",
        results: {},
        toolCalls: [],
      }),
    );
  });
});

/* ----- 2. out_of_scope ---------------------------------------------- */

describe("ask — out_of_scope path", () => {
  it("skips Planner+Executor, llmCallCount=2", async () => {
    const route = makeRoute("out_of_scope");
    const plan = makePlan([]);
    const synth = makeSynth("oos");

    const res = await ask("직원 시급 얼마야", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
    });

    expect(res.trace.category).toBe("out_of_scope");
    expect(res.trace.plan).toEqual([]);
    expect(res.trace.llmCallCount).toBe(2);
    expect(plan).not.toHaveBeenCalled();
  });
});

/* ----- 3. lookup happy-path ----------------------------------------- */

describe("ask — lookup happy-path", () => {
  it("uses findCustomerByPhoneOrName in plan, llmCallCount=3", async () => {
    const route = makeRoute("lookup");
    const planSteps: PlanStep[] = [
      {
        toolName: "findCustomerByPhoneOrName",
        argsJson: JSON.stringify({ query: "Andrew Kim" }),
        reason: "이름으로 손님 검색",
      },
    ];
    const plan = makePlan(planSteps);
    const synth = makeSynth("lookup");

    const res = await ask("Andrew Kim 정보", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
    });

    expect(res.trace.category).toBe("lookup");
    expect(res.trace.plan).toEqual(planSteps);
    expect(res.trace.llmCallCount).toBe(3);
    expect(res.trace.toolCalls).toHaveLength(1);
    expect(res.trace.toolCalls[0]!.toolName).toBe("findCustomerByPhoneOrName");
    expect(res.trace.toolCalls[0]!.errorMessage).toBeNull(); // safe-empty success
  });
});

/* ----- 4. aggregate happy-path -------------------------------------- */

describe("ask — aggregate happy-path", () => {
  it("uses aggregateRevenue in plan", async () => {
    const route = makeRoute("aggregate");
    const planSteps: PlanStep[] = [
      {
        toolName: "aggregateRevenue",
        argsJson: JSON.stringify({
          dateFrom: "2026-05-01T00:00:00Z",
          dateTo: "2026-05-15T00:00:00Z",
          groupBy: "day",
        }),
        reason: "최근 2주 매출",
      },
    ];
    const plan = makePlan(planSteps);
    const synth = makeSynth("agg");

    const res = await ask("최근 2주 매출", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
    });

    expect(res.trace.plan[0]!.toolName).toBe("aggregateRevenue");
    expect(res.trace.toolCalls[0]!.toolName).toBe("aggregateRevenue");
    expect(res.trace.llmCallCount).toBe(3);
  });
});

/* ----- 5. compare happy-path ---------------------------------------- */

describe("ask — compare happy-path", () => {
  it("uses compareTimeWindows in plan", async () => {
    const route = makeRoute("compare");
    const planSteps: PlanStep[] = [
      {
        toolName: "compareTimeWindows",
        argsJson: JSON.stringify({
          windowA: { from: "2026-05-01T00:00:00Z", to: "2026-05-08T00:00:00Z" },
          windowB: { from: "2026-05-08T00:00:00Z", to: "2026-05-15T00:00:00Z" },
          metric: "revenue",
        }),
        reason: "지난주 vs 이번주 비교",
      },
    ];
    const plan = makePlan(planSteps);
    const synth = makeSynth("cmp");

    const res = await ask("지난주 vs 이번주", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
    });

    expect(res.trace.plan[0]!.toolName).toBe("compareTimeWindows");
    expect(res.trace.toolCalls[0]!.toolName).toBe("compareTimeWindows");
    expect(res.trace.llmCallCount).toBe(3);
  });
});

/* ----- 6. planner overproduce → llmCallCount=4 ---------------------- */

describe("ask — planner overproduce", () => {
  it("counts the retry hop (llmCallCount=4)", async () => {
    const route = makeRoute("aggregate");
    // Return 6 steps — over the PLANNER_MAX_PLAN_STEPS=5 cap.
    const sixSteps: PlanStep[] = Array.from({ length: 6 }, (_, i) => ({
      toolName: "aggregateRevenue",
      argsJson: JSON.stringify({
        dateFrom: "2026-05-01T00:00:00Z",
        dateTo: "2026-05-15T00:00:00Z",
        groupBy: "day",
      }),
      reason: `over-${i}`,
    }));
    // llmCalls=2 reflects the planner's own retry hop. Pre-fix the
    // orchestrator inferred this from `steps.length > MAX`, which was
    // unreachable because the planner sliced before returning — this
    // stub now mirrors the real planner's reported count.
    const plan = makePlan(sixSteps, 2);
    const synth = makeSynth("over");

    const res = await ask("매출 분석", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
    });

    expect(res.trace.llmCallCount).toBe(4);
    // Plan is preserved as-returned (the cap in the real planner is
    // internal; the orchestrator simply records what came back).
    expect(res.trace.plan).toHaveLength(6);
  });
});

/* ----- 7. tool best-effort failure ---------------------------------- */

describe("ask — tool best-effort failure", () => {
  it("populates errorMessage and still hands results to synthesizer", async () => {
    const route = makeRoute("lookup");
    const planSteps: PlanStep[] = [
      {
        toolName: "fetchLiveOrder",
        argsJson: JSON.stringify({ externalId: "boom" }),
        reason: "test failure",
      },
    ];
    const plan = makePlan(planSteps);
    const synth = makeSynth("err");

    const spy = vi
      .spyOn(TOOL_REGISTRY.fetchLiveOrder, "invoke")
      .mockImplementation(async () => {
        throw new Error("kaboom");
      });

    const res = await ask("주문 boom 상태", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(res.trace.toolCalls).toHaveLength(1);
    expect(res.trace.toolCalls[0]!.errorMessage).toContain("kaboom");
    // Synth still received the partial picture so it can apologize.
    expect(synth).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls: expect.arrayContaining([
          expect.objectContaining({ errorMessage: expect.stringContaining("kaboom") }),
        ]),
      }),
    );
  });
});

/* ----- 8. live tool success → freshness pivot ----------------------- */

describe("ask — live tool success rewrites freshnessHint", () => {
  it("synthesizer receives '방금 확인한 실시간 데이터'", async () => {
    const route = makeRoute("lookup");
    const planSteps: PlanStep[] = [
      {
        toolName: "fetchLiveOrder",
        argsJson: JSON.stringify({ externalId: "abc" }),
        reason: "live order",
      },
    ];
    const plan = makePlan(planSteps);
    const synth = makeSynth("live");

    vi.spyOn(TOOL_REGISTRY.fetchLiveOrder, "invoke").mockImplementation(
      async () => ({ ok: true, order: { externalId: "abc" } }),
    );

    await ask("주문 abc 지금 상태", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
      // Provide a baseline so we can prove the pivot happened.
      resolveFreshnessHint: async () => "stale-baseline",
    });

    expect(synth).toHaveBeenCalledWith(
      expect.objectContaining({
        freshnessHint: "방금 확인한 실시간 데이터",
      }),
    );
  });
});

/* ----- 9. clock injection → deterministic latency ------------------- */

describe("ask — clock injection", () => {
  it("trace.totalLatencyMs is the sequential delta", async () => {
    const route = makeRoute("smalltalk");
    const plan = makePlan([]);
    const synth = makeSynth("hi");
    // clock used: startedAt (call 1), now (call 2), totalLatency end (call 3).
    const clock = makeSequentialClock([1_000, 1_500, 4_200]);

    const res = await ask("안녕", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
      clock,
      resolveFreshnessHint: async () => "x",
    });

    // end (4_200) - start (1_000) = 3_200 ms
    expect(res.trace.totalLatencyMs).toBe(3_200);
    expect(res.trace.totalLatencyMs).toBeGreaterThan(0);
  });
});

/* ----- 10. freshness footer pass-through ---------------------------- */

describe("ask — resolveFreshnessHint pass-through", () => {
  it("synthesizer receives the configured hint when no live tool ran", async () => {
    const route = makeRoute("aggregate");
    const planSteps: PlanStep[] = [
      {
        toolName: "aggregateRevenue",
        argsJson: JSON.stringify({
          dateFrom: "2026-05-01T00:00:00Z",
          dateTo: "2026-05-15T00:00:00Z",
          groupBy: "day",
        }),
        reason: "agg",
      },
    ];
    const plan = makePlan(planSteps);
    const synth = makeSynth("fresh");

    await ask("최근 매출", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
      resolveFreshnessHint: async () => "2026-05-15 03:00 ET 기준",
    });

    expect(synth).toHaveBeenCalledWith(
      expect.objectContaining({
        freshnessHint: "2026-05-15 03:00 ET 기준",
      }),
    );
  });
});

/* ----- 11. consistency: answerMarkdown == trace.answerMarkdown ------ */

describe("ask — top-level and trace answerMarkdown agree", () => {
  it("returns the same string at both surfaces", async () => {
    const route = makeRoute("smalltalk");
    const plan = makePlan([]);
    const synth = makeSynth("invariant");

    const res = await ask("hi", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
    });

    expect(res.answerMarkdown).toBe(res.trace.answerMarkdown);
    expect(res.answerMarkdown).toBe("[invariant for hi]");
  });
});

/* ----- 12. happy-path llmCallCount=3 (lookup with single tool) ------ */

describe("ask — happy-path llmCallCount invariant", () => {
  it("lookup with single tool produces exactly 3 LLM calls", async () => {
    const route = makeRoute("lookup");
    const plan = makePlan([
      {
        toolName: "findCustomerByPhoneOrName",
        argsJson: JSON.stringify({ query: "Kim" }),
        reason: "test",
      },
    ]);
    const synth = makeSynth("ok");

    const res = await ask("Kim 손님 정보", {
      routeQuestion: route,
      planTools: plan,
      synthesizeAnswer: synth,
    });

    expect(res.trace.llmCallCount).toBe(3);
    expect(route).toHaveBeenCalledTimes(1);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(synth).toHaveBeenCalledTimes(1);
  });
});
