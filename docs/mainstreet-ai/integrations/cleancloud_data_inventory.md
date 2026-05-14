# CleanCloud — 매장에서 빼올 수 있는 데이터 인벤토리

작성일: 2026-05-14  
대상 매장: DropShop (드라이클리닝, CleanCloud POS 사용)  
용도: AI agent가 진짜 POS에 연결됐을 때 어떤 데이터를 받아서 어떤 답변/자동화를 할 수 있는지 한 장으로 파악

---

## TL;DR — 한 줄 요약

CleanCloud API는 **43개 endpoint + 8개 webhook**으로 매장의 거의 모든 운영 데이터를 노출함. 우리 AI agent 입장에서 **즉시 가치 있는 데이터 6덩어리**(고객 프로필, 주문 + 상태, 가격표 + 상품, 결제 + 인보이스, 픽업/배송 슬롯, 멤버십/로열티/프로모)와 **나중에 가치 있는 2덩어리**(인보이스/B2B 계정, 운영 보고서) 모두 노출됨. 단, 두 가지 제약:

1. **유료 플랜 필요** — CleanCloud `Grow` 또는 `Grow+` 구독에서만 API 활성화. 친구가 어느 플랜인지 먼저 확인 필요.
2. **Rate limit** — 월 50,000 requests, 초당 3 requests. 매장 규모엔 충분하지만 폴링 설계 시 고려해야 함.

webhook은 폴링 없이 실시간 푸시 받을 수 있어서 **Nextiva보다 훨씬 통합 친화적** — 주문 상태 바뀌면 즉시 우리 서버로 POST가 옴.

---

## 1. 전체 API 표면

| 카테고리 | endpoint 개수 | 주요 endpoint |
|---|---|---|
| 고객 관리 | 6 | `addCustomer`, `updateCustomer`, `deleteCustomer`, `loginCustomer`, `getCustomer`, `passwordCustomer` |
| 주문 관리 | 6 | `addOrder`, `updateOrder`, `deleteOrder`, `getOrders`, `getGarment`, `updateGarment` |
| 가격/상품 | 3 | `getPriceLists`, `getProducts`, `getInventory` |
| 메시지/통신 | 2 | `addMessage`, `getMessages` |
| 픽업/배송 | 6 | `getPickups`, `addPickup`(repeat), `updatePickup`, `deletePickup`, `getDates`, `getSlots`, `getRoute`, `driverLocation` |
| 결제/카드 | 6 | `addCard`, `chargeCard`, `getCards`, `setDefaultCard`, `getInvoices`, `getPayments` |
| 멤버십/마케팅 | 6 | `getReferral`, `usePromo`, `convertLoyaltyPoints`, `addSubscription`, `deleteSubscription`, `getSubscription` |
| B2B 계정 | 1 | `getBusinessAccounts` |
| 운영 보고서 | 1 | `summaryReport` |
| 모바일 앱 푸시 | 2 | `addPushToken`, `deletePushToken` |
| 사진 / 자산 | 1 | `getPhotos` |
| 고객 그룹 | 1 | `addToCustomerGroup` |
| webhook | 8 이벤트 | 주문 상태 변경 포함 |

총 **43개 REST endpoint + 8개 webhook**. 모두 POST 방식 RESTful, `api_token`을 body에 포함, JSON 응답.

---

## 2. AI agent 관점 — 데이터 인벤토리 매트릭스

각 데이터 덩어리를 (1) 어떤 endpoint에서 빼는지, (2) 어떤 필드가 들어오는지, (3) AI agent가 어떻게 활용할 수 있는지 정리.

### 2.1 고객 프로필 — `getCustomer` ⭐ 가장 중요

고객 ID 1개로 또는 가입 날짜 범위로 조회 가능. 빠질 수 있는 필드 (DropShop 시나리오 기준 중요한 것만 추린 것):

