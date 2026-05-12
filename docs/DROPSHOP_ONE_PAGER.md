# DropShop — 한 페이지 요약

> **무엇을 만들었나 · 어떤 문제를 풀었나** (2026년 1월 ~ 5월, 22개 Phase)

---

## 1. 한 줄 요약

**동네 세탁소에 SMS로 들어오는 손님 문자를, AI가 80% 자동 응답 초안 + 사장이 한 번 탭으로 승인하는 시스템.** 손님 응대 시간을 시간당 단위에서 분 단위로 줄이고, 사장은 매장 일에 집중할 수 있게 만듦.

타겟 고객: **Peter** (DropShop 운영자, 친구). 첫 파일럿 매장: 본인 세탁소.

---

## 2. 푼 문제 (Before → After)

| 측면 | Before (지금 Peter의 일상) | After (DropShop) |
|---|---|---|
| **응대 시간** | 손님 문자 하나당 평균 2~3분 (POS 열기 → 주문 검색 → 답장 작성) | 15초 (AI 초안 검토 → Approve 탭) |
| **정확도** | 사장이 직접 답하니 정확, 하지만 늦음 | AI가 POS 조회까지 끝낸 초안, 사장이 검토만 |
| **놓치는 문자** | 바쁜 시간엔 30분~1시간 늦게 답장 | 즉시 초안 생성, 사장이 짬날 때 일괄 승인 |
| **민감 케이스** | 분실/도난/컴플레인도 사장이 직접 처리 | Critical 자동 감지 → 자동응답 중단 → 사장한테 알림 |
| **매장 톤 유지** | 다른 직원이 답하면 톤이 다름 | RAG가 사장이 직접 보낸 과거 답장에서 톤 학습 |

---

## 3. 핵심 아키텍처 (3개 기둥)

### ① **AI Intent Classifier** — 5종 분류
손님 문자가 들어오면 LLM이 정확히 5개 중 하나로 분류:

- **Pickup Request** (찾으러 갈게요)
- **ETA/Order Status** (언제 돼?)
- **Alteration Quote** (수선 견적)
- **Membership & Pricing** (가격/멤버십 문의)
- **Critical Escalation** (분실/도난/컴플레인 → 자동응답 중단)

→ 분류 실패 / 알 수 없는 응답이면 **자동으로 Critical Escalation 처리** (fail-safe).

### ② **Mock CleanCloud POS 연동**
실제 CleanCloud API 통합 전 데모용 mock layer로 5개 도구를 AI에게 노출:
`getCustomerByPhone`, `getOrdersByPhone`, `searchPrice`, `listAllPrices`, `getMembershipInfo`.

→ AI가 손님 문자 → 도구 호출 → POS 데이터 가져옴 → 답장 초안 생성, 한 흐름.

### ③ **Human-in-the-Loop + RAG** (Phase 2의 핵심 발명)
AI는 절대로 자동 전송하지 않음. 모든 응답은 **Approval Queue**에 초안으로 쌓임.

사장이 Approve → 답장 전송 + 그 (요청, 응답) 쌍을 **style_examples 테이블에 임베딩과 함께 저장**.

사장이 Reject → 거절 사유 (8개 카테고리 + 자유 텍스트)와 함께 **rejections 테이블에 저장** + AI가 즉시 재생성.

다음 비슷한 문자가 오면 → 같은 손님 / 같은 intent의 과거 (Approve된 응답 + Reject된 사유)를 RAG로 끌어와서 few-shot 예시로 프롬프트에 넣음.

**결과**: 시간이 지날수록 AI 응답이 더 "Peter처럼" 됨. 학습 corpus가 매일 자라는 게 RAG Memory 탭에서 실시간 보임.

---

## 4. 작업 흐름 — Phase별 무엇을 했나

| Phase | 기간 | 결과 |
|---|---|---|
| **Phase 1** | 1월 | 5종 intent 분류기 + Mock POS + 첫 데모 UI |
| **Phase 2** | 2월 | **Human-in-the-Loop + RAG** — 자동 전송 끔, 모든 답장 사장 승인 거침 |
| **Phase 3~4** | 2월말 | iMessage 스타일 정리, 거절 사유 8개 카테고리, 모바일 반응형 |
| **Phase 5** | 3월 초 | **손님별 컨텍스트** — 같은 손님의 과거 응답을 우선 RAG로 가져옴 |
| **Phase 6~7** | 3월 중 | **Stripe Soft Light** 비주얼로 전면 리프레시 (네이비 + Iris purple) |
| **Phase 8** | 3월말 ~ 4월 | **39개 robustness audit 전부 해결** (P0~P3, 5 sprint) — Twilio HMAC, 멱등성, 트랜잭션, PII redaction, CSRF, rate-limit, 등 |
| **Phase 9~11** | 4월 초 | 에러 로깅 패널, **Salon Pilot 2 별도 라우트** (/salon), Friend Partner 통합 |
| **Phase 12~14** | 4월 중 | 친구 PDF 피드백 처리, CODE_AUDIT P0/P1/P2 전부 해결 |
| **Phase 15~16** | 4월말 | 라이브 환경 403 버그 수정 (퍼블리시된 번들에서 OAuth state 깨짐) |
| **Phase 17~21** | 4월말 | mattpocock/skills 패턴 적용, MessageTransport adapter, Claude Code 리뷰 5체인 |
| **Phase 22** | 5월 (현재) | **친구 피드백 → Simple Mode 토글** + **Aischedule.pdf → Salon Pilot 2 빌드 플랜** |

