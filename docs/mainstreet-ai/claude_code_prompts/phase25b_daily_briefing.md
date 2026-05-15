# Claude Code Prompt — Phase 25b Daily Briefing Rebuild

> Copy everything **between** the `BEGIN PROMPT` / `END PROMPT` markers into Claude Code. The file you are reading right now is just notes for the human; do NOT include this header section in the paste.

---

## Notes for the human (do not paste)

- This rebuilds the Daily Briefing service that was lost in a sandbox reset on 2026-05-15.
- Run Claude Code in your **local clone** of `dropshop-ai-demo` (path: wherever you cloned `yongmin205-maker/dropshop-ai-demo`). Do NOT paste this into Manus's sandbox.
- Before starting Claude Code, run: `git pull origin main` to be on top of the current `main` (HEAD `749ff12f`).
- Claude Code should NOT need any new env vars. The existing `BUILT_IN_FORGE_API_KEY`, `DATABASE_URL`, `OWNER_OPEN_ID`, `OWNER_NAME`, `CLEANCLOUD_WEBHOOK_SECRET` are sufficient.
- After Claude Code finishes, you commit + push, then I (Manus) pull on the sandbox side and continue with Phase 25c.

---

## BEGIN PROMPT

You are an agentic coding assistant working inside a clone of the `dropshop-ai-demo` Node.js + tRPC + Drizzle (MySQL/TiDB) project. Your job is to **rebuild Phase 25b — the Daily Briefing service** that was lost during a sandbox reset, and commit+push the result. This is a self-contained rebuild: every file path, function signature, schema column, test expectation, and external integration point you need is given below.

Work autonomously. Do not stop to ask the human for clarification — every decision has been pre-made. If something looks ambiguous, prefer the most boring, conservative interpretation (no creative refactors, no renaming existing things, no reformatting unrelated files).

---

### 1. Project context (already on disk; verify, do not recreate)

The repo already contains the Phase 25a vendor-neutral POS mirror tables. You can confirm by inspecting `drizzle/schema.ts`. The existing tables you will read FROM are:

- `posCustomers(id, source, externalId, name, phoneE164, syncedAt, createdAt, updatedAt, ...)`
- `posOrders(id, source, externalId, customerExternalId, status, finalTotalCents, paid, completed, express, placedAt, pickupAt, deliveryAt, syncedAt, ...)` — `status` is enum `POS_ORDER_STATUSES` (e.g. `received`, `in_progress`, `ready`, `delivered`, `cancelled`).
- `posPayments(id, source, externalId, orderExternalId, amountCents, type, paidAt, ...)`
- `posProducts(id, source, externalId, name, category, priceCents, ...)`
- `posSyncLog(id, source, trigger, endpoint, startedAt, finishedAt, rowsFetched, rowsUpserted, error, ...)`
- `posProductChanges(id, source, externalId, kind, oldPriceCents, newPriceCents, productName, syncLogId, detectedAt)`

The `source` enum value is `"cleancloud"` for our pilot store.

The existing scheduled-handler that fires the daily POS pull is at `server/integrations/cleancloud/scheduledHandler.ts` and is mounted in `server/_core/index.ts` via `registerCleanCloudDailyPullCron(app)` at line ~50. **Mirror that exact pattern** for the new briefing handler. Do not invent a new auth scheme.

LLM helper is `server/_core/llm.ts` exporting `invokeLLM({ messages, response_format? })`. Look at `server/aiAgent.ts:96` for an exact call-site example with JSON schema. Use it the same way.

DB helper is `server/db.ts` exporting `getDb()` (returns a Drizzle MySql2Database or null when DB is unavailable in tests) and `withTransaction(fn)`. Always import `getDb` from `"../db"` (one level up from `server/briefing/` and `server/analytics/`).

Owner notification helper is `server/_core/notification.ts` exporting `notifyOwner({ title, content }) → Promise<boolean>`. It returns false when the upstream is unavailable; do not throw on false.

Env constants are in `server/_core/env.ts` (`ENV.cleanCloudWebhookSecret`, `ENV.ownerOpenId`, etc.). Do not add new env vars.

The tRPC root router is `server/routers.ts`. Procedures use `adminProcedure`, `protectedProcedure`, `publicProcedure` exported from `server/_core/trpc.ts`. The Phase 25a `posMirror` sub-router lives at the bottom of `appRouter`. Add the new `briefing` sub-router right after `posMirror`.

