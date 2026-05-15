/**
 * Router LLM — classifies the Owner's question into one of seven
 * QuestionCategory values. The classification gates everything that
 * follows:
 *   - smalltalk / out_of_scope → bypass the Planner + Executor;
 *     Synthesizer answers directly.
 *   - everything else → continue to the Planner.
 *
 * We pick gemini-2.5-flash (project default) over a heavier model
 * because the classification is shape-trivial and we want this hop to
 * cost ~no latency. Tests stub invokeLLM directly.
 */

import { invokeLLM } from "../_core/llm";
import {
  QuestionCategorySchema,
  type QuestionCategory,
} from "./types";

export type RouterResult = {
  category: QuestionCategory;
  reasoning: string;
};

const SYSTEM_PROMPT = `당신은 매장 점주의 자연어 질문을 다음 7개 카테고리 중 하나로 분류합니다.
- lookup: 특정 손님 1명 또는 특정 주문 1건을 찾는 질문. 예: "Andrew Kim 정보", "주문 1234 상태".
- aggregate: 매출, 신규 손님 수, 단골 수, 비활성 손님 같은 집계 질문. 예: "지난 달 매출", "60일 이상 안 온 손님".
- compare: 두 시간 구간을 비교하는 질문. 예: "지난 주 vs 이번 주", "4월 대비 5월".
- action: 메시지 발송, 데이터 수정 같은 실제 변경. Phase 25c는 read-only이므로 action은 거절될 수 있음.
- search_text: 손님 메모나 주문 메모의 본문 검색 (RAG). Phase 25c 범위 밖.
- smalltalk: 인사, 감사, 잡담. tool 없이 친절히 답변할 것.
- out_of_scope: 재고, 직원 시급, 임대료 같이 우리 데이터에 없는 질문.

판단이 모호하면 가장 가까운 카테고리로. 무조건 둘 중 하나는 골라야 함 (out_of_scope도 정상 응답).`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "reasoning"],
  properties: {
    category: {
      type: "string",
      enum: [
        "lookup",
        "aggregate",
        "compare",
        "action",
        "search_text",
        "smalltalk",
        "out_of_scope",
      ],
    },
    reasoning: { type: "string", maxLength: 400 },
  },
} as const;

export type RouteFn = (question: string) => Promise<RouterResult>;

export const routeQuestion: RouteFn = async (question) => {
  const res = await invokeLLM({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "router_classification",
        strict: true,
        schema: OUTPUT_SCHEMA,
      },
    },
  });
  const content = res.choices?.[0]?.message?.content ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof content === "string" ? content : "{}");
  } catch {
    parsed = {};
  }
  const cat = QuestionCategorySchema.safeParse(
    (parsed as { category?: unknown }).category,
  );
  return {
    category: cat.success ? cat.data : "out_of_scope",
    reasoning:
      typeof (parsed as { reasoning?: unknown }).reasoning === "string"
        ? ((parsed as { reasoning: string }).reasoning ?? "")
        : "",
  };
};
