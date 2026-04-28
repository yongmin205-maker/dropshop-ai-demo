# MainStreet AI — 마스터 인덱스

> 이 폴더는 MainStreet AI 비즈니스 전체의 컨텍스트, 리서치, 제안서를 한 곳에 모은 공간입니다.
> **모든 새 세션은 이 파일을 가장 먼저 읽고 시작합니다.**

---

## 비즈니스 개요

소상공인(미용실, 세탁소, PT샵 등)이 이미 쓰고 있는 SaaS는 그대로 두고,
그 위에 **버티컬 특화 AI 에이전트**를 얹어서 운영을 대신해 주는 모델입니다.
대형 프랜차이즈가 아닌 **mom-and-pop shop**을 1순위 타깃으로 합니다.

코드 데모는 별도 폴더 `/home/ubuntu/dropshop-ai-demo/`에 있고, Manus 위에 배포되어 있습니다.

- **Pilot 1 (Laundromat)**: https://dropshopai-vx45nyzf.manus.space/
- **Pilot 2 (Salon)**: https://dropshopai-vx45nyzf.manus.space/salon
- 한 도메인 안에서 헤더 우측의 "⇄ Switch to Salon / Switch to Laundromat" 토글로 두 데모 즉시 전환.
- Pilot 1+2 합산 vitest **196개 통과** (29 파일, regression 0건).

노션 마스터 페이지: [MainStreet AI](https://www.notion.so/MainStreet-AI) (검색해서 진입)

---

## 폴더 구조

```
mainstreet-ai/
├── README.md                              ← 이 파일
├── contexts/                              ← 매 세션 시작에 읽을 파일들
│   ├── pilot1_dropshop.md                 ← DropShop (세탁소) 친구 시스템 정보
│   └── pilot2_salon.md                    ← Salon (미용실) 친구 시스템 정보
├── shared/                                ← 파일럿 공통 자료 (가격 모델, 톤 가이드 등)
└── pilots/
    ├── pilot1_dropshop/
    │   ├── research/
    │   └── proposals/
    │       └── openphone_migration_pitch.md
    └── pilot2_salon/
        ├── research/
        │   └── pilot2_salon_research.md
        └── proposals/
            ├── salon_ai_proposal.md       ← 친구한테 보낼 정식 제안서
            ├── salon_ai_proposal.pdf      ← 위 파일의 PDF 버전
            ├── salon_ai_review_for_friend_v1.md   ← 캐주얼 톤 v1 (참고용)
            └── salon_mockup_*.png         ← UI 목업 이미지
```

---

## 파일럿 현황

| 파일럿 | 업종 | 친구 시스템 | 단계 | 다음 액션 |
|---|---|---|---|---|
| **Pilot 1: DropShop** | 세탁소 (visitdropshop.com) | CleanCloud (POS) + Nextiva (텍스트) | ✅ 데모 배포 완료, 섀도우 모드(라이브 인바운드 연동) 대기 | 친구한테 OpenPhone 마이그레이션 제안 |
| **Pilot 2: Salon** | 미용실 | Phorest / Mindbody / GlossGenius 중 미확인 | ✅ 데모 배포 완료 (`/salon`, Overlap Auctioneer 포함) | 친구한테 데모 URL + PDF 제안서 보내고 운영 정보 5개 질문에 답 받기 |

---

## 운영 원칙 (모든 파일럿 공통)

1. **친구의 risk = 0** — 우리 시스템이 friend production에 들어가기 전, 반드시 섀도우 모드(트래픽 복사만)로 1–2주 검증한다.
2. **HITL이 기본** — 자동 발송은 정확도 95% 넘는 단순 케이스만 화이트리스트로 허용.
3. **회수 매출 기반 가격** — 회수 매출의 10–15% 구독료. 회수 < 구독료 달은 청구하지 않는다.
4. **버티컬 특화** — 횡적 일반화보다 한 업종 deep dive. POS/예약 플랫폼별 통합을 직접 짠다.

---

## 매 세션 시작 체크리스트

새 세션을 시작할 때 이 순서대로 읽으세요.

1. 이 README (현황 파악)
2. 작업할 파일럿의 `contexts/pilot{N}_*.md` (친구 시스템 디테일)
3. (필요 시) `pilots/pilot{N}/research/` 안의 최신 리서치 노트
4. (필요 시) Notion `MainStreet AI > Pilot {N}` 페이지

---

## 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-04-26 (오전) | 마스터 폴더 구조 초기 셋업. Pilot 1/2 자료 마이그레이션 |
| 2026-04-26 (오후) | Pilot 2 살롱 데모 빌드 완료 (`/salon`, Overlap Auctioneer + 7 인텐트 + Modern Botanical 테마). Pilot 1+2 한 도메인 통합 배포 — https://dropshopai-vx45nyzf.manus.space. Notion Pilot 1/2 페이지 라이브 URL 동기화. |
