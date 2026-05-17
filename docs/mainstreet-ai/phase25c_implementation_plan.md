# Phase 25c — Owner Assistant 구현 plan (코드 작성 직전 단계)

> 상위 디자인은 `agentic_owner_assistant.md`에 있음. 이 문서는 그 디자인을 **그대로 코드로 옮기기 위한 파일 맵 + 인터페이스 + 테스트 케이스**다. Claude Code가 25b 완료하는 즉시 이 문서대로 25c 코드 작성 시작한다.

## 0. 사전 가정 (이미 확정)

- 데이터 freshness: 매일 03:00 ET pull 1회 (Stage 0). Owner Assistant 답변에 "오늘 03:00 ET 기준" 또는 "방금 확인한 실시간 데이터" 명시.
- 사용자 1명 (점주). 권한 분리 없음. 모든 procedure는 `adminProcedure`.
- 백엔드 LLM 호출은 `server/_core/llm.ts`의 `invokeLLM` (gemini-2.5-flash) 그대로 사용.
- 프론트는 기존 `AIChatBox` 재사용. 채팅 페이지는 admin tab 또는 별도 라우트 `/owner-chat`.
- Latency 허용치 여유 — 30초 안팎 OK.
- Vendor-neutral mirror 스키마 (`posCustomers/posOrders/posPayments/posProducts/posSyncLog`) 위에서 작동. `source = 'cleancloud'` 하드코딩으로 시작.

## 1. 파일 맵

### Server

| 파일 | 책임 |
|---|---|
| `server/ownerAssistant/types.ts` | Tool input/output schema (zod) + `ToolDefinition` shape + `AgentContext`/`AgentTrace` |
| `server/ownerAssistant/tools/findCustomer.ts` | `findCustomerByPhoneOrName` 한 개 tool — pure DB lookup |
| `server/ownerAssistant/tools/orders.ts` | `getCustomerRecentOrders`, `getOrderDetails`, `getActiveOrdersByStatus` |
| `server/ownerAssistant/tools/aggregates.ts` | `aggregateRevenue`, `aggregateNewCustomers`, `aggregateRepeatCustomers`, `findInactiveCustomers` |
| `server/ownerAssistant/tools/compare.ts` | `compareTimeWindows` |
| `server/ownerAssistant/tools/livePos.ts` | `fetchLiveOrder`, `countActiveGarments`, `aggregateRevenueLive` (CleanCloud API 직호출) |
| `server/ownerAssistant/tools/index.ts` | `TOOL_REGISTRY` — 위 모든 tool을 한 객체로 export |
| `server/ownerAssistant/router.ts` | Router LLM — 질문 카테고리 분류 |
| `server/ownerAssistant/planner.ts` | Planner LLM — tool 호출 계획 생성 |
| `server/ownerAssistant/executor.ts` | 계획대로 tool 실행, trace 누적 |
| `server/ownerAssistant/synthesizer.ts` | Synthesizer LLM — 결과 자연어 답변 |
| `server/ownerAssistant/agent.ts` | 4단계 orchestrator, dependency injection 가능 |
| `server/ownerAssistant/db.ts` | 대화 영속화 helpers (`saveConversation`, `appendTurn`, `loadConversation`) |
| `server/ownerAssistant/agent.test.ts` | Orchestrator 단위 테스트 (LLM/DB 다 stub) |
| `server/ownerAssistant/tools/aggregates.test.ts` | Aggregate SQL 정확성 (테이블 fixture 기반) |
| `server/ownerAssistant/tools/findCustomer.test.ts` | 매칭 로직 (phone/name/email) |

### Frontend

| 파일 | 책임 |
|---|---|
| `client/src/pages/OwnerChat.tsx` | `/owner-chat` 페이지 — `AIChatBox` 래퍼 + freshness 헤더 + tool-call trace 펼침 |
| `client/src/components/OwnerAssistantTrace.tsx` | 어떤 tool이 호출됐는지 collapsible 박스로 노출 (debug + trust) |
| `client/src/pages/OwnerChat.test.tsx` | UI 렌더링 + send/loading 상태 |

### Schema

| 변경 | 내용 |
|---|---|
| `drizzle/schema.ts` 추가 | `ownerConversations`, `ownerMessages` 테이블 (대화 영속화) |

## 2. 핵심 타입 (server/ownerAssistant/types.ts)

