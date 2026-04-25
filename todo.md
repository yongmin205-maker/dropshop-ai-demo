# DropShop AI SMS Assistant — TODO

## Core Features
- [x] Schema: conversations, messages, processingLogs, escalations, mockCustomers, mockOrders, mockPriceList
- [x] Seed Mock CleanCloud POS data (customers, orders w/ 4 statuses, price list, memberships)
- [x] tRPC procedures: simulator.sendMessage, conversations.list/messages/logs, escalations.list/resolve, config.get (Live Mode detect)
- [x] AI Intent Classifier (5 exact categories: Pickup Request, ETA/Order Status, Alteration Quote, Membership & Pricing, Critical Escalation)
- [x] Mock CleanCloud tool calls (getCustomerByPhone, getOrdersByPhone, searchPrice, listAllPrices, getMembershipInfo)
- [x] AI Response Generator (DropShop-branded SMS tone)
- [x] Critical Handoff trigger (stop auto-reply, create escalation, alert dashboard)
- [x] Processing Log writer (intent → mock api → response drafted → sent/escalated)
- [x] Twilio webhook endpoint at /api/twilio/sms (only handles incoming when LIVE_MODE)
- [x] Twilio outbound send (only when LIVE_MODE; otherwise simulator-only)
- [x] Live Mode auto-detect from env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)

## UI
- [x] Premium DropShop theme (luxury dark + champagne accent, Fraunces + Inter typography)
- [x] Split-screen dashboard: left = phone simulator, center = store inbox, right = AI log + escalations
- [x] Phone simulator UI (iMessage-style, sender = customer persona selector)
- [x] Store inbox conversation thread view
- [x] AI Processing Log panel (real-time step stream)
- [x] Critical Handoff alert panel
- [x] Preset demo scenario buttons (5 scenarios)
- [x] Live Mode status badge
- [x] Landing/header polish with DropShop branding

## Quality
- [x] Vitest: intent labels are exactly the 5 required strings
- [x] Vitest: order seed uses exactly the 4 required statuses
- [x] Vitest: membership tiers + currency formatting

## Phase 2 — Human-in-the-Loop + RAG
- [x] Schema: drafts, style_examples, rejections, knowledge_chunks (all with embedding columns)
- [x] Backend: simulator flow now stages a pending draft instead of auto-sending
- [x] Backend: drafts.approve (persists outbound + style_example) / drafts.reject (persists rejection + regenerates draft with reason hint)
- [x] Backend: embedding helper (Forge text-embedding-3-small primary, hash-bag deterministic fallback) + cosine topK ranker
- [x] Backend: inject top-K approved pairs + rejection lessons + knowledge chunks as few-shot into reply-generation prompt
- [x] UI: Approval Queue tab with Approve / Reject-with-reason + revision badges on regenerated drafts
- [x] UI: RAG Memory tab (Approved / Rejections / Knowledge sub-tabs) showing the learning corpus grow live
- [x] UI: Auto-send left OFF by default; controllable via `DROPSHOP_AUTO_SEND=1` env flag
- [x] Vitest: 5 new tests — draft does not auto-send, approval records style example, rejection records reason + regenerates, topK ranks same-intent higher, step vocabulary contract

## Phase 3 — UX polish (complete)

- [x] Fix iMessage bubble alignment in PhoneSimulator (customer = right/blue, DropShop = left/grey)
- [x] Add `category` (enum) column to `rejections` table
- [x] Reject Reason dropdown UI: 8 preset categories + Other (free text)
- [x] Surface category in regenerated draft prompt (not just freeform reason)
- [x] RAG Memory tab: "Top reject reasons" widget with bar chart
- [x] Mobile-responsive layout: 3-pane collapses to tabs on `<lg`
- [x] Vitest: REJECT_CATEGORIES contract + regen prompt includes category tag (5 new tests, 23 total passing)

## Phase 4 — UI orientation polish (complete)

- [x] Flip StoreInbox bubbles to manager POV: customer (inbound) = LEFT/gray, DropShop (outbound) = RIGHT/blue
- [x] Add `Reset demo` button in header (clears conversations/drafts/rejections, preserves knowledge base) — fixes accumulated duplicate fixture data
- [x] Existing 23 vitest still pass after refactor
- [x] Save checkpoint

