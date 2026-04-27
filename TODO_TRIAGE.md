# todo.md 미체크 항목 분류 리포트

44개 미체크 항목을 코드베이스와 파일 시스템 실측 결과에 따라 세 범주로 정리했다. 결론부터: **44개 중 33개는 이미 끝났는데 체크박스만 안 눌린 행정 부채**이고, 실제로 코드 작성이 필요한 일은 7건이며, 그 7건도 모두 친구의 OpenPhone 마이그레이션 결정을 기다리는 의도된 보류다. 나머지 4건은 친구한테 PDF 전달 후 자연 해소된 작업이다.

| 범주 | 건수 | 의미 |
| --- | --- | --- |
| ① 이미 구현됐는데 체크만 안 됨 | 33 | 코드/파일 존재 확인됨. 체크박스만 [x]로 정리하면 끝. |
| ② 의도적으로 보류 중 (친구 OK 대기) | 7 | Quo HTTP 노출 + shadow 테이블 + 친구 메시지. 친구가 "OpenPhone 갈게" 답하기 전에는 손대지 않는 게 맞다. |
| ③ 친구 PDF 전달 후 사실상 종료 | 4 | 4월 26일에 PDF 보냈고 후속 캡처/렌더 작업도 해당 흐름에서 끝남. |

## ① 이미 구현됐는데 체크만 안 된 33건 — 정리만 하면 됨

### Phase 14 placeholder 8건
세션 중간에 생성된 옛 계획 항목인데, 실제 작업은 새로 만든 "Phase 14 — P1+P2 follow-ups from CODE_AUDIT.md (complete)" 섹션에 모두 [x]로 들어가 있다. 즉 한 작업이 두 곳에 적혀 있고 새 섹션만 체크된 상태. 옛 항목 8개는 실측으로 확인됨:

- `server/dropshopRouter.test.ts` — 9 cases 존재, 직접 실행해 통과 확인
- `server/storage.test.ts` — 7 cases 존재
- `client/src/hooks/useVisiblePollInterval.ts` — 추출 + Salon에서 import
- `shared/serviceGuess.ts` — 서버 `salonAgent`와 클라 `Salon.tsx` 양쪽이 import
- `client/src/pages/dropshop/ApprovalQueue.tsx` — Home.tsx에서 분리됨 (1732 → 1338 LOC)
- `vitest.workspace.ts` — server(node) + client(jsdom) 분리, jsdom + RTL devDep 설치 완료
- `client/src/pages/dropshop/{intentTone, ApprovalQueue}.test.{ts,tsx}` + `shared/serviceGuess.test.ts` — 첫 클라 테스트 3개 파일
- 36 files / 260 tests 통과 + 체크포인트 e8a936ba 저장

### Provider-agnostic Quo adapter Phase 1 (4건) + Phase 3 (7건)
이전 세션에서 코드까지 다 들어갔다. grep으로 모든 심볼 확인:

| 항목 | 위치 | 비고 |
| --- | --- | --- |
| `shared/messaging/InboundMessage.ts` 타입 | `shared/messaging.ts` (`InboundMessage`, `MessagingMode`, `SignatureVerifyResult`) | 단일 파일로 통합 |
| `MessagingInboundAdapter` 인터페이스 | `server/messaging/types.ts` | `verifySignature` + `parsePayload` 시그니처 일치 |
| `quoAdapter` 구현 | `server/messaging/quoAdapter.ts` | HMAC-SHA256, scheme;version;timestamp;sig 헤더 파싱 |
| `inboundPipeline` shadow/live 모드 | `server/messaging/inboundPipeline.ts` | shadow 모드에서 outbound 호출은 throw로 차단 |
| HMAC 6 vitest (good/tampered body/tampered ts/replay/normalize/shadow-no-send) | `server/messaging/quoAdapter.test.ts` (10 케이스) + `inboundPipeline.test.ts` | 실제로는 계획보다 더 많이 들어가 있음 |

### Phase 4 친구 메시지 한국어 2버전 (3건)
파일 두 개 모두 존재: `mainstreet-ai/pilots/pilot1_dropshop/proposals/openphone_migration_friend_message.md`(짧은 카톡톤), `openphone_migration_pitch.md`(긴 1페이지). 4월 26일 작성됨.

