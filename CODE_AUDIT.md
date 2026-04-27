# DropShop · 코드 품질 + 테스트 커버리지 감사

작성: 2026-04-26 · 대상 커밋: `b40c49a7` · 테스트 결과: **31 files / 231 tests, 모두 통과 (≈4.1s)**

이 문서는 DropShop 코드베이스를 한 번 쫙 훑은 결과를 정리한 것이다. 1부는 객관적인 측정값(LOC, 커버리지 표), 2부는 발견된 코드 스멜과 권장 픽스를 우선순위(P0/P1/P2)로 묶었다. 모든 권장사항은 "그래서 무엇을 고친다"까지 적었고, 어디서 발견된 패턴인지 파일·라인 근거를 함께 적어두었다.

---

## 1. 측정값 한눈에

### 1.1 코드량

서버 소스 약 **10.6k LOC** (테스트 포함), 클라이언트 약 **5.5k LOC**. 가장 비대한 파일은 다음과 같다.

| 위치 | 파일 | LOC | 비고 |
|---|---|---|---|
| server | `routers.ts` | 1,067 | 모든 tRPC procedure가 한 파일에 들어있음 |
| server | `db.ts` | 853 | 풀/트랜잭션/CRUD/PII redaction이 섞여 있음 |
| server | `mockSalon.ts` | 705 | 살롱 mock 도메인 (read-only seed + 런타임 상태) |
| server | `salonAgent.ts` | 540 | 살롱 LLM 오케스트레이션 |
| server | `aiAgent.ts` | 427 | DropShop LLM 오케스트레이션 |
| client | `pages/Home.tsx` | **1,732** | 한 파일에 15개 컴포넌트 + 폴링 훅 |
| client | `pages/ComponentShowcase.tsx` | 1,437 | 데모용 — 라이브 경로 아님 |
| client | `pages/Salon.tsx` | 946 | 살롱 페이지, 9+ trpc 호출, 로컬 turn 상태 직접 관리 |

### 1.2 백엔드 테스트 커버리지 (v8 reporter 기준)

전체 평균 **Stmts 68.99 / Branch 74.72 / Funcs 69.17**. 파일 단위로 보면 두 개의 거대한 사각지대가 보인다.

| 파일 | Stmts | Branch | Funcs | 의미 |
|---|---|---|---|---|
| `server/storage.ts` | **0** | 0 | 0 | 한 줄도 실행되지 않음 (P1) |
| `server/db.ts` | **39.4** | 45 | 34.7 | 가장 큰 절대 사각지대. 853 LOC 중 60%+ 미실행 |
| `server/routers.ts` | **47.7** | 62.9 | **0** | Funcs 0% — router-level 직접 테스트 하네스가 없음 |
| `server/twilioWebhook.ts` | 47.6 | 42.1 | 100 | inbound 본문 파싱·서명 검증은 OK, 진짜 turn 처리·자동 재발송 경로 미커버 |
| `server/aiAgent.ts` | 68.1 | 63.4 | 100 | escalation/RAG retrieval 본문은 OK, 회복 루프 358-389 미커버 |
| `server/twilio.ts` | 78.7 | 73.3 | 66.7 | live-mode 분기 절반 미커버 |
| 그 외 | 80~100 | 70~95 | 75~100 | 안정 수준. branch 0~3개씩 남음 |

테스트는 잘 짜여져 있다 (231개 모두 통과, 각 파일이 짧고 contract 단위로 잘 쪼개져 있음). 다만 router 자체와 db 헬퍼는 **다른 파일을 통해 간접적으로만 실행**되기 때문에 회귀 안전망이 매우 얕다 — 한 줄 수정해도 자동 경고를 못 받는다.

### 1.3 클라이언트 테스트

`client/**/*.test.{ts,tsx}` = **0개**. `vitest.config.ts`의 `include`도 `server/**`만 본다. 즉 **UI 회귀 테스트가 0%**. Approve 버튼 nested anchor 같은 문제(라이브에서만 터졌던)는 이 사각지대 한가운데서 나왔다.

---

## 2. 코드 스멜 + 권장 픽스 (우선순위별)

### 2.1 P0 — 운영 안전성에 직결

