# CleanCloud → DropShop 데이터 파이프라인 아키텍처

작성일: 2026-05-14 (rev 2 — daily-pull stage 0 + POS-neutral schema)
선행 문서: [`cleancloud_data_strategy.md`](./cleancloud_data_strategy.md) (무엇을 mirror할지 결정)
이 문서의 결정: 그 mirror를 *어떻게* 채우고, *어떻게 발전*시키고, *나중에 우리 POS로 어떻게 갈아탈지*

---

## 0. TL;DR

P0 출시 단계는 **Stage 0 — Daily Pull 2회 (영업 종료 후 + 점심 한산 시간)**. webhook은 의도적으로 도입 안 함. 이유는 단순함이다:

1. 점주의 P0 질문 (단골 동향, 매출 추이, 비교 분석) 전부 "어제까지 데이터"면 답할 수 있음. 실시간 lookup ("지금 매장에 옷 몇 벌?")은 on-demand API call로 처리 — mirror 불필요.
2. webhook 처리/재시도/out-of-order/dead-letter 로직을 모두 미룰 수 있어 구현이 1/3로 줄어듦.
3. 친구한테 webhook 8개 활성화 요청 안 해도 됨 — dependency 하나 제거.
4. 데이터가 부족함을 *명시적으로* 점주에게 표시 ("data as of last pull at 22:00 yesterday") → 거짓 신선도보다 정직한 stale가 낫다.

**더 중요한 결정 — Schema는 vendor-neutral하게 간다.** 우리가 결국 자체 POS를 만들 것이므로, mirror 테이블 이름을 `cc_*`(CleanCloud-specific)이 아니라 `customers`/`orders`/`payments`/`products`로 짓고, vendor-specific ID는 별도 `external_refs` 테이블로 분리. CleanCloud는 첫 vendor adapter, DropShop POS는 둘째 vendor adapter — 둘 다 같은 정규화된 fact 테이블로 흘러들어옴. POS 전환 시 migration 비용이 거의 0에 수렴한다.

발전 경로: **Stage 0 (Daily Pull) → Stage 1 (Webhook, Trigger-based) → Stage 2 (자체 POS event stream)**. 각 stage는 직전 stage의 schema와 호환되도록 만든다.

---

## 1. 옵션 비교 — 4개로 확장

원래 3개 옵션을 검토했지만 사용자 피드백 (2026-05-14)으로 daily-pull 옵션을 추가.

| 옵션 | 신선도 | 구현 난이도 | rate-limit 안전 | P0 적합도 |
|---|---|---|---|---|
| A. On-demand pull (mirror 없음) | 실시간 | 0 | ❌ 분석 1건당 50K req | ❌ |
| B. Webhook + 캐시 (mirror 없음) | 실시간 | 낮음 | ⚠️ 캐시 miss 시 위험 | ❌ |
| **C-0. Daily Pull 2회 (Stage 0)** | T-12h 또는 T-0.5d | **낮음** | ✅ 페이지네이션 1회/12h | ✅ **P0 채택** |
| C-1. Webhook + Nightly Snapshot | ≤ 1초 / 누락분 ≤ 24h | 중간 | ✅ | Stage 1 (P1) |
| D. CDC stream | 실시간 | 높음 | — | 자체 POS 갔을 때만 가능 |

C-0이 P0인 이유: **신선도 손실(약 12시간) < 구현 단순함의 이득 + dependency 제거**. 그리고 신선도 자체가 점주에게 *치명적인 경우가 없다* — 점주는 daily/weekly 패턴을 묻지, "방금 5분 전에 들어온 주문"을 묻지 않는다. (그런 lookup은 on-demand call로 처리.)

### A, B의 탈락 이유 (요약)

A는 분석 질문 1개당 수십~수백 API call이 필요 → rate limit (50K/월, 3/sec) 안에서 실용성 0. B는 캐시가 있어도 cold start + historical 부재 + aggregation 불가 → 결국 mirror가 필요.

### C-0 (Daily Pull 2회) 자세히