The frontend root tabs are in `client/src/pages/Home.tsx`. The admin gating pattern is `const isAdmin = user?.role === "admin"` (line 84) and adds tabs like `{isAdmin && <TabsTrigger value="errors">Errors</TabsTrigger>}` at line 326 plus a matching `<TabsContent>` block lower down at ~line 353.

The streamdown markdown renderer is imported as `import { Streamdown } from "streamdown";` (used in `client/src/components/AIChatBox.tsx:7`).

Testing: `pnpm vitest run` runs everything. Server tests live next to the file (e.g. `server/foo.ts` + `server/foo.test.ts`). Client tests use `@testing-library/react` (see `client/src/components/SimpleModeToggle.test.tsx` for shape). Mock tRPC with `vi.mock("@/lib/trpc", () => ({ ... }))`.

Project DOES use ESM module resolution; relative imports do NOT need `.js` extensions (the tsx runtime handles it). Look at any existing `import { ... } from "./somefile"` for the convention.

NYC business-day window: A "business day" for the briefing is **04:00 America/New_York to 04:00 America/New_York the next day**. Use this 04:00 cutoff (not midnight) so late pickups after closing don't roll into the next morning's briefing. Convert to UTC for SQL: 04:00 ET ≈ 09:00 UTC during EDT (Mar-Nov), 04:00 ET ≈ 09:00 UTC during EST (Nov-Mar). For simplicity, compute the window in JavaScript using `Intl.DateTimeFormat` with `timeZone: "America/New_York"`, derive the local 04:00 boundary, then convert back to UTC `Date` objects for the DB query.

---

### 2. Files to create

#### 2.1 `drizzle/schema.ts` — append at the very end

Add a new table:

```ts
/**
 * Phase 25b — Daily Briefing storage.
 *
 * One row per (briefingDate, generatedAt). `briefingDate` is the YYYY-MM-DD
 * NYC-local date the briefing summarizes (i.e. the day that ENDED at the
 * 04:00 ET window close). The same date can have multiple rows if the user
 * regenerates manually (the latest by generatedAt wins for `briefing.latest`).
 *
 * `summaryMarkdown` is the LLM output. `metrics` is a snapshot of the raw
 * numbers used as input to the prompt — kept so the UI can render chips
 * without re-querying, AND so we can audit "did the LLM hallucinate that
 * 단골 number?" by comparing summary against metrics.
 *
 * `errorMessage` is non-null when generation partially failed (e.g. LLM
 * timeout, fixture-missing DB). The UI surfaces a banner in that case.
 */
export const dailyBriefings = mysqlTable("dailyBriefings", {
  id: int("id").autoincrement().primaryKey(),
  briefingDate: varchar("briefingDate", { length: 10 }).notNull(), // YYYY-MM-DD NYC
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
  summaryMarkdown: text("summaryMarkdown"),
  metrics: json("metrics"),
  errorMessage: text("errorMessage"),
});
export type DailyBriefing = typeof dailyBriefings.$inferSelect;
export type InsertDailyBriefing = typeof dailyBriefings.$inferInsert;
```

