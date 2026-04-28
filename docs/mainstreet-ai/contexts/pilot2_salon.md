# Pilot 2 — Salon AI Scheduler 컨텍스트

> 미용실 운영하는 친구를 대상으로 한 파일럿. 매 세션 시작에 이 파일을 읽고 시작합니다.

---

## ⚡ Phase 11 빌드 스펙 (다음 액션)

사용자가 톤·라우트·캘린더 시각화 등 모두 결정 완료. 새 세션에서 이 파일 → 빌드 스펙 → 빌드 시작.

→ **빌드 스펙**: `/home/ubuntu/mainstreet-ai/pilots/pilot2_salon/phase11_build_spec.md`
→ **무드보드 (옵션 B 톤)**: `/home/ubuntu/mainstreet-ai/pilots/pilot2_salon/mood_b_botanical.png`

결정 요약: `/salon` 별도 라우트 / Modern Botanical 톤 (sage green + terracotta) / 미니 타임라인 시각 / 헤더 industry 토글 / DropShop 미터치.

새 세션 시작 명령어: **"미용실 데모 빌드 시작. spec은 phase11_build_spec.md 참고"**

---

## 친구 정보 (확인 필요)

| 항목 | 값 |
|---|---|
| 이름 | 미확인 (소유자 형이 알고 있음) |
| 업종 | 미용실 |
| 사용 중인 예약 플랫폼 | **미확인** — Phorest / Mindbody / GlossGenius 중 하나로 추정 |
| 디자이너 수 | 미확인 |
| 체어 수 | 미확인 |
| 주간 텍스트 inbound | 미확인 |
| 주요 페인 포인트 | 중복 예약(overlap booking) 불가 — 펌·컬러 처리 시간 동안 다른 손님 못 끼움 |

→ **첫 미팅에서 위 5개 항목을 확인해야 합니다.** (제안서 9번 섹션에 동일한 5개 질문 박혀 있음)

---

## 시스템 비교 (이미 리서치 완료, 자세한 내용은 `pilots/pilot2_salon/research/pilot2_salon_research.md`)

세 플랫폼 **모두 overlap booking 기능은 존재**합니다. 다만 사장님이 설정 안 함 + UX 마찰 때문에 거의 사용되지 않습니다.

| 플랫폼 | Overlap 기능 명칭 | 우리 통합 가능성 |
|---|---|---|
| **Mindbody** | Allow Staff Concurrency + Prep/Finish Time | ⭐ 가장 빠름 (공개 API + webhook) |
| **Phorest** | A La Carte / Sandwich 패턴 + Processing Time | △ 파트너십 신청 4–6주 |
| **GlossGenius** | Allow Processing Time Booking 토글 | ✗ 공개 API 없음 |
| **Jane App** | Online Double Booking (명시적 마케팅) | ✗ 공개 API 없음 |
| **Square Appointments** | (overlap 자체 미지원) | — 경쟁사 약점 |

---

## 우리 제품 컨셉 (4가지 핵심 기능)

1. **중복 슬롯 자동 제안** — 손님 텍스트 들어오면 AI가 처리 시간 갭 찾아내서 다른 시술 끼워 넣기 답안 자동 작성. 사장님은 승인만.
2. **빈 슬롯 채우기** — 매일 아침 캘린더 스캔 → 웨이팅 리스트 손님에게 자동 SMS draft 작성.
3. **노쇼 사전 예방** — 위험도 학습 후 보증금 정책 자동화.
4. **예약 시점 업셀** — 마지막 시술 이력 보고 자연스럽게 추가 권유.

---

## 단계별 도입 (제안서와 동일)

| 단계 | 기간 | 내용 | 친구 risk |
|---|---|---|---|
| 1단계: 섀도우 모드 | 1–2주 | 트래픽 복사만, 답안 비교 | 0 |
| 2단계: 사장님 검토 모드 | 1–2개월 | 답안 만들고 승인하면 발송 | 낮음 |
| 3단계: 부분 자동화 | 3개월+ | 정확도 95% 넘는 케이스만 자동 | 통제됨 |

각 단계에서 멈춰도 됨.

---

## 가격 모델

회수되는 매출의 **10–15%** 수준에서 구독료 책정. 일반적으로 월 **300–500달러**. 회수 < 구독료인 달은 청구 안 함.

---

## 결정/진행 로그

| 날짜 | 결정 |
|---|---|
| 2026-04-26 | 리서치 완료, Notion에 한글 페이지 게시. 7페이지 PDF 제안서 생성 (UI 목업 2장 포함). |
| 2026-04-26 | 폴더를 `mainstreet-ai/`로 통합 마이그레이션. |

---

## 다음 세션 시작 액션

1. 친구가 PDF 제안서 보고 답을 줬는지 확인 (소유자한테 물어보기).
2. 답이 왔으면 → 친구 운영 정보 5개로 제안서 숫자/통합 경로 fit.
3. 답이 안 왔으면 → 우리 코드 데모(DropShop 기반)에 미용실 시나리오 mock 데이터 추가 시작.