```
[11:00 점심 한산 시간 pull]
  └─ getOrders(dateFrom=어제 11:00, dateTo=지금) → upsert orders 테이블
  └─ getCustomer(updatedSecondsAgoFrom=어제 11:00) → upsert customers 테이블
  └─ getPayments(dateFrom=어제 11:00, dateTo=지금) → upsert payments 테이블

[22:00 영업 종료 후 pull]
  └─ 같은 3개 endpoint, 같은 24h 윈도우 (overlap OK, upsert이므로 무해)
  └─ getProducts/getPriceLists 전체 스냅샷 → diff alert
```

작동 시나리오:
- 점주가 22:30에 "오늘 매출?" 묻는다 → 22:00 pull 결과 사용 → 정확
- 점주가 21:00에 "오늘 매출?" 묻는다 → 11:00 pull 결과 + on-demand `getOrders(dateFrom=11:00)` 짧은 call로 보완 → 5초 안에 답
- 점주가 다음날 09:00에 "어제 단골 동향?" 묻는다 → 어제 22:00 pull 결과 사용 → 완벽

각 pull의 API 비용:
- `getOrders`: 24h 윈도우, 일 30주문 가정 → 1 페이지 (≤ 100건) → API call 1회
- `getCustomer`: 변경된 손님만 → 일 5–10명 가정 → 1 페이지
- `getPayments`: 동일
- `getProducts/getPriceLists`: 전체 카탈로그, 수백 SKU → 1–2 페이지

→ pull 1회당 ~5 API call, 일 2회 = 일 10 call = 월 300 call. 50K 한도의 0.6%. **여유 만점.**

### C-1 (Webhook 도입)으로 graduate하는 트리거

Stage 0 → Stage 1 전환은 다음 중 하나가 발생할 때 검토:

1. 점주가 "방금 들어온 주문이 안 보여서 불편하다"고 명시적으로 컴플레인
2. 매장 규모가 일 200+ 주문으로 성장 (현재 추정 30–80) → daily pull로는 페이지 폭증
3. 마케팅 자동화 (Phase 25f)에서 "주문 완료 즉시 reminder" 같은 이벤트 기반 액션 필요
4. 실시간 dashboards 요구사항이 생김

그 전까지는 webhook 활성화는 *선택사항으로 남겨두고 의도적으로 안 켠다*. complexity budget 보전.

---

## 2. POS-future-proof — Vendor-neutral schema 디자인

우리가 결국 DropShop 자체 POS를 만들 것이므로, mirror schema를 *vendor 종속적으로 설계하면 안 된다*. CleanCloud는 첫 vendor adapter일 뿐이고, 미래의 DropShop POS는 둘째 adapter.

### 원칙

| 원칙 | 적용 |
|---|---|
| **Vendor-neutral 테이블명** | `cc_orders` ❌ → `orders` ✅. 같은 테이블에 여러 vendor source 가능 |
| **External ID는 별도 매핑** | `orders.id`는 우리 내부 UUID. 외부 시스템 ID는 `external_refs` 테이블에 분리 |
| **Source 표시** | 모든 행에 `source` 컬럼 (`"cleancloud"` 또는 `"dropshop_pos"`) — query에서 filter 가능 |
| **Vendor-specific은 raw_payload에** | 표준화하기 어려운 필드는 `raw_payload JSON`에 그대로 보관, schema migration 없이 사용 |
| **Adapter 패턴** | `server/integrations/cleancloud/adapter.ts`가 CleanCloud 응답을 표준 schema로 변환. 미래에 `server/integrations/dropshop_pos/adapter.ts` 추가 |

### Migration 시나리오

미래에 친구 매장이 DropShop POS로 갈아탄다고 가정:

```
Day 0: CleanCloud만 사용
  - 모든 orders 행에 source="cleancloud"
  - external_refs에 cleancloud_order_id 매핑

Day N: DropShop POS 도입 (병행 운영, 친구가 점진적 전환)
  - 새 orders 행에 source="dropshop_pos"
  - external_refs에 dropshop_pos_order_id 매핑
  - 같은 테이블에 두 source가 공존 — Owner Assistant 쿼리는 source 무관 작동

Day N+30: CleanCloud 완전 종료
  - 기존 orders 행은 그대로 (historical 보존)
  - 신규 orders는 source="dropshop_pos"만
  - external_refs의 cleancloud 매핑은 read-only로 archive
```

