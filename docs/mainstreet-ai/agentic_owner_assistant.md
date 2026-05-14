# Agentic Owner Assistant — 자연어 점주 비서 설계

작성일: 2026-05-14
선행 문서:
- [`integrations/cleancloud_data_strategy.md`](./integrations/cleancloud_data_strategy.md) — 무엇을 mirror할지
- [`integrations/cleancloud_pipeline.md`](./integrations/cleancloud_pipeline.md) — 어떻게 mirror할지

이 문서가 다루는 것: 그 mirror 위에서 점주(친구 1명)가 자연어로 묻는 질문에 LLM이 어떻게 답할 것인가.

---

## 0. TL;DR

> 옵션 3개 (순수 RAG · text-to-SQL · function-calling agent) 중 **function-calling agent**를 P0로 채택한다. 이유는 단순함이다 — 점주의 질문이 (1) 사실 lookup, (2) 시계열 집계, (3) 비교/원인 분석, (4) 액션(메시지 송신/픽업 변경) 4가지로 깔끔하게 갈리고, 각각이 *예측 가능한 SQL 패턴*에 매핑된다. 우리가 사전 정의한 ~12개의 tool (각자가 정형화된 SQL 또는 API call)을 LLM이 골라서 호출하게 하면, **text-to-SQL의 hallucination 위험 없이** 90% 질문을 커버한다. RAG는 `customerNotes`/`orderNotes` 같은 자유 텍스트 검색 보조 tool로만 사용. Latency는 점주가 "오래 걸려도 됨"이라 했으니 multi-step reasoning에 30–60초 허용. 모든 답변은 *데이터 freshness 메타*를 함께 출력 ("based on data as of 3 minutes ago").

---

## 1. 점주가 물어볼 질문 — 5개 카테고리

실제로 친구 같은 동네 드라이클리닝 점주가 던질 질문을 1주일치 일과 기준으로 패턴 분석한 결과.

### 카테고리 1 — 단순 사실 lookup ("이 손님 누구?")

빈도: 매우 높음 (하루 수십 회). Latency 민감 (수 초 안).

예시:
- "이 번호 (415-xxx-xxxx) 누구?"
- "Andrew의 다음 픽업 언제야?"
- "오더 #4521 결제 됐어?"
- "지금 매장에 옷 몇 벌 있어?" (status=cleaning OR ready)

**Tool 매핑**: 단일 SQL SELECT 하나 + WHERE 절. 거의 LLM 추론 없음.

### 카테고리 2 — 시계열 집계 ("최근 N일 매출")

빈도: 매일 1–3회. Latency는 약간 여유.

예시:
- "어제 매출?"
- "이번 주 픽업 몇 건?"
- "지난 달 평균 객단가?"
- "최근 2주 단골 동향" ← 사용자가 직접 언급한 예시
- "오늘 신규 손님 몇 명?"

**Tool 매핑**: `GROUP BY` + `WHERE date BETWEEN`의 정형 패턴. 사전 정의된 집계 함수 6–8개로 95% 커버.

### 카테고리 3 — 비교 / 원인 분석 ("왜 줄었어?")

빈도: 주 1–2회 (전략적 검토). Latency 여유 큼.

예시:
- "지난 달보다 이번 달 매출이 줄었는데 왜?"
- "코트 가격 올린 게 영향이 있었나?"
- "비 오는 날 매출 vs 맑은 날?"
- "Andrew 지난 3개월 동안 안 왔는데 왜 안 오지?"

**Tool 매핑**: 멀티 SQL + 외부 데이터 (날씨, 공휴일) join + LLM의 자연어 인과 해석. 이 카테고리가 agent의 진가를 보여주는 지점.

### 카테고리 4 — 마케팅 / 운영 action ("이 손님들한테 보내자")

빈도: 주 1–3회. Latency 무관.