```ts
import { z } from "zod";

export const QuestionCategory = z.enum([
  "lookup",         // 카테고리 1
  "aggregate",      // 카테고리 2
  "compare",        // 카테고리 3
  "action",         // 카테고리 4
  "search_text",    // 카테고리 5
  "smalltalk",      // greetings, "고마워" 같은 비-tool 응답
  "out_of_scope",   // 재고/직원 관리 등 우리 데이터 밖
]);

export type ToolName =
  | "findCustomerByPhoneOrName"
  | "getCustomerRecentOrders"
  | "getOrderDetails"
  | "getActiveOrdersByStatus"
  | "fetchLiveOrder"
  | "countActiveGarments"
  | "aggregateRevenueLive"
  | "aggregateRevenue"
  | "aggregateNewCustomers"
  | "aggregateRepeatCustomers"
  | "findInactiveCustomers"
  | "compareTimeWindows";

export type ToolDefinition<TIn, TOut> = {
  name: ToolName;
  category: z.infer<typeof QuestionCategory>;
  description: string;       // LLM이 보는 한국어 설명
  inputSchema: z.ZodType<TIn>;
  outputSchema: z.ZodType<TOut>;
  invoke(input: TIn, ctx: AgentContext): Promise<TOut>;
};

export type AgentContext = {
  source: "cleancloud";
  freshnessHint: string;     // "2026-05-15 03:00 ET 기준" 또는 "방금 확인한 실시간 데이터"
  now: Date;                 // injectable for tests
};

export type ToolCall = {
  toolName: ToolName;
  inputJson: string;
  outputJson: string;
  startedAt: number;         // epoch ms
  finishedAt: number;
  errorMessage: string | null;
};

export type AgentTrace = {
  question: string;
  category: z.infer<typeof QuestionCategory>;
  plan: Array<{ toolName: ToolName; argsJson: string; reason: string }>;
  toolCalls: ToolCall[];
  answerMarkdown: string;
  totalLatencyMs: number;
  llmCallCount: number;
};
```

## 3. Tool 구현 — 핵심 SQL 패턴

### 3.1 `findCustomerByPhoneOrName`

```ts
input: { query: string }
output: { customers: Array<{ id, externalId, name, phone, email, visitCount, lastSeenAt }> }
```

- `query`가 `^\+?\d[\d\s\-]{6,}$` 패턴이면 phone search → `posCustomers.phoneE164` LIKE `%digits%`.
- 그 외엔 name search → `posCustomers.name` LIKE `%query%`.
- email 후보면 `email = ?`.
- visitCount는 `(SELECT COUNT(*) FROM posOrders WHERE customerExternalId = c.externalId)` 서브쿼리.
- 최대 10명 반환. 더 있으면 `truncated: true` 플래그.

### 3.2 `getCustomerRecentOrders`

```ts
input: { externalId: string, limit: int = 10 }
output: { orders: Array<{ externalId, status, finalTotalCents, paid, placedAt, pickupAt, items[] }> }
```

- `posOrders` WHERE `source='cleancloud' AND customerExternalId = ?` ORDER BY `placedAt DESC` LIMIT ?
- `items[]`는 `posOrders.itemsSummary` JSON column. 각 item에 productName 매핑은 `posProducts` left join (있으면).

### 3.3 `aggregateRevenue`

```ts
input: { dateFrom: ISO, dateTo: ISO, groupBy: "day"|"week"|"month"|"dayOfWeek" }
output: { series: Array<{ bucket, revenueCents, orderCount }>, totalRevenueCents, totalOrderCount }
```

- 시간대 변환: 입력 ISO를 UTC 그대로 받아 `placedAt BETWEEN ? AND ?` 비교.
- groupBy=day: `DATE_FORMAT(CONVERT_TZ(placedAt, '+00:00', 'America/New_York'), '%Y-%m-%d')` (NYC local day).
- groupBy=dayOfWeek: `DAYNAME(CONVERT_TZ(placedAt, '+00:00', 'America/New_York'))`.
- groupBy=week: ISO week.
- 결제 안 된 주문도 매출에 포함할지 옵션? → 일단 `paid=1`만 매출로. Param `includeUnpaid: bool = false` 추가.

### 3.4 `aggregateRepeatCustomers`

```ts
input: { dateFrom: ISO, dateTo: ISO, minVisits: int = 2, lookbackDays: int = 90 }
output: { count, customers: [{ externalId, name, visitCountInWindow, lastSeenAt, totalSpendInWindow }] }
```

- 기간 내 주문이 있는 손님 중, `lookbackDays` 안에 `minVisits` 이상 방문한 사람만.
- 단골 정의 = customer X가 (now - lookbackDays) ~ now 사이에 minVisits번 이상 주문.
- 결과는 visit count desc.

### 3.5 `compareTimeWindows`

```ts
input: { windowA: {from, to}, windowB: {from, to}, metric: "revenue"|"order_count"|"new_customer_count"|"repeat_visit_count" }
output: { a: number, b: number, delta: number, deltaPct: number, summary: string }
```

