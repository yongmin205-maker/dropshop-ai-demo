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
import { TOOL_REGISTRY } from "./tools";
import { TOOL_NAMES, type PlanStep, type QuestionCategory, type ToolCall, type ToolName } from "./types";

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
 * Static invariants checked, in order (first miss wins):
 *   - S1 — `plan.length === 0` (planner returned no steps)
 *   - S3 — any step references a tool not in `TOOL_NAMES` / `TOOL_REGISTRY`
 *   - S2 — any step's `argsJson` is non-parseable JSON, or parses but
 *          fails the tool's `inputSchema.safeParse` (this folds the
 *          broken-JSON and zod-fail cases under one invariant since both
 *          are arg-validation failures from the executor's POV)
 *   - S4 — every tool call recorded a non-null `errorMessage` (only
 *          fires when `toolCalls.length > 0`; an empty list defers to
 *          the LLM critic, which has the richer view)
 *
 * No LLM call is made; `usedLlm` is always `false` on the returned
 * CriticCall. The `pass` field is 1-indexed and uses `history.length + 1`
 * so a static veto on critic-pass-2 still reports `pass: 2` honestly.
 */
export function staticPreCheck(
  input: CriticInput,
  deps: CriticDeps = {},
): CriticCall | null {
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const pass = input.history.length + 1;

  const veto = (failedInvariant: string, reason: string, replanHint: string): CriticCall => ({
    pass,
    verdict: "retry",
    reason,
    replanHint,
    disclaimer: null,
    failedInvariant,
    startedAt,
    finishedAt: clock(),
    usedLlm: false,
  });

  // S1 — empty plan.
  if (input.plan.length === 0) {
    return veto(
      "S1",
      "Planner가 빈 계획을 반환했습니다. 도구 호출이 한 건도 없습니다.",
      "질문에 맞는 도구를 최소 1개 선택해 계획에 포함하세요.",
    );
  }

  // S3 — unknown tool name. Done before S2 so we can safely look up the
  // tool's zod schema in the next loop without an existence check.
  for (const step of input.plan) {
    if (!(TOOL_NAMES as readonly ToolName[]).includes(step.toolName)) {
      return veto(
        "S3",
        `알 수 없는 도구 이름: ${String(step.toolName)}`,
        `등록된 도구만 사용하세요: ${TOOL_NAMES.join(", ")}.`,
      );
    }
  }

  // S2 — broken JSON OR zod-fail args.
  for (const step of input.plan) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(step.argsJson);
    } catch {
      return veto(
        "S2",
        `${step.toolName} 호출의 args가 유효한 JSON이 아닙니다.`,
        `${step.toolName}의 args를 ToolDefinition.argsExample 형태의 유효 JSON으로 다시 작성하세요.`,
      );
    }
    const tool = TOOL_REGISTRY[step.toolName];
    const zodResult = tool.inputSchema.safeParse(parsed);
    if (!zodResult.success) {
      return veto(
        "S2",
        `${step.toolName} 호출의 args가 입력 스키마를 통과하지 못했습니다.`,
        `${step.toolName}의 inputSchema 필수 필드를 모두 채워서 다시 계획하세요. argsExample을 참고하세요.`,
      );
    }
  }

  // S4 — all tool calls failed. Only meaningful when there are any
  // toolCalls; an empty list (e.g. critic invoked before executor for
  // some future use) defers to the LLM critic.
  if (input.toolCalls.length > 0) {
    const allFailed = input.toolCalls.every((c) => c.errorMessage !== null);
    if (allFailed) {
      return veto(
        "S4",
        "계획에 포함된 모든 도구 호출이 실패했습니다.",
        "이전 도구들이 모두 실패했으니, 다른 도구 조합이나 다른 인자 값으로 재계획하세요.",
      );
    }
  }

  return null;
}

/* ---------- LLM critic prompt + JSON schema ---------- */

/**
 * KR system prompt. The invariant checklist is the one place Phase 26
 * heuristics live — kept short on purpose so the model re-reads it
 * each turn. Reviewer guard: this whole prompt + critic.ts stays under
 * 80 lines together (per arch §9.4).
 */
