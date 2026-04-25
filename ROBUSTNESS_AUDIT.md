# DropShop AI Agent — Production Robustness Audit

**Scope:** Code-level review of every realistic failure mode that would surface once this demo is run against a paying client (live Twilio number, real customers, multi-instance deploy). Findings are grounded in the current `main` branch (checkpoint `b126bb9c`).

**Reading guide:** Severity uses the convention **P0** (will lose money / leak data / brick the demo on stage), **P1** (silently corrupts state or violates customer trust), **P2** (degrades UX or analytics quality), **P3** (cosmetic / nice-to-have hardening).

---

## 1. Executive summary

The demo is solid as a *simulator*. Once you flip Live Mode on (real Twilio inbound), four classes of bug become real money or real reputational damage:

1. **The Twilio webhook bypasses Human-in-the-Loop entirely** and auto-sends. The whole "Approval Queue" UX you just built does not protect a real customer.
2. **No webhook authentication and no idempotency.** Anyone on the internet who knows your URL can inject fake customer SMS, and Twilio's normal retry behavior will double-charge and double-reply.
3. **Several writes are non-transactional and non-idempotent** — duplicate approvals, lost rejections, ghost outbound messages that were never actually sent, and a stale "escalated" flag that never clears.
4. **Cost / abuse exposure is uncapped** — no per-phone rate limit, no daily SMS budget, no LLM token budget, no message-length cap before billing, and the simulator endpoint is `publicProcedure` (unauthenticated) on a deployed URL.

There are also ~20 P2/P3 issues (silent DB-down behavior, polling waste, intent classifier defaulting wrong, RAG fallback being non-semantic, factual drift between mock POS and knowledge base, etc.) that I list in detail below.

---

## 2. P0 — must fix before any live customer touches this

### 2.1 Twilio webhook auto-sends, completely bypassing the approval queue

**File:** `server/twilioWebhook.ts` lines 64–80.

Inbound real SMS goes: `runAgent()` → `appendMessage(outbound)` → `sendSms()` directly. There is no `insertDraft()`, no `pending_approval` row, no manager touchpoint. The right-pane Approval Queue you ship will look empty in production while real replies are flying out.

> ```ts
> } else if (result.reply) {
>   await appendMessage({ ...outbound, mode: "live" });
>   await appendProcessingLog({ step: "sent", ... });
>   await sendSms(from, result.reply);  // ← gone, no approval
> }
> ```

**Fix:** Mirror the simulator router behavior — write a `pending_approval` draft, gated by `DROPSHOP_AUTO_SEND === "1"`. Default OFF in live mode. Send a manager push (the `notifyOwner` helper is already wired) so a human knows there's something to approve.

### 2.2 No Twilio request signature validation

`twilioWebhook.ts` accepts any POST to `/api/twilio/sms`. Anyone who curls that URL with a fake `From=+15555550000&Body=refund me $500` becomes a "customer", triggers an LLM call, possibly an outbound SMS, and pollutes RAG learning.