- 동일 metric을 두 window에 대해 계산 → diff. summary는 한국어 한 줄 ("4월 대비 +14.6%").

### 3.6 `findInactiveCustomers`

```ts
input: { inactiveSinceDays: int = 60, minPriorVisits: int = 3, limit: int = 50 }
output: { customers: [{ externalId, name, lastSeenAt, totalLifetimeOrders, totalLifetimeSpendCents }] }
```

- `posCustomers` WHERE `(SELECT MAX(placedAt) FROM posOrders WHERE customerExternalId = c.externalId) < now - inactiveSinceDays`.
- AND 그 손님의 `(SELECT COUNT(*) FROM posOrders WHERE customerExternalId = c.externalId) >= minPriorVisits`.

### 3.7 Live tools (`fetchLiveOrder`, `countActiveGarments`, `aggregateRevenueLive`)

- `cleanCloudTransport.ts`의 기존 fetcher 재사용. 단, mirror로 우회 안 함.
- `aggregateRevenueLive` 은 "오늘 04:00 ET 이후 ~ 지금" 윈도우만 처리 (mirror에 아직 없는 데이터). dateFrom 자동 계산.
- LLM이 잘못 lookup 카테고리에 live tool 쓰지 않도록 description에 "오늘 영업 중 실시간 질문 전용" 명시.

## 4. 4-단계 Agent loop

### 4.1 Router

```
System: "당신은 매장 점주의 질문을 5개 카테고리로 분류합니다. ..."
User: <user question>
Output (JSON schema): { category: enum, reasoning: string }
```

- `smalltalk` / `out_of_scope` 면 short-circuit — Synthesizer 단독 호출 (tool 0개)로 친절한 답.

### 4.2 Planner

```
System: "다음 tool 12개로 점주 질문에 답하기 위한 계획을 세우세요. ..."
Tools: <tool description list as JSON>
User: <user question> + <category from router>
Output (JSON schema): { plan: [{ toolName, args, reason }] }
```

- Planner는 tool args를 *literal*로 채워야 함 (날짜 = ISO, 숫자 = int).
- `now`는 `AgentContext.now` 사용 — Planner LLM에 "오늘은 YYYY-MM-DD입니다" 명시 주입.
- Plan 길이 제한: 최대 5 tool 호출. 초과시 Planner 재호출 (1회만).

### 4.3 Executor

- Plan을 순서대로 실행. 각 tool에 zod validation. 실패시 trace에 errorMessage 누적, 다음 tool로 넘어감 (best-effort).
- 모든 tool 결과를 JSON-serializable 한 dict에 누적.
- 안전 장치: action tool (`sendBulkMessage`) 은 실제 호출 안 함, *dryRun*만. (Phase 25c는 read-only로 한정. action은 Phase 25f.)

### 4.4 Synthesizer

