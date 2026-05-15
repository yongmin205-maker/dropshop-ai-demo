/**
 * Synthesizer LLM — takes the tool results + the Owner's original
 * question and writes a polished Korean answer. Rules:
 *   - 4~6 sentences max, optional one markdown table.
 *   - No fabrication: anything not in the results is "확인이 필요해요".
 *   - Always end with a freshness footer (data: 03:00 ET pull or
 *     "방금 확인한 실시간 데이터" when a live tool ran).
 *
 * For smalltalk / out_of_scope: no tool results, the model just
 * answers politely. The freshness footer is omitted because no data
 * was consulted.
 */

import { invokeLLM } from "../_core/llm";
import type { QuestionCategory, ToolCall } from "./types";

export type SynthesizeArgs = {
  question: string;
  category: QuestionCategory;
  results: Record<string, unknown>;
  toolCalls: ToolCall[];
  freshnessHint: string;
};

const SYSTEM_BASE = `당신은 매장 점주의 비서입니다. 도구 결과를 바탕으로 한국어로 친절히 답변하세요.

원칙:
- 4~6 문장 이내. 필요하면 markdown 파이프 표 1개 추가.
- 추측 금지. 도구 결과에 없는 숫자/이름/날짜는 만들지 말 것. 없으면 "데이터에 없어요"로.
- 화폐는 USD ($). cents → dollar 변환은 100으로 나눠 표시. 천 단위 구분 쉼표.
- 손님 이름이 비어있으면 "이름 미상" 또는 phoneE164 일부를 가린 형태로 ("+1******1234").
- 항상 마지막 줄에 데이터 fresh 정보 ("(데이터: …)") 한 줄 footer.

응답에는 답변 본문 + freshness footer 외에 다른 markdown 헤더 (#) 금지.`;

const SMALLTALK_PROMPT = `${SYSTEM_BASE}

이 질문은 일상 대화(smalltalk) 또는 우리 데이터 범위 밖(out_of_scope) 입니다. 도구는 호출되지 않았습니다. 친절하게 한두 문장으로 답변하세요. 데이터 footer는 생략합니다.`;

export type SynthesizeFn = (args: SynthesizeArgs) => Promise<string>;

export const synthesizeAnswer: SynthesizeFn = async (args) => {
  const isSmalltalkPath =
    args.category === "smalltalk" || args.category === "out_of_scope";

  const system = isSmalltalkPath ? SMALLTALK_PROMPT : SYSTEM_BASE;
  const userParts = [
    `Question: ${args.question}`,
    `Category: ${args.category}`,
  ];
  if (!isSmalltalkPath) {
    userParts.push(`Freshness hint to append as footer: "${args.freshnessHint}"`);
    userParts.push(
      `Tool results JSON:\n${JSON.stringify(args.results, null, 2)}`,
    );
    const failed = args.toolCalls.filter((c) => c.errorMessage);
    if (failed.length > 0) {
      userParts.push(
        `참고 — 일부 도구가 실패했습니다 (답변에서 한 줄로 짧게 양해):\n${failed
          .map((c) => `- ${c.toolName}: ${c.errorMessage}`)
          .join("\n")}`,
      );
    }
  }

  const res = await invokeLLM({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userParts.join("\n\n") },
    ],
  });
  const out = res.choices?.[0]?.message?.content;
  const text = typeof out === "string" ? out.trim() : "";
  if (text.length === 0) {
    return isSmalltalkPath
      ? "안녕하세요! 무엇을 도와드릴까요?"
      : `답변 생성 중 문제가 있었어요. 다시 시도해 주세요.\n\n(데이터: ${args.freshnessHint})`;
  }
  return text;
};