| 필드 | 설명 | AI 활용 |
|---|---|---|
| `customerName`, `customerTel`, `customerEmail` | 기본 신원 | 문자 받았을 때 누군지 식별 (현재 mock의 `getCustomerByPhone` 직접 대체) |
| `customerAddress`, `customerAddressInstructions` | 주소 + 도어맨/층 메모 | 픽업 요청 들어왔을 때 "주소 맞아요?" 확인 |
| `customerRoute`, `customerLat`, `customerLng` | 픽업 루트 + GPS | 배송 가능 여부 + 픽업 일정 자동 매핑 |
| `customerNotes` | 매장 직원이 적어놓은 메모 | 예: "이 손님 항상 light starch" → AI 답변 톤/스타일에 반영 |
| `customerGender`, `birthdayDay`, `birthdayMonth` | 생일 | 생일 자동 인사/할인 푸시 |
| `marketingOptIn` | 마케팅 동의 여부 | 마케팅 메시지 보낼 때 필터 (compliance) |
| **선호도 필드 (드라이클리닝 전용)** | | |
| `starchPreference` | 풀먹임 강도 (없음/라이트/노멀/헤비) | 옷 접수 메시지에 자동 반영 |
| `shirtPreference`, `trouserPreference` | 셔츠/바지 마감 (행어/박스/접기) | 동일 |
| `detergentType`, `detergentScent` | 세제 종류/향 | 동일 |
| `fabricSoftenerType` | 섬유유연제 선호 | 동일 |
| `whitesWashTemp`, `whitesDryerHeat`, `colorsWashTemp`, `colorsDryerHeat` | 세탁/건조 온도 | 동일 |

**현재 mock과의 차이**: 우리 `mockCustomers` 테이블은 `phone, name, membership, address, notes` 5개 필드만 가지고 있음. CleanCloud에서 진짜로 빼오면 **선호도 9개 필드**가 추가됨. 이게 AI 답변을 "Hi, your order is ready" 수준에서 **"Hi Andrew, your shirts (boxed, light starch as usual) are ready"** 수준으로 끌어올림.

### 2.2 주문 + 상태 — `getOrders`

필터 옵션이 풍부함:

| 필터 | 용도 |
|---|---|
| `orderID` | 단일 주문 조회 |
| `customerID` | 특정 고객의 모든 주문 |
| `dateFrom`, `dateTo` | 날짜 범위 |
| `updatedSecondsAgoFrom` | "지난 X초 안에 업데이트된 주문" — 폴링에 최적 |
| `status` | 4=Awaiting Pickup, 5=Detailing, 0=Cleaning, 1=Ready, 2=Completed |
| `completed` | 0/1 |
| `paid` | 0/1 |
| `sendProductDetails` | 1로 두면 garment 단위 디테일까지 포함 |

응답에 포함되는 핵심 필드 (`addOrder`에서 들어가는 필드 기준으로 역추정):
- `orderID`, `customerID`, `status`, `finalTotal`, `paid`, `completed`
- `pickupDate`, `pickupStart`, `pickupEnd`, `delivery`, `deliveryDate`, `deliveryStart`, `deliveryEnd`
- `orderNotes`, `notifyMethod` (SMS/EMAIL/둘 다/안 함)
- `paymentType` (현금/카드/수표)
- `express` (정규/익스프레스)
- `tip`, `discount`, `tax`, `tax2`, `tax3`, `deliveryFee`, `minimumAdjust`, `creditUsed`
- `storeOrder`, `storeDropOffDate`, `storeReadyByDate`, `storeReadyByTime`
- `lockerOrder`, `lockerNumber`, `lockerLocationID`
- `priceListID`
- `products[]` (각 제품의 `id`, `name`, `price`, `pieces`, `quantity`)
- `staffVerify` 플래그

**AI 활용**:
- "내 주문 어디까지 됐어?" → `status` 인간이 읽는 문장으로 변환 + `pickupDate/deliveryDate`로 ETA 답변. 현재 mock의 `etaText` 자리에 진짜 데이터 들어옴.
- "픽업 시간 바꿀 수 있어요?" → `updateOrder`로 직접 변경 가능 (현재 우리는 안 함, 추후 가능)
- "결제 안 됐어?" → `paid=0` 확인 후 결제 링크 안내

### 2.3 Garment 단위 디테일 — `getGarment`, `getOrderGarments`

옷 한 벌 한 벌의 상태. drop-off 직후 매장 직원이 라벨링한 정보가 그대로 노출. 어떤 옷이 어떤 단계에 있는지, stain 처리 중인지, 분실/손상 표시됐는지 등. AI agent가 "내 빨간 자켓 어디 있어요?" 같은 super-specific 질문에 답할 수 있게 함.

