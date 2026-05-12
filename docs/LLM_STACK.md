# LLM Stack — DropShop / Salon

> 어떤 LLM 모델을, 어디서, 어떻게 부르는지. 실제 코드 인용 포함.

---

## 1. 한 줄 답

**Manus Forge proxy** (OpenAI-compatible 게이트웨이) 한 곳을 통해서:
- **채팅/추론**: `gemini-2.5-flash`
- **임베딩 (RAG용)**: OpenAI `text-embedding-3-small`
- **백업 (proxy 다운 시)**: 결정적 hash-bag 임베딩 (semantic 아님, lexical만)

직접 OpenAI / Anthropic / Google API 키를 우리가 안 들고 있음. 전부 Manus가 운영하는 Forge 프록시 뒤에 숨음.

---

## 2. 아키텍처

```
┌─────────────────────────────────────┐
│ 우리 server 코드 (Node.js)            │
│                                     │
│  invokeLLM()  ─┐                    │
│  embedText()  ─┤  HTTP POST + Bearer│
│                │                    │
└────────────────┼────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│ Manus Forge proxy                   │
│ https://forge.manus.im/v1/...       │
│                                     │
│  /v1/chat/completions  ──→  Gemini  │
│  /v1/embeddings        ──→  OpenAI  │
└─────────────────────────────────────┘
```

OpenAI 호환 스펙이라 `model` 파라미터만 바꾸면 다른 모델로도 갈아탈 수 있음.

---

## 3. 채팅/추론 — `invokeLLM`

**파일:** `server/_core/llm.ts:268`

```ts
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  assertApiKey();
  // ...
  const payload: Record<string, unknown> = {
    model: "gemini-2.5-flash",                       // ← 모델 고정
    messages: messages.map(normalizeMessage),
  };
  // ...
  payload.max_tokens = 32768;
  payload.thinking = { budget_tokens: 128 };          // ← Gemini thinking budget

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000); // ← 30초 hard timeout

  response = await fetch(resolveApiUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.forgeApiKey}`,    // ← BUILT_IN_FORGE_API_KEY
    },
    body: JSON.stringify(payload),
    signal: ac.signal,
  });
}
```

**엔드포인트:** `${BUILT_IN_FORGE_API_URL}/v1/chat/completions` (디폴트 `https://forge.manus.im/v1/chat/completions`)

**모델:** `gemini-2.5-flash` — Google Gemini 2.5 Flash. 빠르고 (1~2초), 저렴하고, JSON schema 강제 (`response_format: json_schema`) 지원.

**왜 Flash인가:**
- Pro 대비 5~10배 빠름 — 손님 문자 응답 대기를 줄임
- Pro 대비 1/10 가격 — 매장 100개 깔리면 비용 차이 큼
- thinking budget 128 토큰만 켜둠 — 분류는 깊은 추론 필요 없고, 답장 생성도 톤 매칭 위주라 thinking이 별로 도움 안 됨

**호출 위치 (3곳):**
- `aiAgent.ts:96` — `classifyIntent()` 5종 intent 분류
- `aiAgent.ts:298` — `generateReply()` 답장 초안 생성
- `salonAgent.ts:114, 379`, `salonIntents.ts:57` — 살롱 파일럿 동일 패턴

### 3-1. 분류 호출 예시 (실제 코드)

```ts
const res = await invokeLLM({
  messages: [
    { role: "system", content: CLASSIFIER_SYSTEM },   // 5종 라벨 + 8 few-shot
    { role: "user",   content: body },                 // 손님 문자 raw
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "intent_result",
      strict: true,
      schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: [...INTENT_LABELS] },
        },
        required: ["intent"],
      },
    },
  },
});
```

→ Gemini가 정확히 `{"intent": "Pickup Request"}` 같은 JSON만 뱉도록 강제. 파싱 실패 / 알 수 없는 enum이면 **Critical Escalation으로 fail-safe** (server/aiAgent.ts).

### 3-2. 답장 생성 호출 예시 (실제 코드)

```ts
const res = await invokeLLM({
  messages: [
    { role: "system", content: buildSystemPrompt() },   // DropShop SMS 톤 + RAG few-shot
    {
      role: "user",
      content:
        `Intent: ${opts.intent}\n\n` +
        `Tool data (Mock CleanCloud POS):\n${JSON.stringify(opts.toolContext, null, 2)}\n\n` +
        (ragBlock ? `${ragBlock}\n\n` : "") +
        `Customer message:\n<UNTRUSTED_INPUT>\n${opts.body}\n</UNTRUSTED_INPUT>\n\n` +
        `Compose the SMS reply for DropShop.${regenHint}`,
    },
  ],
});
```

**눈여겨볼 점:**
- 손님 문자는 `<UNTRUSTED_INPUT>` 태그로 감싸서 prompt injection 방지 (모델이 그 안의 명령어를 명령으로 안 따르도록 학습된 패턴 활용).
- POS 도구 데이터 + RAG few-shot이 손님 메시지 *앞에* 옴. 모델이 신뢰 컨텍스트를 먼저 파싱한 후에 untrusted 입력을 봄.

---

## 4. 임베딩 (RAG용) — `embedText`

**파일:** `server/embeddings.ts:109`

```ts
async function tryForgeEmbedding(text: string): Promise<number[] | null> {
  if (!ENV.forgeApiKey) return null;
  const base = ENV.forgeApiUrl?.replace(/\/$/, "") || "https://forge.manus.im";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);    // ← 5초 timeout
  const res = await fetch(`${base}/v1/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.forgeApiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",                  // ← OpenAI 모델
      input: text,
    }),
    signal: ac.signal,
  });
  // ...returns embedding number[] or null on failure
}

