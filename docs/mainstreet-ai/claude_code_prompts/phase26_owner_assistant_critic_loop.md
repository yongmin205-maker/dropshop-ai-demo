# Phase 26 — Owner Assistant Self-Correcting Loop (Claude multi-role brief)

당신은 **Claude Code**입니다. 이 문서는 DropShop AI Demo 프로젝트의 Owner Assistant 파이프라인을 **휴리스틱 prompt-patching에서 self-correcting critic loop로 전환**하는 작업 의뢰서입니다. 단일 markdown 안에서 4개의 역할(PM / Architect / Coder / Reviewer)을 **순차적으로** 수행하고, 각 역할 사이에는 사용자(점주 측 운영자)에게 명시적으로 확인을 받습니다. 가정하지 말고 모르면 질문하세요.

---

## 0. 작업 환경

- Repository: `https://github.com/yongmin205-maker/dropshop-ai-demo`
- Default branch: `main`
- 최신 커밋 (이 문서 작성 시점): `8f3e3334` 직후 + 로컬에 한 단계 더(`a7cccef9` — topSpenderProfiles에 name/phoneE164 노출). 사용자가 push 마저 끝낸 뒤에 clone 받으면 됨.
- 스택: TypeScript, React 19 + Tailwind 4, Express 4, tRPC 11, Drizzle (MySQL/TiDB), Vitest, Gemini 2.5 Flash via Forge gateway (`server/_core/llm.ts`).
- 실행: `pnpm install` → `pnpm dev` (port 3000). `pnpm test` = vitest + tsc. DB 마이그레이션은 `pnpm db:push`.
- 비밀: `.env`는 Manus가 자동 주입. 로컬 개발이 필요하면 사용자에게 `.env` 또는 connection string을 요청하세요.

clone:

```bash
gh repo clone yongmin205-maker/dropshop-ai-demo
cd dropshop-ai-demo
git checkout -b phase26/critic-loop
pnpm install
pnpm test     # 베이스라인: 579/579 pass, tsc clean이어야 함
```

---

## 1. 문제 정의 (왜 이 작업이 필요한가)

### 1.1 현 상태

`server/ownerAssistant/`는 다음 1-shot 파이프라인입니다:

```
[질문] → router (카테고리 분류) → planner (한 번에 tool plan 생성)
       → executor (plan 그대로 실행) → synthesizer (한국어 답변 작성)
```

`planner.ts`는 `invokeLLM`(Gemini 2.5 Flash) 하나로 plan을 만들고, 그 plan을 그대로 신뢰합니다. 사용자가 발견한 실패 케이스가 누적되면 우리는 `planner.basePrompt`에 "이런 경우는 이렇게 해라" 룰을 한 줄씩 박아왔습니다. 예:

> "compareTimeWindows의 windowA/windowB는 각각 `{from, to}` 객체로 두 기간을 채워라."
> "이번 달/주/분기처럼 진행 중 기간 비교는 `mode: 'fair-pace'`로 호출하라."
> "'지난 주 요일별'은 `groupBy: 'dayOfWeek'`로 호출하라."

이 패턴의 문제:

- 새 케이스마다 사용자가 발견해서 지적 → 룰 한 줄 추가. **휴리스틱 누더기**.
- prompt가 길어질수록 Gemini가 충돌하는 룰을 무시하기 시작.
- 실제 production smoke에서도 "지난 주 요일별"이 여전히 `groupBy: "day"`로 깨짐.

### 1.2 실패 케이스 (재현 가능)

`scripts/smokeOwnerAssistant.mjs`로 live LLM smoke 가능:

```bash
pnpm exec tsx scripts/smokeOwnerAssistant.mjs
```

지금까지 확인된 결함:

