# CleanCloud 데이터 활용 전략 — 무엇을 쓰고, 무엇을 버리고, 무엇을 직접 보관할 것인가

작성일: 2026-05-14 (rev 2 — daily-pull P0 + POS-neutral schema)
대상 매장: DropShop (드라이클리닝, CleanCloud Grow 플랜)
선행 문서: [`cleancloud_data_inventory.md`](./cleancloud_data_inventory.md) (43 endpoint + 8 webhook 카탈로그)
구현 디테일: [`cleancloud_pipeline.md`](./cleancloud_pipeline.md) (daily pull 2회, vendor-neutral schema, adapter 패턴)

이 문서의 목적은 **카탈로그 관점**이 아니라 **결정 관점**이다. CleanCloud가 노출하는 데이터 중에서 (1) 지금 어떤 필드를 실제로 쓰고 있고, (2) 어떤 필드는 비활성 상태로 낭비되고 있으며, (3) CleanCloud 서버에 의존하면 위험한 것은 무엇이고, (4) 우리 DB에 따로 mirror해야 하는 것은 무엇인지 — 한 장으로 결정한다.

---

## 0. TL;DR

> CleanCloud의 43개 endpoint 중 **현재 DropShop이 실질적으로 쓰는 것은 4개**(`getCustomer`, `getOrders`, `getProducts`, `getPriceLists`)이며, 그나마도 *직접 호출만 하고 어디에도 저장하지 않음*. Owner Assistant("최근 2주 단골 동향" 같은 자연어 질문에 답하는 LLM agent)를 만들려면, 적어도 `orders`/`customers`/`payments` 세 덩어리는 **반드시 우리 DB로 mirror**해야 한다. 이유는 세 가지: (a) CleanCloud는 분석용 쿼리 API를 제공하지 않음 (단일-주문/단일-고객 lookup 위주), (b) rate limit (월 50K req, 초당 3 req) 안에서 시계열 집계는 불가능, (c) 데이터를 우리 쪽에 둬야 SQL/벡터 검색/외부 데이터 join이 가능해진다. CleanCloud는 매장 운영의 **source of truth**로 유지하되, 우리는 그 위에 **read-only analytical replica**를 쌓는다.
>
> **P0 출시 단계는 daily pull 1회 (03:00 America/New_York) 만으로 시작**한다 (webhook은 의도적으로 도입 안 함 — 자세히는 [pipeline.md §1](./cleancloud_pipeline.md)). 그리고 우리가 결국 자체 POS를 만들 것이므로, mirror 테이블 이름을 vendor-neutral하게 (`customers`/`orders`/`payments`/`products`) 짓고 vendor-specific ID는 별도 `external_refs` 테이블로 분리한다. 이렇게 하면 미래 DropShop POS로 갈아탈 때 schema 변경 0줄로 가능.

---

## 1. 결정 매트릭스 — 한눈에