총 **300+ vitest 통과**, 38개 테스트 파일, 22번의 체크포인트.

---

## 5. 풀린 기술적 난제

### (a) "자동응답이 사고치면 어떡해?"
→ **자동 전송 0%**가 디폴트. AI는 초안만 만들고, 사장이 매번 승인. 그러면서도 RAG 학습으로 점점 정확해짐.

### (b) "AI가 모르는 케이스(분실/도난)도 답해버리면?"
→ Classifier가 알 수 없거나 의심스러우면 **무조건 Critical Escalation**으로 분류. 자동응답 중단 + 사장한테 알림.

### (c) "AI 답장이 매장 톤과 안 맞으면?"
→ 사장이 Approve한 과거 답장이 그대로 다음 답장의 few-shot 예시가 됨. **사장이 쓸수록 사장처럼 변함.**

### (d) "임베딩 API가 다운되면?"
→ 결정적 hash-bag fallback으로 자동 전환 + UI에 노란 배너로 정직하게 노출 + retrieval 정책도 자동으로 보수적으로 바뀜 (cosine floor 상향).

### (e) "두 사장이 동시에 같은 draft를 Approve하면?"
→ Draft status 머신 (`pending_approval → sent | rejected | superseded`) + DB 트랜잭션으로 멱등 보장.

### (f) "Twilio webhook이 위조되면?"
→ HMAC signature 검증, `X-Twilio-Signature` 헤더, URL을 `X-Forwarded-*`로 재구성. 위조 시 403.

### (g) "PII가 로그에 남으면?"
→ `pii.ts` 모듈이 전화번호 / 이메일 / 주소를 redact한 후에야 processingLogs에 insert.

### (h) "데모 리셋을 실수로 누르면?"
→ shadcn AlertDialog + 사용자가 `RESET`을 타이핑해야 버튼 활성화 (typed guard).

---

## 6. 지금 친구 매장에 어떤 가치를 주는가

(추정 — Peter 매장 가정: 일 평균 SMS 30건, 매장 운영 10시간)

| 항목 | 절감 |
|---|---|
| 응대 시간 (직접 답장 vs 초안 승인) | 손님 1명당 **2~3분 → 15초** = 매일 **~75분 절감** |
| 놓친 응답으로 잃는 손님 | 추정 1~2명/주 회수 |
| 사장 야간 응답 부담 | RAG가 새벽에도 초안 만들어 놓음, 아침에 일괄 승인 |
| 매장 톤 일관성 | 직원 누구든 같은 톤으로 응답 (RAG가 사장 톤 학습) |

→ Phase 22a (Simple Mode)에서는 친구 피드백 반영해서 "탭 한 번에 Approve" 화면을 **첫 화면 디폴트**로 만들 예정. 모바일 앱 폼팩터 가정.

---

## 7. 다음 (Phase 22 ~ 23)

| Phase | 무엇 | 언제 |
|---|---|---|
| **22a** | DropShop **Simple Mode 토글** (친구 피드백) | 1시간 |
| **22b** | Salon **스마트 슬롯 추천** + 티켓마스터식 hold/lock | 1~2일 |
| **22c** | Salon **멀티 스타일리스트 패키지 예약** | 1일 |
| **23** | Salon **결제 pillar** (Stripe + Apple Pay + 분할결제) | 1주+ |

---

## 8. 데모 / 자료

- **라이브 데모**: <https://dropshopai-vx45nyzf.manus.space>
- **GitHub**: webdev 프로젝트 → user_github 리모트 자동 동기화
- **친구한테 보여줄 문서**:
  - `docs/mainstreet-ai/pilots/pilot2_salon/smart_slot_scoring.ko.md` (스마트 슬롯 한글 설명)
  - `docs/PHASE22_DECISIONS.md` (티켓마스터식 hold 설계)
  - 본 문서 — DropShop 전체 요약

---

**한 줄 결론:** Peter의 매장 한 곳에서 4개월간 22번의 Phase를 거치며, **"사장은 절대 자동응답을 신뢰 안 한다"는 전제로 만든 AI 초안 + 인간 승인 시스템**이 성숙해졌고, 이제 같은 패턴을 미용실(Salon)에도 그대로 이식 중.