Then run `pnpm db:push` once to materialize the migration. If `db:push` complains about needing the DB to be reachable, that is fine — the migration file (`drizzle/0011_*.sql`) will still be generated and you can commit that. (Production DB will pick it up at next deploy; locally it doesn't matter for vitest because the tests stub the DB layer.)

#### 2.2 `server/analytics/dailyMetrics.ts`

Pure aggregation module. Two layers:
- **Layer A: pure math** — `computeDailyMetricsFromRows(rows: AggregationInput): DailyMetrics`. Takes already-fetched rows as plain arrays. No I/O. This is what the unit tests will exercise.
- **Layer B: DB loader** — `loadDailyMetricsForDate(briefingDate: string): Promise<DailyMetrics>`. Loads rows from the DB then calls Layer A. This is what the LLM/agent calls.

Types:

```ts
export type AggregationInput = {
  briefingDate: string; // YYYY-MM-DD NYC
  windowStart: Date;    // UTC, inclusive
  windowEnd: Date;      // UTC, exclusive (next day 04:00 ET)
  orders: Array<{
    externalId: string;
    customerExternalId: string | null;
    status: string;
    finalTotalCents: number;
    paid: number; // 0/1
    placedAt: Date | null;
    pickupAt: Date | null;
  }>;
  payments: Array<{ amountCents: number; paidAt: Date | null }>;
  customersAllTime: Array<{
    externalId: string;
    firstSeenAt: Date | null;
    visitCount: number;
  }>;
  productsByExternalId: Map<string, { name: string }>;
  itemsSummariesByOrder: Map<string, Array<{ productExternalId: string; quantity: number }>>;
};

export type DailyMetrics = {
  briefingDate: string;
  windowStart: string; // ISO
  windowEnd: string;   // ISO
  revenueCents: number;
  orderCount: number;
  paidOrderCount: number;
  unpaidOrderCount: number;
  newCustomerCount: number;       // customers whose firstSeenAt ∈ window
  returningCustomerCount: number; // distinct customers in window who have visitCount > 1
  avgOrderValueCents: number;
  todayPickupCount: number;       // orders with pickupAt ∈ NEXT day's window (the morning AFTER briefingDate)
  topProducts: Array<{ name: string; orderCount: number }>; // top 3 by appearance in itemsSummary
  anomalies: Array<{ kind: string; message: string }>; // e.g. "큰 주문: $XXX > 평균*3"
};
```

Anomaly detection rules (Layer A):
1. Any order whose `finalTotalCents` is greater than `3 * avgOrderValueCents` (when avg > 0) → anomaly `kind: "large_order"`, message in Korean.
2. Day with zero orders but customers added → `kind: "no_orders"`.
3. More than 30% of orders unpaid → `kind: "unpaid_spike"`.
4. New-customer ratio above 50% → `kind: "newcomer_surge"`.

Window logic for new vs returning: a customer is **new** if their `firstSeenAt` falls within `[windowStart, windowEnd)`. Returning = distinct customers in the window minus new.

Top products: aggregate `itemsSummariesByOrder.values()`, count appearances per `productExternalId`, look up `name` via `productsByExternalId`, sort desc, slice 3.

Layer B (`loadDailyMetricsForDate`):
1. Compute window bounds from `briefingDate` using `Intl.DateTimeFormat` (zone `America/New_York`, hour 4).
2. Query orders where `placedAt >= windowStart AND placedAt < windowEnd AND source='cleancloud'`.
3. Query payments where `paidAt >= windowStart AND paidAt < windowEnd AND source='cleancloud'`.
4. Query all `posCustomers` (we need firstSeenAt, modeled as `min(syncedAt) GROUP BY externalId` if there's no `firstSeenAt` column — there isn't yet, so for Stage 0 derive `firstSeenAt = MIN(posOrders.placedAt) WHERE customerExternalId = c.externalId`). Visit count = `COUNT(*) FROM posOrders WHERE customerExternalId = c.externalId`.
5. Query `posProducts` (small table) to populate `productsByExternalId`.
6. Build `itemsSummariesByOrder` from `posOrders.itemsSummary` JSON column (already an array per order).
7. Call `computeDailyMetricsFromRows(...)`.

If `getDb()` returns null (test/no-DB context), `loadDailyMetricsForDate` throws `new Error("DB unavailable")`.

#### 2.3 `server/analytics/dailyMetrics.test.ts`

Cover **Layer A only** (pure math). DB tests come later. Aim for 20+ cases:

- Empty day: zero everything, no anomalies.
- Single paid order: revenue, orderCount, paidOrderCount, avgOrderValue all line up.
- Mixed paid/unpaid: counts split correctly, unpaid_spike triggers when >30%.
- New-customer detection: customer with `firstSeenAt = windowStart + 1h` counted as new.
- Returning detection: customer with `firstSeenAt = windowStart - 7d` counted as returning.
- Large order anomaly: 3 orders $50/$60/$200, avg $103, $200 < 309 → no anomaly. Then 3 orders $50/$60/$1000, avg $370, $1000 > 1110? No → tweak fixture so $1500 > 3 * $400 = $1200 → anomaly fires.
- Top products: 5 orders consuming products A×3, B×2, C×1, D×1 → top-3 = A, B, then tie on C/D (both have 1 — pick whichever the sort is stable on; assert the top-3 length and that A is first).
- Pickup count: pickup window = NEXT day's 04:00-04:00 ET window. Order with `pickupAt` inside that window counts; order with `pickupAt` 2 days later doesn't.
- Newcomer surge: 6 customers, 4 are new → ratio 67% → anomaly fires.
- No orders but 1 new customer added (firstSeenAt in window via no-order path? Skip this case if it's ambiguous; document).

Use vi.fn() / no I/O. All expectations on the returned `DailyMetrics` object.

#### 2.4 `server/briefing/dailyBriefing.ts`

```ts
import { invokeLLM } from "../_core/llm";
import { loadDailyMetricsForDate, type DailyMetrics } from "../analytics/dailyMetrics";
import { getDb } from "../db";
import { dailyBriefings } from "../../drizzle/schema";

export type RunBriefingResult = {
  ok: boolean;
  briefingId: number | null;
  briefingDate: string;
  errorMessage: string | null;
};

export type RunBriefingDeps = {
  loadMetrics?: (date: string) => Promise<DailyMetrics>;
  llm?: typeof invokeLLM;
  insertBriefing?: (row: {
    briefingDate: string;
    summaryMarkdown: string | null;
    metrics: DailyMetrics | null;
    errorMessage: string | null;
  }) => Promise<{ id: number }>;
  notify?: (payload: { title: string; content: string }) => Promise<boolean>;
};

/**
 * Run today's briefing. Idempotent in the sense that re-running for the
 * same `briefingDate` ALWAYS inserts a new row (briefing.latest reads
 * MAX(generatedAt)), so a manual regenerate after a bad LLM call is safe.
 *
 * `briefingDate` defaults to "yesterday in NYC" — the day that ENDED at
 * the most recent 04:00 ET cutoff. So if this runs at 07:00 ET on Tue,
 * it summarizes Mon 04:00 ET → Tue 04:00 ET.
 */
export async function runDailyBriefing(opts: {
  briefingDate?: string;
  notifyOwnerOnSuccess?: boolean;
  deps?: RunBriefingDeps;
} = {}): Promise<RunBriefingResult> { /* ... */ }
```

The function:
1. Resolve `briefingDate` (NYC-local YYYY-MM-DD of yesterday).
2. Try `loadMetrics(briefingDate)`. If it throws, insert an error row, return `{ ok: false }`.
3. Build the LLM prompt (Korean, see below) and call `invokeLLM({ messages, response_format: undefined })` — we want plain markdown, not JSON.
4. Insert a row with `summaryMarkdown` + `metrics` + `errorMessage = null`.
5. If `notifyOwnerOnSuccess`, call `notifyOwner({ title: "오늘의 매장 브리핑", content: <first 280 chars of summary> })`. Don't fail the briefing if the notify returns false; just record the boolean in step logs.
6. Return success.

**LLM system prompt (Korean):**

```
당신은 미국 뉴욕에서 운영되는 동네 드라이클리닝 매장의 매니저 보조입니다.
점주가 매일 아침 출근 전에 어제 매장이 어땠는지 5초 안에 파악할 수 있도록
짧고 명료한 브리핑을 한국어로 작성합니다.

규칙:
- 길이는 4-6 문장. 절대 7 문장을 넘기지 마세요.
- 첫 문장은 어제의 한 줄 요약 (매출 + 주문 건수 + 톤).
- 둘째~넷째 문장은 점주가 알아야 할 가장 중요한 인사이트 1-2개
  (예: 단골 vs 신규, 평소 대비 어땠는지, 큰 주문, 재방문 패턴).
- 마지막 문장은 오늘 픽업 예정 + 점주가 챙겨야 할 한 가지.
- 숫자는 정확하게 인용하되, 너무 많이 나열하지 마세요.
- 반드시 사실 기반 (제공된 metrics 안의 숫자와 anomaly만 사용).
  추측, 비교 데이터 없는 단정, 가짜 트렌드 금지.
- 점주에게 친근한 반말체가 아니라 정중한 ~합니다 체.
- markdown 헤더(#, ##) 사용 금지. 짧은 문단 한두 개로 끝내세요.
```

**LLM user prompt:**

```
어제의 매장 데이터입니다 (뉴욕 시간 기준):

날짜: {briefingDate}
영업 윈도우: {windowStart ISO} ~ {windowEnd ISO}

매출: ${revenueCents/100}
주문 수: {orderCount}건 (결제완료 {paidOrderCount}, 미결제 {unpaidOrderCount})
평균 주문 금액: ${avgOrderValueCents/100}
신규 손님: {newCustomerCount}명
재방문 손님: {returningCustomerCount}명
오늘 픽업 예정: {todayPickupCount}건

상위 인기 품목: {topProducts.map(p => `${p.name} (${p.orderCount}건)`).join(", ")}

특이 신호 (있을 경우 반드시 언급):
{anomalies.map(a => `- ${a.kind}: ${a.message}`).join("\n")}

위 데이터를 기반으로 오늘 아침 브리핑을 작성해주세요.
```

Failure modes to handle:
- `loadMetrics` throws → `errorMessage = "Metrics 로드 실패: " + err.message`, no LLM call, insert row with `summaryMarkdown = null`.
- `invokeLLM` throws → `errorMessage = "LLM 호출 실패: " + err.message`, insert row with `summaryMarkdown = null` but `metrics` populated.
- `insertBriefing` throws → return `{ ok: false }` with `briefingId: null`.
- `notify` returns false → log it, do NOT mark briefing as failed.

#### 2.5 `server/briefing/dailyBriefing.test.ts`

11+ cases covering the orchestrator with all-stubbed deps:

- Happy path: metrics load OK, LLM returns text, insert called, notify called when flag true.
- Notify NOT called when `notifyOwnerOnSuccess=false`.
- Metrics-load failure: errorMessage set, LLM NOT called, briefing row inserted with summary null.
- LLM failure: errorMessage set, briefing row inserted with metrics populated, summaryMarkdown null.
- Insert failure: returns `{ok: false, briefingId: null}`.
- Notify-returns-false: briefing still considered ok.
- briefingDate defaults to NYC yesterday (mock current Date and assert).
- Long LLM output gets persisted in full (no truncation server-side; UI handles overflow).
- LLM prompt contains all metric chips literally (regex assertion on the user-message string captured by stubbed llm).
- LLM prompt includes any anomalies present in metrics.
- Korean system prompt verbatim (assert presence of "어제의 매장 데이터" or "5초 안에" substring).

#### 2.6 `server/briefing/scheduledHandler.ts`

Mirror `server/integrations/cleancloud/scheduledHandler.ts`:

```ts
import type { Express, Request, Response } from "express";
import { runDailyBriefing } from "./dailyBriefing";
import { ENV } from "../_core/env";

const CRON_HEADER = "x-manus-cron-task-uid";
const SHARED_SECRET_HEADER = "x-cleancloud-cron-secret"; // reuse same secret

export function registerDailyBriefingCron(app: Express) {
  app.post(
    "/api/scheduled/daily-briefing",
    async (req: Request, res: Response) => {
      const expected = ENV.cleanCloudWebhookSecret;
      const provided =
        (req.headers[SHARED_SECRET_HEADER] as string | undefined) ??
        (req.query.secret as string | undefined);
      const cronTaskUid = req.headers[CRON_HEADER] as string | undefined;
      if (expected && provided !== expected && !cronTaskUid) {
        return res.status(403).json({ error: "forbidden" });
      }
      try {
        const result = await runDailyBriefing({ notifyOwnerOnSuccess: true });
        return res.status(result.ok ? 200 : 500).json({
          ...result,
          firedAt: new Date().toISOString(),
          taskUid: cronTaskUid ?? null,
        });
      } catch (err) {
        const e = err as Error;
        return res.status(500).json({
          error: e?.message ?? "unknown",
          stack: e?.stack ?? null,
          context: { url: req.originalUrl, taskUid: cronTaskUid ?? null },
          timestamp: new Date().toISOString(),
        });
      }
    }
  );
}
```

#### 2.7 `server/briefing/db.ts`

```ts
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { dailyBriefings, type DailyBriefing } from "../../drizzle/schema";

export async function getLatestBriefing(): Promise<DailyBriefing | null> { /* ORDER BY generatedAt DESC LIMIT 1 */ }

export async function getBriefingByDate(briefingDate: string): Promise<DailyBriefing | null> {
  /* WHERE briefingDate = ? ORDER BY generatedAt DESC LIMIT 1 */
}

export async function listBriefings(limit: number): Promise<DailyBriefing[]> {
  /* ORDER BY generatedAt DESC LIMIT N. Default cap at 50. */
}
```

#### 2.8 `server/_core/index.ts` — mount the new handler

Add the import + the `register...` call right next to the existing CleanCloud one:

```ts
import { registerDailyBriefingCron } from "../briefing/scheduledHandler";
// ...
registerCleanCloudDailyPullCron(app);
registerDailyBriefingCron(app);
```

#### 2.9 `server/routers.ts` — add the briefing tRPC sub-router

At the top, add imports:

```ts
import { runDailyBriefing } from "./briefing/dailyBriefing";
import { getLatestBriefing, getBriefingByDate, listBriefings } from "./briefing/db";
```

Right after the `posMirror` router block (just before the closing `})` of `appRouter = router({...})`), add:

```ts
/* ---------- Phase 25b: Daily Briefing ---------- */
briefing: router({
  /** Latest briefing (for "오늘의 브리핑" hero card). */
  latest: adminProcedure.query(async () => {
    return getLatestBriefing();
  }),
  /** Briefing for a specific NYC date (history drill-down). */
  byDate: adminProcedure
    .input(z.object({ briefingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(({ input }) => getBriefingByDate(input.briefingDate)),
  /** Recent briefings list (default 30, hard cap 50). */
  list: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(30) }).default({}))
    .query(({ input }) => listBriefings(input.limit)),
  /** Manually generate now (e.g. before the 07:00 ET cron has fired today). */
  generateNow: adminProcedure
    .input(z.object({ notify: z.boolean().default(false) }).default({}))
    .mutation(async ({ input }) => {
      const result = await runDailyBriefing({ notifyOwnerOnSuccess: input.notify });
      return result;
    }),
}),
```

(Watch the trailing comma — match the existing style.)

#### 2.10 `client/src/components/DailyBriefingPanel.tsx`

Component that renders:
1. Hero card with: briefing date (formatted as "5월 14일 (목)"), "지금 다시 생성" admin button, error banner when `errorMessage != null`, MetricsChips row, full markdown summary via `<Streamdown>`.
2. History card listing the last 30 briefings as clickable rows showing date + revenue + order count.

Use shadcn ui components (`Card`, `CardHeader`, `CardTitle`, `CardContent`, `Badge`, `Button`, `Skeleton`, `Alert`). Use `lucide-react` icons (`AlertCircle`, `RefreshCw`, `ChevronRight`).

Korean locale for weekday: `["일", "월", "화", "수", "목", "금", "토"][date.getUTCDay()]` after constructing date with `Date.UTC(y, m-1, d)`.

Mutations: `trpc.briefing.generateNow.useMutation({ onSuccess: invalidate latest+list, onError: toast })`. Default `notify: false` for manual regen.

The 8 metric chips (in Korean):
| Label | Value |
|---|---|
| 매출 | $X.XX |
| 주문 | N건 |
| 결제완료 | N건 |
| 미결제 | N건 |
| 평균 주문 | $X.XX |
| 신규 손님 | N명 |
| 재방문 | N명 |
| 오늘 픽업 예정 | N건 |

#### 2.11 `client/src/components/DailyBriefingPanel.test.tsx`

6 cases:
- Empty state ("아직 생성된 브리핑이 없습니다" copy).
- Loaded state shows revenue chip "$452.00" + order chip "8건" + summary text.
- Error state shows "일부 단계가 실패했습니다" banner.
- Regenerate button click triggers mutation with `{ notify: false }`.
- History rows render dates "5월 14일", "5월 13일" — use `getAllByText(...).length >= 1` because the hero header also contains the date.
- Korean weekday formatting (e.g. 2026-05-14 → "5월 14일 (목)").

Mock pattern (top of test file):

```ts
const stub = {
  latestData: null as Row | null,
  latestLoading: false,
  historyData: [] as Row[],
  historyLoading: false,
  mutateSpy: vi.fn(),
};
vi.mock("@/lib/trpc", () => ({
  trpc: {
    briefing: {
      latest: { useQuery: () => ({ data: stub.latestData, isLoading: stub.latestLoading }) },
      list: { useQuery: () => ({ data: stub.historyData, isLoading: stub.historyLoading }) },
      generateNow: {
        useMutation: (opts: any) => ({
          mutate: (args: unknown) => { stub.mutateSpy(args); opts?.onSuccess?.(); },
          isPending: false,
        }),
      },
    },
    useUtils: () => ({ briefing: { latest: { invalidate: vi.fn() }, list: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
```

#### 2.12 `client/src/pages/Home.tsx` — add the admin tab

Two edits:

(a) Right after `import { useAuth } from "@/_core/hooks/useAuth";` add:

```tsx
import DailyBriefingPanel from "@/components/DailyBriefingPanel";
```

(b) In the desktop tabs section near line 326, change:

```tsx
<TabsTrigger value="rag">RAG Memory</TabsTrigger>
{isAdmin && <TabsTrigger value="errors">Errors</TabsTrigger>}
```

to:

```tsx
<TabsTrigger value="rag">RAG Memory</TabsTrigger>
{isAdmin && <TabsTrigger value="briefing">브리핑</TabsTrigger>}
{isAdmin && <TabsTrigger value="errors">Errors</TabsTrigger>}
```

And add a matching `<TabsContent>` block right before the existing `errors` content block (~line 353):

```tsx
{isAdmin && (
  <TabsContent forceMount value="briefing" className="mt-3 data-[state=inactive]:hidden">
    <DailyBriefingPanel />
  </TabsContent>
)}
```

Do NOT touch the mobile tabs section unless tests request it.

---

### 3. Run order

1. Append `dailyBriefings` to `drizzle/schema.ts`.
2. Try `pnpm db:push` (if DB unreachable, that's fine — commit the generated migration file).
3. Create the 5 server files (`analytics/dailyMetrics.ts`, `briefing/dailyBriefing.ts`, `briefing/scheduledHandler.ts`, `briefing/db.ts`, plus their `.test.ts` files except scheduledHandler — that one can skip dedicated unit tests since the body is glue and is exercised by the dailyBriefing tests).
4. Run `pnpm tsc --noEmit` — fix any type errors.
5. Run `pnpm vitest run server/analytics server/briefing` — should be all green.
6. Mount in `_core/index.ts`.
7. Add to `routers.ts`.
8. Re-run `pnpm tsc --noEmit`.
9. Create `DailyBriefingPanel.tsx` + `.test.tsx`.
10. Wire into `Home.tsx`.
11. Run `pnpm vitest run client/src/components/DailyBriefingPanel.test.tsx`.
12. Run the **full** suite: `pnpm vitest run`. Target: all previously-passing tests still pass, **475+ pass total**, fewer than 10 skipped, zero failed.
13. `git add -A && git commit -m "Phase 25b — Daily Briefing service rebuild after sandbox reset"` and `git push origin main`.

---

### 4. Decisions already made — do not change

- Single 03:00 ET POS pull cron is already running (task_uid `3kzaRy73L7wQ9M4D9DyL3B`). The 07:00 ET briefing cron (task_uid `5wdNx6YKseqreEiHJrGx9y`) is **also already registered** on the platform side. Do NOT re-register or touch any heartbeat config. The platform will hit `/api/scheduled/daily-briefing` once the next deploy lands; your job is just to make sure that endpoint exists and works.
- The shared secret header is `x-cleancloud-cron-secret` (reused across the two scheduled endpoints — correct, intentional).
- briefingDate format: `YYYY-MM-DD`, NYC-local, the date that ENDED at the most recent 04:00 ET cutoff.
- Markdown summary is pure text (no `# headers`).
- LLM model: leave it to `invokeLLM`'s default (gemini-2.5-flash). Do not set the model.
- All briefing analytics queries are scoped to `source = 'cleancloud'` for now.
- One owner. No multi-tenant. No role beyond `admin`/`user`.
- No new env vars. No new dependencies.
- Idempotency: re-running `runDailyBriefing` for the same date inserts a NEW row. UI reads by `MAX(generatedAt)`. This is intentional because the manual "지금 다시 생성" button needs to win over a stale earlier row.

---

### 5. Hard constraints

- **No `git reset --hard`** under any circumstances. If you make a mistake, fix forward.
- **Do not modify** any file outside the list in section 2 unless tsc forces you to (e.g. an existing file imports something you renamed — but you should not be renaming anything).
- **Do not delete** existing tests. If a test's expectation conflicts with your new code, the new code is wrong; debug it.
- **Do not** add `webdev_*` calls or Manus-specific tooling. This is a vanilla Node/pnpm workflow.
- **Korean is the primary user-facing language** for the briefing copy and panel. English in code comments is fine.
- All file writes use forward-slash paths. The repo runs cross-platform.
- Tests must be deterministic — no `new Date()` outside of explicit injection points.

When done, summarize:
- All files created (paths).
- Total vitest count: pass / fail / skip.
- Any tsc warnings still outstanding.
- The exact commit hash of the push.

## END PROMPT