| 데이터 덩어리 | 현재 DropShop이 쓰는가? | CleanCloud의 영구 보관 여부 | 우리 mirror 필요? | 이유 (한 줄) |
|---|---|---|---|---|
| **고객 프로필 + 선호도** | ⚠️ phone→ID lookup만 | ✅ 영구 | ✅ **필수** | 선호도 9개 필드가 LLM 답변 톤·정확도를 결정짓는 핵심 컨텍스트 |
| **주문 (주문 단위)** | ⚠️ 직접 호출만, 저장 안 함 | ✅ 영구 | ✅ **필수** | 시계열 분석, "최근 N주 동향" 류 질문은 mirror 없이 불가능 |
| **Garment (옷 한 벌 단위)** | ❌ | ✅ 영구 | 🟡 **선택** | 가치 있지만 stage 1엔 과함; "내 빨간 자켓 어디" 류 질문 필요해질 때 |
| **가격표 + 상품 카탈로그** | ⚠️ 호출만, 저장 안 함 | ✅ 영구 | ✅ **필수 (캐시)** | 매장에서 바뀌면 stale; webhook 없으니 nightly snapshot으로 잡아야 함 |
| **결제 / 인보이스** | ❌ | ✅ 영구 | ✅ **필수** | 매출/객단가/B2B 미수금 등 owner 인사이트 질문 전부 여기에 의존 |
| **멤버십 / 로열티 / 프로모** | ❌ | ✅ 영구 | 🟡 **선택** | "이 손님 포인트 얼마?" 류는 on-demand로 충분; 마케팅 캠페인 자동화 단계에서 mirror |
| **픽업/배송 슬롯 + 드라이버 위치** | ❌ | ⚠️ 슬롯=영구, GPS=실시간만 | ❌ **mirror 불가** | GPS는 본질적으로 실시간 — webhook 또는 직접 호출만 가능 |
| **메시지 (CleanCloud 앱 내)** | ❌ | ❓ retention 불명 | 🟡 **선택** | 친구가 CleanCloud 모바일 앱 안 쓰면 채널 자체가 비활성 |
| **사진** | ❌ | ❓ retention 불명 | 🟡 **선택 (URL만)** | 바이트 mirror는 비용 큼; URL만 보관, 만료되면 재요청 |
| **운영 보고서** | ❌ | ✅ 영구 (집계는 매번 재계산) | ❌ **mirror 불필요** | 우리가 raw `orders`/`payments` 미러를 갖게 되면 자력으로 더 깊은 집계 가능 |
| **B2B 비즈니스 계정** | ❌ | ✅ 영구 | ✅ **필수 (있다면)** | B2B 미수금 알림 자동화의 root; 친구한테 B2B 계정 유무 확인 필요 |
| **Webhook 이벤트 로그** | ⚠️ 핸들러만 있음 | ❌ CleanCloud는 재전송 안 함 | ✅ **필수** | 한 번 놓치면 영영 없음 — raw payload를 무조건 우리 쪽에 적재해야 함 |

**범례**: ✅ 결정 완료 · ⚠️ 부분/임시 · ❌ 안 함 또는 불가능 · 🟡 stage 2+

---

## 2. Endpoint별 활용·낭비 분석

각 endpoint에 대해 (a) 어떤 필드가 *실용적으로 가치 있고*, (b) 어떤 필드는 *수집해도 쓰지 않을 것이고*, (c) 어떤 필드는 *가치 있지만 stage 1엔 미룬다*를 명시한다.

### 2.1 `getCustomer` — 가장 비대칭적인 endpoint

고객 1명이 보유한 30+ 필드 중, **AI agent 입장에서 실용적인 것은 12개**, 나머지는 매장 운영 백오피스용이다.

| 필드 | 활용 plan | 분류 |
|---|---|---|
| `customerName`, `customerTel`, `customerEmail` | 신원 식별, 메시지 인사말 | ✅ 사용 |
| `customerAddress`, `customerAddressInstructions` | 픽업 요청 시 주소 확인 | ✅ 사용 |
| `customerLat`, `customerLng`, `customerRoute` | 배송 가능 루트 자동 매핑 | ✅ 사용 |
| `customerNotes` | "이 손님 항상 light starch" 같은 매장 직원의 자유 메모 | ✅ 사용 (LLM 컨텍스트에 inject) |
| `starchPreference`, `shirtPreference`, `trouserPreference`, `detergentType`, `detergentScent`, `fabricSoftenerType`, `whitesWashTemp`, `whitesDryerHeat`, `colorsWashTemp`, `colorsDryerHeat` | **드라이클리닝 전용 선호도 10개** — 답변을 "your order is ready" → "your shirts (boxed, light starch as usual) are ready"로 끌어올리는 핵심 | ✅ 사용 |
| `marketingOptIn`, `birthdayDay`, `birthdayMonth`, `customerGender` | 마케팅 캠페인 필터 + 생일 자동 인사 | 🟡 stage 2 (Owner Assistant가 마케팅 캠페인 제안할 때) |
| `customerPassword`, `customerPasswordReset` | 우리는 CleanCloud 앱 로그인 안 함 | ❌ 무시 |
| `customerLoyaltyPoints`, `customerCredit` | 포인트/크레딧 잔액 — 가치 있지만 on-demand 충분, mirror 불필요 | 🟡 on-demand |
| `customerCreatedDate`, `customerUpdatedDate` | mirror sync 메타데이터로 사용 | ✅ 사용 (필드 자체는 안 보여줌) |
| `customerActive`, `customerArchived` | 비활성/삭제 고객 필터링 | ✅ 사용 |
| `taxExempt`, `taxRate`, `tax2Rate`, `tax3Rate` | 가격 계산에만 필요하고 LLM 답변에 직접 안 씀 | ❌ 무시 (raw mirror엔 포함) |
| `priceListID` | 어떤 가격표를 보여줘야 하는지 결정 | ✅ 사용 |
| `defaultCardID` | 결제 자동화 단계에서 필요 | 🟡 stage 3+ |