예시:
- "90일째 안 온 손님 리스트 뽑아줘"
- "그 리스트한테 20% 할인 쿠폰 SMS 보내자"
- "내일 픽업 예약된 손님들한테 reminder 보내자"

**Tool 매핑**: Query → segment → 옵션 confirm → bulk action. **Action은 무조건 owner approval 후 실행** (HITL 룰 유지).

### 카테고리 5 — 자유 텍스트 검색 ("스타치 light 좋아하는 손님")

빈도: 낮음 (주 0–1회). 가치 큼.

예시:
- "Light starch 좋아한다고 메모해둔 손님들 누구야?"
- "지난 주 컴플레인 받은 주문들 뭐였지?" (`orderNotes` 검색)
- "Andrew가 지난 번에 뭐 불만이었지?" (`customerNotes` + `orderNotes`)

**Tool 매핑**: 벡터 검색 (embedding) + SQL filter. RAG가 진짜 필요한 유일한 카테고리.

---

## 2. 아키텍처 선택 — 3개 옵션 비교

### 옵션 1 — Pure RAG

모든 mirror 데이터를 embedding해서 벡터 DB에 적재. 질문 → top-k 청크 → LLM 합성.

**적용 가능**: 카테고리 1, 5 일부
**탈락 이유**: 카테고리 2–4 (시계열 집계, 비교, action)는 본질적으로 *aggregation*이 필요. RAG는 retrieval이지 aggregation이 아님. 1년치 주문을 chunk로 쪼개도 "지난 달 매출 합"을 못 답한다.

### 옵션 2 — Pure Text-to-SQL

LLM이 schema 보고 SQL 직접 작성 → 실행 → 결과 합성.

**적용 가능**: 카테고리 1–3 거의 전부
**탈락 이유**:
- Hallucination 위험 — LLM이 존재하지 않는 컬럼을 만들거나 잘못된 JOIN을 짤 수 있음
- 결과 검증 어려움 — 점주가 SQL을 못 읽으므로 "이 답이 맞아?"를 검증할 수 없음
- 비결정성 — 같은 질문도 다른 SQL을 생성 → 답이 미묘하게 달라짐
- 보안 — `DELETE`/`UPDATE`를 막아도 비싼 cartesian join으로 DB 부하 줄 수 있음

소규모 점주 매장에선 *예측 가능성*이 *유연성*보다 중요하다.

### 옵션 3 — Function-calling agent (채택)

사전 정의된 tool 집합 (~12개). LLM은 *tool을 고르고 인자만 채움*. SQL은 우리가 짠 함수 안에 있음.

```
점주 질문
  ↓
[Router LLM: 어느 카테고리?]
  ↓
[Planner LLM: 어떤 tool 호출 sequence?]
  ↓
[Executor: tool 1개씩 실행, 결과 누적]
  ↓
[Synthesizer LLM: 결과 → 자연어 답변]
  ↓
출력 (답변 + 데이터 freshness + 사용한 tool 목록)
```

**장점**:
- 각 tool의 SQL을 우리가 미리 검증 → hallucination 0
- tool 결과가 정형 데이터 → 답변 검증 가능 ("이 합계가 맞아?" → tool 재실행)
- 새로운 질문 유형이 생기면 tool 추가만 하면 됨 (LLM 변경 불필요)
- Action tool (마케팅 send, 픽업 update)도 동일 프레임워크에 자연스럽게 들어감

**단점**:
- 사전 정의 안 된 질문은 못 답함 → "이 질문은 답할 수 없습니다. 추가 분석이 필요하면 운영자에게 문의" 정직한 fallback

이 trade-off는 우리 유즈케이스(점주 1명, 예측 가능 질문 패턴)에 맞다.

---

## 3. Tool 카탈로그 — 초안 12개

각 tool은 (a) 정확한 SQL/API call, (b) 입력 schema, (c) 출력 schema가 사전 정의됨. LLM은 이름 + description만 보고 선택.

