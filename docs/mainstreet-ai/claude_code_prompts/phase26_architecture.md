# Phase 26 Architecture — Owner Assistant Critic Loop

**Role:** Claude Code, Architect hat. No code yet — interface + pseudocode + invariant list + critic prompt draft + test matrix.
**Branch:** `phase26/critic-loop` (post-PM commit `57e5e79`).
**Locked PM decisions:** Q1 hybrid (static = guard rail, LLM = real critic), Q2 plan+results only (no synth), Q3 fresh planner w/ extra system context, Q4 critic-authored disclaimer (≤60 tokens, owner-friendly tone).

## 1. Module surface (`server/ownerAssistant/critic.ts`)

```ts
// New types — extends types.ts
export type CriticVerdict = "ok" | "retry";

export type CriticCall = {
  pass: number;                       // 1-indexed
  verdict: CriticVerdict;
  reason: string;                     // KR, ≤2 sentences, populated in every verdict
  replanHint: string | null;          // KR, present iff verdict === "retry"
  disclaimer: string | null;          // KR, ≤60 tokens, present iff result is partial / uncertain (per Q4)
  failedInvariant: string | null;     // "I3", "I2", "S1", etc — for trace UI + tests
  startedAt: number;
  finishedAt: number;
  usedLlm: boolean;                   // false when static pre-check forced verdict
};

export type CriticInput = {
  question: string;
  category: QuestionCategory;
  plan: PlanStep[];
  toolResults: Record<string, unknown>;   // keyed `${toolName}#${stepIndex}` (matches executor.ts)
  toolCalls: ToolCall[];                  // includes per-step errorMessage
  now: Date;
  history: CriticCall[];                  // previous passes this turn (empty on first pass)
};

// Two-stage entry point. Static pre-check FIRST; LLM critic only when static is silent.
export function staticPreCheck(input: CriticInput): CriticCall | null;
export async function llmCritic(input: CriticInput): Promise<CriticCall>;
export async function evaluatePlan(input: CriticInput): Promise<CriticCall>;
```

### Static pre-check semantics (per Q1 clarification)

Static **cannot** stamp `"ok"` — it can only short-circuit to `"retry"` when a hard spec violation is detected. Anything semantic falls through to LLM critic. Static rules:

- **S1**: Every plan step's `argsJson` parses as JSON.
- **S2**: Every plan step's args pass that tool's `inputSchema.safeParse`. (Planner's `validatePlanArgs` already does this, but we re-check at critic time to defend against planner regressions.)
- **S3**: Plan is non-empty for non-smalltalk/non-out_of_scope categories.
- **S4**: If every tool step has `errorMessage !== null`, force retry (no useful data to synthesize from).

If any S1–S4 fires → `usedLlm: false`, `verdict: "retry"`, `replanHint` synthesized from the violated rule. **Cost saving applies only here.**
If none fire → fall through to LLM critic (`llmCritic`) — this is the real critic.

## 2. Orchestrator loop (`server/ownerAssistant/agent.ts`)

```
const MAX_CRITIC_PASSES = 2;     // brief §2 cap
const WALL_CLOCK_BUDGET_MS = 25_000;  // see DP2

router → category                                // hop 1
if (smalltalk || out_of_scope) {
  synth → answer                                 // hop 2; trace.criticCalls = []
  return
}

planResult = planTools(question, category, now)  // hop 2 (or 2-3 if planner retried internally)
criticHistory: CriticCall[] = []
let finalDisclaimer: string | null = null