const CRITIC_SYSTEM_PROMPT = `당신은 매장 점주 질문에 대한 tool 호출 계획과 결과를 검토하는 critic입니다.
평가 대상은 (1) 점주 질문, (2) planner가 만든 plan, (3) executor가 실행한 tool 결과 입니다.
**synthesizer가 최종적으로 쓸 한국어 답변은 평가하지 않습니다 — 그 단계 전에 멈춥니다.**

verdict 룰:
- "ok" — plan과 결과가 점주 의도와 일치. invariant 위반 없음.
- "retry" — plan에 의미적 결함이 있음. replanHint 필드에 planner가 다음 시도에서 어떻게 고쳐야 할지 1-2 문장으로 적어라.

invariant 체크리스트 (failedInvariant 필드는 아래 코드 그대로 사용):
- I1 카테고리/도구 정렬: lookup 질문에 aggregate tool, 또는 그 반대를 쓰면 retry.
- I2 fair-pace: 질문이 "이번 달/주/분기" 같은 진행 중 기간을 풀-기간과 비교하는데 compareTimeWindows mode != "fair-pace" 이면 retry.
- I3 dayOfWeek: 질문에 "요일" / "어느 요일" 표현이 있는데 aggregateRevenue groupBy != "dayOfWeek" 이면 retry.
- I4 window 길이: "지난 주"는 7일 윈도우, "지난 달"은 ~30일, "최근 2주"는 14일. 2배 이상 벗어나면 retry.
- I5 args 일관성: windowA.from < windowA.to, windowA.from < windowB.from (오래된 것이 앞).
- I6 0-row 판단: rowCount=0이 자연스러운지(예: 60일 동안 안 온 손님이 0명 — 모두 최근에 옴, 정상) 아니면 anomaly(예: 평일 점심인데 매출 0 — 미러 동기화 의심)인지. anomaly면 retry, legitimate면 ok + disclaimer 한 줄.
- I7 부분 실패: tool 일부만 실패했을 때, 남은 데이터로 답할 수 있으면 ok + disclaimer, 못 답하면 retry.

disclaimer 필드 룰:
- verdict="ok"이든 "retry"이든 점주에게 추가로 알릴 게 있으면 한 줄 한국어로 적어라. 없으면 비워라.
- 240자 이내. 점주 친화 톤(정중하되 굳지 않게).
- verdict="retry"일 때 disclaimer를 채우면, 2회차도 실패할 때 그 문구가 답변에 그대로 붙는다 — 점주가 봐도 이해 가능한 톤으로.

이전 critic 시도(history)가 비어있지 않으면, planner가 이미 한 번 고치려 한 결과를 검토하는 것이다. 같은 replanHint를 반복하지 말고, 다른 각도에서 문제를 짚어라.

출력 JSON 스키마: { verdict: "ok"|"retry", reason: string, replanHint?: string, disclaimer?: string, failedInvariant?: string }
JSON 외 다른 텍스트는 출력하지 말 것.`;

/** Per arch §4 response_format. Strict JSON schema keeps Gemini honest. */
const CRITIC_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: {
    verdict: { type: "string", enum: ["ok", "retry"] },
    reason: { type: "string", maxLength: 300 },
    replanHint: { type: "string", maxLength: 300 },
    disclaimer: { type: "string", maxLength: 240 },
    failedInvariant: {
      type: "string",
      enum: ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "S1", "S2", "S3", "S4"],
    },
  },
} as const;

/**
 * Compact preview of tool results. Critic sees rowCount + first-3-row
 * sample per step — enough to reason about anomalies (I6) without
 * dumping 50KB of raw rows into the prompt. Heuristic: if the result
 * is an object with an array-valued property (`series`, `customers`,
 * `buckets`, ...), preview that array; otherwise preview the whole
 * value.
 */
function previewToolResult(result: unknown): {
  rowCount: number | null;
  preview: unknown;
} {
  if (result == null) return { rowCount: null, preview: null };
  if (Array.isArray(result)) {
    return { rowCount: result.length, preview: result.slice(0, 3) };
  }
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        const arr = obj[key] as unknown[];
        return {
          rowCount: arr.length,
          preview: { [key]: arr.slice(0, 3), ...summarizeScalars(obj, key) },
        };
      }
    }
    return { rowCount: null, preview: obj };
  }
  return { rowCount: null, preview: result };
}

/** Pull out scalar siblings of the row-array key so totals (`totalCount`,
 *  `totalRevenueCents`, etc.) stay visible to the critic. */
function summarizeScalars(
  obj: Record<string, unknown>,
  skipKey: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === skipKey) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      out[k] = v;
    }
  }
  return out;
}

/** Build the user-message JSON the critic LLM sees. */
function buildCriticUserPayload(input: CriticInput): string {
  const planJson = input.plan.map((s, i) => ({
    stepIndex: i,
    toolName: s.toolName,
    args: safeJsonParse(s.argsJson),
    reason: s.reason,
  }));

  const toolResultsSummary = input.plan.map((s, i) => {
    const key = `${s.toolName}#${i}`;
    const raw = input.toolResults[key];
    const { rowCount, preview } = previewToolResult(raw);
    return { stepIndex: i, toolName: s.toolName, rowCount, preview };
  });

  const toolErrorsSummary = input.toolCalls
    .filter((c) => c.errorMessage !== null)
    .map((c) => ({ toolName: c.toolName, errorMessage: c.errorMessage }));

  const historySummary = input.history.map((h) => ({
    pass: h.pass,
    verdict: h.verdict,
    failedInvariant: h.failedInvariant,
    replanHint: h.replanHint,
  }));

  return JSON.stringify(
    {
      질문: input.question,
      카테고리: input.category,
      오늘: input.now.toISOString(),
      plan: planJson,
      tool_결과: toolResultsSummary,
      tool_오류: toolErrorsSummary,
      이전_critic_시도: historySummary,
    },
    null,
    2,
  );
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparseable: s };
  }
}

