# CleanCloud → DropShop 데이터 파이프라인 아키텍처

작성일: 2026-05-14
선행 문서: [`cleancloud_data_strategy.md`](./cleancloud_data_strategy.md) (무엇을 mirror할지 결정)
이 문서의 결정: 그 mirror를 *어떻게* 채우고 유지할 것인가

---

## 0. TL;DR

세 가지 파이프라인 옵션을 검토했다.

| 옵션 | 신선도 | 구현 난이도 | rate-limit 안전 | 추천도 |
|---|---|---|---|---|
| A. On-demand pull (mirror 없음) | 실시간 | 0 (지금 상태) | ❌ 분석 질문 1개당 50K req | ❌ |
| B. Webhook + 캐시 (mirror 없음, 메모리 TTL) | 실시간 | 낮음 | ⚠️ 캐시 miss 시 위험 | ❌ |
| **C. Webhook 실시간 + Nightly 풀 스냅샷 (full mirror)** | webhook ≤ 1초, 누락분 ≤ 24h | 중간 | ✅ 90% 쿼리가 SQL | ✅ **이거 간다** |

옵션 C는 webhook을 *primary*로, nightly snapshot을 *self-healing reconciliation*으로 사용한다. webhook이 누락되거나 잘못된 순서로 도착해도 다음날 reconciliation에서 자동 복구된다. 추가 옵션으로 D (CDC stream)도 검토했지만 CleanCloud가 그런 API를 안 제공하므로 제외.

---

## 1. 옵션 비교 — 자세히

### A. On-demand pull (현재 상태)

Owner Assistant가 질문을 받을 때마다 CleanCloud API를 호출한다.

```
[질문] → [LLM이 endpoint 결정] → [getOrders 호출] → [메모리에서 집계] → [답변]
```

**작동 시나리오**: "지난 7일 매출 얼마야?"
- LLM이 `getOrders` 호출 결정
- 7일 × 30주문/일 = 210건 → 한 페이지 응답으로 처리 가능
- 5초 안에 답변 → ✅ 작동

**깨지는 시나리오**: "최근 2주 동안 단골 손님 동향"
- "단골"을 정의하려면 *지난 90일* 데이터가 필요 (3+회 방문 기준)
- 90일 × 30주문/일 = 2,700건 → 페이지네이션 필요
- 페이지당 100건 가정 시 27회 호출 → rate limit (3/sec)에 9초 소요
- LLM이 여러 cut으로 분석하려고 같은 데이터를 다시 호출하면 호출 폭증

**판정**: 단순 lookup엔 OK, *분석성 질문엔 본질적으로 불가능*. Owner Assistant의 P0 시나리오는 분석성 질문이므로 옵션 A는 탈락.

### B. Webhook + 인메모리 캐시 (mirror 없음)

webhook으로 변경 이벤트를 받아서 메모리/Redis 캐시에 보관. TTL 만료 시 CleanCloud에 재호출.

**문제 1 — 콜드 스타트**: 서버 재시작 또는 인스턴스 스케일링 시 캐시가 비어있음. Cloud Run min-instances=0 환경에서 첫 질문이 cold cache hit → 옵션 A로 fallback.

**문제 2 — historical 데이터 없음**: webhook은 *지금부터* 시작. "지난 1년 매출 패턴" 같은 질문에 답하려면 historical pull이 어차피 필요. 캐시는 webhook 이후 데이터만 잡음.

**문제 3 — analytics 쿼리는 캐시가 아니라 SQL이 필요**: 단순 키-값 lookup이 아니라 `GROUP BY customer_id HAVING COUNT(*) >= 3` 같은 쿼리는 캐시로 답할 수 없음. 결국 raw 데이터를 다 갖고 있어야 함.

**판정**: 옵션 B는 결국 옵션 C의 열등한 변종 (DB 대신 메모리). 탈락.

### C. Webhook 실시간 + Nightly 풀 스냅샷 (추천)