**낭비**: `customerPassword`, `tax*Rate` 등 매장 백오피스용 필드 5–7개. 수집은 자동으로 따라오지만 LLM 컨텍스트에 절대 injecting하지 않는다 (토큰 낭비 + 데이터 누출 위험).

### 2.2 `getOrders` — 가장 데이터 무거운 endpoint

주문 1건당 50+ 필드 + `products[]` 배열. **owner-facing 인사이트 질문의 99%가 여기서 나옴**.

| 필드 묶음 | 활용 plan |
|---|---|
| 식별 (`orderID`, `customerID`, `priceListID`) | ✅ mirror 핵심 키 |
| 상태 (`status`, `paid`, `completed`, `staffVerify`) | ✅ "내 주문 어디?" 류 답변 + 시계열 funnel 분석 |
| 시점 (`dateAdded`, `storeDropOffDate`, `pickupDate`, `deliveryDate`, `storeReadyByDate`) | ✅ **시계열 분석의 척추** — 모든 동향 질문이 이걸 기준으로 함 |
| 금액 (`finalTotal`, `tip`, `discount`, `tax`, `tax2`, `tax3`, `deliveryFee`, `minimumAdjust`, `creditUsed`) | ✅ 매출/객단가/할인율 등 owner 분석 |
| 옵션 (`express`, `paymentType`, `notifyMethod`) | ✅ "익스프레스 비중", "결제 방식 분포" 류 |
| 픽업/배송 (`pickupStart`, `pickupEnd`, `deliveryStart`, `deliveryEnd`, `delivery`) | ✅ ETA 답변 + 슬롯 이용률 분석 |
| 라커 (`lockerOrder`, `lockerNumber`, `lockerLocationID`) | 🟡 매장이 locker 운영 안 하면 무시 |
| 자유 메모 (`orderNotes`) | ✅ LLM 컨텍스트로 injection |
| `products[]` | ✅ **두 번째 척추** — "어떤 상품이 잘 팔리는지" 분석은 이 배열 join에 의존. 별도 mirror 테이블 권장. |

**낭비**: locker 필드 3개 (친구가 locker 운영 안 한다면). 일단 raw로 수집하되 분석 쿼리에 안 씀.

### 2.3 `getProducts` / `getPriceLists` — 카탈로그

가격표는 *상대적으로 정적*이지만 매장에서 가격을 바꿔도 우리에게 webhook이 안 온다. **stale 위험**이 가장 큰 데이터.

| 결정 | 이유 |
|---|---|
| 매일 1회 nightly snapshot | 50K req 한도 안에서 비용 미미; webhook 없음으로 인한 stale을 1일로 제한 |
| 변경 감지 시 알림 | 가격 변경 추적은 자체로 owner-facing 가치 ("어제 코트 가격을 $25 → $28로 올렸는데, 이번 주 코트 주문이 20% 줄었습니다") |