| Tool | 카테고리 | 입력 | 출력 |
|---|---|---|---|
| `findCustomerByPhoneOrName` | 1 | `query: string` | `customer` (full row) |
| `getCustomerRecentOrders` | 1 | `customerId, limit=10` | `orders[]` |
| `getOrderDetails` | 1 | `orderId` | `order + items[]` |
| `getActiveOrdersByStatus` | 1 | `status[]` | `count + orders[]` |
| `aggregateRevenue` | 2 | `dateFrom, dateTo, groupBy=day\|week\|month\|dayOfWeek` | `series[]` |
| `aggregateNewCustomers` | 2 | `dateFrom, dateTo, groupBy` | `series[]` |
| `aggregateRepeatCustomers` | 2 | `dateFrom, dateTo, minVisits=3, lookbackDays=90` | `count + customers[]` |
| `findInactiveCustomers` | 2/4 | `inactiveSinceDays` | `customers[]` |
| `compareTimeWindows` | 3 | `windowA (from,to), windowB (from,to), metric` | `comparison summary` |
| `searchCustomerNotes` | 5 | `query: string, topK=10` | `customers[] with snippets` |
| `searchOrderNotes` | 5 | `query: string, dateFrom?, dateTo?, topK=10` | `orders[] with snippets` |
| `sendBulkMessage` (action) | 4 | `customerIds[], templateId, variables{}` | `dryRun preview` (owner confirm 후 실제 송신) |

이 12개로 우리가 분석한 카테고리 1–5의 ~90% 질문을 커버한다.

**추가 후보 (Stage 2+에서 도입)**:
- `joinWeather` — 시계열 결과에 날씨 join
- `joinHoliday` — 공휴일 효과
- `findProductSalesTrend` — 상품별 매출 추이 (cc_order_items 의존)
- `forecastNextWeek` — 단순 시계열 예측 (Prophet 등)

---

## 4. End-to-end trace — "최근 2주 단골 손님 동향"

사용자가 직접 언급한 예시 질문을 따라가 본다.

### Step 1 — Router LLM

```
입력: "최근 2주 동안 단골 손님 동향"
프롬프트: "다음 질문이 카테고리 1~5 중 어디에 해당하나? 단순 lookup / 시계열 집계 / 비교 분석 / action / 텍스트 검색"
출력: 카테고리 2 (시계열 집계) + 보조로 카테고리 3 (비교 분석) 가능성
```

### Step 2 — Planner LLM

```
프롬프트: "이 질문을 답하기 위해 어떤 tool을 어떤 순서로 호출해야 하나? 사용 가능 tool: [12개 list]"
출력:
  1. aggregateRepeatCustomers(dateFrom=오늘-14일, dateTo=오늘, minVisits=2, lookbackDays=90)
     → 최근 2주에 방문한 손님 중 90일 내 2+ 방문자 = "단골"
  2. compareTimeWindows(
       windowA=(오늘-28일, 오늘-14일),  // 그 전 2주
       windowB=(오늘-14일, 오늘),       // 이번 2주
       metric="repeat_visit_count"
     )
     → 직전 2주 대비 동향
  3. (선택) aggregateRevenue(dateFrom=오늘-14일, dateTo=오늘, groupBy=day, customerFilter=단골만)
     → 단골들의 일별 매출 패턴
```

### Step 3 — Executor

각 tool 실행. 모두 mirror SQL → 200ms 안에 결과 반환.

```
Tool 1 결과: {regularCount: 47, customers: [{id, name, visitCount, totalSpend}, ...]}
Tool 2 결과: {prev: 41, curr: 47, delta: +6, deltaPct: +14.6%}
Tool 3 결과: {series: [{date, total_cents}, ...]}  // 14일치
```

### Step 4 — Synthesizer LLM

