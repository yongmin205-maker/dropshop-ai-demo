# DropShop AI — Mainstreet AI Pilot 1 + Pilot 2

> Human-in-the-loop AI SMS concierge for small main-street businesses. Two pilots in one app:
> **Pilot 1** — Drycleaner (DropShop, Peter's shop). **Pilot 2** — Hair salon scheduling.

**Live demo:** <https://dropshopai-vx45nyzf.manus.space>
**Status:** Pilot 1 production-hardened (300+ vitest, 22 phases). Pilot 2 in active build (Phase 22).

---

## What this app does in one sentence

Customer texts the shop → AI classifies intent + queries the POS + drafts an SMS reply → **owner taps Approve or Reject** → reply goes out (or AI regenerates) → every approval/rejection becomes a few-shot example for the next reply.

Auto-send is **off by default** (env-gated). The owner is always in the loop.

---

## Two pilots, one codebase

| Pilot | Route | Domain | What's the AI doing |
|---|---|---|---|
| **1 — DropShop** | `/` | Drycleaning | 5 intent classes (Pickup, ETA, Alteration, Membership, Critical Escalation), Mock CleanCloud POS tools, RAG over approved replies + rejection reasons |
| **2 — Salon** | `/salon` | Hair salon scheduling | Smart slot suggestion (gap-fill scoring), ticketmaster-style hold/lock, multi-stylist package booking *(in build, see Phase 22)* |

---

## The 3-pillar architecture

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Intent Classifier        2. Mock POS Tools   3. HITL+RAG │
│  (Gemini 2.5 Flash +         (5 mock CleanCloud  (Approve   │
│   JSON schema enum)           getCustomerByPhone, /Reject + │
│                               getOrdersByPhone... )  embed) │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
       ┌─────────────┐                 ┌─────────────┐
       │  Approval   │  Approve →      │   Twilio    │
       │   Queue     │  txn-commit  →  │   send SMS  │
       │  (HITL UI)  │  Reject →       │  (gated by  │
       │             │  regenerate     │  LIVE_MODE) │
       └─────────────┘                 └─────────────┘
              │
              └─→ Style examples + rejection reasons
                  → embedded → next reply's few-shot
```

See [docs/DROPSHOP_ONE_PAGER.md](docs/DROPSHOP_ONE_PAGER.md) for the full Before/After breakdown and Phase-by-Phase journey.

---

## LLM stack

| Use | Model | Endpoint | File |
|---|---|---|---|
| Chat / reasoning | **Gemini 2.5 Flash** | `forge.manus.im/v1/chat/completions` | `server/_core/llm.ts` |
| Embeddings (RAG) | **OpenAI text-embedding-3-small** | `forge.manus.im/v1/embeddings` | `server/embeddings.ts` |
| Fallback (Forge down) | Deterministic djb2 hash-bag (256-dim, lexical only) | local | `server/embeddings.ts` |

Both production calls go through the **Manus Forge proxy** (OpenAI-compatible spec), so we don't hold OpenAI/Google keys directly. Model swap = one-line change. Full details in [docs/LLM_STACK.md](docs/LLM_STACK.md).

**Hard limits in code:** 30s LLM timeout, 5s embedding timeout, LRU embedding cache (1000 entries, sha256 keyed), per-IP + per-phone rate limits, daily LLM token budget cap.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Tailwind 4, shadcn/ui, wouter, Stripe Soft Light visual system (light theme, navy ink, Iris #635BFF accent) |
| Backend | Express 4 + tRPC 11 + Drizzle ORM (TiDB Serverless) |
| Auth | Manus OAuth (cookie session, see `server/_core/oauth.ts`) |
| SMS | Twilio (HMAC signature verified, idempotent on `twilioSid`, two-phase send, `LIVE_MODE` env gate) |
| Tests | Vitest, **300+ tests across 38 files** |
| Deployment | Manus webdev hosting (`*.manus.space`) |

---

## Repo layout

```
client/
  src/
    pages/
      Home.tsx           ← Pilot 1 dashboard (DropShop SMS)
      Salon.tsx          ← Pilot 2 dashboard (Salon scheduling)
    components/          ← shadcn/ui + DropShop custom (ApprovalQueue, RAGMemory, etc.)
server/
  _core/
    llm.ts               ← invokeLLM(Gemini 2.5 Flash, JSON schema, 30s timeout)
    oauth.ts             ← Manus OAuth callback handler
    env.ts               ← BUILT_IN_FORGE_API_KEY, JWT_SECRET, etc.
  aiAgent.ts             ← classifyIntent + generateReply (Pilot 1)
  salonAgent.ts          ← Pilot 2 booking agent
  embeddings.ts          ← embedText (OpenAI 3-small + hash-bag fallback) + topK + ragRetrievalDefaults
  routers.ts             ← tRPC procedures (split between dropshop / salon)
  pii.ts                 ← Phone/email/address redaction before logs
  twilio.ts              ← Twilio inbound webhook + outbound send
  *.test.ts              ← 38 vitest files
drizzle/
  schema.ts              ← conversations, messages, drafts, style_examples, rejections,
                           knowledge_chunks, escalations, processingLogs, errorLog,
                           salon_appointments, mock_customers/orders/priceList
docs/
  DROPSHOP_ONE_PAGER.md  ← Project overview (read this first)
  LLM_STACK.md           ← LLM/embedding architecture deep dive
  PHASE22_PROPOSAL.md    ← Current build cycle plan
  PHASE22_DECISIONS.md   ← Locked design decisions (Simple Mode, hold/lock)
  mainstreet-ai/pilots/pilot2_salon/
    smart_slot_scoring.md      ← English version of slot algorithm
    smart_slot_scoring.ko.md   ← Korean version (friend-facing)
    phase11_build_spec.md      ← Salon pilot original spec
    friend_pdfs/               ← Friend feedback PDFs (Aischedule.pdf, etc.)
```

---

## Run locally

```bash
pnpm install
pnpm db:push        # apply Drizzle schema to DATABASE_URL
pnpm dev            # starts Express + Vite on :3000
pnpm test           # run vitest (300+)
```

Required env (auto-injected on Manus webdev, set manually for local):
- `DATABASE_URL` — TiDB / MySQL connection string
- `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY` — Manus Forge LLM/embedding proxy
- `JWT_SECRET` — session cookie signing
- `VITE_APP_ID`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL` — Manus OAuth
- *(optional)* `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` — switches Live Mode on
- *(optional)* `DROPSHOP_AUTO_SEND=1` — bypass HITL (NOT recommended)
- *(optional)* `MAX_SMS_SEGMENTS=4`, `SALON_SLOT_HOLD_TTL_SEC=180`, `ALLOWED_ORIGINS=...`

---

## Demo flow (try this in 60 seconds)

1. Open <https://dropshopai-vx45nyzf.manus.space>.
2. Click **"Repeat Pickup"** preset scenario in the Demo Scenarios bar.
3. Phone simulator on the left sends a customer SMS.
4. Watch the **AI Log** tab on the right stream `intent → tool call → draft generated`.
5. **Approval Queue** card appears with the proposed reply.
6. Tap **Approve** → reply is logged as outbound + saved as a style example.
7. Switch to **RAG Memory** tab → see the new approved pair appear in the corpus.
8. (Optional) Click **"Switch to Salon"** in the header to see Pilot 2.

---

## Phase journey (22 cycles, Jan – May 2026)

| Phase | Theme |
|---|---|
| 1 | Intent classifier + Mock POS + first demo UI |
| 2 | **Human-in-the-Loop + RAG** (the core invention) |
| 3–5 | UX polish, customer-aware approval queue |
| 6–7 | Stripe Soft Light visual system |
| 8 | **39-finding robustness audit fully resolved** (5 sprints, P0→P3) |
| 9–11 | Error logging + Salon Pilot 2 separate route + Friend Partner integration |
| 12–14 | CODE_AUDIT P0/P1/P2 fixes |
| 15–16 | Live env 403 OAuth fix |
| 17–21 | Skills patterns, MessageTransport adapter, Claude Code reviews |
| **22** | **Friend feedback → Simple Mode toggle + Salon Pilot 2 build (in progress)** |

Full per-phase checklist: [todo.md](todo.md)

---

## Key trust + safety properties (Phase 8 hardening)

- **Twilio webhook**: HMAC `X-Twilio-Signature` verified, URL reconstructed via `X-Forwarded-*`, 403 on mismatch.
- **Idempotency**: `messages.twilioSid` UNIQUE; duplicate webhooks short-circuit with empty TwiML.
- **Two-phase send**: `messages.status: queued → sent | failed | delivered`; on Twilio failure the draft re-opens.
- **Atomic state**: every customer turn (inbound + log + draft|escalation) commits in a single `withTransaction`.
- **PII redaction**: phone/email/address masked before insert into `processingLogs`.
- **Fail-safe classifier**: any LLM parse / unknown-enum failure → `Critical Escalation` (not silent fail-open).
- **Rate limits**: per-IP 30/min + 500/day, per-phone 5/5min, daily LLM token budget.
- **CSRF**: `Origin`/`Referer` enforced on `/api/trpc` mutations.
- **Reset destructive guard**: typed `RESET` confirmation dialog (no one-tap accidents).
- **Embedding-degraded honesty**: yellow banner whenever the hash-bag fallback is active; retrieval policy auto-tightens cosine floor 0.0 → 0.7.

---

## Where to read more

- [`docs/DROPSHOP_ONE_PAGER.md`](docs/DROPSHOP_ONE_PAGER.md) — **start here**, full project overview
- [`docs/LLM_STACK.md`](docs/LLM_STACK.md) — model choices, prompts, fallbacks, costs
- [`docs/PHASE22_PROPOSAL.md`](docs/PHASE22_PROPOSAL.md) — current build cycle
- [`docs/mainstreet-ai/pilots/pilot2_salon/smart_slot_scoring.ko.md`](docs/mainstreet-ai/pilots/pilot2_salon/smart_slot_scoring.ko.md) — Korean explainer for friend
- [`todo.md`](todo.md) — full phase-by-phase checklist (Phase 1 → 22)

---

## License & attribution

Proprietary — Mainstreet AI internal pilot. Built on the Manus webdev template (React 19 + tRPC 11 + Drizzle + Manus OAuth scaffold).