**이게 왜 중요한가**: 우리가 Owner Assistant tool 12개를 만들 때 (24c 문서), 그 tool들은 *vendor 추상화 위에서 SQL을 짠다*. 즉 vendor 갈아타도 tool 코드 0줄 변경. POS migration이 **데이터/SQL/agent 레벨에서 완전히 비파괴적**이 된다.

---

## 3. Schema sketch — Vendor-neutral (Drizzle MySQL)

```ts
// drizzle/schema.ts — 추가 (vendor-neutral 버전)

// 1. 모든 외부 시스템 ID 매핑을 한 곳에
export const externalRefs = mysqlTable("external_refs", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  entityType: varchar("entity_type", { length: 32 }).notNull(),   // "customer" | "order" | "payment" | "product"
  internalId: varchar("internal_id", { length: 64 }).notNull(),   // our UUID
  source: varchar("source", { length: 32 }).notNull(),            // "cleancloud" | "dropshop_pos" | ...
  externalId: varchar("external_id", { length: 128 }).notNull(),  // vendor's ID
  metadata: json("metadata"),                                      // vendor-specific extras (priceListId, etc.)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  lookupIdx: index("external_refs_lookup").on(t.entityType, t.source, t.externalId),
  reverseIdx: index("external_refs_reverse").on(t.internalId),
  uniq: uniqueIndex("external_refs_uniq").on(t.entityType, t.source, t.externalId),
}));

// 2. 정규화된 fact 테이블 — vendor 무관
export const customers = mysqlTable("customers", {
  id: varchar("id", { length: 64 }).primaryKey(),  // our UUID
  source: varchar("source", { length: 32 }).notNull(),  // "cleancloud" | "dropshop_pos"
  tel: varchar("tel", { length: 32 }),
  name: varchar("name", { length: 256 }),
  email: varchar("email", { length: 256 }),
  address: text("address"),
  notes: text("notes"),
  preferences: json("preferences"),         // 드라이클리닝 선호도 (vendor-specific shape OK)
  marketingOptIn: boolean("marketing_opt_in"),
  birthdayDay: int("birthday_day"),
  birthdayMonth: int("birthday_month"),
  active: boolean("active").default(true),
  archived: boolean("archived").default(false),
  externalCreatedAt: timestamp("external_created_at"),   // vendor 시스템 생성 시각
  externalUpdatedAt: timestamp("external_updated_at"),
  rawPayload: json("raw_payload").notNull(),             // vendor 원본
  syncedAt: timestamp("synced_at").defaultNow().onUpdateNow().notNull(),
  syncedVia: varchar("synced_via", { length: 32 }).notNull(),  // "daily_pull_11am" | "daily_pull_10pm" | "backfill" | "webhook" | "pos_event"
}, (t) => ({
  telIdx: index("customers_tel_idx").on(t.tel),
  sourceIdx: index("customers_source_idx").on(t.source),
  archivedIdx: index("customers_archived_idx").on(t.archived),
}));

export const orders = mysqlTable("orders", {
  id: varchar("id", { length: 64 }).primaryKey(),
  source: varchar("source", { length: 32 }).notNull(),
  customerId: varchar("customer_id", { length: 64 }).notNull(),  // FK → customers.id (internal)
  status: varchar("status", { length: 32 }).notNull(),           // 정규화된 상태 (e.g. "received", "cleaning", "ready", "picked_up")
  statusRaw: int("status_raw"),                                  // vendor 원본 status code (CleanCloud는 int)
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
  placedAt: timestamp("placed_at").notNull(),         // = CleanCloud's dateAdded
  droppedOffAt: timestamp("dropped_off_at"),
  readyByAt: timestamp("ready_by_at"),
  pickupDate: date("pickup_date"),
  pickupStart: time("pickup_start"),
  pickupEnd: time("pickup_end"),
  deliveryDate: date("delivery_date"),
  deliveryStart: time("delivery_start"),
  deliveryEnd: time("delivery_end"),
  notes: text("notes"),
  rawPayload: json("raw_payload").notNull(),
  syncedAt: timestamp("synced_at").defaultNow().onUpdateNow().notNull(),
  syncedVia: varchar("synced_via", { length: 32 }).notNull(),
}, (t) => ({
  customerIdx: index("orders_customer_idx").on(t.customerId),
  placedAtIdx: index("orders_placed_at_idx").on(t.placedAt),  // 시계열 분석 척추
  statusIdx: index("orders_status_idx").on(t.status),
  sourceIdx: index("orders_source_idx").on(t.source),
}));

export const payments = mysqlTable("payments", {
  id: varchar("id", { length: 64 }).primaryKey(),
  source: varchar("source", { length: 32 }).notNull(),
  orderId: varchar("order_id", { length: 64 }).notNull(),
  amountCents: int("amount_cents").notNull(),
  type: varchar("type", { length: 32 }),       // "cash" | "card" | "credit" | ...
  paidAt: timestamp("paid_at").notNull(),
  refunded: boolean("refunded").default(false),
  refundedAt: timestamp("refunded_at"),
  rawPayload: json("raw_payload").notNull(),
  syncedAt: timestamp("synced_at").defaultNow().onUpdateNow().notNull(),
  syncedVia: varchar("synced_via", { length: 32 }).notNull(),
}, (t) => ({
  orderIdx: index("payments_order_idx").on(t.orderId),
  paidAtIdx: index("payments_paid_at_idx").on(t.paidAt),
  sourceIdx: index("payments_source_idx").on(t.source),
}));

export const products = mysqlTable("products", {
  id: varchar("id", { length: 64 }).primaryKey(),
  source: varchar("source", { length: 32 }).notNull(),
  priceListId: varchar("price_list_id", { length: 64 }),
  name: varchar("name", { length: 256 }).notNull(),
  category: varchar("category", { length: 64 }),
  priceCents: int("price_cents"),
  active: boolean("active").default(true),
  rawPayload: json("raw_payload").notNull(),
  syncedAt: timestamp("synced_at").defaultNow().onUpdateNow().notNull(),
  syncedVia: varchar("synced_via", { length: 32 }).notNull(),
}, (t) => ({
  priceListIdx: index("products_pricelist_idx").on(t.priceListId),
  sourceIdx: index("products_source_idx").on(t.source),
}));

// 가격 변경 감지 — daily diff 결과 적재
export const productChanges = mysqlTable("product_changes", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  productId: varchar("product_id", { length: 64 }).notNull(),
  source: varchar("source", { length: 32 }).notNull(),
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
  field: varchar("field", { length: 32 }).notNull(),  // "price_cents" | "name" | "active"
  oldValue: text("old_value"),
  newValue: text("new_value"),
});

// Sync 메타데이터 — 모든 pull/upsert 작업 추적
export const syncLog = mysqlTable("sync_log", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
  source: varchar("source", { length: 32 }).notNull(),       // "cleancloud" | ...
  trigger: varchar("trigger", { length: 32 }).notNull(),     // "daily_pull_11am" | "daily_pull_10pm" | "backfill" | "manual"
  endpoint: varchar("endpoint", { length: 64 }).notNull(),
  rowsSynced: int("rows_synced").default(0),
  rowsFailed: int("rows_failed").default(0),
  error: text("error"),
});
```

