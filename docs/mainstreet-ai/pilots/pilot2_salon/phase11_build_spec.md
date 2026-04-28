# Phase 11 — Salon Demo Build Spec

> 새 세션에서 이 파일을 먼저 읽고 빌드 시작.
> 위치: `/home/ubuntu/mainstreet-ai/pilots/pilot2_salon/phase11_build_spec.md`

## 결정된 사양 (User-confirmed)

| 항목 | 결정 |
|---|---|
| 라우트 | `/salon` (별도 페이지, DropShop은 `/` 그대로) |
| Industry 토글 | (a) 헤더 우측 작은 토글 `Laundry / Salon` |
| 톤 & 매너 | **옵션 B — Verdant Beauty Co. (Modern Botanical)** |
| 캘린더 시각화 | (b) 미니 타임라인 시각 |
| 빌드 범위 | DropShop 미터치, 80% 코드 재사용 |

## 디자인 시스템 (Modern Botanical)

```
배경       : #F8F6F0  (off-white)
프라이머리  : #7A8E6F  (sage green)
액센트     : #C2825F  (terracotta)
텍스트     : #1A1F1C  (ink black)
보더       : #E5E2D8
폰트 헤딩   : Fraunces (serif, 변형 가능)
폰트 본문   : DM Sans (sans-serif)
보더 반경   : 12px (카드), 8px (버튼)
그림자     : 0 1px 3px rgba(0,0,0,0.04)
```

장식 요소: 작은 보태니컬 라인 일러스트 (잎사귀), 좌상/우상에 한 개씩.

## 데이터 모델 (mockSalon.ts)

### 스타일리스트 3명
1. **Hayley Park** (Senior, 시간당 80달러, 모든 서비스)
2. **Jisoo Min** (Color Specialist, 시간당 70달러, 컬러+컷)
3. **Soomin Yoon** (Junior, 시간당 50달러, 컷+블로우+매니큐어)

### 서비스 카탈로그
| 서비스 | 소요 | 처리시간 (overlap 가능) | 가격 (USD) |
|---|---|---|---|
| Cut & Style | 45분 | — | 40~80 |
| Perm | 3시간 | 90분 | 120~200 |
| Color | 2~4시간 | 60~90분 | 100~250 |
| Balayage | 4시간 | 120분 | 250~400 |
| Manicure | 40분 | — | 25~40 |
| Pedicure | 50분 | — | 35~50 |
| Hair Spa | 30분 | — | 50 |

### 고객 7명 (페르소나)
1. **Jessica Kim** — 펌+컬러 단골, 월 1회
2. **Sarah Lee** — 컬러 매달, VIP
3. **Emily Park** — 컷만, 6주 간격
4. **신디 Cindy** — 첫 방문 (얼리어답터)
5. **박지훈** — 노쇼 단골 (지난 3회 중 1회 노쇼)
6. **정연희** — VIP (월 평균 300달러+)
7. **Olivia Choi** — 결혼식 준비 (multiple bookings)

### 예약 5건 (다음 7일 캘린더)
overlap 시연용으로 의도적 갭 포함. 예: Sarah가 토요일 오후 컬러 4시간 잡혀있는데 처리시간 90분 동안 Hayley는 비어있음 → AI가 그 슬롯에 다른 손님 컷 제안.

## 의도 6개 (salonIntents.ts)

1. `booking_request` — "토요일 펌 가능?"
2. `availability_check` — "이번 주 빈 시간?"
3. `reschedule` — "예약 옮길 수 있나요?"
4. `cancel` — "취소해주세요"
5. `service_question` — "발레아쥬랑 옴브레 차이?"
6. `pricing` — "롱헤어 펌 얼마?"

각 intent에 few-shot 3개씩, classifier fail-safe 패턴 (DropShop classifierFailSafe.test.ts 참고).

## 핵심 차별 — Overlap Slot Auctioneer

`booking_request` 들어오면:
1. 캘린더 스캔 (다음 14일)
2. 다른 고객의 처리시간 (perm/color processing) 동안 빈 시간대 찾기
3. 해당 스타일리스트가 그 시간대에 다른 서비스 가능한지 체크 (서비스 매트릭스)
4. AI draft에 "토요일 14:00에 Sarah 컬러 처리시간 동안 컷 가능합니다" 같은 제안 포함
5. 미니 타임라인에서 시각적으로 보여줌 (Sarah 블록 + Hayley 빈 슬롯 highlight)

## 파일 구조

```
server/
  mockSalon.ts                  ← 데이터 시드
  salonIntents.ts               ← 분류기
  salonAgent.ts                 ← draft 생성 (runAgent 미러)
  salonRouter.ts                ← tRPC 서브라우터
  mockSalon.test.ts
  salonIntents.test.ts
  salonAgent.test.ts
  salonRouter.test.ts
client/src/
  pages/Salon.tsx               ← 메인 페이지
  components/salon/
    CalendarTimeline.tsx        ← 미니 타임라인
    StylistColumn.tsx
    AppointmentBlock.tsx
    SalonPhoneSimulator.tsx     ← (또는 기존 PhoneSimulator 재사용)
    SalonAIDraftCard.tsx
  contexts/SalonThemeContext.tsx (옵션 — 톤 전환용, 일단 스킵)
  index.css                     ← .salon-theme 스코프 추가
client/src/App.tsx              ← /salon 라우트 + Industry 토글
```

## tRPC 라우터 추가

```ts
// server/routers.ts (기존)
salon: salonRouter,           // ← 추가
```

## 산출물 검증

- [ ] `pnpm test` 전체 통과 (152 + 미용실 신규)
- [ ] `/salon` 페이지가 빈 화면 없이 렌더
- [ ] 6개 intent 각각 booking_request → 캘린더 갭 찾아 답변
- [ ] 미니 타임라인에 5개 예약이 색깔별로 표시됨
- [ ] 헤더 토글로 `/` ↔ `/salon` 이동
- [ ] DropShop 데모 (`/`) 동작 변화 없음 (regression 0)

## 시작 명령어 (새 세션에서)

```
"미용실 데모 빌드 시작. spec은
/home/ubuntu/mainstreet-ai/pilots/pilot2_salon/phase11_build_spec.md
참고."
```

## Mood board reference
- `/home/ubuntu/mainstreet-ai/pilots/pilot2_salon/mood_b_botanical.png` ← 이거 톤 참고

## Out-of-scope (이번 phase 아님)
- 실제 Phorest/Mindbody API 연동 (mock만)
- Auth (어드민 분리)
- 결제/구독 시스템
- 멀티 테넌트 (가게 1곳 가정)
