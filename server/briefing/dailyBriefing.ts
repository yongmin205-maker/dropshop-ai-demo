/**
 * server/briefing/dailyBriefing.ts
 *
 * LLM-written Korean overnight summary of yesterday's POS activity.
 * Designed to be:
 *   - Idempotent: same `briefingDate` overwrites via ON DUPLICATE KEY.
 *   - Fail-safe: LLM failure still writes a row with fallback summary.
 *   - DI-friendly: tests pass `loadMetrics`/`invokeLLMFn` overrides.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { dailyBriefings } from "../../drizzle/schema";
import { invokeLLM, type InvokeResult, type Message } from "../_core/llm";
import {
  loadDailyMetrics as defaultLoadDailyMetrics,
  type DailyMetrics,
} from "../analytics/dailyMetrics";

const SOURCE_DEFAULT = "cleancloud" as const;
const FALLBACK_SUMMARY = "(브리핑 생성 실패 — 잠시 후 다시 시도)";

export interface RunDailyBriefingArgs {
  briefingDate: string; // YYYY-MM-DD in NYC
  source?: "cleancloud" | "dropshop_pos";
  loadMetrics?: (args: {
    briefingDate: string;
    source: "cleancloud" | "dropshop_pos";
  }) => Promise<DailyMetrics>;
  invokeLLMFn?: (messages: Message[]) => Promise<InvokeResult>;
}

export interface RunDailyBriefingResult {
  briefingDate: string;
  summaryMarkdown: string;
  metrics: DailyMetrics;
  llmModel: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
}

export function buildBriefingPrompt(metrics: DailyMetrics): Message[] {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const sign = (pct: number) => (pct >= 0 ? `+${pct}` : `${pct}`);

  const facts = [
    `브리핑 대상 영업일: ${metrics.briefingDate} (NYC 04:00 → 다음날 04:00)`,
    `총 주문 수: ${metrics.orderCount}건`,
    `총 매출: ${dollars(metrics.revenueCents)}`,
    `평균 주문 금액: ${dollars(metrics.avgOrderCents)}`,
    `결제 완료 주문: ${metrics.paidCount}건`,
    `급송 주문(express): ${metrics.expressCount}건`,
    `유니크 손님 수: ${metrics.uniqueCustomerCount}명 (신규 ${metrics.newCustomerCount} · 재방문 ${metrics.returningCustomerCount})`,
    `내일 픽업 예정 주문: ${metrics.pickupTomorrowCount}건`,
    metrics.revenueDeltaPct !== null
      ? `전일 대비 매출: ${sign(metrics.revenueDeltaPct)}%`
      : `전일 대비 매출: 비교 불가 (전일 데이터 부족)`,
    metrics.orderCountDeltaPct !== null
      ? `전일 대비 주문 수: ${sign(metrics.orderCountDeltaPct)}%`
      : `전일 대비 주문 수: 비교 불가`,
    `최대 단일 주문 금액: ${dollars(metrics.largestOrderCents)}`,
    metrics.topSpenders.length > 0
      ? `상위 고객 (${metrics.topSpenders
          .map(
            (s) =>
              `${s.externalId.slice(0, 8)}: ${dollars(s.revenueCents)} / ${s.orderCount}건`,
          )
          .join(", ")})`
      : "상위 고객 데이터 없음",
  ].join("\n");

  return [
    {
      role: "system",
      content: [
        "당신은 NYC에서 드라이클리닝 매장을 운영하는 점주를 위한 데이터 분석 어시스턴트입니다.",
        "어제의 POS 데이터를 점주가 출근 전 1분 안에 읽을 수 있게 한국어로 요약합니다.",
        "",
        "출력 규칙:",
        "- 4~7문장 (혹은 짧은 단락 2~3개).",
        "- 마크다운 사용 가능 (굵은 글씨, 짧은 표 1개까지).",
        "- 헤드라인 한 문장으로 시작.",
        "- 매출/주문 수/손님 구성/특이점 순으로 다룸.",
        "- 데이터에 없는 사실은 추측하지 말 것.",
        "- 친근한 존댓말.",
        "- 끝에 한 줄 운영 제안.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `다음 데이터를 바탕으로 어제 매장 운영 요약을 작성해주세요:\n\n${facts}`,
    },
  ];
}

export function extractTextContent(result: InvokeResult): string {
  const choice = result.choices?.[0];
  if (!choice) return "";
  const c = choice.message.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

export async function runDailyBriefing(
  args: RunDailyBriefingArgs,
): Promise<RunDailyBriefingResult> {
  const source = args.source ?? SOURCE_DEFAULT;
  const loadMetrics = args.loadMetrics ?? defaultLoadDailyMetrics;
  const invokeLLMFn = args.invokeLLMFn ?? ((m: Message[]) => invokeLLM({ messages: m }));

  const metrics = await loadMetrics({ briefingDate: args.briefingDate, source });

  let summaryMarkdown = FALLBACK_SUMMARY;
  let llmModel: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let errorMessage: string | null = null;

  try {
    const messages = buildBriefingPrompt(metrics);
    const result = await invokeLLMFn(messages);
    const text = extractTextContent(result);
    if (text.length > 0) summaryMarkdown = text;
    llmModel = result.model ?? null;
    promptTokens = result.usage?.prompt_tokens ?? null;
    completionTokens = result.usage?.completion_tokens ?? null;
  } catch (err) {
    errorMessage = String((err as Error).message ?? err).slice(0, 480);
  }

  const db = await getDb();
  if (db) {
    const insertValues = {
      briefingDate: metrics.briefingDate,
      periodStartMs: String(metrics.periodStartMs),
      periodEndMs: String(metrics.periodEndMs),
      metrics,
      summaryMarkdown,
      llmModel,
      promptTokens,
      completionTokens,
      errorMessage,
    };
    await db
      .insert(dailyBriefings)
      .values(insertValues)
      .onDuplicateKeyUpdate({
        set: {
          periodStartMs: insertValues.periodStartMs,
          periodEndMs: insertValues.periodEndMs,
          metrics: insertValues.metrics,
          summaryMarkdown: insertValues.summaryMarkdown,
          llmModel: insertValues.llmModel,
          promptTokens: insertValues.promptTokens,
          completionTokens: insertValues.completionTokens,
          errorMessage: insertValues.errorMessage,
          generatedAt: new Date(),
        },
      });
  }

  return {
    briefingDate: metrics.briefingDate,
    summaryMarkdown,
    metrics,
    llmModel,
    promptTokens,
    completionTokens,
    errorMessage,
  };
}

export async function getLatestBriefing() {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(dailyBriefings).limit(200);
  if (rows.length === 0) return null;
  return rows.sort((a, b) => (a.briefingDate > b.briefingDate ? -1 : 1))[0];
}

export async function getBriefingByDate(briefingDate: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(dailyBriefings)
    .where(eq(dailyBriefings.briefingDate, briefingDate))
    .limit(1);
  return rows[0] ?? null;
}

export async function listBriefings(limit = 30) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(dailyBriefings).limit(200);
  return rows
    .sort((a, b) => (a.briefingDate > b.briefingDate ? -1 : 1))
    .slice(0, limit);
}
