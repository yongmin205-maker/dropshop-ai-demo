/**
 * Phase 26 — Owner Assistant critic loop.
 *
 * The critic evaluates a (plan + tool results) tuple BEFORE the synthesizer
 * runs. If a plan has a semantic defect (wrong groupBy, missing fair-pace
 * mode, 0-row anomaly, etc.) the critic emits `verdict: "retry"` and a
 * `replanHint` that the orchestrator passes to a fresh planner call.
 *
 * Two-stage entry point:
 *   1. `staticPreCheck()`  — deterministic veto-only. Catches hard spec
 *      violations (broken JSON, zod-fail args, empty plan, all-tools-failed).
 *      Cannot stamp "ok"; can only short-circuit to retry without calling
 *      the LLM. Per Phase 26 DP1.
 *   2. `llmCritic()`        — the real critic. Runs `invokeLLM` with the
 *      structured plan + results JSON and the invariant checklist. Only
 *      reached when static is silent.
 *
 * `evaluatePlan()` is the orchestrator-facing entry point that runs static
 * first, then LLM if static is silent.
 *
 * **Phase 27 deferred (see phase26_architecture.md §6):** the synthesizer's
 * Korean answer is NOT evaluated by this critic. A separate Phase 27 critic
 * with a numeric-claim trigger handles synth-answer hallucinations.
 */

import { invokeLLM } from "../_core/llm";
import type { PlanStep, QuestionCategory, ToolCall } from "./types";

/* ---------- Timing budgets (DP2 — tune retroactively from prod data) ---------- */

/** Phase 26 timing budgets — measured retroactively in prod; tune here. */
export const PHASE26_BUDGETS = {
  /** Hard ceiling on the whole agent loop (router + plan + critic + replan
   *  + critic2 + synth). Beyond this we abort with a synthetic disclaimer.
   *  Inside Cloud Run's 30s tRPC mutation timeout. */
  WALL_MS: 25_000,
  /** Per-stage soft budgets — overruns emit a `stageOverrun` event in the
   *  trace but do NOT block. Sum = 22s, matches PREFLIGHT_BAIL_MS. */
  PLANNER_MS: 4_000,
  EXECUTOR_MS: 8_000,
  CRITIC_MS: 3_000,
  REPLAN_MS: 4_000,
  /** If `Date.now() - loopStartedAt > this` when about to start critic-pass-2,
   *  skip critic2 and synth with the PREFLIGHT_BAIL_DISCLAIMER. Prevents
   *  the p99 tail from crossing the 25s wall. */
  PREFLIGHT_BAIL_MS: 22_000,
} as const;

/** Disclaimer copy when PREFLIGHT_BAIL fires before critic pass 2. */
export const PREFLIGHT_BAIL_DISCLAIMER =
  "critic 2회차를 실행하지 못해 첫 plan 결과로 답변합니다. 결과를 한 번 더 확인해 주세요.";

/** Disclaimer copy when the WALL_MS hard ceiling fires anywhere in the loop. */
export const WALL_TIMEOUT_DISCLAIMER =
  "분석 시간이 초과되어 부분 결과만 보여드려요.";

/* ---------- Types ---------- */

export type CriticVerdict = "ok" | "retry";

/** One critic pass — the trace surfaces an array of these per turn. */
export type CriticCall = {
  /** 1-indexed pass within the turn. */
  pass: number;
  verdict: CriticVerdict;
  /** Always populated. ≤2 sentences, Korean, owner-friendly. */
  reason: string;
  /** Present iff `verdict === "retry"`. Korean, ≤2 sentences. The
   *  orchestrator threads this verbatim into the next planner call's
   *  extra system context (DP3 / Q3). */
  replanHint: string | null;
  /** Per Q4: critic-authored disclaimer text. May appear on `verdict:
   *  "ok"` too if the result is partial or uncertain. ≤60 KR tokens. */
  disclaimer: string | null;
  /** "I1" / "I2" / ... / "S1" / etc — surfaced in the trace UI for
   *  debuggability. Maps to the invariant table in
   *  phase26_architecture.md §3. */
  failedInvariant: string | null;
  startedAt: number;
  finishedAt: number;
  /** False iff `staticPreCheck` short-circuited the verdict. */
  usedLlm: boolean;
};

export type CriticInput = {
  question: string;
  category: QuestionCategory;
  plan: PlanStep[];
  /** Keyed `${toolName}#${stepIndex}` per executor.ts convention. */
  toolResults: Record<string, unknown>;
  /** Per-step ToolCall — includes `errorMessage` for failed steps. */
  toolCalls: ToolCall[];
  now: Date;
  /** Previous critic passes this turn (empty on first pass). The LLM
   *  critic sees these so it can avoid re-running a failed replanHint. */
  history: CriticCall[];
};

export type CriticDeps = {
  /** Injectable for tests. Default uses `invokeLLM` from `_core/llm`. */
  invokeLlmCritic?: (input: CriticInput) => Promise<CriticCall>;
  /** Injectable clock for deterministic test timing. */
  clock?: () => number;
};

/* ---------- Entry points (stub bodies — TDD red) ---------- */

/**
 * Deterministic guard rail. Returns `null` when nothing is obviously wrong,
 * forcing the orchestrator to call the LLM critic. When it does return a
 * value, it's always `verdict: "retry"` with `usedLlm: false` — static
 * cannot stamp "ok" per DP1.
 *
 * Phase 26 commit 2 fills this body.
 */
export function staticPreCheck(_input: CriticInput): CriticCall | null {
  throw new Error("staticPreCheck not implemented (Phase 26 commit 2)");
}

/**
 * The real critic. Calls `invokeLLM` with the structured plan + tool
 * results + invariant checklist and parses the verdict JSON.
 *
 * Phase 26 commit 3 fills this body.
 */
export async function llmCritic(
  _input: CriticInput,
  _deps: CriticDeps = {},
): Promise<CriticCall> {
  throw new Error("llmCritic not implemented (Phase 26 commit 3)");
}

/**
 * Orchestrator-facing entry point. Runs `staticPreCheck` first; if static
 * is silent, runs `llmCritic`. Always emits exactly one CriticCall.
 *
 * Phase 26 commit 3 fills this body.
 */
export async function evaluatePlan(
  _input: CriticInput,
  _deps: CriticDeps = {},
): Promise<CriticCall> {
  throw new Error("evaluatePlan not implemented (Phase 26 commit 3)");
}

/* ---------- Internal exports for tests ---------- */

/** Surface a minimal use of `invokeLLM` so the TDD-red stub's import
 *  isn't unused (tsc would warn). Commit 3 wires it for real. */
export const __unusedInvokeLlmReference = invokeLLM;