핵심 디자인 선택:

1. **vendor-neutral 테이블 이름** — `customers`, `orders`, `payments`, `products`. 미래 POS migration이 schema 변경 0줄로 가능.
2. **`source` 컬럼이 모든 fact 테이블에 존재** — multi-vendor 시 query filter (`WHERE source='dropshop_pos'`)로 vendor 분리.
3. **`external_refs` 매핑 테이블** — vendor의 ID와 우리 내부 UUID를 1:1 매핑. vendor 추가/제거 시 schema 변경 0줄.
4. **`statusRaw` 같은 dual-store** — `status`는 정규화된 enum (vendor 무관), `statusRaw`는 vendor 원본 코드. analytics는 `status`로, 디버깅은 `statusRaw`로.
5. **`rawPayload JSON`이 모든 fact 테이블에 존재** — schema migration 부담 0. 새 필드 등장 시 즉시 JSON에서 query.
6. **`syncedVia`** — daily-pull-11am, daily-pull-10pm, backfill, webhook (Stage 1+), pos_event (Stage 2+) 모두 같은 컬럼에 표시. Stage 발전 시 schema 변경 없음.

---

## 4. Adapter 패턴 — `server/integrations/`

```
server/integrations/
├── cleancloud/
│   ├── adapter.ts          # CleanCloud 응답 → 표준 schema 변환
│   ├── pullJob.ts          # daily pull 11am/10pm
│   ├── backfill.ts         # 첫 도입 시 historical pull
│   ├── statusMap.ts        # CleanCloud status int → 표준 enum
│   └── client.ts           # CleanCloud API client (이미 존재)
└── dropshop_pos/           # 미래
    └── (TBD)
```