/** Parsed critic LLM verdict — narrowed shape used internally. */
type LlmCriticPayload = {
  verdict: CriticVerdict;
  reason: string;
  replanHint?: string;
  disclaimer?: string;
  failedInvariant?: string;
};

/**
 * Parses the LLM's JSON response. Defensive — if the model returns
 * something off-schema (despite json_schema strict mode), we surface a
 * synthetic retry rather than throwing into the orchestrator.
 */
function parseCriticPayload(content: unknown): LlmCriticPayload {
  let raw: unknown = content;
  if (typeof content === "string") {
    try {
      raw = JSON.parse(content);
    } catch {
      return {
        verdict: "retry",
        reason: "Critic LLM이 JSON이 아닌 응답을 반환했습니다.",
        replanHint: "planner가 같은 plan으로 다시 시도하도록 하세요.",
      };
    }
  }
  if (!raw || typeof raw !== "object") {
    return {
      verdict: "retry",
      reason: "Critic LLM 응답을 객체로 해석할 수 없습니다.",
      replanHint: "planner가 같은 plan으로 다시 시도하도록 하세요.",
    };
  }
  const obj = raw as Record<string, unknown>;
  const verdict =
    obj.verdict === "ok" || obj.verdict === "retry" ? obj.verdict : "retry";
  const reason = typeof obj.reason === "string" ? obj.reason : "사유 누락";
  const out: LlmCriticPayload = { verdict, reason };
  if (typeof obj.replanHint === "string" && obj.replanHint.length > 0) {
    out.replanHint = obj.replanHint;
  }
  if (typeof obj.disclaimer === "string" && obj.disclaimer.length > 0) {
    out.disclaimer = obj.disclaimer;
  }
  if (typeof obj.failedInvariant === "string" && obj.failedInvariant.length > 0) {
    out.failedInvariant = obj.failedInvariant;
  }
  return out;
}

/**
 * The real critic. Calls `invokeLLM` with the structured plan + tool
 * results + invariant checklist and parses the verdict JSON.
 *
 * The injectable `deps.invokeLlmCritic` exists for tests that want to
 * skip the prompt-construction path entirely; if present, it is called
 * directly and the result returned verbatim. Production path always
 * goes through `invokeLLM` so the prompt + schema stay live.
 */
export async function llmCritic(
  input: CriticInput,
  deps: CriticDeps = {},
): Promise<CriticCall> {
  if (deps.invokeLlmCritic) {
    return deps.invokeLlmCritic(input);
  }
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const pass = input.history.length + 1;

  const userPayload = buildCriticUserPayload(input);
  const res = await invokeLLM({
    messages: [
      { role: "system", content: CRITIC_SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "critic_verdict",
        strict: true,
        schema: CRITIC_OUTPUT_SCHEMA,
      },
    },
  });

  const content = res.choices?.[0]?.message?.content ?? "";
  const parsed = parseCriticPayload(content);

  return {
    pass,
    verdict: parsed.verdict,
    reason: parsed.reason,
    replanHint:
      parsed.verdict === "retry"
        ? parsed.replanHint ?? "planner가 같은 plan을 다시 시도하지 말고 다른 조합을 시도하세요."
        : null,
    disclaimer: parsed.disclaimer ?? null,
    failedInvariant: parsed.failedInvariant ?? null,
    startedAt,
    finishedAt: clock(),
    usedLlm: true,
  };
}

/**
 * Orchestrator-facing entry point. Runs `staticPreCheck` first; if static
 * is silent, runs `llmCritic`. Always emits exactly one CriticCall.
 *
 * Commit 2 wires only the static-short-circuit path. The LLM branch
 * still throws via `llmCritic` until commit 3 fills it in.
 */
export async function evaluatePlan(
  input: CriticInput,
  deps: CriticDeps = {},
): Promise<CriticCall> {
  const staticResult = staticPreCheck(input, deps);
  if (staticResult !== null) {
    return staticResult;
  }
  return llmCritic(input, deps);
}

/* ---------- Internal exports for tests ---------- */

export const __test__ = {
  CRITIC_SYSTEM_PROMPT,
  CRITIC_OUTPUT_SCHEMA,
  buildCriticUserPayload,
  parseCriticPayload,
  previewToolResult,
};