```
프롬프트: "다음 데이터를 점주에게 자연스러운 한국어로 요약하라. 데이터 freshness는 N분 전. 길이는 4–6 문장 + 표 1개."
출력 예시:

  "최근 2주(5/1–5/14) 동안 단골 손님(90일 내 2회 이상 방문)은 47명으로,
   직전 2주(4/17–4/30)의 41명 대비 6명(+14.6%) 늘었습니다.

   특히 5월 8일 이후 단골 방문이 일평균 3.4건 → 4.1건으로 뚜렷이 증가했는데,
   같은 기간 마케팅 캠페인을 보낸 적이 있는지 확인해 보면 원인이 더 명확해질 수 있습니다.

   상위 5명 (이번 2주 방문 횟수 + 지출):
   | 손님 | 방문 | 지출 |
   |---|---|---|
   | Andrew Kim | 4 | $215 |
   | Sarah Lee | 3 | $182 |
   | ...

   (데이터는 3분 전까지 반영. webhook 1건 처리 대기 중.)"
```

이 답변 1개를 만드는 데 LLM 호출 3회 + DB 쿼리 3회 = ~15–30초. 사용자가 "오래 걸려도 됨"이라 했으니 OK.

---

## 5. Action tool의 안전장치

마케팅 send, 픽업 update 같은 *side-effect* 있는 tool은 절대 LLM이 직접 실행 못 함. 두 단계 확인:

```
LLM이 sendBulkMessage 호출 (dryRun=true) 
  ↓
"이 47명한테 [메시지 미리보기] 발송 예정. 확인?"
  ↓
점주 명시적 confirm
  ↓
실제 발송 (dryRun=false, owner action audit log 기록)
```

이건 Phase 22/23에서 이미 확립된 *HITL approval* 패턴 — 새로 만들 필요 없이 재사용.

---

## 6. RAG 보조 — `customerNotes` / `orderNotes` 검색

자유 텍스트 검색이 필요한 카테고리 5만을 위한 *별도 가벼운 RAG*:

- 매 nightly snapshot 끝에서 `cc_customers.customerNotes`, `cc_orders.orderNotes` 변경 감지 시 embedding 재생성
- TiDB Vector 또는 외부 벡터 DB (Pinecone 무료 티어)에 저장
- `searchCustomerNotes(query)` tool이 cosine similarity top-k 반환

vector volume 작음 (수천 행) → 비용 거의 0.

---

## 7. 구현 단계 (Phase 25 build plan)

| Phase | 내용 | 산출물 |
|---|---|---|
| **25a** | mirror Stage 1 (cc_customers, cc_orders) + webhook upsert | drizzle schema + handler + vitest + backfill admin button |
| **25b** | mirror Stage 2 (cc_payments, cc_products) + nightly cron job | manus-heartbeat schedule + diff alerts |
| **25c** | Owner Assistant 백엔드: 12 tool 구현 + Router/Planner/Synthesizer 3-step LLM 파이프라인 | `server/ownerAssistant.ts` + tools/* + vitest |
| **25d** | Owner Assistant 프론트엔드: `/owner-chat` 채팅 UI (기존 `AIChatBox` 재사용) + freshness 표시 + action confirm | React 페이지 + tRPC stream |
| **25e** | RAG 보조 — embedding job + `searchCustomerNotes/Orders` tool 활성화 | (선택, 카테고리 5 요청 시 도입) |
| **25f** | Action tool — `sendBulkMessage` 등 마케팅 자동화 | (선택, owner 마케팅 캠페인 운영 시작 시) |

P0는 25a → 25b → 25c → 25d. 25e/f는 점주 사용 패턴 보고 결정.

---

## 8. 결론

- **아키텍처**: function-calling agent (~12 tool)
- **신선도 보장**: 매 답변에 "data as of N분 전" 메타 노출
- **HITL**: 모든 side-effect tool은 owner confirm 후 실행
- **확장성**: 새 질문 유형은 tool 추가로 대응 (LLM 변경 불필요)
- **다음**: Phase 25a 코드 단계로 진입할지, 아니면 이 docs 먼저 친구 데이터로 sanity check할지 결정 필요