### 2.4 가격표 + 상품 — `getPriceLists`, `getProducts`, `getInventory`

| Endpoint | 무엇을 줌 |
|---|---|
| `getPriceLists` | 매장이 운영 중인 모든 활성 가격표 (예: 정가, VIP 할인가, 시즌 프로모) |
| `getProducts` | 각 가격표에 속한 상품 + 가격. `sendParents=1`로 부모 카테고리, `sendUpcharges=1`로 추가 옵션, `inStore=1`로 POS 뷰 |
| `getInventory` | 실시간 재고 (소매 상품용 — 매장에서 옷걸이/세제 같이 파는 경우) |

**AI 활용**:
- "코트 한 벌 얼마예요?" → `getProducts`에서 정확한 정가 답변. 현재 mock의 `searchPrice` 직접 대체.
- "VIP 가격으로 부탁할 수 있어요?" → 고객의 `priceListID`와 매핑되는 가격표 자동 적용.
- 가격이 매장에서 바뀌면 우리 RAG 시드도 자동으로 stale → `getPriceLists` 주기 풀로 동기화하면 영구히 최신.

### 2.5 결제 + 인보이스 — `getInvoices`, `getPayments`

| Endpoint | 무엇을 줌 |
|---|---|
| `getInvoices` | 발행된 인보이스 (B2B 계정용 — 호텔, 식당 등 정기 거래처) |
| `getPayments` | 모든 결제 이력 (현금/카드/체크 + 환불 + 크레딧 차감) |

**AI 활용**:
- "지난 달 얼마 썼어요?" → `getPayments` 합산
- "환불 받았나요?" → `getPayments`에서 negative entry 찾기
- B2B 계정의 미수금 알림 자동화 (이건 매장 owner-facing 기능)

### 2.6 멤버십 / 로열티 / 프로모 — `getReferral`, `usePromo`, `convertLoyaltyPoints`, `addSubscription`

| Endpoint | 무엇을 줌 / 함 |
|---|---|
| `getReferral` | 고객 추천 코드 + 추천 보상 정보 |
| `usePromo` | 프로모 코드 적용 (또는 `onlyCheckIfValid=1`로 유효성만 검사) |
| `convertLoyaltyPoints` | 적립 포인트 → 크레딧 전환 |
| `getSubscription` / `addSubscription` / `deleteSubscription` | 정기 구독 (월간 빨래 같은 거) |

**AI 활용**:
- "쿠폰 코드 SUMMER20 써도 돼?" → `usePromo`에 `onlyCheckIfValid=1`로 검증 후 답변
- "포인트 얼마나 쌓였어?" → `getCustomer` (loyalty 필드 포함) + `convertLoyaltyPoints`로 즉시 사용 가능
- "VIP 멤버십 가입하고 싶어요" → `addSubscription` 자동 안내. 현재 mock의 `getMembershipInfo`를 대체.

### 2.7 픽업/배송 + 드라이버 — `getDates`, `getSlots`, `getRoute`, `driverLocation`, `getPickups`

| Endpoint | 무엇을 줌 |
|---|---|
| `getDates` | 특정 루트에서 가능한 픽업/배송 날짜 + 슬롯 잔량 |
| `getSlots` | 특정 날짜의 시간 슬롯 |
| `getRoute` | 위경도 → 루트 번호 (이 손님이 어느 루트에 속하는지) |
| `driverLocation` | 드라이버 실시간 위치 (특정 주문 기준) |
| `getPickups` | 정기 픽업 일정 |

**AI 활용**:
- "내일 픽업 가능해요?" → `getDates`로 가용 슬롯 확인 후 즉시 예약 안내
- "지금 배송 어디쯤이에요?" → `driverLocation`으로 GPS 기반 ETA. 이건 우버이츠급 경험 — **매장 입장에서 큰 가치**.
- 픽업 일정 자체를 AI가 잡아줄 수 있음 (`addOrder`로 픽업 주문 생성 가능)

### 2.8 메시지 — `addMessage`, `getMessages`