| Question (Korean)                  | Expected tool/args                                  | Observed                                                                 |
|------------------------------------|-----------------------------------------------------|--------------------------------------------------------------------------|
| 지난 달 대비 이번 달 매출 어땠어 | `compareTimeWindows` mode='fair-pace'               | 잘 작동 (직전 fix 후). 회귀 방지 필요.                                  |
| 60일 이상 안 온 손님              | `findInactiveCustomers` default args                | OK.                                                                       |
| 최근 2주 단골 동향                | `aggregateRepeatCustomers` 5/4–5/18, lookback 90    | OK (방향성).                                                              |
| 지난 주 어떤 요일이 매출 좋아     | `aggregateRevenue` groupBy='dayOfWeek', last 7 days | **FAIL**: groupBy='day', dateFrom=4/1, dateTo=5/1. 사용자 의도 빗나감. |

추가로 사용자가 직접 발견한 결함:

- `topSpenderProfiles`가 `externalId`만 노출 → LLM이 "단골 196번님" 같은 호칭 사용 (직전에 fix됨, 회귀 방지 필요).
- "이번 달 vs 지난 달"을 풀-월 vs 부분-월로 비교 (직전에 fair-pace mode로 fix됨, 회귀 방지 필요).

### 1.3 결론

**Planner prompt에 룰을 더 박지 마세요.** 대신 **plan을 실행한 다음 결과를 critic이 평가**해서, 사용자 의도와 어긋나면 LLM 자체가 self-correct하도록 architecture를 바꿉니다.

---

## 2. 목표 (Definition of Done)

- [ ] `server/ownerAssistant/critic.ts` 신설. `evaluatePlan({ question, category, steps, results, now })` → `{ verdict: "ok" | "retry", reason: string, replanHint?: string }`.
- [ ] `server/ownerAssistant/agent.ts` (또는 동등 위치)에 plan → execute → critic → (retry이면) replan → re-execute 루프. **max critic pass = 2** (총 LLM 호출 ≤ 4: plan, [tool calls], critic, optional replan, optional critic).
- [ ] Critic이 사용한 hint가 다음 plan의 system context에 들어감.
- [ ] Agent trace UI(`AgentTracePanel.tsx` 또는 동등 컴포넌트)에 **critic 단계가 별도 row로** 보임 (verdict + reason).
- [ ] `planner.basePrompt`에서 다음 휴리스틱 룰들 **제거**: fair-pace 분기, dayOfWeek 분기, "args 비우지 말라" 분기. (compareTimeWindows의 windowA/windowB가 객체여야 한다 같은 **타입 수준 룰은 유지**.)
- [ ] Critic은 `invokeLLM`을 그대로 사용 (현재 Gemini 2.5 Flash). 별도 Claude API 도입 없음. 사용자가 별도 모델 요청하면 그때 협의.
- [ ] 회귀 방지: vitest contract 5건 이상 추가.
  - "지난 주 요일별" → critic이 groupBy 불일치 catch + replan → 최종 plan에 `groupBy: 'dayOfWeek'`.
  - "이번 달 vs 지난 달" → critic이 fair-pace 누락 catch + replan → 최종 plan에 `mode: 'fair-pace'`.
  - "60일 이상 안 온 손님" → critic ok, replan 안 함.
  - critic이 빈 결과 fabrication 시도 catch.
  - critic 2회 retry 후에도 실패 시 graceful degrade (마지막 plan 결과를 그대로 synthesizer로 넘기되, 답변 끝에 "데이터 확인이 필요할 수 있음" disclaimer).
- [ ] `pnpm test` 통과 (현재 579/579 → 새 테스트만큼 증가, 회귀 0).
- [ ] `pnpm tsc --noEmit` clean.
- [ ] `scripts/smokeOwnerAssistant.mjs`에 위 4개 질문 + critic trace 출력 추가. 라이브 LLM에서 4개 모두 의도된 tool/args 도달.
- [ ] 응답 시간: critic 추가로 평균 ~5s → ~12–15s 예상. UI에 "분석 중…" 로딩 표시 보존.

---

## 3. 비목표 (Out of scope)