**(P0-A) `server/db.ts`의 mysql2 result 파싱 보일러플레이트 26회 반복.**
`as unknown as { insertId?: number }[]` 같은 캐스트 패턴이 6개 다른 헬퍼에 그대로 복붙되어 있다 (라인 187-203, 264-272, 430-453, 465-468, 579-582). 같은 파일 내 `errorLog.ts`(144-155), `alertEngine.ts`(262-263)에도 같은 패턴이 번졌다. **위험:** drizzle/mysql2가 결과 shape을 살짝만 바꾸어도 6군데가 동시에 깨지고, 각자 fail mode가 다르다 (어떤 헬퍼는 throw, 어떤 헬퍼는 0 fallback).

> **권장 픽스.** `server/db.ts` 상단에 한 번 정의한다:
> ```ts
> function readInsertId(result: unknown): number | null {
>   const arr = result as { insertId?: number }[] | { insertId?: number };
>   return Array.isArray(arr) ? arr[0]?.insertId ?? null : arr.insertId ?? null;
> }
> function readAffectedRows(result: unknown): number { /* 동일 */ }
> ```
> 6군데를 `readInsertId(result) ?? throwInsertFailed("messages")` 한 줄로 수렴. 동시에 `errorLog.ts` / `alertEngine.ts`의 동일 패턴도 import.

**(P0-B) `routers.ts`의 dynamic import 안티패턴.**
라인 259-263에서 `const { updateDraftStatus } = await import("./db")`를 catch 블록 안에서 호출한다. 같은 파일 상단(line 8-50)에 이미 `db`에서 다른 모듈을 ESM static import 하고 있는데, 이 한 군데만 dynamic. **이유 추정:** 옛 PR에서 circular import를 회피하려고 임시로 넣은 흔적. 현재는 circular가 없으므로 static import로 바꿔야 한다 — 지금 형태는 cold path에서 모듈 캐시 미스 + 추가 await + bundler-level tree-shake 방해.

> **권장 픽스.** line 50의 import 블록에 `updateDraftStatus`를 추가하고 line 259-263을 `await updateDraftStatus(draft.id, "pending_approval")` 한 줄로 단순화.

**(P0-C) `routers.ts`의 approve / simulator.sendMessage / twilioWebhook.ts에 동일한 "transition + outbound + Twilio + roll-back" 흐름이 3중 복제.**
세 곳이 거의 같은 두 단계 송신 시퀀스(transition draft → insert outbound queued → Twilio call → flip sent/failed → 실패 시 draft 재오픈)를 가지고 있다. 작은 차이(자동 송신 모드, MMS 강제 escalation)만 있을 뿐이다. **위험:** 친구가 본 라이브 버그처럼 한 경로만 패치하고 다른 경로를 잊으면 라이브에서만 터진다. 또한 routers.ts의 Funcs 커버리지가 0%인 진짜 이유도 이 거대한 procedure body가 단위로 호출되지 않기 때문.

> **권장 픽스.** `server/messaging/sendPipeline.ts` (가칭) 하나에 `dispatchApprovedDraft({ draft, conv, correlationId, mode })` 함수를 추출한다. 세 호출처는 인자만 다르게 넘긴다. 그 다음 sendPipeline에 단위 테스트 4~6개(simulator OK / live OK / live fail rollback / draft already approved 409 / Twilio timeout) 붙이면 router 줄 수도 ~250줄 줄고, Funcs 커버리지도 한 번에 올라간다.

### 2.2 P1 — 구조·가독성

**(P1-A) `client/src/pages/Home.tsx` 1,732 LOC, 15 컴포넌트, 한 파일.**
`Home`, `LiveModeBadge`, `PhoneSimulator`, `StoreInbox`, `ProcessingLogPanel`, `LogRow`, `EscalationsPanel`, `ErrorsPanel`, `PendingDraftsBadge`, `CustomerProfileBadge`, `SmsLengthHint`, `ApprovalQueue`, `RagMemoryPanel`, `TopRejectReasons`, `ResetDemoButton` — 모두 한 파일에. **결과:**
- 친구가 보고했던 nested-anchor 버그 같은 것이 grep으로 잘 안 잡힘.
- 한 컴포넌트(`ApprovalQueue`)가 280 LOC — optimistic 업데이트 + 4개 useMutation + 7개 invalidate 콜이 한 함수 안.
- 코드 스플리팅 단위가 페이지 1개 = 번들 1개라 라이브 first-paint 지연.

