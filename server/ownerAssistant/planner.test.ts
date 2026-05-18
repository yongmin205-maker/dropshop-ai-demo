/**
 * Planner contract tests — pin the args-validation + repair-retry
 * behavior added to fix the "compareTimeWindows zod failure on
 * empty args" regression.
 *
 * The planner imports `invokeLLM` directly so we vi.mock the module.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeLLMMock } = vi.hoisted(() => ({ invokeLLMMock: vi.fn() }));
vi.mock("../_core/llm", () => ({
  invokeLLM: invokeLLMMock,
}));

import { planTools, __test__ } from "./planner";

function llmResult(content: unknown) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: typeof content === "string" ? content : JSON.stringify(content),
        },
      },
    ],
  };
}

describe("planTools — args validation + repair retry", () => {
  beforeEach(() => {
    invokeLLMMock.mockReset();
  });

  it("happy path: planner returns valid compareTimeWindows args", async () => {
    invokeLLMMock.mockResolvedValueOnce(
      llmResult({
        plan: [
          {
            toolName: "compareTimeWindows",
            args: {
              windowA: { from: "2026-04-01T00:00:00Z", to: "2026-05-01T00:00:00Z" },
              windowB: { from: "2026-05-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
              metric: "revenue",
            },
            reason: "지난달 vs 이번달 매출 비교",
          },
        ],
      }),
    );

    const result = await planTools(
      "지난 달 대비 이번 달 매출 동향",
      "compare",
      new Date("2026-05-18T16:00:00Z"),
    );

    expect(result.llmCalls).toBe(1);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.toolName).toBe("compareTimeWindows");
    const parsedArgs = JSON.parse(result.steps[0]!.argsJson);
    expect(parsedArgs.metric).toBe("revenue");
    expect(parsedArgs.windowA.from).toBe("2026-04-01T00:00:00Z");
    expect(parsedArgs.windowB.to).toBe("2026-06-01T00:00:00Z");
  });

  it("salvages empty args by substituting argsExample (no LLM retry needed)", async () => {
    // First-pass salvage: when LLM emits empty args but argsExample parses
    // valid against the tool's inputSchema, we patch in argsExample and
    // skip the repair-LLM round-trip entirely. Saves latency + cost.
    invokeLLMMock.mockResolvedValueOnce(
      llmResult({
        plan: [
          { toolName: "compareTimeWindows", args: {}, reason: "비교" },
        ],
      }),
    );

    const result = await planTools(
      "지난 달 대비 이번 달 매출 동향",
      "compare",
      new Date("2026-05-18T16:00:00Z"),
    );

    expect(invokeLLMMock).toHaveBeenCalledTimes(1);
    expect(result.llmCalls).toBe(1);
    expect(result.steps).toHaveLength(1);
    const parsedArgs = JSON.parse(result.steps[0]!.argsJson);
    expect(parsedArgs.metric).toBeTruthy();
    expect(parsedArgs.windowA).toMatchObject({ from: expect.any(String), to: expect.any(String) });
    expect(parsedArgs.windowB).toMatchObject({ from: expect.any(String), to: expect.any(String) });
  });

  it("repair prompt is built when args fail zod AND salvage isn't possible", async () => {
    // Use partially-bad args (windowA only) so empty-args salvage doesn't
    // kick in. Then the repair LLM call must happen and its prompt must
    // include the diagnostic markers.
    invokeLLMMock
      .mockResolvedValueOnce(
        llmResult({
          plan: [
            {
              toolName: "compareTimeWindows",
              args: {
                windowA: { from: "2026-04-01T00:00:00Z", to: "2026-05-01T00:00:00Z" },
                // missing windowB and metric → not empty, can't salvage
              },
              reason: "비교",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        llmResult({
          plan: [
            {
              toolName: "compareTimeWindows",
              args: {
                windowA: { from: "2026-04-01T00:00:00Z", to: "2026-05-01T00:00:00Z" },
                windowB: { from: "2026-05-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
                metric: "order_count",
              },
              reason: "비교",
            },
          ],
        }),
      );

    await planTools("비교", "compare", new Date("2026-05-18T16:00:00Z"));

    expect(invokeLLMMock).toHaveBeenCalledTimes(2);
    const secondCall = invokeLLMMock.mock.calls[1]![0];
    const sysPrompt = secondCall.messages[0].content;
    expect(sysPrompt).toContain("중요(반드시 수정)");
    expect(sysPrompt).toContain("compareTimeWindows");
    expect(sysPrompt).toContain("windowA");
  });

  it("drops a step whose args remain bad after repair (partial-repair scenario)", async () => {
    // Force both calls to return non-salvageable, non-empty bad args so we
    // exercise the drop-step path.
    invokeLLMMock
      .mockResolvedValueOnce(
        llmResult({
          plan: [
            {
              toolName: "compareTimeWindows",
              args: { windowA: { from: "x" } }, // not empty, not valid
              reason: "비교",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        llmResult({
          plan: [
            {
              toolName: "compareTimeWindows",
              args: {
                windowA: { from: "2026-04-01T00:00:00Z", to: "2026-05-01T00:00:00Z" },
                metric: "revenue",
              },
              reason: "비교",
            },
          ],
        }),
      );

    const result = await planTools(
      "비교",
      "compare",
      new Date("2026-05-18T16:00:00Z"),
    );

    expect(result.steps).toHaveLength(0);
    expect(result.llmCalls).toBe(2);
  });

  it("validatePlanArgs unit: empty compareTimeWindows args → salvaged via argsExample", () => {
    // The salvage path: empty args + a valid argsExample defaults the args
    // and rescues the step without an LLM round-trip.
    const out = __test__.validatePlanArgs({
      plan: [{ toolName: "compareTimeWindows", args: {}, reason: "x" }],
    });
    expect(out.validSteps).toHaveLength(1);
    expect(out.badSteps).toHaveLength(0);
    const args = out.validSteps[0]?.args as { metric?: string; windowA?: unknown };
    expect(args.metric).toBeTruthy();
    expect(args.windowA).toBeTruthy();
  });

  it("validatePlanArgs unit: partially-filled compareTimeWindows args → bad (no salvage)", () => {
    const out = __test__.validatePlanArgs({
      plan: [
        {
          toolName: "compareTimeWindows",
          args: { windowA: { from: "x" } }, // not empty, can't salvage
          reason: "x",
        },
      ],
    });
    expect(out.validSteps).toHaveLength(0);
    expect(out.badSteps).toHaveLength(1);
  });

  it("validatePlanArgs unit: countActiveGarments with {} → valid (argsExample is {})", () => {
    const out = __test__.validatePlanArgs({
      plan: [{ toolName: "countActiveGarments", args: {}, reason: "x" }],
    });
    expect(out.validSteps).toHaveLength(1);
    expect(out.badSteps).toHaveLength(0);
  });

  it("basePrompt embeds argsExample for compareTimeWindows", () => {
    const prompt = __test__.basePrompt(new Date("2026-05-18T16:00:00Z"));
    expect(prompt).toContain("compareTimeWindows");
    // argsExample literal JSON should appear inline.
    expect(prompt).toContain("windowA");
    expect(prompt).toContain("windowB");
    expect(prompt).toContain("revenue");
  });

  it("unknown toolName from LLM is dropped silently (planner enum guard)", async () => {
    invokeLLMMock.mockResolvedValueOnce(
      llmResult({
        plan: [
          {
            toolName: "deleteAllData", // not in TOOL_NAMES
            args: {},
            reason: "x",
          },
        ],
      }),
    );

    const result = await planTools("x", "aggregate", new Date());
    expect(result.steps).toHaveLength(0);
  });

  it("length-cap retry still works (>5 steps → retries with shorten hint)", async () => {
    // Note: aggregateRevenue is a real tool but we use 6 valid copies
    // so length-cap retry fires but args-validation does NOT trigger a
    // 3rd LLM call (we want to isolate the length-cap path).
    const validAggArgs = {
      dateFrom: "2026-05-01T00:00:00Z",
      dateTo: "2026-05-02T00:00:00Z",
      groupBy: "day",
      includeUnpaid: false,
    };
    const sixSteps = Array.from({ length: 6 }, (_, i) => ({
      toolName: "aggregateRevenue",
      args: validAggArgs,
      reason: `step ${i}`,
    }));
    invokeLLMMock
      .mockResolvedValueOnce(llmResult({ plan: sixSteps }))
      .mockResolvedValueOnce(
        llmResult({
          plan: [
            {
              toolName: "aggregateRevenue",
              args: validAggArgs,
              reason: "trim",
            },
          ],
        }),
      );

    const result = await planTools("매출", "aggregate", new Date());
    expect(invokeLLMMock).toHaveBeenCalledTimes(2);
    expect(result.llmCalls).toBe(2);
    expect(result.steps).toHaveLength(1);
    // 2nd call should mention shorten-to-N
    const secondPrompt = invokeLLMMock.mock.calls[1]![0].messages[0].content;
    expect(secondPrompt).toContain("줄이세요");
  });
});