CleanCloud 내부 메시지함. 고객 앱 → 매장 채널로 흐르는 메시지. **Nextiva/Twilio 같은 SMS와는 별도**. 만약 친구가 손님들한테 CleanCloud 모바일 앱을 쓰게 했다면 이 채널이 활성. 안 썼다면 안 씀.

### 2.9 사진 — `getPhotos`

주문에 첨부된 사진 (stain 사진, 손상 증빙 등). "내 자켓 stain 어디 있었어요?" 같은 질문에 사진으로 답할 수 있게 함. 멀티모달 LLM과 잘 어울림.

### 2.10 운영 보고서 — `summaryReport`

지정한 날짜 범위의 매장 운영 요약 (매출, 주문 수, 신규 고객 수 등). owner-facing 인사이트용. AI가 매일 아침 "어제 매출 $X, 신규 손님 N명, 픽업 대기 M개" 같은 푸시 보낼 수 있음.

### 2.11 B2B / 비즈니스 계정 — `getBusinessAccounts`

식당, 호텔, 미용실처럼 정기 거래하는 B2B 고객들. 2025년 6월에 별도 lookup endpoint (`getBusinessAccountName`) 추가됐고, `getInvoices`에 `businessID`로 필터 가능. AI agent가 B2B owner에게 "이번 주 OO 식당 인보이스 $X 발행됨" 같은 자동 요약 제공 가능.

### 2.12 Webhook (이벤트 푸시)

API 페이지에서 활성화 가능한 8개 이벤트 (2024년 8월 기준 8개). 정확한 8개 리스트는 친구 CleanCloud admin에서 `Pickup and Delivery -> API` 페이지 가야 확인 가능하지만, 공개 announcement 기준 핵심은:

1. **Order Status Change** — 주문 상태가 바뀔 때마다 즉시 푸시 (Aug 2024 추가)
2. 그 외 7개 — Customer create/update, Order create, Payment 등을 포함하는 것으로 추정

**AI agent에게 결정적**: 폴링 없이 실시간 트리거 가능. 예) 손님이 매장에서 픽업 완료 → CleanCloud가 즉시 우리 서버에 POST → AI가 자동 "Thanks for your business, your shirts looked great today!" 메시지 발송.

---

## 3. 현재 DropShop demo와의 매핑

우리 demo는 mock CleanCloud (`server/mockCleanCloud.ts`)로 6개 함수를 노출함. 실제 CleanCloud API로 바꾼다면:

| Mock 함수 | CleanCloud endpoint | 매핑 난이도 | 추가 가치 |
|---|---|---|---|
| `getCustomerByPhone(phone)` | `getCustomer` (전화번호 검색은 없으므로 우리 DB에 `phone → customerID` 캐시 유지) | 낮음 (간단한 lookup table) | 선호도 9개 필드 추가 |
| `getOrdersByPhone(phone)` | `getOrders` + `customerID` 필터 | 낮음 | 픽업/배송 시간, 결제 상태, 익스프레스 여부 등 |
| `searchPrice(query)` | `getProducts` + 클라이언트 측 필터 | 중간 (한 번 호출하고 캐싱 권장) | 가격표 자동 갱신 |
| `listAllPrices()` | `getProducts` | 낮음 | 동일 |
| `getMembershipInfo(tier)` | `getSubscription` + 매장의 멤버십 정책 (CleanCloud에 직접 저장 안 됨, 별도 docs 필요) | 중간 | 진짜 가입자 수, 가입 일자 |
| `formatCents(cents)` | (그대로 유지) | — | — |

**추가로 새로 생기는 기능 (mock에 없던 것)**:
- 픽업 일정 자동 잡기 (`getDates` + `getSlots` + `addOrder`)
- 실시간 드라이버 위치 (`driverLocation`)
- B2B 인보이스 알림 (`getInvoices`)
- 사진 답변 (`getPhotos`)
- 매일 매장 요약 (`summaryReport`)
- 마케팅 캠페인 자동화 (`marketingOptIn`, `birthdayDay/Month`, `getReferral`)
- 멤버십/구독 자동 가입 안내 (`addSubscription`)

---

## 4. 통합 전 친구한테 받아야 할 정보 / 체크리스트

