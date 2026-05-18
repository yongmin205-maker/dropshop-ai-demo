/**
 * Planner LLM — given a categorized question and the tool catalogue,
 * produces an ordered list of tool calls to execute. Hard caps:
 *   - max 5 tool calls per plan (cost + UX)
 *   - if the model returns >5 tools, we retry once with an explicit
 *     "shorten to 5" hint. The second attempt is also capped; we
 *     simply truncate if it still over-produces.
 *
 * Args validation:
 *   The Planner system prompt already shows `argsExample` for every
 *   tool, but the JSON schema surface we hand to Gemini only types
 *   `args` as `{ type: "object", additionalProperties: true }` — so
 *   the model can technically satisfy the schema by emitting `{}` and
 *   the Executor then zod-fails the step ("Input validation failed").
 *
 *   To close that hole we run each step's args through the tool's own
 *   `inputSchema` *here* (before the Executor sees it). If any step
 *   fails, we re-call the LLM with a repair prompt that quotes the
 *   bad step + zod error + argsExample, and keep only steps whose
 *   args parse on the second pass. Steps still bad after repair are
 *   dropped (best-effort) so the rest of the plan can still run.
 *
 * The Planner is also told today's date so date math
 * ("지난 2주", "오늘") is grounded in real time and not the model's
 * training cutoff.
 */

import { invokeLLM } from "../_core/llm";
import {
  TOOL_NAMES,
  type PlanResult,
  type PlanStep,
  type QuestionCategory,
} from "./types";
import { TOOL_REGISTRY, toolCatalogueForPrompt } from "./tools";

const MAX_PLAN_STEPS = 5;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: {
    plan: {
      type: "array",
      maxItems: 10, // we'll truncate to MAX_PLAN_STEPS in code; the
      // schema is loose so the Planner doesn't refuse on overflow.
      items: {
        type: "object",
        additionalProperties: false,
        required: ["toolName", "args", "reason"],
        properties: {
          toolName: {
            type: "string",
            enum: [...TOOL_NAMES],
          },
          args: { type: "object", additionalProperties: true },
          reason: { type: "string", maxLength: 200 },
        },
      },
    },
  },
} as const;

function basePrompt(now: Date): string {
  const isoNow = now.toISOString();
  const catalogue = toolCatalogueForPrompt()
    .map(
      (t) =>
        `- ${t.name} (${t.category}): ${t.description}\n  args 예시: ${JSON.stringify(t.argsExample)}`,
    )
    .join("\n");
  return `당신은 매장 점주 질문에 답하기 위한 tool 호출 계획을 세웁니다.
오늘 시각: ${isoNow} (UTC).

사용 가능한 tool 목록 (각 tool 아래에 args 예시가 함께 있습니다):
${catalogue}

규칙:
- 최대 ${MAX_PLAN_STEPS}개 tool 호출까지. 짧을수록 좋음.
- 각 step의 args는 위 "args 예시"와 **같은 필드명/형태**로 채워라. argsExample이 {}인 tool(countActiveGarments, aggregateRevenueLive)을 제외하고는 절대 빈 객체 {}를 반환하지 말 것.
- 날짜/시간 값은 모두 ISO 8601 UTC ("2026-05-18T00:00:00Z" 형식). "지난주", "이번 달" 같은 한국어 표현은 오늘 시각 기준으로 ISO로 변환해서 채워라. 예: 오늘이 5/18(월)이면 "이번 달"=2026-05-01~2026-06-01, "지난 달"=2026-04-01~2026-05-01, "지난 주"=2026-05-11~2026-05-18 (월→월 7일 윈도우), "이번 주"=2026-05-18~2026-05-25.
- 요일별("어느 요일에 매출이 제일 높았냐") 질문에는 aggregateRevenue의 groupBy 값을 "dayOfWeek"로 설정해야 함. "day"로 두면 날짜별 일별 매출이 나와 원하는 답이 안 됨.
- compareTimeWindows의 windowA/windowB는 각각 {from, to} 객체로 두 기간을 채워라. metric은 revenue/order_count/new_customer_count/repeat_visit_count 중 하나. 절대 args를 빈 객체로 두지 말 것 — 두 기간을 명시적으로 채워야 한다.
- 같은 tool을 두 번 부르지 말 것 — 같은 데이터를 두 번 가져오지 않음.
- aggregate 질문에 lookup tool을 쓰지 말 것. lookup 질문에 aggregate tool을 쓰지 말 것.
- "오늘" / "방금 영업 중"이 아닌 과거 기간 질문에는 mirror tools (aggregateRevenue 등)를 쓸 것. live tools는 오늘자 전용.
- reason은 짧은 한국어 한 줄.
`;
}

export type PlanFn = (
  question: string,
  category: QuestionCategory,
  now: Date,
) => Promise<PlanResult>;

type RawPlanStep = { toolName: string; args: unknown; reason?: string };
type RawPlan = { plan: RawPlanStep[] };