```
CleanCloud ─┬─[webhook 실시간]──→ raw payload 적재 → upsert mirror table
            └─[nightly 03:00]────→ getOrders/Customers/Products full snap → upsert mirror table

Owner Assistant ──→ SQL on mirror tables ──→ 답변
              └──→ on-demand call for ephemeral data (driverLocation, slots)
```

**Webhook 경로 (primary, low latency)**:
- CleanCloud → POST `/api/cleancloud/webhook?token=...` (Phase 23f-7에서 구현 완료)
- 모든 payload를 *처리 전에* `cc_webhook_events` raw 테이블에 적재
- 처리 단계에서 mirror 테이블 upsert
- 처리 실패해도 raw는 남아있어 backfill 가능

**Nightly 경로 (reconciliation, self-healing)**:
- 매일 03:00 (매장 closed time)에 scheduled job 실행
- 어제 하루치 `getOrders` + `getPayments` 풀 페이지네이션 → upsert
- 매주 일요일에 *지난 30일* 풀 재스캔 (webhook 놓침 백업)
- `cc_products` + `cc_priceLists`는 매일 전체 스냅샷 + diff alert

**왜 이게 옳은 디자인인가**:
1. 99%의 분석 쿼리는 SQL → rate limit 무관
2. webhook이 놓쳐도 ≤ 24시간 내 자동 복구
3. raw payload 보존 → schema가 바뀌어도 backfill 가능
4. 외부 데이터 (날씨, Google Trends 등) join 가능
5. Owner Assistant가 "이 답변은 N분 전까지의 데이터 기준"이라고 정직하게 응답 가능

**디메리트**:
- 동기화 로직이 새로운 실패 모드를 만든다 (webhook 처리 실패, snapshot job 실패, schema drift)
- → mitigation: `cc_sync_log` 메타 테이블 + `webhook_events` raw payload + Phase 23f-7에서 만든 `notifyOwner` 알림 (sync 실패 시 owner에게 푸시)

---

## 2. 추천 — 옵션 C, 단계적 도입

옵션 C를 한 번에 구현하면 위험. 다음 3 stage로 나눈다.

### Stage 1 (Phase 25a) — `cc_orders` + `cc_customers` mirror 단독

가장 가치 높은 두 테이블만 먼저 구현. webhook은 이미 받고 있으므로 mirror upsert handler만 추가하면 됨.

- `drizzle/schema.ts`에 두 테이블 정의 (raw_payload JSON 포함)
- Webhook `order.*` 핸들러에서 mirror upsert
- Webhook `customer.*` 핸들러에서 mirror upsert
- 첫 도입 시 backfill: 지난 90일 `getOrders` + `getCustomer` 페이지네이션 1회 실행 (수동 admin 버튼)
- vitest: upsert idempotency, raw_payload 보존, webhook out-of-order 처리

Stage 1 끝나면 "최근 2주 매출", "이 손님 작년 총 지출" 같은 질문 답 가능.

### Stage 2 (Phase 25b) — Nightly job + `cc_payments` + `cc_products` 카탈로그

`manus-heartbeat` 또는 자체 cron으로 nightly 03:00 job:
- 어제 하루치 `getOrders`/`getPayments` pull → diff against mirror → upsert missing
- `getProducts`/`getPriceLists` 전체 스냅샷 → diff → 변경 감지 시 `cc_product_changes` 적재 + owner notify
- 매주 일요일 03:00에 지난 30일 풀 재스캔

Stage 2 끝나면 "지난 달 평일 vs 주말 매출 비교", "어제 코트 가격을 $25→$28로 올렸는데 코트 주문 줄었어?" 류 가능.

### Stage 3 (Phase 25c) — `cc_order_items` + 외부 데이터 join

- `cc_orders.products[]` 펼쳐서 `cc_order_items` 테이블 분리 → "어떤 상품이 잘 팔리는지" 가능
- 외부 데이터 fetch: 시(city) 단위 날씨, 공휴일, 지역 행사 → 외부 mirror 테이블
- Owner Assistant가 "지난 비 오는 날 매출 vs 맑은 날 매출" 같은 join 분석 가능