for (pass = 1; pass <= MAX_CRITIC_PASSES; pass++) {
  toolRun = executePlan(plan.steps, ctx)         // not an LLM hop

  criticInput = { question, category, plan: planResult.steps, toolResults, toolCalls, now, history: criticHistory }
  verdict = evaluatePlan(criticInput)            // static pre-check first; LLM critic if S1-S4 silent
  criticHistory.push(verdict)
  finalDisclaimer = verdict.disclaimer

  if (verdict.verdict === "ok") break
  if (pass === MAX_CRITIC_PASSES) {
    // 2nd retry still failing → graceful degrade.
    // Use this critic's reason as the disclaimer source per DP3-(a).
    finalDisclaimer = verdict.disclaimer ?? verdict.reason
    break
  }

  // Replan: fresh planTools() call with extra system context = verdict.replanHint
  // (Q3 — option a). Planner sees the hint as an additional system message,
  // NOT a step-targeted diff.
  planResult = planTools(question, category, now, { extraContext: verdict.replanHint })
}

synth(answer, { disclaimer: finalDisclaimer })   // hop N; disclaimer appended to answer if present
return { answer, trace: { ..., criticCalls: criticHistory } }
```

### Hop accounting (worst-case happy / retry / abort)

| Path | LLM hops | Typical wall time |
|---|---|---|
| smalltalk | router + synth = 2 | ~3s |
| happy, static-ok-via-LLM-critic | router + planner + critic + synth = 4 | ~12s |
| happy, static-flag-on-pass-1 + replan + LLM-critic-pass-2-ok | router + plan + critic1 + plan2 + critic2 + synth = 6 | ~18s |
| abort (2 retries, both fail) | same 6 hops, last is replan failure → synth gets disclaimer | ~18s |

Per-LLM call timeout: 30s (Gemini transport default, untouched). Orchestrator wall budget: **25s** (DP2).

### Timeout distribution

Hard ceiling per LLM call stays at 30s. Orchestrator runs a `Promise.race` with a 25s `setTimeout`; on timeout we emit a synthetic `{ verdict: "abort", disclaimer: "분석 시간이 초과되어 부분 결과만 보여드려요" }` and call synth with whatever toolResults we have. If the timeout fires before executePlan finishes, we send synth with empty results and the disclaimer.

## 3. Critic invariants

### Static (deterministic, no LLM)
- **S1** Plan step args parse as JSON.
- **S2** Plan step args pass tool `inputSchema`.
- **S3** Plan is non-empty for non-smalltalk/oos.
- **S4** Not all tools failed.

### LLM-judgment invariants (the actual semantic critic)

- **I1 Category × tool family match.** Lookup question → lookup tool family. Aggregate → aggregate. Compare → compare. Mis-route = retry.
- **I2 Fair-pace required for in-progress comparison.** Question contains "이번 달/주/분기" + compareTimeWindows used → `mode === "fair-pace"` required. Missing = retry.
- **I3 dayOfWeek required for weekday-grouping question.** Question contains "요일" / "어느 요일" + aggregateRevenue used → `groupBy === "dayOfWeek"` required. Other values = retry.
- **I4 Window length consistent with temporal modifier.** "지난 주" ⇒ 7-day window; "지난 달" ⇒ ~30-day window; "최근 2주" ⇒ 14-day window. Off by > 2x = retry.
- **I5 Tool args internally consistent.** `windowA.from < windowA.to`; `windowB.from < windowB.to`; `windowA.from < windowB.from` (older first). Violations = retry.
- **I6 0-row reasonability.** rowCount === 0 — distinguish legitimate vs anomaly.
  - "신규 SKU 매출", post-midnight "오늘 매출", "60일 이상 안 온 손님 (전부 최근에 옴)" — **legitimate**, verdict ok, disclaimer optional.
  - "평일 점심 매출 0", "어제 영업 중 신규 손님 0" — **anomaly**, verdict retry, replanHint = "다른 윈도우 또는 다른 tool로 재확인 (mirror 동기화 의심)".
- **I7 Partial failure recoverable?** Some tools failed but others succeeded — can we still answer? If yes, verdict ok with disclaimer; if not, retry.

Each I_n maps to a `failedInvariant` string the trace UI surfaces.

## 4. Critic prompt draft (KR)

### System message

```
당신은 매장 점주 질문에 대한 tool 호출 계획과 결과를 검토하는 critic입니다.
평가 대상은 (1) 점주 질문, (2) planner가 만든 plan, (3) executor가 실행한 tool 결과 입니다.
**synthesizer가 최종적으로 쓸 한국어 답변은 평가하지 않습니다 — 그 단계 전에 멈춥니다.**

