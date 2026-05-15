/**
 * Orchestrator — wires Router → Planner → Executor → Synthesizer into
 * a single `ask()` call. Every stage is dependency-injected so
 * agent.test.ts can drive the loop with deterministic stubs.
 *
 * llmCallCount accounting:
 *   - smalltalk / out_of_scope    → 2 (Router + Synthesizer)
 *   - happy-path tool answer      → 3 (Router + Planner + Synthesizer)
 *   - Planner over-produced + retried → 4 (Router + Planner ×2 +
 *     Synthesizer) — that retry is counted in this file.
 *
 * Freshness hint rule (data:):
 *   - If any *live* tool was called and produced ok:true, the hint
 *     becomes "방금 확인한 실시간 데이터" — the Synthesizer footer
 *     will reflect that.
 *   - Otherwise the hint is "<latest sync iso> 기준" using the most
 *     recent posSyncLog row passed in by the caller.
 */

import { planTools as defaultPlanTools } from "./planner";
import { routeQuestion as defaultRouteQuestion, type RouteFn } from "./router";
import { executePlan } from "./executor";
import { synthesizeAnswer as defaultSynthesize, type SynthesizeFn } from "./synthesizer";
import type {
  AgentAnswer,
  AgentContext,
  AgentTrace,
  PlanStep,
  QuestionCategory,
  ToolCall,
} from "./types";

export type AskDeps = {
  routeQuestion?: RouteFn;
  planTools?: typeof defaultPlanTools;
  synthesizeAnswer?: SynthesizeFn;
  /** Optional clock injection — defaults to `new Date()`. */
  clock?: () => Date;
  /** Optional override for the freshness hint, e.g. wired to a real
   *  posSyncLog read. The orchestrator never queries the log itself
   *  so unit tests aren't forced to mock that path. */
  resolveFreshnessHint?: (now: Date) => Promise<string>;
};

const LIVE_TOOL_NAMES = new Set([
  "fetchLiveOrder",
  "countActiveGarments",
  "aggregateRevenueLive",
]);

function liveSucceeded(toolCalls: ToolCall[]): boolean {
  for (const c of toolCalls) {
    if (!LIVE_TOOL_NAMES.has(c.toolName)) continue;
    if (c.errorMessage) continue;
    // a live tool returns `{ ok: true, ... }` or `{ ok: false, error }`
    try {
      const parsed = c.outputJson ? JSON.parse(c.outputJson) : null;
      if (parsed && parsed.ok === true) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function defaultFreshness(now: Date): string {
  return `${now.toISOString().replace("T", " ").slice(0, 16)} UTC 기준 mirror`;
}

export async function ask(
  question: string,
  deps: AskDeps = {},
): Promise<AgentAnswer> {
  const clock = deps.clock ?? (() => new Date());
  const route = deps.routeQuestion ?? defaultRouteQuestion;
  const plan = deps.planTools ?? defaultPlanTools;
  const synth = deps.synthesizeAnswer ?? defaultSynthesize;
  const freshnessOf =
    deps.resolveFreshnessHint ?? (async (n: Date) => defaultFreshness(n));

  const startedAt = clock().getTime();
  let llmCallCount = 0;

  // 1. Router
  const routerOut = await route(question);
  llmCallCount += 1;
  const category: QuestionCategory = routerOut.category;

  let planSteps: PlanStep[] = [];
  let toolCalls: ToolCall[] = [];
  let results: Record<string, unknown> = {};

  // 2. Planner + Executor (skipped for smalltalk / out_of_scope)
  const skipsTools =
    category === "smalltalk" || category === "out_of_scope";

  // The freshness hint defaults to mirror; live success will rewrite
  // it after the Executor runs.
  const now = clock();
  let freshnessHint = await freshnessOf(now);

  if (!skipsTools) {
    // The Planner returns its own LLM-call count (1 normally, 2 if the
    // shorten-to-N retry fired). Pre-fix the orchestrator inferred this
    // from `planSteps.length > PLANNER_MAX_PLAN_STEPS` — provably
    // unreachable because the planner already truncated. Trust the
    // planner's report and add it.
    const planResult = await plan(question, category, now);
    planSteps = planResult.steps;
    llmCallCount += planResult.llmCalls;

    const ctx: AgentContext = {
      source: "cleancloud",
      freshnessHint,
      now,
    };
    const execRes = await executePlan(planSteps, ctx);
    toolCalls = execRes.toolCalls;
    results = execRes.results;
    if (liveSucceeded(toolCalls)) {
      freshnessHint = "방금 확인한 실시간 데이터";
    }
  }

  // 3. Synthesizer
  const answerMarkdown = await synth({
    question,
    category,
    results,
    toolCalls,
    freshnessHint,
  });
  llmCallCount += 1;

  const totalLatencyMs = clock().getTime() - startedAt;

  const trace: AgentTrace = {
    question,
    category,
    plan: planSteps,
    toolCalls,
    answerMarkdown,
    totalLatencyMs,
    llmCallCount,
  };
  return { answerMarkdown, trace };
}
