/**
 * Orchestrator — wires Router → Planner → Executor → Critic → (replan?) →
 * Synthesizer into a single `ask()` call. Phase 26 adds the critic loop:
 * after each plan executes, the critic evaluates (plan + results); a
 * `"retry"` verdict triggers a replanned planner call (up to 1 replan,
 * = 2 critic passes max). The second pass's disclaimer is appended to
 * the synth answer per DP3.
 *
 * Every stage is dependency-injected so `agent.test.ts` can drive the
 * loop with deterministic stubs.
 *
 * llmCallCount accounting (post-Phase-26):
 *   - smalltalk / out_of_scope    → 2 (Router + Synthesizer)
 *   - happy-path tool answer      → 4 (Router + Planner + Critic + Synth)
 *   - Planner over-produced + retried → +1 (Planner ×2)
 *   - Critic with static-veto     → +0 (no LLM call when usedLlm=false)
 *   - One replan after critic1 retry → +2 (Planner2 + Critic2)
 *
 * Freshness hint rule unchanged from Phase 25c: any live tool with
 * `ok:true` pivots the hint to "방금 확인한 실시간 데이터".
 */

import { evaluatePlan as defaultEvaluatePlan } from "./critic";
import type { CriticCall } from "./critic";
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
  TraceEvent,
} from "./types";

/** Phase 26 — max critic passes per turn (brief §2 cap). Pass 1 always
 *  runs after the initial plan; pass 2 runs only when pass 1 retried. */
const MAX_CRITIC_PASSES = 2;

export type EvaluatePlanFn = typeof defaultEvaluatePlan;