verdict 룰:
- "ok" — plan과 결과가 점주 의도와 일치. invariant 위반 없음.
- "retry" — plan에 의미적 결함이 있음. replanHint 필드에 planner가 다음 시도에서 어떻게 고쳐야 할지 1-2 문장으로 적어라.

invariant 체크리스트 (코드 ID는 trace에 surface된다):
- I1 카테고리/도구 정렬: lookup 질문에 aggregate tool, 또는 그 반대를 쓰면 retry.
- I2 fair-pace: 질문이 "이번 달/주/분기" 같은 진행 중 기간을 풀-기간과 비교하는데 compareTimeWindows mode != "fair-pace" 이면 retry.
- I3 dayOfWeek: 질문에 "요일" / "어느 요일" 표현이 있는데 aggregateRevenue groupBy != "dayOfWeek" 이면 retry.
- I4 window 길이: "지난 주"는 7일 윈도우, "지난 달"은 ~30일, "최근 2주"는 14일. 2배 이상 벗어나면 retry.
- I5 args 일관성: windowA.from < windowA.to, windowA.from < windowB.from (오래된 것이 앞).
- I6 0-row 판단: rowCount=0이 자연스러운지(예: 60일 동안 안 온 손님이 0명 — 모두 최근에 옴, 정상) 아니면 anomaly(예: 평일 점심인데 매출 0 — 미러 동기화 의심)인지. anomaly면 retry, legitimate면 ok + disclaimer 한 줄.
- I7 부분 실패: tool 일부만 실패했을 때, 남은 데이터로 답할 수 있으면 ok + disclaimer, 못 답하면 retry.

disclaimer 필드 룰:
- ok이든 retry이든 점주에게 추가로 알릴 게 있으면 한 줄 한국어로 적어라.
- 60 토큰 이내. 점주 친화 톤(정중하되 굳지 않게).
- 예: "오늘 매출은 아직 안 들어왔어요. 어제까지 기준입니다." / "지난주는 정상, 이번 주는 진행 중이라 같은 일수로 잘라 비교했어요."

출력 JSON 스키마: { verdict: "ok"|"retry", reason: string, replanHint?: string, disclaimer?: string, failedInvariant?: string }
```

### User message template

```
질문: {question}
카테고리: {category}
오늘: {nowIso}

plan:
{planJson}

tool 결과 (요약):
{toolResultsSummary}            // rows count + first-3-row preview per step

tool 실행 오류 (있으면):
{toolErrorsSummary}