### 2.4 `getPayments` / `getInvoices` — 매출/B2B 미수금

owner의 *돈에 관한 모든 질문*은 여기서 나옴. 결제 1건의 필드는 비교적 단순함 (`paymentID`, `orderID`, `amount`, `type`, `date`, `refunded`).

| 필드 | 활용 plan |
|---|---|
| 모든 필드 | ✅ raw mirror — 분석 쿼리가 너무 다양해서 *지금* 어떤 필드를 쓸지 미리 가지치기하면 안 됨 |

**낭비 가능성 0**. 매출 데이터는 mirror 비용 < 분석 가치.

### 2.5 `summaryReport` — 우리가 이걸 안 쓰는 이유

CleanCloud가 직접 제공하는 운영 요약 리포트. 매력적이지만 **deliberately 사용 안 함**.

이유: 우리가 `orders` + `payments`를 raw로 미러링한다면, 그 위에서 **더 깊고 유연한 집계**가 SQL로 가능하다. CleanCloud의 `summaryReport`는 미리 정의된 컬럼만 노출. Owner Assistant가 "이번 달 평일 vs 주말 매출 비교"처럼 임의의 cut을 할 수 있어야 하는데, 그건 raw 데이터 mirror가 있어야 가능하다. 결론: `summaryReport`는 비교/검증용으로만 가끔 호출하고, primary source는 우리 mirror.

### 2.6 webhook 8개 — 가장 fragile한 데이터

webhook은 **재전송이 없다**. CleanCloud는 처음 한 번만 POST하고, 우리가 5xx로 응답하거나 timeout이 나도 retry 안 함. 한 번 놓치면 그 이벤트는 영원히 없는 셈.

→ 결정: 모든 webhook payload를 받는 즉시 *처리 전에* raw로 `webhook_events` 테이블에 적재. 처리 실패해도 raw는 남음. 나중에 backfill 가능.

이 부분은 Phase 23f-7에서 이미 구현됨. 새로 할 일은 없지만 **Phase 24의 mirror 파이프라인이 이 raw 테이블을 source로 삼는다**는 점이 중요.

---

## 3. CleanCloud 데이터 retention에 대한 가정

CleanCloud는 공식 retention SLA를 공개하지 않는다. 친구 admin 화면에서 보존 설정 페이지가 있는지 확인하기 전까지, 우리는 보수적 가정을 깔고 간다.

| 데이터 | 가정 | 우리 대응 |
|---|---|---|
| 고객 프로필 | 영구 보존 (`customerArchived=1`로 soft-delete만) | mirror해도 OK; 우리도 soft-delete만 |
| 주문 + garment | 영구 보존 | mirror해도 OK |
| 결제 + 인보이스 | 영구 보존 (회계 요구사항) | mirror해도 OK |
| 메시지 (CleanCloud 앱 내) | **불명 — 1년 가능성 있음** | 만약 친구가 채널 활성화하면 미러링 필수 |
| 사진 | **불명 — 1–2년 가능성 있음** | URL만 mirror, 만료 감지되면 백오피스 알림 |
| 가격표 변경 이력 | **CleanCloud는 변경 이력을 안 보여줌** (현재 가격만 노출) | nightly snapshot diff로 우리가 직접 변경 이력 생성 |
| webhook 이벤트 | **재전송 없음 = retention 0** | 받는 즉시 raw 적재 (위 2.6 참고) |

**친구한테 확인할 것 (Phase 24a 후속 질문 1개로 통합)**: CleanCloud admin에서 "데이터 보존 기간" 또는 "data retention" 같은 메뉴가 보이는지, 보이면 캡쳐. 안 보이면 영구 보존이라고 가정.

---

## 4. "Mirror"라는 결정의 비용·이득