`adapter.ts`는 *순수 함수*:
```ts
export function adaptCleanCloudCustomer(cc: CleanCloudCustomerResponse): NewCustomerRow {
  return {
    id: deriveUuidFrom(cc.customerID, "cleancloud"),  // deterministic UUID from external ID
    source: "cleancloud",
    tel: cc.customerTel,
    name: cc.customerName,
    // ... 표준화된 필드 매핑
    preferences: pickPreferenceFields(cc),  // vendor-specific JSON
    rawPayload: cc,
    syncedVia: getCurrentSyncContext(),
  };
}
```

미래 DropShop POS adapter도 같은 출력 shape (`NewCustomerRow`)을 반환. Owner Assistant 코드는 변경 0줄.

---

## 5. 단계적 도입 — Phase 25 build plan (수정판)

| Stage | Phase | 내용 | 산출물 |
|---|---|---|---|
| **Stage 0** | **25a** | Vendor-neutral schema migration + CleanCloud adapter + daily pull 2회 (11am/10pm) | drizzle schema, `server/integrations/cleancloud/*`, scheduled jobs, vitest |
| Stage 0 | 25b | Backfill admin UI (수동 1년치 historical pull 버튼) + sync_log 대시보드 | React admin page + tRPC procedures |
| Stage 1 | 25c | (선택) Webhook 도입 — 기존 23f-7 webhook handler를 mirror upsert에 연결 | webhook handler 확장 |
| Owner Assistant | 25d | 12 tool 구현 + Router/Planner/Synthesizer 3-step LLM | `server/ownerAssistant/*` + vitest |
| Owner Assistant | 25e | `/owner-chat` 프론트엔드 (기존 `AIChatBox` 재사용) + freshness 표시 | React page + tRPC stream |
| Stage 2+ | 25f+ | RAG 보조, 외부 데이터 join, 마케팅 action tool | (점주 사용 패턴 보고 결정) |

**P0 build 순서: 25a → 25b → 25d → 25e**. 25c (webhook)는 점주가 신선도 컴플레인할 때까지 보류.

---

## 6. Daily Pull job 구체 설계

```ts
// server/integrations/cleancloud/pullJob.ts
export async function runDailyPull(trigger: "11am" | "10pm") {
  const syncId = await db.insert(syncLog).values({ 
    source: "cleancloud", 
    trigger: `daily_pull_${trigger}`, 
    endpoint: "multi"
  });
  
  const windowFrom = subHours(new Date(), 14);  // 14h overlap (12h gap + 2h buffer)
  
  try {
    await pullCustomers(windowFrom, syncId);
    await pullOrders(windowFrom, syncId);
    await pullPayments(windowFrom, syncId);
    if (trigger === "10pm") {
      await pullProductCatalog(syncId);  // 카탈로그는 하루 1번만
    }
    await db.update(syncLog).set({ finishedAt: new Date() }).where(eq(syncLog.id, syncId));
  } catch (err) {
    await db.update(syncLog).set({ finishedAt: new Date(), error: String(err) }).where(eq(syncLog.id, syncId));
    await notifyOwner({ title: "CleanCloud daily pull failed", content: String(err) });
  }
}
```