이전 critic 시도들 (있으면):
{historySummary}                // verdict + failedInvariant + replanHint per pass
```

### `response_format` JSON schema

```ts
{
  type: "json_schema",
  json_schema: {
    name: "critic_verdict",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "reason"],
      properties: {
        verdict: { type: "string", enum: ["ok", "retry"] },
        reason: { type: "string", maxLength: 300 },
        replanHint: { type: "string", maxLength: 300 },
        disclaimer: { type: "string", maxLength: 240 },  // ≤60 KR tokens ≈ 240 chars
        failedInvariant: { type: "string", enum: ["I1","I2","I3","I4","I5","I6","I7","S1","S2","S3","S4"] }
      }
    }
  }
}
```

## 5. Test matrix (regression net)

Pin 6 cases (brief asks ≥5). Each fixture seeds tool stubs via `vi.mock` and asserts on the final `criticCalls[]` shape.

| # | Question | Static? | Expected invariant | Expected plan after critic | Replans |
|---|---|---|---|---|---|
| 1 | "지난 달 대비 이번 달 매출" | pass | I2 ok (planner already emits fair-pace post-8f3e333) | compareTimeWindows `mode='fair-pace'` | 0 |
| 2 | "60일 이상 안 온 손님" | pass | I6 ok-legitimate | findInactiveCustomers defaults | 0 |
| 3 | "최근 2주 단골 동향" | pass | I4 ok | aggregateRepeatCustomers 14d window | 0 |
| 4 | "지난 주 어떤 요일이 매출 좋아" | pass | I3 retry → ok on pass 2 | aggregateRevenue `groupBy='dayOfWeek'` 7d | 1 |
| 5 | "이번 달 매출 어땠어" + stub returns rowCount=0 at weekday-lunch fixture time | pass | I6 retry (anomaly) → ok on pass 2 after replan widens window | aggregateRevenue with broader window | 1 |
| 6 | Fixture: planner emits `compareTimeWindows({})` | **S2 fires** | retry (static), `usedLlm: false` | properly populated args after replan | 1 |
| 7 | Fixture: critic returns retry on both passes | n/a | abort path | last `criticCall.disclaimer` becomes the synth disclaimer; answer suffixed with it | 2 (both fail) |

User's 4 named fixtures → mapped:
- "0-row legitimate" → case 2 (60-day inactive) + variant: new SKU, post-midnight.
- "0-row anomaly" → case 5.
- "args semantically wrong" → cases 4 (groupBy) + 1's regression variant (drop fair-pace and confirm critic catches it).
- "synth hallucinates" → **NOT covered by this phase** (per Q2 scope). Documented gap below.

## 6. What we are NOT covering (Q2 scope boundary)

Per Q2: critic evaluates plan + tool results, not synthesizer output. The user's 4th fixture ("synthesizer hallucinates a store name not in data") is therefore **outside Phase 26's safety net**. Mitigation lives in:
1. The existing synthesizer system prompt's "추측 금지" rule (unchanged).
2. The synthesizer's `Tool results JSON` user message wrapping — the model only sees what tools returned, so out-of-tool fabrication is already low-probability.
3. **Phase 27 follow-up**: an answer-grounding critic pass. Out of scope today; tracked as a known gap in `todo.md` after Coder commit.

## 7. Decision points for user

Two required (brief asks ≥2); two optional.

**DP1. Confirm static pre-check semantics.** My read of your Q1: static can only short-circuit to `retry` on hard spec violations (S1–S4). Static CANNOT stamp `ok` — that's always the LLM critic's job. So the cost-saving from "hybrid" applies only when the plan is schema-broken. Confirm this is what you meant; if you instead want static to be able to stamp `ok` on an allowlist of trivially-good plans (e.g. `findInactiveCustomers` with default args + non-zero rows), say so and I'll add an `S0` allowlist rule before the LLM critic.

**DP2. Wall-clock budget.** I'm proposing 25s for the whole agent loop (router + plan + critic + replan + critic2 + synth). Beyond that, abort with a synthetic disclaimer "분석 시간이 초과되어 부분 결과만 보여드려요". This leaves headroom inside Cloud Run's 30s tRPC mutation timeout. OK, or a different number?

**DP3 (optional). Abort disclaimer source.** When pass 2's critic returns `retry` and we run out of budget, we use that critic call's own `disclaimer` field (which it always populates, per the prompt). Sub-question: if the 2nd-pass critic's disclaimer is empty (model didn't fill it), fall back to its `reason` string? My lean: yes, fall back to reason; otherwise we'd need a 3rd critic call just to author the disclaimer.

**DP4 (optional). Trace UI density.** `criticCalls[]` lands as a separate array next to `toolCalls[]` in `AgentTrace`. The UI panel renders critic passes as their own row block (1-2 rows for the typical happy path, 4 rows for full retry). Confirm OK, or do you want them inline with the tool calls in chronological order?

## 8. Files Architect commits in this turn

Just `docs/mainstreet-ai/claude_code_prompts/phase26_architecture.md`. No code yet. Coder role starts after your DP1/DP2 answers + any objections to invariants / prompt draft / test matrix.

Waiting on DP1, DP2 (DP3/DP4 if you have a view).