데이터를 우리 DB에 복제하는 것은 공짜가 아니다. 비용·이득을 명시한다.

### 비용

1. **저장 공간** — DropShop 규모(추정 일 30–80 주문, 활성 고객 ~수천 명)에서 5년치 mirror는 수 GB 수준. TiDB 무료 티어 안에서 해결 가능. 비용 0에 수렴.
2. **동기화 복잡도** — 가장 큰 리스크. CleanCloud가 source of truth라는 것을 잊고 우리 mirror에 직접 쓰기를 하는 순간 데이터가 갈라진다. 규칙: **mirror는 read-only**. 쓰기는 무조건 CleanCloud API를 통해서 한다.
3. **stale window** — webhook이 누락되면 mirror가 잠시 stale. nightly snapshot으로 self-heal.
4. **schema drift** — CleanCloud가 필드를 추가/삭제하면 우리 schema 업데이트가 필요. JSON column으로 `raw_payload`도 함께 보관하면 schema migration 없이 새 필드를 사용 가능. → **`raw_payload JSON` 컬럼 항상 추가**.

### 이득

1. **SQL이 가능해진다** — `WHERE date >= NOW() - INTERVAL 14 DAY GROUP BY customerID HAVING COUNT(*) >= 3` 같은 분석은 mirror가 없으면 매번 50K 주문을 API로 끌어와서 메모리에서 집계해야 함. 비현실적.
2. **rate limit 회피** — Owner Assistant가 자연어 질문 1개를 답하기 위해 50개 SQL을 돌릴 수도 있는데, CleanCloud API로 50개 호출하면 16초가 걸린다 (초당 3 req). mirror 위에서 50개 SQL은 50ms.
3. **외부 데이터 join 가능** — Google Trends, 날씨, 지역 행사 등을 join한 인사이트는 mirror 없이는 절대 불가능.
4. **RAG / 벡터 검색** — `customerNotes`, `orderNotes` 같은 텍스트 필드를 embedding해서 의미 검색 가능. 이건 CleanCloud API가 절대 못 줌.

**결론**: 비용은 mostly engineering effort 1회, 이득은 *Owner Assistant 자체의 가능성*. mirror 없이는 Owner Assistant 못 만든다.

---

## 5. Mirror 대상 — 4개 코어 + 2개 메타 (vendor-neutral)

P0 schema는 vendor-neutral하게 설계. CleanCloud는 첫 source, DropShop POS는 둘째 source가 됨. 자세한 컬럼은 [pipeline.md §3](./cleancloud_pipeline.md) 참조.

| 테이블 | source endpoint (현재 vendor=cleancloud) | 갱신 트리거 (Stage 0) | 핵심 컬럼 |
|---|---|---|---|
| `customers` | `getCustomer` (updatedSecondsAgoFrom=86400) | daily pull 03:00 ET | `id PK (internal UUID)`, `source`, 위 §2.1 ✅ 필드, `raw_payload JSON`, `synced_at` |
| `orders` | `getOrders` (dateFrom=28h ago) | daily pull 03:00 ET | `id PK`, `source`, `customer_id FK`, 위 §2.2 ✅ 필드, `raw_payload JSON` |
| `payments` | `getPayments` (dateFrom=28h ago) | daily pull 03:00 ET | `id PK`, `source`, `order_id FK`, `amount_cents`, `type`, `paid_at`, `refunded` |
| `products` | `getProducts` / `getPriceLists` (전체) | daily pull 03:00 ET | `id PK`, `source`, `price_list_id`, `name`, `price_cents`, `category` |
| **`external_refs`** (매핑) | — | upsert 시마다 | `entity_type`, `source`, `external_id`, `internal_id` (Customer/Order/Payment/Product ID 매핑) |
| **`sync_log`** (메타) | — | 모든 pull 작업 | `id PK`, `source`, `trigger` (`daily_pull_03am_et`/`backfill`/`manual`), `endpoint`, `started_at`, `finished_at`, `rows_synced`, `error` |