async function callPlanner(
  prompt: string,
  question: string,
  category: QuestionCategory,
): Promise<RawPlan> {
  const res = await invokeLLM({
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: `Category: ${category}\nQuestion: ${question}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "owner_assistant_plan",
        strict: true,
        schema: OUTPUT_SCHEMA,
      },
    },
  });
  const content = res.choices?.[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(typeof content === "string" ? content : "{}");
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.plan)) {
      return parsed as RawPlan;
    }
  } catch {
    /* fall through */
  }
  return { plan: [] };
}

type ValidationResult = {
  validSteps: RawPlanStep[];
  /** Steps that failed zod validation, with the zod error message
   *  surface so the repair prompt can quote it back to the LLM. */
  badSteps: Array<{ step: RawPlanStep; error: string }>;
};

/**
 * Run each step's args through its tool's zod inputSchema. Splits the
 * plan into validated + needs-repair buckets. Unknown tool names are
 * dropped silently (planner enum guarantees they shouldn't appear,
 * but we still defend).
 *
 * Phase 25-enrich-2 hardening: if the LLM emitted args that fail zod but
 * argsExample is a valid default (e.g. findInactiveCustomers takes
 * `{ inactiveDays?, minPriorVisits? }` and the example `{}` parses fine
 * thanks to zod defaults), we accept the step with argsExample patched in.
 * This rescues the common case where Gemini omits a tool's optional args.
 */
function validatePlanArgs(plan: RawPlan): ValidationResult {
  const validSteps: RawPlanStep[] = [];
  const badSteps: ValidationResult["badSteps"] = [];
  for (const s of plan.plan) {
    if (!TOOL_NAMES.includes(s.toolName as (typeof TOOL_NAMES)[number])) {
      continue;
    }
    const tool = TOOL_REGISTRY[s.toolName as (typeof TOOL_NAMES)[number]];
    const parsed = tool.inputSchema.safeParse(s.args);
    if (parsed.success) {
      validSteps.push(s);
      continue;
    }
    // Salvage attempt: try argsExample as the args (covers the case
    // where the LLM dropped optional fields but the tool has defaults).
    const argsAreEmpty =
      s.args == null ||
      (typeof s.args === "object" && Object.keys(s.args as object).length === 0);
    if (argsAreEmpty) {
      const fallback = tool.inputSchema.safeParse(tool.argsExample);
      if (fallback.success) {
        validSteps.push({ ...s, args: tool.argsExample });
        continue;
      }
    }
    badSteps.push({
      step: s,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    });
  }
  return { validSteps, badSteps };
}

function buildRepairPrompt(
  basePrompt: string,
  badSteps: ValidationResult["badSteps"],
): string {
  const lines = badSteps.map(({ step, error }) => {
    const tool = TOOL_REGISTRY[step.toolName as (typeof TOOL_NAMES)[number]];
    const example = tool ? JSON.stringify(tool.argsExample) : "{}";
    return `- ${step.toolName}: 직전 args=${JSON.stringify(step.args)}, 에러="${error}". args 예시: ${example}`;
  });
  return `${basePrompt}

중요(반드시 수정): 직전 응답에서 다음 step들의 args가 검증에 실패했습니다. 각 step의 args를 "args 예시"와 같은 필드/형태로 다시 채워서 plan 전체를 재생성하세요. 빈 객체 {}는 절대 금지(argsExample이 {}인 tool 제외).
${lines.join("\n")}`;
}

export const planTools: PlanFn = async (question, category, now) => {
  const prompt1 = basePrompt(now);
  let raw = await callPlanner(prompt1, question, category);
  let llmCalls = 1;

  // Length-cap retry (existing behavior).
  if (raw.plan.length > MAX_PLAN_STEPS) {
    const lengthRetry =
      basePrompt(now) +
      `\n\n중요: 직전에 ${raw.plan.length}개 tool 호출이 나왔습니다. ${MAX_PLAN_STEPS}개 이하로 줄이세요. 가장 중요한 tool만 유지.`;
    raw = await callPlanner(lengthRetry, question, category);
    llmCalls += 1;
  }

  // Args validation — split into valid/bad and, if any bad, retry with
  // a repair prompt that quotes the offending step + zod error.
  let validation = validatePlanArgs(raw);
  if (validation.badSteps.length > 0) {
    const repairPrompt = buildRepairPrompt(basePrompt(now), validation.badSteps);
    const repaired = await callPlanner(repairPrompt, question, category);
    llmCalls += 1;
    const repairedValidation = validatePlanArgs(repaired);
    // Merge: keep originally-valid steps PLUS any newly valid steps from
    // the repaired plan that weren't already in the valid set. Order is
    // preserved as (original valid, repaired-only valid). This way one
    // bad step doesn't tank the whole plan, even when repair only
    // partially succeeds.
    if (repairedValidation.validSteps.length > 0) {
      const existingNames = new Set(
        validation.validSteps.map((s) => s.toolName),
      );
      const merged = [
        ...validation.validSteps,
        ...repairedValidation.validSteps.filter(
          (s) => !existingNames.has(s.toolName),
        ),
      ];
      validation = { validSteps: merged, badSteps: repairedValidation.badSteps };
    }
  }

  const steps: PlanStep[] = validation.validSteps
    .slice(0, MAX_PLAN_STEPS)
    .map((s) => ({
      toolName: s.toolName as PlanStep["toolName"],
      argsJson: JSON.stringify(s.args ?? {}),
      reason: typeof s.reason === "string" ? s.reason : "",
    }));
  return { steps, llmCalls };
};

export const PLANNER_MAX_PLAN_STEPS = MAX_PLAN_STEPS;

/* ---------- Test-only exports ---------- */
export const __test__ = {
  validatePlanArgs,
  buildRepairPrompt,
  basePrompt,
};
