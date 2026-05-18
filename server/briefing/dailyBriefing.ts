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
import { fetchNycWeather, type WeatherSummary } from "./weather";

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
  /** Inject for tests; production uses Open-Meteo via fetchNycWeather. */
  loadWeather?: (briefingDate: string) => Promise<WeatherSummary | null>;
}

export interface RunDailyBriefingResult {
  briefingDate: string;
  summaryMarkdown: string;
  metrics: DailyMetrics;
  weather: WeatherSummary | null;
  llmModel: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
}

export function buildBriefingPrompt(
  metrics: DailyMetrics,
  weather: WeatherSummary | null = null,
): Message[] {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const sign = (pct: number) => (pct >= 0 ? `+${pct}` : `${pct}`);
  const fmtHour = (h: number) => {
    const period = h < 12 ? "오전" : "오후";
    const display = h === 0 ? 12 : h <= 12 ? h : h - 12;
    return `${period} ${display}시`;
  };

  // Service mix line — top 3 categories by revenue, only when we
  // actually parsed any line items.
  const mixLine =
    metrics.serviceMix.length > 0
      ? `서비스 믹스 (상위 3): ${metrics.serviceMix
          .slice(0, 3)
          .map(
            (s) =>
              `${s.category} ${s.quantity}점${
                s.revenueCents > 0 ? `/${dollars(s.revenueCents)}` : ""
              }`,
          )
          .join(", ")}`
      : "서비스 믹스: line item 데이터 없음";

  // Peak / hourly distribution — express it as one short sentence so
  // the LLM can fold it into the headline if relevant.
  const peakLine =
    metrics.peakHour !== null
      ? `피크 시간: ${fmtHour(metrics.peakHour)} (${
          metrics.hourlyDistribution.find((b) => b.hour === metrics.peakHour)
            ?.orderCount ?? 0
        }건)`
      : "피크 시간: 주문 없음";

  // Top spenders enriched with lifetime context the LLM can use to
  // call out 단골 vs 신규.
  const topSpenderLine =
    metrics.topSpenderProfiles.length > 0
      ? `상위 고객:\n${metrics.topSpenderProfiles
          .map((p) => {
            const tag = p.isReturning
              ? `단골 (전체 ${p.lifetimeOrderCount}건/${dollars(p.lifetimeRevenueCents)})`
              : "신규";
            return `  - ${p.externalId.slice(0, 8)}: 어제 ${dollars(p.revenueCents)}/${p.orderCount}건 · ${tag}`;
          })
          .join("\n")}`
      : "상위 고객: 데이터 없음";

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
    mixLine,
    peakLine,
    topSpenderLine,
    metrics.dowVsAvg
      ? `같은 요일 ${metrics.dowVsAvg.sampleCount}주 평균 대비: 매출 ${
          metrics.dowVsAvg.revenueDeltaPct === null
            ? "비교 불가"
            : `${sign(metrics.dowVsAvg.revenueDeltaPct)}%`
        } (평균 ${dollars(metrics.dowVsAvg.avgRevenueCents)}), 주문 수 ${
          metrics.dowVsAvg.orderCountDeltaPct === null
            ? "비교 불가"
            : `${sign(metrics.dowVsAvg.orderCountDeltaPct)}%`
        } (평균 ${metrics.dowVsAvg.avgOrderCount.toFixed(1)}건)`
      : `같은 요일 평균 대비: 비교 불가 (과거 같은 요일 데이터 없음)`,
    weather
      ? `날씨: ${weather.description} (최고 ${weather.tempMaxC.toFixed(1)}°C / 최저 ${weather.tempMinC.toFixed(1)}°C, 강수 ${weather.precipMm.toFixed(1)}mm)`
      : `날씨: 데이터 없음`,
  ].join("\n");

  return [
    {
      role: "system",
      content: [
        "당신은 NYC에서 드라이클리닝 매장을 운영하는 점주를 위한 데이터 분석 어시스턴트입니다.",
        "어제의 POS 데이터를 점주가 출근 전 1분 안에 읽을 수 있게 한국어로 요약합니다.",
        "",
        "출력 규칙:",
        "- 5~8문장 (또는 짧은 단락 2~3개). 헤드라인 한 문장으로 시작.",
        "- 친근한 존댓말, 마크다운 사용 가능 (굵은 글씨, 표 1개까지).",
        "- 다음 순서를 권장: 헤드라인 → 매출/주문/손님 구성 → 서비스 믹스·피크 시간 → 단골/신규 인사이트 → 운영 제안.",
        "- '특이한 점'이 보이면 1~2개 짚어주세요. 예: 평소보다 큰 주문, 특정 카테고리 비중 급변, 피크 시간 이동, 단골 0명, 같은 요일 평균 대비 ±20% 이상 매출 변동.",
        "- 날씨가 데이터에 있다면 매출/주문 패턴과 연결되는 부분이 있을 때만 언급하세요 (예: 비/눈으로 손님 줄었을 가능성, 더운 날 워시앤폴드 증가). 단순한 날씨 보고는 금지.",
        "- 같은 요일 평균 대비 매출/주문 변동이 ±20%를 넘으면 반드시 한 줄로 언급하세요.",
        "- 단골(재방문) 고객은 '단골' 또는 '재방문 고객'으로 부르고, 신규 고객은 '첫 방문 손님'으로 부르세요.",
        "- 데이터에 없는 사실은 절대 추측하지 마세요. 비교 불가 항목은 그렇다고 적으세요.",
        "- 끝에 한 줄로 오늘 실행 가능한 운영 제안 1개.",
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

  const loadWeather =
    args.loadWeather ?? ((d: string) => fetchNycWeather({ briefingDate: d }));

  const [metrics, weather] = await Promise.all([
    loadMetrics({ briefingDate: args.briefingDate, source }),
    loadWeather(args.briefingDate).catch(() => null),
  ]);

  let summaryMarkdown = FALLBACK_SUMMARY;
  let llmModel: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let errorMessage: string | null = null;

  try {
    const messages = buildBriefingPrompt(metrics, weather);
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
    weather,
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