## Phase 5 — Customer-aware Approval Queue (complete)

- [x] Filter Approval Queue by `activeConvId` (with "showing X · click for all" toggle)
- [x] Add `customers.profile(conversationId)` tRPC procedure: aggregate intent distribution, message count, approval rate, avg reply length, top reject categories, last seen
- [x] Customer profile badge on Approval Queue header when filtered
- [x] Inject customer-specific history into RAG retrieval: prefer `style_examples` from same phone (`listStyleExamplesByPhone`), fall back to same-intent global
- [x] Vitest: 3 new tests — customer profile aggregation, null for unknown conv, listStyleExamplesByPhone scoping (26 total passing)


## Phase 6 — Stripe Soft Light visual refresh (complete)

- [x] Build moodboard with 5 tone-and-manner candidates; user chose Option 3 (Stripe Soft Light)
- [x] Rewrite `index.css` with Stripe Soft Light tokens: white canvas (#FFFFFF), navy ink (#0A2540), iris primary (#635BFF), gray-100 (#F6F9FC) panels, soft shadows
- [x] Switch ThemeProvider default from "dark" to "light" so semantic tokens read light values everywhere
- [x] Replace champagne/clay class names (`bubble-business-inbox`, `text-champagne`, `surface-cream`) with Stripe-language equivalents
- [x] Header: clean white bar, navy logo, iris-tinted Live/Simulator badge, Reset/Pitch deck as ghost buttons
- [x] Phone simulator: keep iMessage native (light bg already matches); avatar swapped to iris gradient for brand consistency
- [x] Store Inbox: white `.panel` cards on F6F9FC base, soft shadows, navy headings
- [x] Approval Queue: white cards with iris-tinted draft rows, iris primary CTA, rose destructive outline
- [x] Customer profile badge: iris-tinted pill row
- [x] Inbox bubbles: customer = gray-100 with subtle border (`bubble-customer-inbox`), DropShop = iris gradient (`bubble-business-inbox`)
- [x] Charts/RAG memory bar widget: iris fill on secondary track, light pills for category labels
- [x] Reset demo button uses native confirm dialog with explicit warning copy
- [x] Empty states converted to muted-foreground on light cards (Approvals, Inbox, RAG, Escalations, Phone all reviewed)
- [x] Run vitest (26 pass), save checkpoint (44819425)

## Phase 7 — Panel separation polish (complete)

- [x] Deepen canvas (`--secondary` 0.975 → 0.96 oklch) so white panels lift more visibly
- [x] Strengthen `.panel` shadow (multi-layer 8/24px ambient + 4/8px contact) + sharper hairline border
- [x] CardHeader gets its own band (bottom border + soft top-to-bottom gradient)
- [x] Increase desktop column gap (gap-6 → gap-7)
- [x] Right-pane TabsList moved to white bg with shadow so it floats above the canvas
- [x] Phone simulator outer frame gets matching multi-layer ambient shadow
- [x] Run vitest (26 pass)

## Phase 8 — Production hardening: resolve all 39 robustness audit findings

### Sprint 1 — Live-safety lockdown (P0) — complete
- [x] §2.1 Twilio webhook routes through HITL (insert pending draft, never auto-send unless `DROPSHOP_AUTO_SEND=1`)
- [x] §2.2 Validate `X-Twilio-Signature` HMAC on `/api/twilio/sms` (403 on mismatch, URL reconstructed via `X-Forwarded-*`)
- [x] §2.3 Idempotency: `messages.twilioSid` UNIQUE; webhook short-circuits duplicates with empty TwiML
- [x] §2.4 Two-phase send (`messages.status: queued|sent|failed|delivered`, twilioSid persisted only on ok, draft reopened on fail)
- [x] §2.5 Rate-limit + auth-gate: per-IP (30/min, 500/day) + per-phone (5/5min) + daily LLM token budget; `rag.addKnowledge`/`demo.reset` moved to `adminProcedure`

### Sprint 2 — State integrity (P1) — partially complete (folded into Sprint 1 work)
- [x] §3.1 `getLatestPendingDraftForMessage` filters status='pending_approval'; added `getLatestDraftForMessage` for audit views
- [x] §3.2 Approve/Reject use real `withTransaction` blocks: state transition + outbound row insert (approve) and transition + supersede + rejection + log (reject) commit atomically. Twilio I/O is *outside* the txn so row locks stay short; failure path re-opens the draft.
- [x] §3.3 `resolveEscalation` clears `conversations.escalated` when no other open escalations remain
- [x] §3.4 `getOrCreateConversation` uses `INSERT ... ON DUPLICATE KEY UPDATE`
- [x] §3.5 Customer turn (inbound message + step logs + intent + draft OR escalation) commits inside a single `withTransaction` block in both `simulator.sendMessage` and `twilioWebhook`.
- [x] §3.6 DB-unavailable propagates errors instead of silent void on writes (insertStyleExample/insertRejection/upsertKnowledgeChunk/updateConversationIntent/updateDraftStatus)
- [x] §3.7 `resetDemoData` transactional + admin-only + `ALLOW_DEMO_RESET` env gate

### Sprint 2.5 — Real DB transactions (carryover) — complete
- [x] Wrap `drafts.approve` (transition + outbound queue) in `withTransaction`; Twilio call kept out of txn, failure path re-opens draft
- [x] Wrap `drafts.reject` (transition + supersede siblings + rejection + log) in `withTransaction`; embedding generated outside
- [x] Wrap `drafts.reject` regeneration (insert new draft + step logs) in `withTransaction`
- [x] Wrap `simulator.sendMessage` customer turn (inbound + logs + intent + draft|escalation) in `withTransaction`; auto-send path also tx-wrapped
- [x] Wrap `twilioWebhook` inbound turn + auto-send paths in `withTransaction`
- [x] New vitest `withTransaction.test.ts` (4 contracts: DB-down throws, return forwarding, error propagation, single-BEGIN)

### Sprint 3 — Trust, cost & compliance (P1)
- [ ] §3.8 Cross-instance seeding via `INSERT IGNORE` / unique-key upserts
- [ ] §3.9 Knowledge chunks generated from `MEMBERSHIP_INFO` + `SEED_PRICES` (single source)
- [ ] §3.10 Embedding fallback banner + raise cosine threshold when in fallback
- [ ] §3.11 Classifier defaults to `Critical Escalation` on parse failure (fail-safe)
- [ ] §3.12 PII redaction in `processingLogs.detail` (phone masking, ref by message id)
- [ ] §3.13 MMS skeleton: capture `MediaUrl0..N` and pass as image content for Alteration Quote
- [ ] §3.14 `config.get` re-fetched after each approve; live-mode visible in button label
- [ ] LLM/Twilio/embeddings AbortController timeouts (8s)

### Sprint 4 — Operational quality (P2)
- [ ] §4.1 Smart polling: pause on `document.hidden`, slow when blurred
- [ ] §4.2 Optimistic updates on Approve/Reject
- [ ] §4.3 Cursor pagination on `list*` endpoints (conversations/styleExamples/rejections/knowledge)
- [ ] §4.4 Cap RAG topK candidate pool to recent N
- [ ] §4.5 `getCustomerProfile` uses `inArray` instead of in-memory filter
- [ ] §4.6 `searchPrice` switched to `eq(category)` for known categories
- [ ] §4.7 Reject supersedes any other pending drafts for same `inboundMessageId`
- [ ] §4.9 Structured tracing: correlation_id on logs + twilioSid linkage
- [ ] §4.10 Reset confirm uses shadcn AlertDialog with typed "RESET" guard
- [ ] §4.11 Embedding dimension stored alongside vector

### Sprint 5 — Hardening polish (P3)
- [x] §5.1 E.164 phone validation in `sendSms` (rejects pre-Twilio-call) + simulator input also validates
- [ ] §5.2 SMS segment cap (320 chars warning)
- [x] §5.3 simulator body cap reduced to 500 chars (was 1000)
- [ ] §5.4 Server-side pickup guard when customer not found
- [x] §5.5 `getConversationById` helper added; approve mutation no longer scans `listConversations(500)`
- [ ] §5.6 `document.title` badge with pending count
- [ ] §5.8 Classifier prompt few-shot examples
- [ ] §5.9 mysql2 pool with keep-alive
- [ ] §5.10 CSRF protection on mutations
- [ ] §5.11 Reset clears `activeConvId`
- [ ] §5.12 Embedding LRU cache (1000 entries, sha256 key)

### Final
- [ ] Full vitest suite green, save checkpoint