`sync_log`가 별도 있어야 하는 이유: Owner Assistant가 "이 답변 얼마나 fresh해?"라고 답할 수 있어야 함. "데이터는 오늘 03:00 ET pull 기준" 같은 정직한 freshness 메타 표시 가능.

`external_refs`가 별도 있어야 하는 이유: 우리가 자체 POS를 만들 때 같은 fact 테이블을 두 vendor가 공유. 표준 SQL을 그대로 쓰면서 vendor mapping만 분리.

**Stage 1 (webhook 도입) 추가 테이블**: `webhook_events` (raw payload archive). Stage 0에서는 불필요.

---

## 6. *Mirror 안 하는* 데이터

명시적으로 mirror에서 제외하는 것들 — 이유와 함께.

| 데이터 | 제외 이유 |
|---|---|
| `driverLocation` | 본질적으로 ephemeral (수 초 단위 변경). pull-through만. |
| `getSlots` (특정 날짜 슬롯) | 매장에서 슬롯 정의가 자주 바뀌므로 mirror는 빠르게 stale. 픽업 예약 시점에 직접 호출. |
| `getPhotos` 바이트 | URL만 mirror (위 §3 참고). 바이트는 storage 비용 큼. |
| `summaryReport` | §2.5 참고 — 우리가 자력으로 더 잘함. |
| `getReferral`, `usePromo`, `convertLoyaltyPoints` 응답 | 액션의 *결과*이지 분석 대상이 아님. webhook + log만. |
| 모바일 푸시 토큰 (`addPushToken`) | DropShop은 자체 푸시 안 보냄. |

---

## 7. Open questions — 친구한테 한 번에 모아 물어볼 것

1. CleanCloud admin → Settings 어디엔가 **data retention 설정** 또는 표시 페이지가 있는지? 있으면 스크린샷.
2. **B2B 비즈니스 계정**을 운영하는가? (호텔, 식당, 미용실 정기 거래처) — 있다면 `getBusinessAccounts` mirror 필요.
3. **Locker 서비스** 운영하는가? — 안 하면 locker 관련 필드 분석 제외.

*(timezone=NYC, 앱=태블릿 POS 전용 이 둘은 2026-05-14 사용자 응답으로 확정. 원래 있던 "활성화된 webhook 8개 캡쳐"는 Stage 0에선 불필요 — Stage 1 도입 결정 시점에 다시 요청.)*

---

## 8. 결론 — 다음 문서 (24b)에서 다룰 것

이 문서는 "무엇을 쓰고 무엇을 버릴 것인가"를 결정했다. 다음 문서 [`cleancloud_pipeline.md`](./cleancloud_pipeline.md)는 그 결정을 *어떻게 구현할 것인가*를 다룬다:

- mirror를 채우는 3가지 파이프라인 옵션 (on-demand pull · webhook + cache · webhook + nightly snapshot) 비교
- 추천안의 schema migration (drizzle/schema.ts 변경 사항)
- backfill 절차 (첫 통합 시 1년치 historical 데이터를 어떻게 끌어오는가)
- 모니터링 / failure mode

그 다음 문서 [`agentic_owner_assistant.md`](../agentic_owner_assistant.md)는 *그 mirror 위에서* 자연어 질문을 어떻게 LLM이 답하게 할 것인지 — agent 아키텍처와 질문 taxonomy를 다룬다.

---

## References

- [1] CleanCloud API Documentation. https://cleancloudapp.com/api
- [2] CleanCloud Webhooks 발표 (2024-06-20). https://cleancloudapp.com/updates/727
- [3] Phase 23f-7 webhook handler — `server/cleanCloudWebhook.ts`
- [4] 기존 인벤토리 문서 — [`cleancloud_data_inventory.md`](./cleancloud_data_inventory.md)