> **권장 픽스.** `client/src/pages/dropshop/` 디렉토리 하나 만들고 컴포넌트당 한 파일(`ApprovalQueue.tsx`, `StoreInbox.tsx`, `PhoneSimulator.tsx` …)로 쪼갠다. `Home.tsx`는 라우팅·레이아웃·상위 state hook만 남긴다 (~300 LOC 목표). 동시에 1.4-1.5MB 단일 청크가 자연스럽게 나뉘어 lazy import도 가능해진다.

**(P1-B) `client/src/pages/Salon.tsx`에 서버 로직 중복.**
파일 상단 주석에서 인정하듯이 `guessServiceFromBody`가 의도적으로 클라이언트와 서버 양쪽에 존재한다 ("Node-only deps를 import하지 않으려고"). **위험:** 가격표 카테고리가 추가될 때 서버만 업데이트하고 클라이언트를 잊으면 견적 분기가 어긋난다.

> **권장 픽스.** 서버에 의존성이 없는 순수 함수(`guessServiceFromBody`, `formatMin`, `intentTone`)를 `shared/salon/intents.ts`로 옮긴다. tsconfig path alias `@shared`가 이미 정의되어 있으므로 양쪽에서 같은 한 파일을 import.

**(P1-C) `server/storage.ts` 0% 커버리지.**
파일은 짧고(97 LOC) 외부 fetch만 하므로 mock fetch 4개로 100% 가능. 지금은 **storage 헬퍼가 깨져도 아무 알람이 안 뜬다.**

> **권장 픽스.** `server/storage.test.ts` 추가:
> 1. 환경변수 누락 시 명시적 throw,
> 2. presign 응답 200 + 본문 PUT 200 → `{ key, url }` 반환,
> 3. presign 4xx → 에러 메시지 propagate,
> 4. PUT 5xx → 메시지 propagate.

**(P1-D) router 자체에 단위 테스트 0개 (Funcs 0%).**
이미 `server/salonRouter.test.ts`가 `appRouter.createCaller(...)` 패턴을 쓴다 (라인 32). **같은 패턴을 DropShop 쪽에 확대**하면 routers.ts의 Funcs 커버리지를 한 번에 50%+ 끌어올릴 수 있다.

> **권장 픽스.** `server/dropshopRouter.test.ts` 신규. 우선 다음 5개만 커버 — Approve happy path / Approve concurrent 409 / Reject + regenerate / Simulator inbound→draft / Simulator inbound→escalation. 각 테스트는 db 헬퍼를 stub하는 방식으로(이미 `hitlRag.test.ts`가 같은 in-memory state 패턴을 쓴다, 라인 71-101 참조) 4-5분이면 골격 잡힌다.

### 2.3 P2 — 작은 위생

**(P2-A) `useAuth` 훅이 render 중에 `localStorage.setItem` 호출 (Strict Mode 부작용 위험).**
`client/src/_core/hooks/useAuth.ts`. Manus 템플릿 코드라 직접 수정은 권하지 않지만, 만약 OAuth 패치를 만질 일이 생기면 setItem을 `useEffect` 안으로 옮기면 좋다. 지금 동작에 큰 문제는 없음.

**(P2-B) `Home.tsx`의 `useVisiblePollInterval` 훅이 `Home.tsx` 내부에 정의되어 있다 (line 58).**
다른 파일에서 못 쓴다. 이미 6군데에서 폴링을 쓰고 있고 Salon.tsx의 15s 폴링도 같은 패턴인데 거기는 그냥 hard-coded 15_000을 쓴다.

> **권장 픽스.** `client/src/hooks/useVisiblePollInterval.ts`로 분리하고 Salon.tsx도 import해서 쓰면, 탭이 백그라운드일 때 자동 정지 효과를 살롱 페이지에도 준다 (현재는 살롱 탭이 백그라운드여도 15초마다 떰).

**(P2-C) 테스트 코드의 `as any` 80+ 회.**
운영 코드의 `as any`는 거의 없다 (`storage.ts` 1회, ui shadcn 3회 = composition event). 그러나 테스트 헬퍼들에서 광범위. 지금 당장은 큰 문제 아니지만, 새 헬퍼 작성 시 `vitest`의 `MockedFunction<typeof fn>` / `Partial<Db>` 타입을 쓰는 것이 더 안전하다. 한 번에 다 바꿀 필요는 없고 새 테스트 추가할 때 점진적으로.