export async function embedText(text: string): Promise<number[]> {
  // 1. SHA256 캐시 확인 (LRU 1000 엔트리)
  const cached = _embedCache.get(key);
  if (cached) return cached;

  // 2. Forge 시도
  const forge = await tryForgeEmbedding(text);

  let vec: number[];
  if (forge) {
    vec = forge;                                         // 정상 — semantic embedding
  } else {
    __embeddingFallbackActive = true;                    // 플래그 영구 ON
    vec = hashBagEmbedding(text);                        // 결정적 lexical fallback
  }

  _embedCache.set(key, vec);
  return vec;
}
```

**모델:** OpenAI `text-embedding-3-small` (1536 dim)

**왜 small인가:**
- 우리 corpus가 작음 (매장 한 곳의 답장 history) — 1536 dim이면 충분
- large는 가격 6배, 우리 use case에서 정확도 차이 미미
- OpenAI 임베딩이 아직 Korean 포함 멀티링귤 모델보다 검증된 품질

**3중 안전망:**
1. **LRU 캐시** (1000 엔트리, sha256 키) — 같은 손님 문자가 한 turn에서 여러번 임베딩되는 걸 방지 + 비용 절감
2. **5초 timeout** — 임베딩이 stall되면 손님 응답 전체가 막힘
3. **결정적 hash-bag fallback** — Forge가 죽으면 djb2 해시 기반 256-dim 벡터로 자동 전환. 의미는 못 잡지만 같은 텍스트는 같은 벡터 (재현성 유지) → topK가 여전히 동작.

### 4-1. fallback 모드일 때 RAG 정책 자동 변경

```ts
export function ragRetrievalDefaults() {
  if (__embeddingFallbackActive) {
    // 노이즈 많으니 보수적으로
    return { topKKnowledge: 2, topKExamples: 2, topKRejections: 1, minScore: 0.7, fallback: true };
  }
  // 정상 — 너그럽게
  return { topKKnowledge: 3, topKExamples: 3, topKRejections: 2, minScore: 0, fallback: false };
}
```

→ fallback일 때 cosine 점수 0.7 이하는 잘라냄, top-K도 절반으로. UI에는 노란 배너로 솔직히 표기 ("Semantic search degraded").

---

## 5. 환경 변수 (자동 주입)

`server/_core/env.ts`에서 다음 두 개를 읽음 (Manus 플랫폼이 자동 세팅):

| ENV | 용도 |
|---|---|
| `BUILT_IN_FORGE_API_URL` | 프록시 base URL (디폴트 `https://forge.manus.im`) |
| `BUILT_IN_FORGE_API_KEY` | Bearer 토큰 |

→ 우리 코드 어디에도 OpenAI/Google 키 하드코딩 0. `.env`도 안 만짐. 플랫폼 secrets로 주입됨.

---

## 6. 모델 변경하려면

`server/_core/llm.ts:283` 한 줄만 바꾸면 됨:

```ts
model: "gemini-2.5-flash",   // → "gpt-4.1-mini" 또는 "claude-sonnet-4" 등
```

Forge 프록시가 OpenAI / Google / Anthropic 모델을 다 같은 `/v1/chat/completions` 인터페이스로 라우팅함. JSON schema 강제 (`response_format: json_schema`)는 OpenAI 계열이 가장 안정적, Gemini는 두 번째, Claude는 별도 prefill 패턴 필요.

임베딩도 마찬가지로 `embeddings.ts:67`에서 `model: "text-embedding-3-small"` 한 줄 바꾸면 됨.

---

## 7. 비용 추정 (매장 1개, 일 30 SMS 기준)

| 호출 | 횟수/일 | 평균 토큰 | 모델 | 일 비용 |
|---|---|---|---|---|
| `classifyIntent` | 30 | in 200 / out 30 | Gemini Flash | ~$0.001 |
| `generateReply` | 30 | in 1500 / out 200 | Gemini Flash | ~$0.012 |
| `embedText` (분류 + RAG retrieval + 저장) | 90 | 200 토큰 | OpenAI 3-small | ~$0.002 |
| **합계** | | | | **~$0.015 / 매장 / 일** |

→ 매장 100개 깔려도 **월 ~$45**. 가격이 Phase 22~23의 결제 통합 비용 대비 무시할 수준.

---

## 8. 테스트에서 LLM 어떻게 mock하나

모든 테스트 파일이 `vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }))` 패턴 씀.
임베딩도 마찬가지로 `vi.mock("./embeddings", () => ({ embedText: vi.fn(async () => [0.1, 0.2, 0.3]) }))`.

→ vitest 300+개 전부 LLM API 안 호출. 결정적 + 빠름 + 무료.

---

## 9. 프론트엔드는?

프론트엔드 코드는 **LLM을 직접 안 부름**. 모든 LLM 호출은 tRPC procedure 안에서만 (서버사이드). 이유:
1. 키 노출 방지
2. rate-limit / cost-cap 강제 (Phase 8 §2.5)
3. PII redaction 강제 (server/pii.ts)
4. processingLogs에 모든 LLM step 기록 (audit trail)

`VITE_FRONTEND_FORGE_API_KEY`가 env에 있긴 하지만 우리 프로젝트는 안 씀 (템플릿 디폴트). 미래에 클라이언트에서 직접 부를 일이 생기면 (예: 스트리밍 음성 인식) 그때 사용.

---

**한 줄 결론:** 모델 두 개 — **Gemini 2.5 Flash** (대화/추론) + **OpenAI text-embedding-3-small** (RAG). 둘 다 **Manus Forge 프록시** 통해서 Bearer 인증으로만 부름. 키 직접 안 들고, 한 줄 바꾸면 모델 갈아탈 수 있음.