**Fix:** Validate the `X-Twilio-Signature` header against the request URL + form body using the auth token (Twilio's documented HMAC). Reject mismatch with 403. Add `express.urlencoded` body capture so the raw body is available for the HMAC. Also bind the route to a secret subpath (`/api/twilio/sms/<random>`) as defence-in-depth.

### 2.3 No webhook idempotency — Twilio retries cause duplicates

Twilio retries delivery on any 5xx or timeout, and inbound webhooks can fire twice under network jitter. Today the same SMS would create two `messages` rows, two LLM drafts, two Twilio outbound charges, two billing units.

**Fix:** Twilio sends a `MessageSid` with each delivery. Store it on `messages` as `varchar(40) UNIQUE`. On webhook entry, `INSERT ... ON DUPLICATE KEY UPDATE id=id`; if it was already there, return `<Response/>` immediately and skip the agent.

### 2.4 Outbound "sent" persisted before Twilio actually accepts the message

Both `routers.ts` (`drafts.approve`) and `twilioWebhook.ts` write the outbound `messages` row + `processingLogs.step="sent"` *before* awaiting `sendSms()`. If Twilio returns 4xx (bad number, blocked content, suspended account), the UI shows "Approved & dispatched via Twilio" but nothing was actually sent.

**Fix:** Two-phase commit. First persist outbound with `status="queued"`. Then call `sendSms`. Only on `ok:true` flip to `status="sent"` and store the returned `sid`. On `ok:false` flip to `status="failed"`, surface the error in the UI, and do NOT mark the draft `approved`.

(Add a `status mysqlEnum("queued","sent","failed","delivered")` column to `messages` and a `twilioSid` column.)

### 2.5 Cost / abuse: simulator endpoint is unauthenticated and uncapped

`simulator.sendMessage` is a `publicProcedure` on a public URL. Anyone can hammer it. Each call burns one classifier LLM call + one generator LLM call + one embedding call + RAG retrieval — easily 4–8k tokens. A 1 req/s attacker burns ~$30/day in tokens before you notice.

Same exposure on `rag.addKnowledge` (anyone can pollute your RAG store with arbitrary text up to 4 KB).

**Fix (minimum viable):**
- Per-IP rate limit on `/api/trpc/simulator.sendMessage` and `/api/trpc/rag.addKnowledge` (express-rate-limit, 10 req/min per IP, 100/day).
- Per-phone rate limit (`max 5 inbound msgs / 5 min / phone`) inside the procedure.
- Daily LLM token budget gate (read a counter from DB, abort if over).
- Move `rag.addKnowledge` to a `protectedProcedure` requiring `role === "admin"`.
- For live Twilio: per-phone outbound budget (max 20 SMS / day to one number) — Twilio bills per segment.

---

## 3. P1 — silent state corruption and customer-trust risk

### 3.1 `getLatestPendingDraftForMessage` is a misnomer

`server/db.ts` lines 251–263. The query orders by `desc(drafts.id)` but never filters `status = "pending_approval"`. After a manager rejects and a fresh draft is created, this helper still returns the latest row — which is correct *that one time*. But if the regenerated draft is then itself approved or rejected, the function will return that approved/rejected row to a UI element that is asking "is there anything pending?". The Approval card on the customer's row in the inbox will mis-render.

**Fix:** Add `and(eq(drafts.inboundMessageId, ...), eq(drafts.status, "pending_approval"))`. Rename the helper or add a separate `getLatestDraftForMessage` for the "show me whatever is most recent" use case.

### 3.2 Approve / Reject are not atomic — double-click double-fires

`drafts.approve` reads draft → checks `status === "pending_approval"` → writes outbound → updates status. There is no row-level lock. Two managers (or one manager hammering the button despite `disabled={approve.isPending}` if the round-trip stalls and they reload) can both pass the status check and both fire `sendSms`. Customer gets two replies, two Twilio charges, two `styleExamples` rows.

**Fix:** Wrap the whole approve / reject body in a Drizzle transaction (`db.transaction(async tx => {...})`) and inside the transaction do `UPDATE drafts SET status='approved' WHERE id=? AND status='pending_approval'`. Check `affectedRows === 1`; if not, abort with 409 conflict — someone else already handled it. Same pattern for reject.

### 3.3 `createEscalation` sets `conversations.escalated=1`, but `resolveEscalation` never clears it

`db.ts` 136–145 vs 184–191. After resolution the conversation row stays `escalated=1` forever. Any UI that filters "active escalations by conversation" via this flag will lie. The Critical tab today doesn't depend on it, but the schema invites the bug.

**Fix:** In `resolveEscalation`, after updating the escalation row, check whether any *other* open escalation remains for the same conversation; if not, reset `conversations.escalated = 0`.

### 3.4 `getOrCreateConversation` is a read-then-insert race

`db.ts` 90–108. Two concurrent inbound messages for the same brand-new phone race: both `SELECT` find nothing, both `INSERT` — the second one violates the `phone UNIQUE` constraint and throws.

**Fix:** Use `INSERT ... ON DUPLICATE KEY UPDATE customerName = VALUES(customerName)` then re-select by phone. Or wrap in a transaction with `SELECT ... FOR UPDATE`.

### 3.5 Multi-step writes have no transactional boundary

`simulator.sendMessage` performs ~6 sequential writes (inbound msg + N processing logs + intent update + escalation OR draft). If the process crashes mid-sequence, you get a half-recorded conversation that the UI cannot recover. Same for the reject regeneration path (rejection insert + draft status update + log + new draft + per-step logs — 5+ writes).

**Fix:** Wrap each end-to-end customer turn in `db.transaction`. Move all `appendProcessingLog` calls into a buffered array and flush as a single batched insert at the end of the transaction.

### 3.6 Rejection records can succeed while the draft status update silently fails

In `db.ts` `updateDraftStatus`, `insertRejection`, `insertStyleExample` all early-return `void` when `getDb()` returns null. So the router happily continues, returns `{ok: true}`, but nothing was persisted. The user sees "Draft rejected — regenerating with feedback" and the queue still shows the same draft. Worse, the regeneration fires an LLM call against a database that's down, then tries to insert the new draft and finally throws — the user sees a half-broken state.

**Fix:** Either propagate "database unavailable" as a thrown error (recommended for all *write* paths), or gate the procedure entry on a `getDb()` health check and 503 fast.

### 3.7 Demo "Reset" wipes data without a transaction

`resetDemoData` does 7 `DELETE`s sequentially. If anything fails partway, you get ghost orphan rows (e.g. messages without conversations). And there's no `WHERE` clause limiting blast radius — if this endpoint is ever hit in production it nukes everything. Plus the endpoint is `publicProcedure`.

**Fix:** Wrap in `db.transaction`. Move to `protectedProcedure` with `role === "admin"`. Add an env flag `ALLOW_DEMO_RESET=1` that has to be set explicitly.

### 3.8 Module-level seeding flag is per-process

`mockCleanCloud.ts` line 147 (`let seeded = false`) and `knowledgeSeed.ts` (`seedOnce: Promise<void> | null`) cache "I already seeded" in process memory. Behind a load balancer with N instances, each instance independently checks the DB and may race to insert. The check is `count==0 → bulk insert` which is not atomic.

**Fix:** Use `INSERT IGNORE` or `ON DUPLICATE KEY UPDATE` against a natural unique key (phones for customers, orderNumber for orders, a hash for knowledge title). Or use a Postgres advisory lock / MySQL `GET_LOCK("seed", 5)`.

### 3.9 Knowledge-base text contradicts Mock POS source of truth

`mockCleanCloud.ts` says Silver = $19/mo / 10% off, Gold = $39/mo / 15% off. If `knowledgeSeed.ts` quotes different numbers (separate hard-coded copy), the AI's RAG block and its tool data will disagree mid-reply — exactly the kind of bug a customer screenshots and posts to Twitter.

**Fix:** Single source of truth — generate the knowledge chunks for membership/pricing programmatically from `MEMBERSHIP_INFO` and `SEED_PRICES` at seed time. Never hand-author both.

### 3.10 Embeddings fall back to a non-semantic hash bag

`embeddings.ts` 20–39. When the Forge `/v1/embeddings` endpoint 404s (already documented as the production fallback), RAG retrieval becomes essentially keyword-bucket nearest neighbour. The agent will appear to learn from rejections in the demo (because the same exact words repeat), but in production it will silently degrade and managers will reject the same kind of draft over and over without progress.

**Fix:** Health-check the embeddings endpoint at boot and surface a banner when in fallback mode. Add a metric `embeddingFallbackRatio`. When in fallback, raise the cosine threshold to avoid retrieving noise.

### 3.11 Intent classifier defaults to "Membership & Pricing" on parse failure

`aiAgent.ts` line 111. If the JSON-mode response is malformed, every unparseable message becomes a pricing question. That means a damage report or theft accusation could be silently routed to the pricing path, drafted, and (in webhook auto-send mode) sent to a customer who is already angry.

**Fix:** On classifier parse failure, default to `"Critical Escalation"` — fail safe. Log the raw response. Add a metric.

### 3.12 No PII redaction in logs

`processingLogs.detail` is a `json` blob that today stores full reply text, full inbound body, customer name, address, phone (via `mock_api_called` step). It is queryable from the Database panel. In production this is GDPR/CCPA-relevant: full SMS bodies + addresses + phone in a log table the operator can query without an audit trail.

**Fix:** Redact phone (`+1555***1003`) and address in `detail`. Move full bodies to the `messages` table only (where they belong), and reference by id in logs. Add a TTL job that prunes processing logs > 30 days.

### 3.13 No handling of MMS / image attachments

The demo brand-voice prompts "(often with a photo)" for Alteration Quote, but Twilio inbound images arrive as `MediaUrl0..N` form fields. The webhook only reads `Body`. So a customer who actually sends a zipper photo gets the same generic "we charge $35" response — no vision call, no per-photo pricing.

**Fix (when ready):** Capture `MediaUrl0..N`, pass to `invokeLLM` as image content blocks for Alteration Quote intent.

### 3.14 Live Mode flag flips silently, and the UI cannot tell when a fresh send is live or simulated

`config.get` returns `liveMode` once at page load. If an operator adds Twilio creds at runtime, the Approval card will still say "Approved & delivered in Simulator Mode" until refresh. Worse, the inverse — Live Mode is off but the operator believes it's on and clicks Approve, expecting a real SMS to fire.

**Fix:** Re-fetch `config.get` after every approve, OR show the live/sim mode prominently *inside* the confirmation toast and the Approve button label itself ("Approve & send via Twilio").

---

## 4. P2 — UX, analytics, and operational quality

### 4.1 Polling waste

Three queries poll every 2.0–2.5 s regardless of tab focus: `messages`, `logs`, `drafts.listPending`. Each fires even when the tab is in the background. Over 8-hour business day per browser session that's ~25,000 RPCs — multiplied by N users.

**Fix:** Disable polling when `document.hidden`. Or replace with Server-Sent Events / WebSocket on the existing Express server. At minimum gate by `refetchOnWindowFocus` and a 10 s interval when blurred.

### 4.2 No optimistic update on Approve / Reject

The button shows a spinner while the round-trip happens (~1.5–4 s for reject because it does a full LLM regeneration). For a demo where managers may approve dozens per minute, this feels sluggish. The README itself prescribes optimistic updates for list actions.

**Fix:** `onMutate` removes the row from the local list immediately; rollback on error.

### 4.3 No pagination anywhere

`listConversations(50)`, `listStyleExamples(500)`, `listRejections(500)`, `listKnowledge()` (unbounded). At 5 conversations they're fine; at 5,000 the RAG panel blocks the main thread for seconds and the network response is multiple MB.

**Fix:** Cursor pagination on all `list*` endpoints, server-side filtering for the RAG panel.

### 4.4 RAG `topK` is O(N) JavaScript per query

`embeddings.ts` 89–101 loads *all* knowledge / examples / rejections into Node, computes cosine in JS, sorts. Fine at 100 rows; at 50,000 it's hundreds of ms per inbound SMS plus DB round-trip on every classifier call.

**Fix:** When promoting to production embeddings, store vectors in a vector index (TiDB Serverless has vector search, or use pgvector / Pinecone). Until then, cap `listRejections` / `listStyleExamples` to most-recent N for the topK call.

### 4.5 Customer profile aggregation is N+1 inside a single function

`getCustomerProfile` does one query per related table, then in JS loops through *all* rejections / styleExamples to filter by `draftIds` (lines 379–387). This is a full table scan per profile open.

**Fix:** Use `where(inArray(rejections.draftId, draftIds))`. Single SQL query.

### 4.6 `searchPrice("alteration")` is a substring scan, not a category lookup

`mockCleanCloud.ts` 180–192. Works because seed data has the literal word "alteration" in the category. As the price list grows, false positives leak (e.g. an item named "Alterations consult"). Also brittle to translations.

**Fix:** Where the AI agent calls "alteration", pass `category: "alteration"` explicitly and do `eq(mockPriceList.category, "alteration")`.

### 4.7 Approval Queue assumes one pending draft per inbound message

If two regeneration cycles race (e.g. manager double-clicks Reject before the first round-trip resolves), you get two `pending_approval` drafts pointing at the same `inboundMessageId`. The UI will render both side by side and the "Approve" of the older one will silently approve a draft that is no longer the freshest.

**Fix:** Disable the Reject button while `reject.isPending` (already partially in place via `disabled` on category select but not the button itself for `other` path). Plus: in `drafts.reject`, before regenerating, mark any existing pending drafts for the same `inboundMessageId` as `superseded`.

### 4.8 No timeouts on LLM / embeddings / Twilio calls

A hung Forge call blocks the tRPC procedure indefinitely; the client request hangs; the Express worker is occupied. At any concurrent load this is a slow-loris vector against your own server.

**Fix:** `AbortController` with 8 s timeout on every `fetch` in `embeddings.ts`, `llm.ts`, `twilio.ts`. Surface as a clean error, log it.

### 4.9 No structured request logging

Today it's `console.log` here and there. In production you cannot answer "what did we draft for +1555010xxxx between 14:00 and 14:30 yesterday" without a query against `processingLogs`, which is itself missing rich metadata (no draft id link from `step="sent"`, no Twilio sid).

**Fix:** Add `request_id` to every log line, add `twilioSid` to outbound message rows, add a `correlation_id` column to `processingLogs` so a single inbound → draft → reject → regenerate → approve → send chain is one queryable trace.

### 4.10 Reset demo confirm dialog uses `window.confirm`

Browser native `confirm()` blocks the main thread, doesn't match brand, can be silenced by browser settings. On stage it's also ugly mid-pitch.

**Fix:** Replace with shadcn `<AlertDialog>` and a typed "RESET" confirmation field (mirrors GitHub-style danger UX).

### 4.11 Embedding dimension mismatch silent failure

`embeddings.ts` returns 256-dim hash bag fallback or whatever Forge returns (1536 for `text-embedding-3-small`). `cosineSim` clamps to `min(a.length, b.length)` so no error fires. But mixing 256-dim historic rows with 1536-dim fresh queries gives garbage cosine scores forever after the migration.

**Fix:** Store dimension alongside embedding (`embeddingDim: int`). On query, only compare same-dim. Add a one-shot re-embed migration path.

---

## 5. P3 — hardening polish

| ID | File | Issue | Fix |
|---|---|---|---|
| 5.1 | `twilio.ts` | No phone format validation; `sendSms` will happily POST `to=garbage` and waste a Twilio API call | Validate E.164 with regex before send, fail fast |
| 5.2 | `twilio.ts` | SMS body unbounded; one segment is 160 chars (GSM-7) or 70 (UCS-2). 1000-char draft = 7 segments billed | Cap at 320 chars and warn the manager in the UI before approving longer |
| 5.3 | `routers.ts` | `simulator.sendMessage` accepts `body.max(1000)`. SMS spec is 1600. But more importantly, an attacker can submit 1000-char prompts that explode LLM tokens — body should be capped at 500 |
| 5.4 | `aiAgent.ts` BRAND_VOICE | Brand voice rule "never confirm pickup unless data shows the customer exists" is *advisory*. The LLM will sometimes confirm anyway. | Hard-code a server-side guardrail: if `customer.found === false` and intent is `Pickup Request`, append a "we don't have you on file yet" preamble before sending to LLM, or refuse to draft and escalate |
| 5.5 | `routers.ts` `drafts.approve` | After approve, fetches `listConversations(500)` just to look up the phone for `sendSms`. Wasteful + caps at 500. | Add a `getConversationById(id)` helper |
| 5.6 | `Home.tsx` polling | Tab title doesn't reflect pending draft count — manager who tabs away doesn't notice queue piling up | Update `document.title` to `(N) DropShop` when `pending.length > 0` |
| 5.7 | `index.css` | Tab list got `shadow-sm` for separation, but the contrast against the deepened canvas is now borderline against the panel below — verify on a 6-bit color laptop | Manual visual QA on a low-quality external monitor |
| 5.8 | `aiAgent.ts` | Classifier prompt doesn't include few-shot examples — relies entirely on label descriptions. Misclassification rate likely 5–10% on adversarial messages | Add 2 hand-picked examples per intent, especially for the Critical vs ETA boundary ("where is my coat" vs "where is the coat I gave you 3 weeks ago and never got back") |
| 5.9 | `db.ts` `getDb` | Connection is a singleton with no health check, no reconnect on stale connection, no pool config | Switch to `mysql2/promise.createPool` with `connectionLimit`, set `enableKeepAlive`, expose a health endpoint |
| 5.10 | All routers | No CSRF protection on mutations; cookie-based auth makes us vulnerable to cross-site form submission | Add a CSRF token check on all mutations; the tRPC fetch link can ship a header automatically |
| 5.11 | `Home.tsx` tabs | `useState(activeConvId)` defaults to `null`, then falls back to `conversations.data?.[0]?.id`. After a Reset, `activeConvId` keeps the now-deleted id, queries silently return `[]`, panels look broken | Reset `activeConvId` to null in `reset.onSuccess` |
| 5.12 | `embeddings.ts` | No caching — same inbound message will be re-embedded for classifier path, generator path, RAG path. 3× cost on every turn | Add an in-memory LRU keyed by SHA-256 of body, 1000 entries |

---

## 6. Concrete remediation roadmap

If we tackle this in order, roughly one PR per row, the demo becomes production-ready in ~3 days of focused engineering:

| Sprint | Days | Tickets | Outcome |
|---|---|---|---|
| **Live-safety lockdown** | Day 1 | 2.1 (HITL in webhook) · 2.2 (Twilio sig) · 2.3 (idempotency) · 2.4 (two-phase send) | Live Mode is safe to point at a real number |
| **State integrity** | Day 2 | 3.1 (pending filter) · 3.2 (atomic approve/reject) · 3.4 (race-safe upsert) · 3.5 (transactions) · 3.6 (DB-down propagation) | No more half-states or duplicate sends |
| **Cost & abuse caps** | Day 2 | 2.5 (rate limits + admin gates) · 4.8 (timeouts) · 5.3 (body cap) | Bounded blast radius from any single attacker |
| **Trust & compliance** | Day 3 | 3.12 (PII redaction in logs) · 3.11 (fail-safe classifier) · 3.9 (single source of truth) · 5.4 (server-side pickup guard) | Customer-facing replies stop hallucinating and stop leaking data |
| **Operational quality** | Day 3 | 4.1 (smart polling) · 4.2 (optimistic updates) · 4.9 (request tracing) · 5.6 (title badge) · 5.11 (reset cleanup) | Manager UX scales to 50+ approvals/hr |

Everything else (P3 polish, vector index, MMS support, pagination) can ride on subsequent sprints once a real client is using the system.

---

## 7. What this audit did **not** cover

For honesty: the following are real production concerns I have not yet inspected in code and would want to revisit before a paying-customer launch:

- **Auth flow edge cases** — Manus OAuth callback failure paths, session cookie expiry handling
- **Deployment-time concerns** — Cloud Run cold-start behavior of seed code, DATABASE_URL secret rotation, Twilio number provisioning checklist
- **Frontend accessibility** — keyboard traps in the Approval Queue, screen-reader labels on the iMessage simulator
- **Browser compatibility** — Safari Private Browsing kills our cookie-based session; we should detect and warn

Happy to extend the audit into any of these next.

---

*Author: Manus AI — Robustness audit prepared for DropShop AI Agent demo, checkpoint `b126bb9c`.*