**(P2-D) `vitest.config.ts`의 include가 `server/**` 한정.**
client 테스트를 추가하기 전에 이 한 줄부터 풀어야 한다:
```ts
include: ["server/**/*.test.ts", "client/**/*.test.{ts,tsx}"],
environment: "node", // → 클라 테스트는 별도 project로 jsdom
```
권장은 vitest projects(workspaces)로 server(node) / client(jsdom) 분리.

**(P2-E) DashboardLayout placeholder 메뉴.**
`client/src/components/DashboardLayout.tsx`에 `Page 1`, `Page 2` placeholder 메뉴가 남아있음. DropShop은 dashboard layout을 쓰지 않으므로 라이브 경로엔 영향 없으나, 살롱 데모를 dashboard 패턴으로 옮길 때 사용자에게 노출 위험. 지금 정리.

---

## 3. 권장 작업 순서 (sprint planning)

| 순서 | 작업 | 예상 시간 | 가져올 것 |
|---|---|---|---|
| 1 | P0-A `readInsertId` / `readAffectedRows` 헬퍼 추출 + 8군데 치환 | 30분 | db.ts 가독성 +; 회귀 면역 |
| 2 | P0-B dynamic import 제거 | 5분 | cold path latency ↓; lint 깔끔 |
| 3 | P1-D `dropshopRouter.test.ts` 5개 케이스 (createCaller 패턴) | 1시간 | routers.ts Funcs 0→~55% |
| 4 | P0-C `dispatchApprovedDraft` 추출 + 3군데 호출처 정리 | 2시간 | 라이브 송신 회귀 안전망. 완료 후 routers.ts ~250줄 ↓ |
| 5 | P1-C `storage.test.ts` 4 케이스 | 30분 | storage 0→100% |
| 6 | P1-A `Home.tsx` 컴포넌트 분리 (페이지 dir) | 3시간 | 유지보수성, 번들 분할 가능 |
| 7 | P2-D vitest projects 설정 + 첫 client 테스트 1개(Approve 버튼 클릭→drafts.approve mutation 호출) | 1시간 | UI 회귀 안전망 시작 |
| 8 | P1-B 살롱 shared 추출 | 30분 | 클라/서버 drift 제거 |

총 누적 약 **8.5시간** 일감. 1~3번만 해도 운영 안전성은 큰 폭으로 올라간다. 4번을 끝내면 라이브에서만 터지는 송신 버그가 사실상 막힌다.

---

## 4. 강점 (의도적으로 남기고 싶은 것)

- **트랜잭션 사용이 일관되고 정확함.** `withTransaction` + `*Tx` 헬퍼 패턴이 router와 webhook 양쪽에서 같은 방식으로 쓰인다. 멀티-row turn에서 partial-write 위험 없음. (`server/withTransaction.test.ts`로 contract pinned.)
- **Critical Escalation의 fail-safe 디자인.** `aiAgent.ts`와 `salonIntents.ts` 모두 "uncertainty → human" 한 방향으로만 분기한다. `classifierFailSafe.test.ts`로 명시적으로 잠겨 있음.
- **Quo/OpenPhone 어댑터(`server/messaging/quoAdapter.ts`)가 작고 잘 격리됨.** 93% 커버리지, HMAC + replay window 검증 명시. 이대로 유지.
- **In-memory 상태 격리(`mockSalon.ts`, `mockCleanCloud.ts`)가 깔끔함.** 데모 reset이 한 함수로 끝남. 이 디자인 덕에 살롱 데모는 DB 없이도 돈다 (롤백 비용 0).
- **에러 → 로그 → 알람 파이프라인 일관성.** `errorLog.ts` → `alertEngine.ts` → `notifyOwner` 한 흐름으로 통일. spike + flap detector 두 개로 false positive 방어.

---

## 부록 A — 측정 명령

```bash
# 테스트 + 커버리지
pnpm vitest run --coverage --coverage.provider=v8 \
  --coverage.reporter=text \
  --coverage.include='server/**/*.ts' \
  --coverage.exclude='server/_core/**' \
  --coverage.exclude='server/**/*.test.ts'

# 큰 파일 LOC
find server client/src -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -path '*/_core/*' -not -path '*/components/ui/*' | xargs wc -l | sort -rn | head -10

# 미커버 소스 파일
comm -23 \
  <(find server -type f -name '*.ts' -not -name '*.test.ts' -not -path '*/_core/*' | sed 's/\.ts$//' | sort) \
  <(find server -type f -name '*.test.ts' | sed 's/\.test\.ts$//' | sort)
```