1. **CleanCloud 플랜 확인** — `Grow` 또는 `Grow+` 인가? 아니면 더 낮은 플랜? (API access는 Grow 이상 필요)
2. **API 토큰** — CleanCloud admin → `Pickup and Delivery → API` 페이지에서 발급. 한 줄 string.
3. **Rate limit 협상 필요한가** — 매장 트래픽이 월 50K request 안에 들어오나? 현재 매장 규모면 거의 확실히 OK지만 확인.
4. **활성화된 webhook 8개의 정확한 이름** — admin → API 페이지에서 캡처 한 장.
5. **CleanCloud 모바일 앱 사용 여부** — 친구가 손님들한테 모바일 앱 권장하는가? `addMessage/getMessages`, `addPushToken` 채널이 의미 있으려면 필요.
6. **B2B 계정 운영 여부** — 식당/호텔 같은 정기 거래처가 있나? 있다면 `getBusinessAccounts` + `getInvoices` 흐름이 가치 큼.
7. **현재 사용 중인 결제 게이트웨이** — Stripe / Clearent / EVO / CleanCloud Pay 중 무엇? `chargeCard` 호출할 때 `type` 파라미터 정확히 매핑해야 함.

---

## 5. 권장 다음 단계 (Phase 23 제안)

CleanCloud 통합을 단계적으로:

### Stage 1 — 읽기 전용 통합 (1주)
- API 토큰 + Grow 플랜 확인
- `server/messaging/cleanCloudTransport.ts` 생성 (rate limit 1초 3회 준수, 1시간 응답 캐시)
- `getCustomer`, `getOrders`, `getProducts`, `getPriceLists` 4개만 활성화
- Mock 6개 함수 중 4개를 CleanCloud 실제 호출로 교체. 환경변수 `DROPSHOP_USE_REAL_POS=1` 토글로 mock ↔ real 전환
- 새 vitest: real API 호출은 mocked fetch로 contract test

### Stage 2 — webhook 실시간 푸시 (1주)
- CleanCloud admin에서 webhook 8개 모두 활성화 → 우리 `/api/cleancloud/webhook` 엔드포인트로 라우팅
- 주문 상태 변경 webhook이 오면 자동으로 `getOrders` 재조회 → cache invalidate → 필요시 능동 문자 ("Your order is ready!")

### Stage 3 — 쓰기/액션 통합 (2주)
- AI agent가 단순 답변에서 **action 단계**로 진화: `updateOrder` (픽업 시간 변경), `addOrder` (픽업 주문 생성), `usePromo` (프로모 검증/적용)
- 모든 액션은 여전히 **shadow mode** — 자동 송신 아니라 매장 owner approval 필요

### Stage 4 — owner-facing 인사이트 (2주)
- `summaryReport` 일일 다이제스트 자동 발송
- `getBusinessAccounts` + `getInvoices` 기반 B2B 미수금 알림
- 손님 30일 inactive → 마케팅 캠페인 자동 제안 (`marketingOptIn=1`인 손님만)

---

## 6. 결론 — 한 줄

> CleanCloud는 **우리 mock의 6개 함수보다 7배 많은** 실용적 데이터(43 endpoint + 8 webhook)를 노출함. Nextiva와 달리 documented API가 진짜로 작동하고 webhook도 있어서, **친구가 Grow 플랜이기만 하면 통합 가능성은 확실히 매우 높음**. 다음 액션은 친구한테 (1) 플랜 확인, (2) API 토큰 발급 부탁하는 것.

---

## References

- [1] CleanCloud API Documentation. https://cleancloudapp.com/api
- [2] CleanCloud Webhooks 발표 (2024-06-20). https://cleancloudapp.com/updates/727
- [3] Order Status Change Webhook 추가 (2024-08-06). https://cleancloudapp.com/updates/756
- [4] getInventory endpoint 발표 (2024-10-10). https://cleancloudapp.com/updates/787
- [5] getOrderSummary endpoint 발표 (2024-10-31). https://cleancloudapp.com/updates/793
- [6] B2B Account Name lookup endpoint 발표 (2025-06-24). https://cleancloudapp.com/updates/874
- [7] CleanCloud API 공식 Postman collection (GitHub). https://github.com/cleancloud/api-doc