### Phase 5 sweep + checkpoint + deliver (3건)
207 + 후속 테스트로 누적 260 통과로 확장됐고, 체크포인트 d943118e → e8a936ba로 두 번 저장 후 친구에게 PDF 전달까지 완료.

### Phase 11 Salon 마지막 1건
"Update CONTEXT.md & Notion Pilot 2 page with sandbox URL once shipped" — 사실 같은 todo의 "Pilot 2 follow-up" 섹션에 동일 작업이 [x]로 있음. 두 군데에 중복 기재된 항목이 한쪽만 체크된 케이스다. Notion + README 동기화 모두 완료.

### Phase 8 Sprint 2 (없음)
이 영역의 [ ]는 위 분류표 합산에서 제외했다. 모두 [x]다.

## ② 의도적으로 보류 중 — 친구 OK 대기 7건

> 이 7건은 미완성이 아니라 "친구가 OpenPhone(=Quo)으로 옮긴다고 답하기 전에는 손대면 안 된다"는 의도적 게이트다. 코드까지 가는 순간 우리 dev 환경에 외부 endpoint가 노출되고, 가게 핸드폰 번호 portability 결정이 묶이기 때문이다.

| 항목 | 어디 적혀있나 | 친구 OK 후 예상 작업 시간 |
| --- | --- | --- |
| `POST /api/messaging/inbound/quo` Express 핸들러 (raw body, HMAC 검증, shadow mode) | Phase 2 | 30분 |
| `shadow_messages` drizzle 테이블 + 마이그레이션 | Phase 2 | 20분 |
| `shadow.list` / `markReviewed` / `discard` tRPC 절차 | Phase 2 | 30분 |
| `QUO_WEBHOOK_SIGNING_KEY` 환경변수 + README 문서화 | Phase 2 | 5분 (값은 친구가 Quo 발급 후 `webdev_request_secrets`) |
| `POST /api/shadow/inbound` (shared-secret 버전) | Phase 10 | Phase 2와 통합 가능, 별도 미작업 |
| Shadow 테스트 2건 (auth gate + draft-only contract) | Phase 10 | 20분 |
| 친구가 Sona 안 쓰는 사이드케이스 검토 | Phase 4 long version 안에 자연 답변되어 있음 | 0분 |

총 약 **2시간 정도면 친구가 "ㅇㅋ 옮길게" 한 줄에 곧바로 가동 가능**하도록 준비돼 있다. 지금은 손대지 않는 게 맞다.

## ③ 사실상 종료된 4건 — DropShop 친구 PDF briefing

`/home/ubuntu/dropshop-screenshots/` 폴더에 4월 26일자로 모두 존재함:

- `01_landing.png`, `02_pickup_draft.png`, `03_eta_cleancloud.png`, `04_critical_escalation.png`, `05_ai_log.png` (5장)
- `dropshop_partner_brief.md` (8.7KB) + `DropShop_Partner_Brief.pdf` (1.45MB)
- `clean/` 디렉터리에 banner-cropped 버전도 정리됨

마지막 세션에서 PDF 친구한테 전달 완료. 이 4개 항목(스크린샷 5장 + markdown + PDF + 전달)은 todo의 별도 섹션 "DropShop friend-facing PDF briefing (in progress)"에 적혀 있는데, 이름이 (in progress)로 되어 있어서 체크박스만 안 눌린 행정 부채다.

## 권고

지금 바로 todo.md를 한 번 정리하면 좋다. 구체적으로:

1. **위 ①과 ③ 합계 37건을 [x]로 일괄 체크**하면 todo.md의 미체크 카운터가 44 → 7로 떨어진다.
2. **남은 7건은 별도 섹션 "Awaiting friend OK (Quo migration)"으로 묶고 모두 `(deferred — gated by friend decision)` 태그**를 달면, 다음 세션 시스템 알림이 "44 uncompleted"로 잘못 트리거되지 않는다.
3. 동시에 todo.md 옛 placeholder Phase 14 8개 줄을 지우고 새 "Phase 14 (complete)" 섹션 하나만 남기면 두 곳에 같은 일감이 적힌 혼란이 사라진다.

원하면 이 정리를 지금 바로 적용할게.