Stage 3은 Owner Assistant 사용자가 "더 깊은 분석" 원할 때 도입. P0 아님.

---

## 3. Schema sketch (Drizzle)

Stage 1 기준. 정확한 컬럼은 구현 시점에 CleanCloud 실제 응답 보고 확정 (raw_payload가 있어서 schema migration 부담 작음).

```ts
// drizzle/schema.ts — 추가

export const ccWebhookEvents = mysqlTable("cc_webhook_events", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),   // e.g. "order.status_changed"
  externalEventId: varchar("external_event_id", { length: 128 }), // CleanCloud's event ID if available
  rawPayload: json("raw_payload").notNull(),
  processedAt: timestamp("processed_at"),                        // null = pending
  processedOk: boolean("processed_ok"),                          // null = pending, true/false = result
  processingError: text("processing_error"),
});

export const ccCustomers = mysqlTable("cc_customers", {
  customerId: varchar("customer_id", { length: 64 }).primaryKey(), // CleanCloud's ID
  customerTel: varchar("customer_tel", { length: 32 }),
  customerName: varchar("customer_name", { length: 256 }),
  customerEmail: varchar("customer_email", { length: 256 }),
  customerAddress: text("customer_address"),
  customerNotes: text("customer_notes"),
  priceListId: varchar("price_list_id", { length: 64 }),
  preferences: json("preferences"),         // starch/shirt/trouser/detergent etc. — flexible JSON
  marketingOptIn: boolean("marketing_opt_in"),
  birthdayDay: int("birthday_day"),
  birthdayMonth: int("birthday_month"),
  customerActive: boolean("customer_active").default(true),
  customerArchived: boolean("customer_archived").default(false),
  customerCreatedAt: timestamp("customer_created_at"),
  customerUpdatedAt: timestamp("customer_updated_at"),
  rawPayload: json("raw_payload").notNull(),
  syncedAt: timestamp("synced_at").defaultNow().onUpdateNow().notNull(),
  syncedFrom: varchar("synced_from", { length: 32 }).notNull(),  // "webhook" | "snapshot" | "backfill"
}, (t) => ({
  telIdx: index("cc_customers_tel_idx").on(t.customerTel),
  archivedIdx: index("cc_customers_archived_idx").on(t.customerArchived),
}));

export const ccOrders = mysqlTable("cc_orders", {
  orderId: varchar("order_id", { length: 64 }).primaryKey(),
  customerId: varchar("customer_id", { length: 64 }).notNull(),
  priceListId: varchar("price_list_id", { length: 64 }),
  status: int("status").notNull(),
  paid: boolean("paid").notNull(),
  completed: boolean("completed").notNull(),
  express: boolean("express"),
  finalTotalCents: int("final_total_cents"),
  tipCents: int("tip_cents"),
  discountCents: int("discount_cents"),
  taxCents: int("tax_cents"),
  deliveryFeeCents: int("delivery_fee_cents"),
  paymentType: varchar("payment_type", { length: 32 }),
  notifyMethod: varchar("notify_method", { length: 32 }),
  dateAdded: timestamp("date_added").notNull(),                   // 시계열 분석의 척추
  storeDropOffDate: timestamp("store_dropoff_date"),
  storeReadyByDate: timestamp("store_readyby_date"),
  pickupDate: date("pickup_date"),
  pickupStart: time("pickup_start"),
  pickupEnd: time("pickup_end"),
  deliveryDate: date("delivery_date"),
  deliveryStart: time("delivery_start"),
  deliveryEnd: time("delivery_end"),
  orderNotes: text("order_notes"),
  rawPayload: json("raw_payload").notNull(),
  syncedAt: timestamp("synced_at").defaultNow().onUpdateNow().notNull(),
  syncedFrom: varchar("synced_from", { length: 32 }).notNull(),
}, (t) => ({
  customerIdx: index("cc_orders_customer_idx").on(t.customerId),
  dateAddedIdx: index("cc_orders_date_added_idx").on(t.dateAdded),    // 가장 자주 쓸 인덱스
  statusIdx: index("cc_orders_status_idx").on(t.status),
  paidIdx: index("cc_orders_paid_idx").on(t.paid),
}));

export const ccSyncLog = mysqlTable("cc_sync_log", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
  source: varchar("source", { length: 32 }).notNull(),     // "webhook" | "nightly_snapshot" | "backfill" | "manual"
  endpoint: varchar("endpoint", { length: 64 }).notNull(), // e.g. "getOrders"
  rowsSynced: int("rows_synced").default(0),
  rowsFailed: int("rows_failed").default(0),
  error: text("error"),
  webhookEventId: bigint("webhook_event_id", { mode: "number", unsigned: true }),
});
```