- 새 LLM 공급사 (Anthropic 등) 추가. 별도 PR.
- Owner Assistant 외 영역 (briefing, sync, dashboard). 본 PR은 ownerAssistant 폴더에 한정.
- 새 tool 추가. 기존 tool 출력 schema가 critic 평가에 필요해서 확장하는 것은 OK.
- Planner를 ReAct 다중-step loop로 전면 재설계. 본 PR은 "plan → execute → critic → replan" 1.5-step에 한정.

---

## 4. 작업 절차 (4-role workflow)

각 역할은 별도 메시지로 사용자에게 산출물을 전달하고, 사용자가 "OK" 한 다음에 다음 역할로 넘어갑니다. 한 메시지에서 두 역할을 겸하지 마세요.

### Role 1: Product Manager (PM)

산출물: `phase26_pm.md` (PR 본문 형식, ~400단어)

해야 할 것:

1. 위 1.2의 4개 실패 케이스 외에 더 있는지 `scripts/smokeOwnerAssistant.mjs`를 직접 돌려서 확인. 새 결함 발견 시 표에 추가.
2. 사용자가 진짜로 신경 쓰는 metric은 무엇인가? 응답 정확도 vs 응답 속도. trade-off 명시.
3. 성공 기준을 측정 가능한 형태로 다시 쓰기 (위 §2를 줄이거나 늘림). 예: "4개 카논 질문 + 6개 회귀 질문에서 critic 1회 이내에 90% 정답 도달".
4. **확인 질문 ≥ 3개**를 사용자에게 명시. 모르는 채로 다음으로 가지 말 것.

기다리기: 사용자 응답.

### Role 2: Architect

산출물: `phase26_architecture.md` + 첫 코드 변경 없음.

해야 할 것:

1. `critic.ts` interface 설계 (타입 시그니처 + json_schema response_format).
2. `agent.ts` 루프 의사코드 (max iter, timeout 분배, error path).
3. Critic이 검사할 **invariant 목록**을 명시적으로 적기. 예시:
   - 진행 중 기간을 풀 기간과 직접 비교하지 않았는가
   - tool 결과의 rowCount가 0인데 synthesizer가 가짜 숫자를 만들 위험은 없는가
   - 사용자가 "지난 주"라 했는데 plan window가 30일 이상인가
4. critic prompt 초안 (한국어, 시스템/유저 분리).
5. 회귀 방지를 위한 **테스트 매트릭스** (질문 × 기대 invariant × 기대 plan).
6. **결정 지점 ≥ 2개**를 사용자에게 명시. (예: "critic이 retry 횟수 0이면 critic 호출 자체를 skip할까, 아니면 OK 도장만 찍을까?")

기다리기: 사용자 응답.

### Role 3: Coder

산출물: 실제 코드 변경. `git checkout -b phase26/critic-loop`에 커밋.

해야 할 것:

1. 한 commit = 하나의 작은 변경 단위. PR을 작게 유지.
2. **첫 commit은 vitest 추가만**. red 상태에서 시작 → 구현 → green. TDD.
3. critic.ts 구현 → agent.ts 통합 → planner.basePrompt에서 휴리스틱 제거.
4. AgentTracePanel 업데이트 (critic row 추가). 디자인은 기존 step row와 동일 스타일.
5. smokeOwnerAssistant.mjs 확장 (critic trace 출력).
6. 매 commit 후 `pnpm test`, `pnpm tsc --noEmit` 통과. 빨강이면 다음 commit 금지.
7. **막히면 작업 중단하고 사용자에게 질문**. 추측해서 코드 쓰지 말 것.

기다리기: 사용자 (또는 Reviewer)에게 "리뷰 받을 준비 됨" 신호.

### Role 4: Reviewer

산출물: `phase26_review.md` (체크리스트 형식).

해야 할 것:

1. PR diff 전체를 읽고 다음을 평가:
   - critic invariant가 §1.2 + §1.3에서 본 모든 결함을 커버하는가
   - prompt에서 휴리스틱이 정말로 빠졌는가, 아니면 critic prompt로 단순 이전됐을 뿐인가
   - critic 자체가 휴리스틱 누더기로 흐를 위험은 없는가 (critic prompt가 200줄 넘으면 경고)
   - timeout/error path가 견고한가 (Gemini 30s timeout이 critic에서도 적용되는지)
   - test coverage가 §2의 5건을 실제로 검증하는가
2. live smoke 재실행 → 4개 카논 질문 모두 통과하는지 확인.
3. **승인 / 변경 요청 / 거절** 중 하나로 결론. 거절이면 Coder로 돌려보내고 이유 적기.
4. 사용자에게 publish 권유 (체크포인트 만든 다음 Manus UI에서 Publish 버튼).

---

## 5. 핵심 파일 지도

```
server/ownerAssistant/
  agent.ts                  ← 메인 entry. plan→execute→synthesize 루프. critic 통합 지점.
  planner.ts                ← 휴리스틱 룰이 박혀 있는 곳. 정리 대상.
  planner.test.ts           ← 10 contract tests. 깨뜨리지 말 것.
  executor.ts               ← plan을 받아 tool 실행.
  synthesizer.ts            ← 한국어 답변 작성. 호칭 룰 포함.
  router.ts / categorizer   ← 카테고리 분류.
  types.ts                  ← QuestionCategory enum, ToolDefinition.
  tools/
    compare.ts              ← compareTimeWindows. mode: 'as-given' | 'fair-pace'.
    aggregates.ts           ← aggregateRevenue / aggregateRepeatCustomers / findInactiveCustomers / findNewCustomers.
    findCustomer.ts
    index.ts                ← toolCatalogueForPrompt(): planner system prompt에 들어가는 tool 목록.

client/src/components/
  AgentTracePanel.tsx (or similar)  ← critic step row 추가.

scripts/
  smokeOwnerAssistant.mjs   ← 라이브 LLM smoke. 4개 질문 + assertion.
```

전체 README는 repo root의 `README.md` 및 `docs/mainstreet-ai/` 참고.

---

## 6. 출력 형식 규칙

- 모든 산출 markdown은 `docs/mainstreet-ai/claude_code_prompts/phase26_*.md`에 작성하고 commit하세요.
- 코드 변경은 가능한 한 작은 commit으로. message 형식: `phase26: <verb> <subject>` (예: `phase26: scaffold critic interface`).
- PR 본문에는 §1의 표 + §2 체크리스트 + 새 회귀 테스트 목록을 포함.
- **추측 금지**: 모르면 사용자에게 질문. 기본 답변 양식: "이 결정은 [A 또는 B 또는 C] 중 어떤 거? 각각의 trade-off는 …"

---

## 7. 첫 행동 (Claude가 이 문서를 읽은 직후 해야 할 일)

1. repo clone + `pnpm install` + `pnpm test` 실행. 베이스라인이 정말 579/579인지 확인. 다르면 사용자에게 알리고 멈춤.
2. PM 역할로 전환. `phase26_pm.md` 초안 작성 후 사용자에게 제시. **이때 코드 변경 없음**.
3. 사용자 응답 기다림.

---

## 8. Manus(나)에게 돌아올 때

Claude가 한 PR을 마치고 사용자가 검토 후 OK하면, 사용자가 Manus 세션에서 "Claude가 phase26 끝냈어, sync해줘"라고 말하면 됩니다. Manus는 그 시점에 다음을 수행:

1. `git pull user_github main` (자동, `webdev_save_checkpoint` 호출 시 내부 처리)
2. 새 체크포인트 저장
3. live smoke 재실행해서 결과 사용자에게 보고
4. publish 권유

---

이상. 더 명확히 해야 할 부분 있으면 PM 역할 시작 전에 질문하세요.