export type AskDeps = {
  routeQuestion?: RouteFn;
  planTools?: typeof defaultPlanTools;
  synthesizeAnswer?: SynthesizeFn;
  /** Phase 26 — injectable critic. Tests pass a stub returning a
   *  deterministic CriticCall to avoid the LLM round-trip. Production
   *  uses `evaluatePlan` from `critic.ts` (static-first, then LLM). */
  evaluatePlan?: EvaluatePlanFn;
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

/** Convert a CriticCall into the trace's `critic` event. */
function criticEvent(call: CriticCall, t: number): TraceEvent {
  return {
    kind: "critic",
    t,
    durationMs: call.finishedAt - call.startedAt,
    pass: call.pass,
    verdict: call.verdict,
    reason: call.reason,
    replanHint: call.replanHint,
    disclaimer: call.disclaimer,
    failedInvariant: call.failedInvariant,
    usedLlm: call.usedLlm,
  };
}

/** Append a critic disclaimer to the synthesizer's answer. Critic
 *  disclaimers are owner-facing Korean copy ≤240 chars per arch §4.
 *  We surface them as a separate line so they're visually distinct
 *  from the synth's own footer. */
function appendDisclaimer(answer: string, disclaimer: string | null): string {
  if (!disclaimer) return answer;
  return `${answer}\n\n_${disclaimer}_`;
}

export async function ask(
  question: string,
  deps: AskDeps = {},
): Promise<AgentAnswer> {
  const clock = deps.clock ?? (() => new Date());
  const route = deps.routeQuestion ?? defaultRouteQuestion;
  const plan = deps.planTools ?? defaultPlanTools;
  const synth = deps.synthesizeAnswer ?? defaultSynthesize;
  const critic = deps.evaluatePlan ?? defaultEvaluatePlan;
  const freshnessOf =
    deps.resolveFreshnessHint ?? (async (n: Date) => defaultFreshness(n));

  const startedAt = clock().getTime();
  let llmCallCount = 0;
  const events: TraceEvent[] = [];

  // 1. Router
  const routerStart = clock().getTime();
  const routerOut = await route(question);
  llmCallCount += 1;
  const category: QuestionCategory = routerOut.category;
  events.push({
    kind: "router",
    t: routerStart,
    durationMs: clock().getTime() - routerStart,
    category,
    reasoning: routerOut.reasoning ?? "",
  });

  let planSteps: PlanStep[] = [];
  let toolCalls: ToolCall[] = [];
  let results: Record<string, unknown> = {};
  const criticHistory: CriticCall[] = [];
  let finalDisclaimer: string | null = null;

  // 2. Planner + Executor + Critic loop (skipped for smalltalk / oos)
  const skipsTools =
    category === "smalltalk" || category === "out_of_scope";

  const now = clock();
  let freshnessHint = await freshnessOf(now);

  if (!skipsTools) {
    // Initial plan.
    const plannerStart1 = clock().getTime();
    let planResult = await plan(question, category, now);
    planSteps = planResult.steps;
    llmCallCount += planResult.llmCalls;
    events.push({
      kind: "planner",
      t: plannerStart1,
      durationMs: clock().getTime() - plannerStart1,
      pass: 1,
      steps: planResult.steps,
      llmCalls: planResult.llmCalls,
    });

    for (let pass = 1; pass <= MAX_CRITIC_PASSES; pass++) {
      // Executor — re-runs against the (possibly new) plan each pass.
      const ctx: AgentContext = {
        source: "cleancloud",
        freshnessHint,
        now,
      };
      const execStart = clock().getTime();
      const execRes = await executePlan(planSteps, ctx);
      toolCalls = execRes.toolCalls;
      results = execRes.results;
      const execEnd = clock().getTime();
      for (const c of toolCalls) {
        events.push({
          kind: "toolCall",
          t: execStart, // best-effort; executor doesn't emit per-call
          durationMs: execEnd - execStart,
          pass,
          toolName: c.toolName,
          inputJson: c.inputJson,
          outputJson: c.outputJson,
          errorMessage: c.errorMessage,
        });
      }
      if (liveSucceeded(toolCalls)) {
        freshnessHint = "방금 확인한 실시간 데이터";
      }

      // Critic.
      const criticStart = clock().getTime();
      const verdict = await critic({
        question,
        category,
        plan: planSteps,
        toolResults: results,
        toolCalls,
        now,
        history: criticHistory,
      });
      if (verdict.usedLlm) llmCallCount += 1;
      criticHistory.push(verdict);
      finalDisclaimer = verdict.disclaimer;
      events.push(criticEvent(verdict, criticStart));

      if (verdict.verdict === "ok") break;

      // verdict === "retry"
      if (pass === MAX_CRITIC_PASSES) {
        // 2nd retry still failing → graceful degrade (DP3-a). Prefer
        // the critic's disclaimer; fall back to its reason.
        finalDisclaimer = verdict.disclaimer ?? verdict.reason;
        break;
      }

      // Replan with the critic's hint as extra system context (Q3-a).
      const plannerStart2 = clock().getTime();
      const replanRes = await plan(question, category, now, {
        extraContext: verdict.replanHint ?? undefined,
      });
      planSteps = replanRes.steps;
      planResult = replanRes;
      llmCallCount += replanRes.llmCalls;
      events.push({
        kind: "planner",
        t: plannerStart2,
        durationMs: clock().getTime() - plannerStart2,
        pass: pass + 1,
        steps: replanRes.steps,
        llmCalls: replanRes.llmCalls,
        extraContext: verdict.replanHint ?? undefined,
      });
    }
  }

  // 3. Synthesizer
  // TODO(phase27): synth-answer critic — Phase 26 evaluates plan+results
  // only (DP / arch §6). A separate critic pass should evaluate the
  // synthesizer's Korean answer when it contains ≥ N numeric tokens
  // (threshold tuned in prod). Integration point: between `synth(...)`
  // and the appendDisclaimer call below. See phase26_architecture.md §6.
  const synthStart = clock().getTime();
  const rawAnswer = await synth({
    question,
    category,
    results,
    toolCalls,
    freshnessHint,
  });
  llmCallCount += 1;
  const answerMarkdown = appendDisclaimer(rawAnswer, finalDisclaimer);
  events.push({
    kind: "synth",
    t: synthStart,
    durationMs: clock().getTime() - synthStart,
    answerLength: answerMarkdown.length,
    appliedDisclaimer: finalDisclaimer,
  });

  const totalLatencyMs = clock().getTime() - startedAt;

  const trace: AgentTrace = {
    question,
    category,
    plan: planSteps,
    toolCalls,
    answerMarkdown,
    totalLatencyMs,
    llmCallCount,
    events,
    criticCalls: criticHistory.map((c) => ({
      pass: c.pass,
      verdict: c.verdict,
      reason: c.reason,
      replanHint: c.replanHint,
      disclaimer: c.disclaimer,
      failedInvariant: c.failedInvariant,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      usedLlm: c.usedLlm,
    })),
  };
  return { answerMarkdown, trace };
}