스케줄링: `manus-heartbeat` cron job.
- `0 11 * * *` America/Los_Angeles → `runDailyPull("11am")`
- `0 22 * * *` America/Los_Angeles → `runDailyPull("10pm")`

(친구 매장이 LA 시간대인지 확인 필요 — 현재 미확인 항목으로 §8에 추가.)

### Overlap window (14h)

12h gap이 아니라 14h overlap을 잡는 이유: 점주 매장이 close 직전 (예: 21:55)에 주문이 들어왔다가 paymentDate가 22:00:30이 되면 22:00 pull이 못 잡을 수 있음. 14h overlap이면 다음 pull (다음날 11:00)이 21:00 이후 데이터를 다시 한 번 쓸어담음. upsert이므로 중복 무해.

---

## 7. Backfill 절차 (첫 도입 시)

```
관리자 admin UI에 "Backfill 시작" 버튼 →
  1. sync_log에 trigger="backfill" 시작 row 적재
  2. getCustomer (createdSecondsAgoFrom=1년) 페이지네이션 → customers upsert
  3. getOrders (dateFrom=오늘-1년, dateTo=오늘) 30일 단위로 12회 페이지네이션 → orders upsert
  4. getPayments 동일하게
  5. getProducts/getPriceLists 전체 스냅샷
  6. 완료 시 sync_log에 rowsSynced 기록 + owner notify
```

1년치는 ~12,000 주문 = ~120 페이지 = ~40초 (rate limit 안에서). 한 번만 실행하고 그 뒤로는 daily pull이 incrementally 업데이트.

---

## 8. Failure modes & monitoring

| 실패 모드 | 감지 방법 | 대응 |
|---|---|---|
| 11:00 또는 22:00 pull 실패 | sync_log 마지막 trigger row의 `finishedAt is null` | owner notify + 다음 schedule에서 자동 재시도 (다음 pull이 14h overlap으로 쓸어담음) |
| 두 번 연속 pull 실패 | 24h 이상 새로운 finished sync 없음 | 더 시끄러운 alert (SMS via Phase 23f Nextiva) + admin UI banner |
| 가격표 변경 감지 | daily diff에서 `products.priceCents` 변경 | `productChanges` 적재 + owner notify |
| schema drift | adapter에서 unknown field 감지 | log warn → raw_payload에는 들어감 → 다음 sprint에 schema 확장 검토 |
| Adapter parse 실패 | 특정 row만 실패 | sync_log.rowsFailed 증가 + 해당 raw payload archive |
| 매장 운영 시간 외 pull (timezone 미스매치) | sync_log의 windowFrom이 비어있는 시간대 | timezone 설정 확인 |

monitoring 대시보드: `/admin/sync-status` (Phase 25b).

---

## 9. 친구한테 확인할 것 — 업데이트

webhook 활성화 요청은 제거됨 (Stage 0에선 불필요). 남은 질문:

1. CleanCloud admin에 **data retention 설정** 페이지가 있는지? 캡쳐.
2. 매장 **timezone**? (LA? NYC? 다른 곳?) — daily pull 시간이 정확히 매장 한산 시간에 맞아야 함.
3. **B2B 비즈니스 계정** 운영 여부? — 있다면 `business_accounts` mirror 추가.
4. **Locker 서비스** 운영 여부? — 안 하면 locker 필드 분석 제외.
5. **모바일 앱**을 손님들에게 권장하는가? — Stage 2+에서 메시지 채널 활성화 여부 결정.

---

## 10. 결론

- **P0 채택안**: Stage 0 — Daily Pull 2회 (11:00 + 22:00), no webhooks
- **Schema**: Vendor-neutral (`customers`/`orders`/`payments`/`products`) + `external_refs` 매핑 + `source` 컬럼
- **POS migration**: schema 변경 없이 가능. adapter만 추가하면 됨.
- **다음 doc**: [`../agentic_owner_assistant.md`](../agentic_owner_assistant.md) — 이 schema 위에서 LLM agent가 점주 질문을 어떻게 답하는가