```
System: "다음 tool 결과들을 점주에게 한국어로 요약. 길이 4~6 문장 + (필요시) 표 1개. 데이터 freshness: <hint>. 사실만 사용. 추측 금지."
User: <user question> + <tool results JSON>
Output: plain markdown (no `# headers`)
```

- 표는 markdown pipe table.
- 마지막 줄에 freshness 푸터: "(데이터: 2026-05-15 03:00 ET 기준)".

## 5. 대화 영속화 schema

```ts
export const ownerConversations = mysqlTable("ownerConversations", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  title: varchar("title", { length: 256 }), // first-question summary, optional
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const OWNER_MESSAGE_ROLES = ["user", "assistant"] as const;

export const ownerMessages = mysqlTable("ownerMessages", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversationId").notNull(),
  role: mysqlEnum("role", OWNER_MESSAGE_ROLES).notNull(),
  contentMarkdown: text("contentMarkdown").notNull(),
  trace: json("trace"), // AgentTrace, only for assistant role
  totalLatencyMs: int("totalLatencyMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

## 6. tRPC 인터페이스

```ts
ownerAssistant: router({
  ask: adminProcedure
    .input(z.object({
      conversationId: z.number().int().nullable(),
      question: z.string().min(1).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      // 1. 새 conversation OR 기존 load
      // 2. agent.ask(question, ctx)
      // 3. ownerMessages 2개 (user + assistant) insert
      // 4. return { conversationId, answerMarkdown, trace }
    }),
  listConversations: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).default({}))
    .query(...),
  getConversation: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .query(...),
  /** 지난 30일 자주 묻는 질문 추천. (LLM이 만든 prompt seed; manual로 시작) */
  suggestedPrompts: adminProcedure.query(() => [
    "최근 2주 동안 단골 손님 동향",
    "지난 달 대비 이번 달 매출 어땠어?",
    "60일 이상 안 온 손님 알려줘",
    "오늘 픽업 예정 몇 건?",
    "지난 주 어떤 요일에 매출이 제일 높았어?",
  ]),
}),
```

## 7. 테스트 케이스 (vitest)

### 7.1 `agent.test.ts` (orchestrator)

- Smalltalk 질문 ("안녕") → category=smalltalk, plan 비어있음, synthesizer 1회 호출, 친절한 한국어 인사.
- Lookup 질문 ("Andrew Kim 이라는 손님 정보") → category=lookup, plan에 `findCustomerByPhoneOrName`, executor 결과 stub, synthesizer가 그 결과를 인용.
- Aggregate 질문 ("최근 2주 매출") → category=aggregate, plan에 `aggregateRevenue` 1개 또는 `compareTimeWindows` 포함.
- Compare 질문 ("지난주 vs 이번주") → category=compare, plan에 `compareTimeWindows`.
- Out-of-scope ("직원 시급") → category=out_of_scope, plan 비어있음, synthesizer가 "이 질문은 답변 범위 밖" 안내.
- Tool 실패 시 best-effort: 첫 tool 실패 → 두 번째 tool 정상 → synthesizer가 "일부 데이터 누락" 언급.
- Plan 길이 6 초과 → Planner 재호출 1회 후 5 cap.
- Trace에 `llmCallCount`가 정확하게 누적 (3 또는 4).
- Total latency ms > 0 (clock injection으로 deterministic).
- Synthesizer가 freshness footer 항상 포함 (regex assertion).

### 7.2 Tool tests

- `findCustomerByPhoneOrName`: phone digits-only normalization (`(415) 555-1234` → `+14155551234`), name fuzzy LIKE, email exact.
- `aggregateRevenue.test.ts`: groupBy=day → bucket이 NYC local date (UTC offset 적용), groupBy=dayOfWeek → 영문 요일 7개. paid=0 제외 default.
- `aggregateRepeatCustomers`: minVisits=2 / minVisits=5 경계 케이스.
- `compareTimeWindows`: deltaPct 0% 분기 (`a=0`이면 deltaPct=null이 아니라 `Infinity` 대신 명시 string "신규").

### 7.3 Frontend tests

- `OwnerChat.test.tsx`: empty 채팅 상태 → suggested prompts 5개 보임.
- 질문 보내면 mutation 호출, isPending 동안 typing indicator.
- Trace 펼치기 클릭 → tool list 보임.
- freshness footer 렌더링.

## 8. 제외 (Phase 25c 범위 밖)

- `searchCustomerNotes`, `searchOrderNotes` (RAG) → Phase 25e.
- `sendBulkMessage` 등 action tool → Phase 25f.
- 대화 검색/필터 기능 → 사용 패턴 본 후 결정.
- 대화 export → 동일.
- 다중 owner / role 분리 → POS 정식 출시 시점.

## 9. 구현 순서 (~3.5h)

1. (15분) `drizzle/schema.ts`에 `ownerConversations`, `ownerMessages` 추가, push.
2. (30분) `types.ts` + 12개 tool 시그니처 골격 (실 SQL은 1개씩 채움).
3. (60분) Tool 구현 + `aggregates.test.ts` + `findCustomer.test.ts` 그린.
4. (45분) Router/Planner/Synthesizer 3개 LLM 호출 함수 + Executor + agent.ts orchestrator.
5. (30분) `agent.test.ts` 11+ 케이스 그린.
6. (20분) tRPC `ownerAssistant` sub-router + db helpers.
7. (40분) `OwnerChat.tsx` + `OwnerAssistantTrace.tsx` 컴포넌트 + 라우트 연결 + admin tab.
8. (10분) `OwnerChat.test.tsx` 4 케이스.
9. (10분) full vitest, checkpoint, 너한테 deploy 부탁.

각 step은 독립적이라 25b가 도착하기 전까지 1, 2단계는 미리 시작 가능 (mirror 스키마는 이미 있고 ownerConversations/ownerMessages는 25b와 충돌 없음).

## 10. 체크리스트

- [ ] schema 두 테이블 push
- [ ] types.ts + tool registry 골격
- [ ] tool 12개 + tool tests
- [ ] router/planner/synthesizer + executor + agent.ts
- [ ] agent.test.ts 그린
- [ ] tRPC `ownerAssistant.ask` + `listConversations` + `getConversation` + `suggestedPrompts`
- [ ] db helpers + 영속화 검증 테스트
- [ ] OwnerChat.tsx + Trace 컴포넌트
- [ ] admin tab 등록 (Home.tsx)
- [ ] OwnerChat.test.tsx
- [ ] full vitest 그린, checkpoint