핵심 디자인 선택:
- **`rawPayload JSON` 컬럼이 모든 테이블에 존재** → 신규 필드 추가 시 schema migration 없이 사용 가능
- **`syncedFrom` 컬럼** → "이 row가 webhook으로 들어왔는지 nightly로 들어왔는지" 디버깅에 결정적
- **`syncedAt`은 `onUpdateNow`** → "이 답변은 N분 전까지의 데이터" 표시 가능
- **인덱스는 `dateAdded`에 가장 무게** → 99% 분석 쿼리가 시간 기반

---

## 4. Backfill 절차 (첫 도입 시)

신규 mirror는 webhook이 들어오기 시작한 *시점부터*만 데이터를 잡는다. 첫 배포 직전에 historical을 한 번 끌어와야 한다.

```
관리자 admin UI에 "Backfill 시작" 버튼 →
  1. cc_sync_log에 source="backfill" 시작 row 적재
  2. getCustomer (createdSecondsAgoFrom=1년) 페이지네이션 → cc_customers upsert
  3. getOrders (dateFrom=오늘-1년, dateTo=오늘) 30일 단위로 12회 페이지네이션 → cc_orders upsert
  4. getPayments 동일하게
  5. 완료 시 sync_log에 rowsSynced 기록 + owner notify
```

90일치 backfill만 해도 webhook이 잡지 못한 1주일 분 안전마진. 1년치는 ~12,000 주문 = ~120 페이지 = ~40초 소요 (rate limit 안에서).

backfill 중에 webhook 들어와도 OK — upsert이므로 어느 쪽이 먼저여도 결과 동일.

---

## 5. Failure modes & monitoring

| 실패 모드 | 감지 방법 | 대응 |
|---|---|---|
| webhook이 한 시간째 안 옴 | `cc_webhook_events` 최신 row 시각 > 1h | owner notify "CleanCloud webhook may be down" |
| webhook payload 처리 실패 | `processed_ok=false` row 존재 | 재시도 큐 + dead-letter 알림 |
| nightly job 실패 | `cc_sync_log` 마지막 nightly 완료 < 어제 03:00 | owner notify + 다음 schedule run에서 자동 재시도 |
| schema drift | upsert 시 unknown field → raw_payload에는 들어가지만 column에는 안 들어감 | log warn + 다음 sprint에 schema 업데이트 |
| 가격표 변경 감지 | nightly diff에서 `cc_products` 가격 변경 발견 | owner notify "Coat price changed $25→$28" (자체 가치) |

monitoring 대시보드는 Phase 25b에서 admin UI 페이지로 노출 (`/admin/cleancloud-sync`).

---

## 6. 다음 문서 (24c)에서 다룰 것

이제 mirror 위에서 Owner Assistant가 *어떻게 자연어 질문을 답하는가*를 결정한다 → [`../agentic_owner_assistant.md`](../agentic_owner_assistant.md).

핵심 질문:
- 점주가 물어볼 질문을 어떤 카테고리로 분류할 것인가?
- LLM이 "어떤 SQL을 짤지" 직접 결정해도 되는가 (text-to-SQL)? 아니면 사전 정의된 tool 집합 안에서 골라야 하는가 (function-calling)?
- RAG가 필요한 부분은? (자유 메모 검색은 embedding이 필요)
- 한 번의 사용자 질문이 여러 sub-query로 풀리는 multi-step reasoning을 어떻게 orchestration할 것인가?
