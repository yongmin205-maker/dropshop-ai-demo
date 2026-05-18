/**
 * Planner LLM — given a categorized question and the tool catalogue,
 * produces an ordered list of tool calls to execute. Hard caps:
 *   - max 5 tool calls per plan (cost + UX)
 *   - if the model returns >5 tools, we retry once with an explicit
 *     "shorten to 5" hint. The second attempt is also capped; we
 *     simply truncate if it still over-produces.
 *
 * The Planner gets only the *names + descriptions* of tools. Arg
 * schemas are validated by the Executor (zod parse). This keeps the
 * Planner's prompt small (every turn pays the token cost) and the
 * error surface honest — bad args become trace errors, not a stuck
 * Planner.
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
import { toolCatalogueForPrompt } from "./tools";

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
- 날짜/시간 값은 모두 ISO 8601 UTC ("2026-05-18T00:00:00Z" 형식). "지난주", "이번 달" 같은 한국어 표현은 오늘 시각 기준으로 ISO로 변환해서 채워라. 예: 오늘이 5/18이면 "이번 달"=2026-05-01~2026-06-01, "지난 달"=2026-04-01~2026-05-01.
- compareTimeWindows의 windowA/windowB는 각각 {from, to} 객체로 두 기간을 채워라. metric은 revenue/order_count/new_customer_count/repeat_visit_count 중 하나.
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

type RawPlan = {
  plan: Array<{ toolName: string; args: unknown; reason?: string }>;
};

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

export const planTools: PlanFn = async (question, category, now) => {
  const prompt1 = basePrompt(now);
  let raw = await callPlanner(prompt1, question, category);
  let llmCalls = 1;

  if (raw.plan.length > MAX_PLAN_STEPS) {
    // Retry once with an explicit shorten-to-N hint. Plan length is
    // mostly the LLM not internalizing the cap; one nudge usually
    // fixes it. Track the hop so the orchestrator's llmCallCount
    // matches reality — pre-fix it inferred this from the returned
    // length, but we slice() below so that signal was lost.
    const prompt2 =
      basePrompt(now) +
      `\n\n중요: 직전에 ${raw.plan.length}개 tool 호출이 나왔습니다. ${MAX_PLAN_STEPS}개 이하로 줄이세요. 가장 중요한 tool만 유지.`;
    raw = await callPlanner(prompt2, question, category);
    llmCalls = 2;
  }

  const steps: PlanStep[] = raw.plan.slice(0, MAX_PLAN_STEPS).flatMap((s) => {
    // Defensive: drop anything that isn't a recognized tool name.
    if (!TOOL_NAMES.includes(s.toolName as (typeof TOOL_NAMES)[number])) {
      return [];
    }
    return [
      {
        toolName: s.toolName as PlanStep["toolName"],
        argsJson: JSON.stringify(s.args ?? {}),
        reason: typeof s.reason === "string" ? s.reason : "",
      },
    ];
  });
  return { steps, llmCalls };
};

export const PLANNER_MAX_PLAN_STEPS = MAX_PLAN_STEPS;
