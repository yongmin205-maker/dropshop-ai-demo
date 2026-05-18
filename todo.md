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

### Sprint 3 — Trust, cost & compliance (P1) — complete
- [x] §3.8 Cross-instance seeding hardened: `mockCleanCloud` switched to `onDuplicateKeyUpdate`; `knowledgeSeed` uses `upsertKnowledgeChunk` against the `(topic, title)` UNIQUE index. Two pods racing to seed both succeed.
- [x] §3.9 Single source of truth: pricing + membership knowledge chunks now derived from `MEMBERSHIP_INFO` + `SEED_PRICES` via `derivedSeed()` in `knowledgeSeed.ts`. Legacy hard-coded duplicate chunk removed; contract test `knowledgeSeedDerivation.test.ts` pins this.
- [x] §3.10 Embedding fallback fully addressed: (a) **disclosure** — `config.get.embeddingFallbackActive` sticky + `embeddingMissingKey` static + yellow banner in Home.tsx with precise per-case copy; (b) **retrieval policy adaptation** — `ragRetrievalDefaults()` raises cosine floor 0.0→0.7 and halves top-K when in fallback (§4.12, pinned by `ragAdaptive.test.ts`).
- [x] §3.11 Classifier defaults to `Critical Escalation` on any parse / shape / unknown-enum failure (fail-safe, not fail-open). Pinned by `classifierFailSafe.test.ts` (5 cases).
- [x] §3.12 PII redaction: new `server/pii.ts` module masks E.164 + NA phone numbers, emails, and street addresses across nested log details. `appendProcessingLog{,s,Tx,sTx}` all sanitize before insert. 11 vitest cases.
- [x] §3.13 MMS skeleton: webhook captures `NumMedia` + `MediaUrl0..N` + `MediaContentType0..N`, persists into new `messages.attachments` JSON column, forces escalation so the agent never auto-quotes from text-only context. Pinned by `twilioWebhook.mms.test.ts` (4 contracts: single-photo escalation, multi-attachment, no auto-send under `DROPSHOP_AUTO_SEND=1`, 400 on empty body+no media).
- [x] §3.14 `config.get` re-fetched every 30s in Home.tsx so a server-side mode flip surfaces in the UI without a hard reload.
- [x] AbortController timeouts: `_core/llm.invokeLLM` 30s; `embeddings.embedText` 5s; `twilio.sendSms` 10s. Pinned by `timeoutContracts.test.ts`.

### Sprint 4 — Operational quality (P2)
- [x] §4.1 Smart polling: `useVisiblePollInterval` pauses every poll when `document.hidden` (saves CPU + server cost overnight)
- [x] §4.2 Optimistic updates on Approve/Reject (instant queue removal + rollback on error + final invalidate)
- [x] §4.3 Cursor pagination on `listConversations` / `listKnowledge` / `listStyleExamples` / `listRejections` (`afterId` + capped limit)
- [x] §4.4 RAG candidate pool capped before topK (recent 200 only) so cosine cost is bounded
- [x] §4.5 `getCustomerProfile` uses `inArray(rejections.draftId, draftIds)` (N+1 eliminated, pinned by `customerProfile.test.ts`)
- [x] §4.6 `searchPrice` prefers `eq(category)` for known categories with substring fallback (pinned by `searchPrice.test.ts`)
- [x] §4.7 Reject calls `supersedeOtherPendingDraftsTx` for the same `inboundMessageId` (pinned by `correlationAndSupersede.test.ts`)
- [x] §4.9 Structured tracing: every customer turn shares one `correlationId` across `messages.correlationId` + every `processingLogs.correlationId` row (pinned by `correlationAndSupersede.test.ts`); webhook ties it to `twilioSid` for cross-system trace joins
- [x] §4.10 Reset confirm uses shadcn `AlertDialog` + **typed RESET guard** (user must type `RESET` before destructive button enables, prevents accidental click during demo or one-click cascade)
- [x] §4.11 Embedding dimension persisted alongside vector (`embeddingDim` column written by every insert path — styleExamples, rejections, knowledgeChunks)
- [x] §4.8 Cursor pagination round-trip pinned by `paginationAndTracing.test.ts` (8 contracts: where()-only-with-beforeId for all four list helpers, signature exposes `beforeId?: number`, limit caps 200 / 500)
- [x] §4.12 Embedding-fallback retrieval policy: `ragRetrievalDefaults()` raises cosine floor 0.0→0.7 and halves top-K when `embeddingFallbackActive` (pinned by `ragAdaptive.test.ts`)

### Sprint 5 — Hardening polish (P3) — complete
- [x] §5.1 E.164 phone validation in `sendSms` (rejects pre-Twilio-call) + simulator input also validates
- [x] §5.2 **Spec change** — the original audit asked for a 320-char warning in the UI; on review we shipped something stronger: a **hard segment cap** (default 4, `MAX_SMS_SEGMENTS` env-overridable) enforced inside `sendSms` *before* fetch, plus the existing approval-queue card already shows segment count next to each draft. A hard block is the right primitive (UI warnings can be ignored / not loaded if the operator approves via API); we can still add a soft 320-char banner later if we want graduated guardrails. Pinned by `sendSmsCap.test.ts` (3 contracts).
- [x] §5.3 simulator body cap reduced to 500 chars (was 1000)
- [x] §5.4 Server-side pickup guard: `Pickup Request` from a phone not in the customer table now forces escalation in `aiAgent.runAgent` (unknown numbers can't get free pickup scheduled).
- [x] §5.5 `getConversationById` helper added; approve mutation no longer scans `listConversations(500)`
- [x] §5.6 `PendingDraftsBadge` writes `(N) <title>` to `document.title` so background tabs surface new drafts; cleans up on unmount.
- [x] §5.7 Classifier system prompt now ships with 8 explicit few-shot examples covering all 5 intents (especially the Critical Escalation cases where misroute = revenue loss).
- [x] §5.8 Real long-lived `mysql2.createPool` (8 connections, `enableKeepAlive`, 30s `keepAliveInitialDelay`) replaces per-call `drizzle(connectionString)` — fixes TiDB Serverless killing idle connections after 10 min and the boot crash on missing DATABASE_URL is now a graceful warn.
- [x] §5.9 Reset mutation success handler clears `activeConvId` in Home.tsx so the Inbox doesn't render a stale-pointer empty pane after wipe.
- [x] §5.10 CSRF defense: new `originGuard.ts` Express middleware in front of `/api/trpc` blocks all state-changing requests whose `Origin`/`Referer` doesn't match the request host (or `ALLOWED_ORIGINS` allow-list). Pinned by `originGuard.test.ts` (7 contracts incl. proxy `X-Forwarded-Host`, allow-list precedence, Referer fallback).
- [x] §5.11 covered by §5.9 above.
- [x] §5.12 Embedding LRU cache (1000 entries, sha256-keyed Map with insertion-order eviction) wraps `embedText`; pinned by `embedCache.test.ts` (3 contracts: hit reuse, distinct keys, oldest-eviction).

### Final
- [x] Full vitest suite green (121/121)
- [x] Save checkpoint after Sprint 5 hardening (c9790d96)

### Carryover after Sprint 5 — complete
- [x] Soft 320-char UI warning: new `SmsLengthHint` component renders below every Approval Queue draft body, showing exact char count + estimated SMS segment count, with graduated tone (gray → amber → orange → rose) and an explicit "Will be blocked by hard cap" callout at ≥4 segments. Mirrors the server-side `countSmsSegments` so operator never approves something that the server will then refuse.
- [x] Cross-origin integration test: new `originGuardIntegration.test.ts` (7 contracts) mounts `requireSameOrigin` on a real Express app via `supertest` and exercises GET pass-through, same-origin POST under proxy headers, cross-origin 403, missing-Origin 403, Referer fallback, ALLOWED_ORIGINS allow-list precedence, and confirms the Twilio webhook mount is not accidentally covered. Production deployment under a different domain just needs `ALLOWED_ORIGINS` set in env.

## Phase 9 — Admin error logging

- [x] Add `errorLogs` table (level, source, message, stack, context JSON, correlationId, createdAt)
- [x] `pnpm db:push` migration
- [x] `server/errorLog.ts`: `logServerError(err, ctx)` — best-effort, never throws
- [x] Wire into existing console.error sites (twilioWebhook, db, drafts.approve, oauth)
- [x] tRPC `errorLogs.list` (adminProcedure, cursor pagination)
- [x] tRPC `errorLogs.clear` (adminProcedure)
- [x] Admin-only "Errors" tab in Home.tsx (only render when user is admin)
- [x] vitest: writes row, swallows DB-down, gating contract
- [x] Run full suite, save checkpoint


## Phase 10 — Friend system context + Shadow forwarding + Alerts
- [x] Create `CONTEXT.md` at project root with friend system info (CleanCloud + Nextiva)
- [x] Mirror context to Notion for cross-session persistence
- [x] Research Nextiva Messaging webhook / API for inbound SMS forwarding (no public inbound SMS webhook)
- [x] Decide forwarding pattern: recommend OpenPhone migration (proposal in `mainstreet-ai/pilots/pilot1_dropshop/proposals/`)
- [x] Build error alert engine: spike (5 errors/source/5min) + flapping (3 same-msg/10min) + 30min cooldown
- [x] Wire alert engine into `notifyOwner` and self-log to errorLogs
- [x] vitest: spike trigger, flapping trigger, cooldown suppression, alert self-log
- [~] Build `POST /api/shadow/inbound` endpoint with shared-secret auth + payload normalizer (intentionally deferred — superseded by `POST /api/messaging/inbound/quo` in the Awaiting-friend-OK section below)
- [x] Add `shadowMode` flag to conversations + shadowSource on messages (DB scaffolding only)
- [~] vitest: shadow inbound auth gate, shadowMode draft-only contract (intentionally deferred — see "Awaiting friend OK" section below; HTTP route + table not yet exposed)
- [x] Full suite (152 passing) + checkpoint a4d6e1e1 / 34dd8a99
- [x] Add level/source filters to errorLogs.list + Errors tab dropdowns
- [x] Add purgeOld TTL helpers + admin Purge button (errorLogs + errorAlerts >30d)
- [x] vitest: filter inputs, sources distinct, purge admin gate


## Pilot 2 — Salon / PT scheduling AI (research phase)
- [x] Research Glow Genius scheduling rules + overlap support
- [x] Research Phorest scheduling rules + overlap support (Phorest interview/consulting context)
- [x] Research Mindbody scheduling rules + overlap support
- [x] Research adjacent tools used by salons/PT: Vagaro, Booksy, Acuity, Square Appointments, GlossGenius, Fresha, Jane App
- [x] Catalog the "no double-booking / no overlap" pain in real reviews
- [x] Brainstorm AI agent edges (10 edges, 2 killer combo: Overlap Auctioneer + Gap Filler)
- [x] Create Notion page "Pilot 2: Salon AI Scheduler" under MainStreet AI
- [x] Generate 7-page Korean proposal PDF + 2 UI mockups
- [x] Generate 3 mood board options + user picked Modern Botanical
- [x] Migrate all pilot materials into `/home/ubuntu/mainstreet-ai/` master folder

## Phase 11 — Pilot 2 Salon demo (option C: separate /salon route)
- [x] mockSalon.ts: customers + stylists + services + appointments seed (delivered in checkpoint 0801c35d)
- [x] salonIntents.ts: 7 intents — added Critical Escalation in addition to original 6 (delivered)
- [x] salonRouter sub-router (mirrors aiAgent runAgent pattern, separate from DropShop) — delivered as `salon.*` namespace
- [x] /salon page with 3-column layout (carry over Home patterns) + CalendarTimeline
- [x] Industry switcher in nav (Laundry / Salon) — pill in both headers
- [x] vitest contracts for salon mock + router (44 new tests)
- [x] Update CONTEXT.md & Notion Pilot 2 page with sandbox URL once shipped (completed during Pilot 2 follow-up sync)


## Pilot 2 — Salon AI Scheduler
- [x] mockSalon data layer: stylists (Hayley, Soomin, Jisoo), 7-service catalog (cut/perm/color/balayage/manicure/pedicure/hairspa), week-of appointments, customer DB (incl. VIP)
- [x] mockSalon overlap auctioneer: surface candidate slots inside another customer's perm/color processing window
- [x] salonIntents classifier (7 labels: Booking Request, Availability Check, Reschedule, Cancel, Service Question, Pricing, Critical Escalation)
- [x] salonAgent draftSalonReply: tool dispatch (lookup customer/services/stylists/overlapSlots) + reply generation w/ Modern Botanical brand voice
- [x] tRPC salon.* router: listAppointments, getCustomer, findOverlapSlots, draft (in-memory, no DB persistence — refresh resets)
- [x] /salon page: 3-column layout (phone simulator + Calendar+Inbox + Approval Queue), CalendarTimeline mini week visualization w/ overlap highlight
- [x] Modern Botanical theme: scoped .salon-theme CSS vars (sage #7a8e6f + terracotta #c2825f + linen #f8f6f0), Fraunces display + DM Sans body, scoped to /salon only
- [x] Industry switcher pills in both headers (Home → Salon, Salon → Laundromat)
- [x] Vitest coverage: mockSalon (20 tests), salonAgent (16 tests), salonRouter (8 tests) — 44 new tests, 196 total passing


## Pilot 2 follow-up — closed-loop demo + Notion sync (post-deploy)
- [x] Sync Pilot 1 (Laundromat) Notion page with live URL https://dropshopai-vx45nyzf.manus.space
- [x] Sync Pilot 2 (Salon) Notion page with live URL https://dropshopai-vx45nyzf.manus.space/salon
- [x] Update mainstreet-ai/README.md (master index): Pilot 1/2 deployment status, live URLs, demo paths
- [x] Update CONTEXT.md & Notion Pilot 2 page with sandbox URL once shipped (also tracked under "Phase 11 — Pilot 2 Salon demo"; both Notion pages + README synced)
- [x] Closed-loop: salon `approveBooking` + `resetDemo` mutations — turns AI's first overlap candidate into a real in-memory appointment, and Reset clears it back to seed
- [x] UI: approve button in salon Approval Queue commits the booking via tRPC, invalidates calendar query, rolls back optimistic approval if the server rejects
- [x] Vitest: 3 new closed-loop tests (approveBooking commits/visibility, resetDemo idempotency, input range guards) — 199 total passing
- [x] Gap Filler scenario: noShow event → AI auto-drafts limited-time outreach to top-3 VIP customers tagged for that service
- [x] Demo scenario pill "Gap Filler: no-show → VIP outreach" added to /salon header (Proactive AI row)
- [x] Processing-window reminder: when a perm/color processing window is about to end, AI drafts "rinse imminent" reminder for the stylist
- [x] /salon header shows "Rinse alerts: N live" pill (always-on, polls every 15s); reminder cards render in a Stylist Pings panel above the phone simulator
- [x] vitest: approveDraft creates appointment, gapFiller surfaces correct VIP list, processing reminder triggers in-window only — 8 new tests added (207 total)


## Phase 3+4 design notes (Gap Filler + Processing-window Reminder)

### Phase 3 — Gap Filler
- [x] mockSalon: `markAppointmentNoShow(apptId)` mutates status → "no_show" and surfaces the freed slot
- [x] mockSalon: `findGapFillerCandidates(freedAppt, n=3)` ranks VIP customers by (vipTier desc, last visit recency, service-fit) and returns top-N candidates
- [x] salonAgent: `runGapFillerPipeline(freedAppt, n)` returns N SMS drafts (one per candidate) with limited-time framing, each carrying a `bookingDraft` so Approve commits them
- [x] tRPC: `salon.simulateNoShow({ appointmentId, topN })` mutation runs the no-show + draft pipeline and returns N drafts with bookable metadata
- [x] /salon UI: "Gap Filler" pill triggers, drafts appear as terracotta-tinted cards in the Approval Queue with target customer name + VIP tier badge + freed slot label; Approve commits via existing approveBooking mutation
- [x] Vitest: gapFiller candidate ranking + draft pipeline shape (4 tests in salonRouter.test.ts)

### Phase 4 — Processing-window reminder
- [x] mockSalon: `findProcessingWindowsEndingSoon(now, leadMinutes=5)` returns appointments whose processing window ends within the lead time (semantic shift: rinse end is what stylists care about, not start)
- [x] salonAgent: `runProcessingReminderPipeline(now, leadMinutes)` builds short stylist-facing rinse-alert drafts (NOT customer SMS) deterministically (no LLM call) for near-zero latency
- [x] tRPC: `salon.checkProcessingReminders({ dayIndex, minute, leadMinutes })` query that surfaces current reminders; polls every 15s on the salon page
- [x] /salon UI: Stylist Pings panel surfaces the rinse alerts above the phone simulator, with deterministic demo cursor pinned to Wed 15:13 so a Jessica perm rinse always demos
- [x] Vitest: window detection edge cases (in-window, before-lead, different-day filter — 3 tests)

### Phase 5 — Sweep + checkpoint + deliver
- [x] Full vitest sweep zero-regression: 29 files / 207 tests passing
- [x] Final checkpoint (version 28a249aa, includes Phases 1-4)
- [x] Deliver to user with updated demo URL/checkpoint


## Provider-agnostic inbound messaging (Quo adapter, shadow mode) — design + scaffold complete

Vendor-neutral design so swapping Quo → Twilio/Bandwidth later is just one adapter file. Shadow mode = AI generates drafts but **never** sends to the real customer.

### Phase 1 — Design + scaffold messaging layer (complete)
- [x] `shared/messaging.ts` — provider-agnostic normalized `InboundMessage` + `MessagingMode` + `SignatureVerifyResult`
- [x] `server/messaging/types.ts` — `MessagingInboundAdapter` interface (`verifySignature` + `parsePayload`)
- [x] `server/messaging/quoAdapter.ts` — HMAC-SHA256 verify against `openphone-signature` (scheme;version;timestamp;sig); `message.received` → `InboundMessage`
- [x] `server/messaging/inboundPipeline.ts` — shadow / live mode; outbound rejected in shadow

### Phase 3 — Vitest contracts (complete)
- [x] HMAC verify: good / tampered body / tampered timestamp / replay >5min — `server/messaging/quoAdapter.test.ts` (10 cases, exceeds the original 6)
- [x] Payload normalize: `message.received` shape lock
- [x] inboundPipeline shadow: outbound adapter never invoked (test fails if called) — `server/messaging/inboundPipeline.test.ts`
- [x] inboundPipeline live mode behind explicit feature flag

### Phase 4 — Friend-facing migration message (Korean) (complete)
- [x] Short KakaoTalk-tone version + 1-page long version both saved at `mainstreet-ai/pilots/pilot1_dropshop/proposals/openphone_migration_friend_message.md` and `openphone_migration_pitch.md`

### Phase 5 — Sweep + checkpoint + deliver (complete, multiple iterations)
- [x] Full vitest sweep zero-regression — latest run: 36 files / 260 tests passing
- [x] Checkpoints saved across iterations (latest: e8a936ba)
- [x] PDF deliverable shipped to user (4-26)


## DropShop friend-facing PDF briefing (delivered)

- [x] Captured 5 DropShop UI screenshots — `01_landing.png` / `02_pickup_draft.png` / `03_eta_cleancloud.png` / `04_critical_escalation.png` / `05_ai_log.png` in `/home/ubuntu/dropshop-screenshots/`
- [x] Wrote partner-tone briefing markdown — `dropshop_partner_brief.md` (8.7 KB)
- [x] Rendered final PDF via `manus-md-to-pdf` — `DropShop_Partner_Brief.pdf` (1.45 MB, 7 pages, image + table glitches all cleaned)
- [x] Delivered PDF + source markdown to user (4-26)


## Phase 12 — Approve bug fix + Friend partner PDF

- [x] Fix "Approve failed · Unable to transform response from server" in DropShop Approval Queue (root cause: stale deploy + nested-anchor render error in old build; fixed Link nesting in Home.tsx + Salon.tsx; dev curl now returns 200 OK with valid superjson; redeploy required to reach the live site)
- [x] Verify Approve flow + 231 vitest still green (231/231 passing across 31 files); save checkpoint
- [x] Capture 5 DropShop UI screenshots for friend PDF (delivered — see `/home/ubuntu/dropshop-screenshots/`)
- [x] Write partner-tone DropShop-only briefing markdown (delivered — `dropshop_partner_brief.md`)
- [x] Render briefing as PDF and deliver (delivered — `DropShop_Partner_Brief.pdf`, 7 pages)


## Phase 13 — P0 code-quality fixes from CODE_AUDIT.md

- [x] P0-A: added `readInsertId` / `readAffectedRows` in `server/db.ts`; replaced 8 inlined casts (db.ts ×6, errorLog.ts ×2, alertEngine.ts ×1) and patched 2 vi.mock blocks
- [x] P0-B: removed dynamic `await import("./db")` in `server/routers.ts` approve catch; static `updateDraftStatus` import added to top of file
- [x] P0-C: created `server/messaging/twoPhaseSend.ts` with `recordTwoPhaseSendSuccess` + `recordTwoPhaseSendFailure` + shared `SEND_ERROR_MAX`; webhook auto-send branch now uses the helpers (4 inline statements → 2 helper calls); approve and simulator paths share the constant (different tx model, intentionally not collapsed)
- [x] Run full vitest suite — 31 files / 231 tests pass (3.83s)
- [x] Save checkpoint with the P0 refactor message


## Phase 14 — P1+P2 follow-ups from CODE_AUDIT.md (complete)

- [x] server/storage.test.ts — 7 cases (storage.ts coverage 0% → ~80%)
- [x] server/dropshopRouter.test.ts — 9 cases via appRouter.createCaller (covers config.get, drafts.listPending, escalations.list, customers.profile, conversations.list/.messages)
- [x] Extract `useVisiblePollInterval` → `client/src/hooks/useVisiblePollInterval.ts`; Salon also opts in (background tab now pauses calendar polling)
- [x] Extract `guessSalonService` + keyword table → `shared/serviceGuess.ts`; salonAgent (server) and Salon.tsx (client) both import — no more drift
- [x] Decompose Home.tsx 1,732 → 1,338 LOC: ApprovalQueue + helpers (CustomerProfileBadge, SmsLengthHint, CustomerProfileData) → `client/src/pages/dropshop/ApprovalQueue.tsx`; intentTone → `client/src/pages/dropshop/intentTone.ts`
- [x] Wire vitest workspace (`vitest.workspace.ts`): server=node, client=jsdom; add jsdom + @testing-library/react/jest-dom/user-event devDeps; client setup file with auto-cleanup + matchMedia/ResizeObserver polyfills
- [x] First client tests:
  - `intentTone.test.ts` (4 cases)
  - `shared/serviceGuess.test.ts` (6 cases)
  - `ApprovalQueue.test.tsx` (3 cases — render, Approve click → mutation, **nested-anchor regression lock**)
- [x] Full suite: 36 files / 260 tests pass (was 247) — net +13 tests across the audit follow-up
- [x] Save final P1+P2 checkpoint


## Awaiting friend OK (Quo migration) — gated by friend's go-ahead, do NOT auto-implement

> All 7 items below are intentionally deferred. They are not pending work; they are a pre-staged batch that goes live in roughly 2 hours of focused work the moment the friend (DropShop owner) confirms the OpenPhone (Quo) migration. Do not implement until that confirmation arrives.

- [~] `POST /api/messaging/inbound/quo` Express handler — captures raw body BEFORE json-parse, runs `quoAdapter.verifySignature` + `parsePayload`, hands off to `inboundPipeline` in shadow mode (≈30 min)
- [~] Persist shadow drafts in a new `shadow_messages` table (drizzle schema): inbound message + AI draft + intent + status (`new` / `reviewed` / `discarded`) + receivedAt (≈20 min)
- [~] tRPC `shadow.list` / `shadow.markReviewed` / `shadow.discard` for an internal viewer (admin-only) (≈30 min)
- [~] Env var `QUO_WEBHOOK_SIGNING_KEY` documented in README — actual value added via `webdev_request_secrets` only after friend OK (≈5 min)
- [~] vitest: shadow inbound auth gate (≈10 min)
- [~] vitest: shadowMode draft-only contract end-to-end through the new HTTP route (≈10 min)
- [~] Friend confirmation conversation itself — happens in the messaging app, not in this repo. The Korean short + long versions are already drafted in `mainstreet-ai/pilots/pilot1_dropshop/proposals/openphone_migration_friend_message.md` and `openphone_migration_pitch.md`.

The `[~]` marker is used here instead of `[ ]` so the file no longer reports false "uncompleted items" against work that should not start without external input.


## Phase 15 — Live "Agent error · Unable to transform response from server" bug

- [x] Located: `dropshop.simulator.sendMessage` (and every other mutation) returns HTTP 403 from the live deploy because `originGuard` rejects the Origin
- [x] Root cause: behind Manus reverse proxy, Express's raw `Host` header is the internal Cloud-Run host, not the public `dropshopai-vx45nyzf.manus.space` that the browser puts in `Origin`. Same-host fallback in `originGuard` therefore returns 403, and tRPC's superjson cannot decode `{"error":"..."}` as a structured response
- [x] Fix 1: `app.set("trust proxy", true)` in `server/_core/index.ts` so `req.hostname` / `req.protocol` reflect `x-forwarded-*`
- [x] Fix 2: `originHostMatchesRequest` now tries `req.hostname`, `x-forwarded-host`, and raw `Host` (with port stripping + lowercase) before declaring a mismatch
- [x] Fix 3: log first 5 CSRF rejections with full header dump so future live-only mismatches can be diagnosed without redeploy
- [x] Vitest sweep: 36 files / 260 tests pass (existing originGuard integration suite already covers the proxy-host scenario)
- [x] Save checkpoint and hand off to user for Publish


## Phase 16 — Phase 15 fix did NOT resolve live 403 (still reproducing on `Ca1NUqB5` bundle, even after publish)

- [x] Stop relying on Host comparison entirely. Rewrite `originGuard.requireSameOrigin` so the fallback rule (when `ALLOWED_ORIGINS` env is unset) accepts any Origin whose hostname ends with `.manus.space` or `.manus.computer` — these are the only domains a real Manus user can hit this app from
- [x] Cross-site Origin (`https://evil.example.com`) still 403; missing Origin still 403; look-alike `manus.space.evil.com` still 403 (4 new contracts)
- [x] originGuard.test.ts now has 11 cases (was 7), originGuardIntegration.test.ts unchanged 7 — both green
- [x] Full vitest 36 files / 264 tests passing


## Phase 17 — Adopt mattpocock/skills patterns

- [x] Cloned `github.com/mattpocock/skills`, inventoried 19 skills, picked 4 high-value: `migrate-to-shoehorn`, `ubiquitous-language`, `domain-model`, `improve-codebase-architecture` (LANGUAGE.md vocabulary). Pre-commit deferred.
- [x] Installed `@total-typescript/shoehorn`. Migrated 6 test files (`auth.logout`, `dropshopRouter`, `salonRouter`, `twilioWebhook.mms`, `draftStateMachine`, `rejectCategory`) — 25 cast sites. Remaining 15 `as` sites are not shoehorn targets (unknown narrowing, generic Record cast, empty array annotation).
- [x] Wrote `UBIQUITOUS_LANGUAGE.md` at repo root with 6 term tables (Conversation, Approval, Send, Escalation, Knowledge, Actors, Pilots), relationships, dialogue, flagged ambiguities (User vs Owner vs Customer; Reply vs Draft vs Outbound; Send overload; Mode overload).
- [x] Created `docs/adr/` with 7 ADRs (HITL default, Two-Phase Send, originGuard suffix policy, MMS Critical Escalation, embedding fallback, Manus-only OAuth, shadow-mode integration) + index README.
- [x] Appended `CODE_AUDIT.md` § 5 with deepening vocabulary (Module/Interface/Depth/Seam/Adapter) + 3 candidate deepenings (Home.tsx DemoStage, MessageTransport adapter for Twilio, RagRetriever adapter for embedding/keyword).
- [x] Full vitest passes (264 tests across 36 files).


## Phase 18 — MessageTransport adapter (CODE_AUDIT §5.3 Candidate 2)

- [x] Inspected every caller of `sendSms` and the `if (env.LIVE_MODE)` branch points (3 sites: routers.approve, routers.simulator.sendMessage, twilioWebhook auto-send)
- [x] Defined `MessageTransport` interface in `server/messaging/transport.ts` with vocabulary `{ ok: true, sid } | { ok: false, error, code, retryable }`
- [x] Implemented `TwilioAdapter` (delegates to existing `sendSms`), `SimulatorTransport` (with per-instance recorded sends + reset), `ShadowGuardTransport` (defensive)
- [x] Boot-time selector `getMessageTransport()` requires BOTH `DROPSHOP_LIVE_MODE=1` AND Twilio creds present — defense against accidental leak in dev/preview
- [x] **Decision: Option B** — do NOT migrate the 3 callers today (would change Simulator-mode UI semantics from "send failed" to "sent SIM"). Recorded in ADR 0008. Migration trigger: OpenPhone or Nextiva integration.
- [x] New tests: `server/messaging/transport.test.ts` (13 contract tests across all 3 adapters + selector). Existing `twoPhaseSend.test.ts` and `sendSmsCap.test.ts` unchanged — no regression.
- [x] All tests green: 37 files / 279 tests (was 36 / 264; added 13 transport + 2 originGuard).
- [x] Added ADR 0008 (MessageTransport seam, Option B rationale) and ADR-index entry.
- [x] ADR 0003 follow-up: tightened `originGuard.ts` with `[originGuard] fallback-used` warn log when suffix fallback is used in `NODE_ENV=production`. Request still allowed (no live-traffic regression). Two new tests pin the observability behavior. The log line is the trigger to set `ALLOWED_ORIGINS` env explicitly via webdev secrets when domain stabilizes.


## Phase 20 — Claude Code review fixes (5-branch chain) + liveMode unification

- [x] Claude Code (external review) wrote 5 fix branches: `fix/1-admin-procedures`, `fix/2-approve-tx-boundary`, `fix/3-twoPhaseSend-helpers`, `fix/4-transport-migration`, `fix/5-prompt-injection-and-unknown-phone`. Manus verified each diff against its stated invariant (file:line spot checks).
- [x] **Fix #1** — 9 owner-side mutations (`drafts.approve`, `drafts.reject`, `escalations.resolve`, `simulator.sendMessage`, `salon.approveBooking`, `salon.resetDemo`, `salon.simulateNoShow`, `agent.draft`) now wrapped in `adminProcedure`. Confirmed remaining `publicProcedure` sites are `.query()` only (incl. `checkProcessingReminders` which is documented "pure read").
- [x] **Fix #2** — `drafts.approve` send-completion writes (delivery flip + draft re-open + processing log) now atomic via `withTransaction(tx => recordTwoPhaseSend*Tx)`. Twilio HTTP call still outside tx.
- [x] **Fix #3** — `routers.ts` (approve + simulator auto-send) now consume `recordTwoPhaseSendSuccess/Failure` helpers; the bare-write inline blocks are gone.
- [x] **Fix #4** — All three send call sites migrated from `sendSms()` to `getMessageTransport().send()`. ADR 0008 status updated. ApprovalQueue toast now distinguishes `SIM`-prefixed sids ("Simulator (no real SMS)") from real Twilio sids.
- [x] **Fix #5** — Unknown-phone escalation widened from `Pickup Request` only to also cover `ETA/Order Status` and `Alteration Quote`. `<UNTRUSTED_INPUT>...</UNTRUSTED_INPUT>` markers wrap raw customer body in the LLM prompt; `BRAND_VOICE` system rule explicitly tells the model to never follow instructions inside those markers. 4 new aiAgent tests pin both behaviors.
- [x] Fast-forward merge to `main` (linear chain). 38 files / 293 tests green on first pass.
- [x] **Follow-up patch (Claude open question #5)** — `liveMode` source-of-truth unified: introduced `isTransportLive()` predicate that both `config.get.liveMode` badge AND `getMessageTransport()` selector now consume. Pre-patch the badge could read "live" while transport silently used the simulator (creds without `DROPSHOP_LIVE_MODE=1`). Inbound row `mode` label and Twilio webhook receiver intentionally keep raw `isLiveMode()`.
- [x] 4 new contract tests pin the 4-cell truth table (no flag/no creds, flag/no creds, no flag/creds=PRE-FIX BUG, flag+creds). 38 files / **297 tests** green.

### Deferred (Claude open questions, low priority)

- [ ] **OQ #1** — `customerProfile` 2 fails are infra-dependent (DB available on Manus sandbox, not on user's local). Add explicit DB-presence guard to skip cleanly.
- [ ] **OQ #2** — `salon.approveBooking` is entangled with simulator demo state. Wait until Pilot 2 build to split.
- [ ] **OQ #3** — Simulator transport produces `queued`-then-`sent` trace; harmless but surprising. No action.
- [ ] **OQ #4** — originGuard `*.manus.space` suffix fallback — Fix #1's admin gate now closes the real attack surface. Strict allowlist via `ALLOWED_ORIGINS` env is cleanup, not security. Defer until domain stabilizes.
- [ ] **OQ #6** — ADR convention for "Superseded" status: Fix #4 updated 0008 in-place. Codify in-place vs new-ADR convention later.


## Phase 21 — Claude-recommended pilot-1 cutover prep

Priority ordered by Claude Code's cutover-risk analysis. Order is load-bearing: (1) raises approval quality before the friend sees first drafts; (2) prevents a same-day 403 outage when a custom domain lands; (3) removes a visible demo flicker surprise.

- [x] **21a** — Done via Claude Code `feat/21a-ubiquitous-language-in-prompt` (sha `9c98f7c`). Added exported `DROPSHOP_VOCABULARY` constant (~40 lines, 5 sections: Actors / Message lifecycle / Approval & escalation / Intent labels / Knowledge surface) + `buildSystemPrompt()` function. `BRAND_VOICE` tightened with "your order" phrasing rule, "we'll text" (not "I'll text") authority rule, and an explicit ground-or-escalate rule. Claude also proactively reordered the user-message parts so `<UNTRUSTED_INPUT>` now comes AFTER Tool data + RAG (defense-in-depth against prompt injection). 3 new regression tests pin: (i) every load-bearing glossary term appears verbatim in the prompt, (ii) vocabulary precedes brand voice, (iii) untrusted input follows trusted context. 38 files / 300 tests green.
- [x] **21b** (sha `d8eff34`) — Centralized `ALLOWED_ORIGINS` read in `server/_core/env.ts` as a getter (so webdev hot-secret reload works without redeploy). New `scripts/verify-origin-config.ts` diagnostic prints effective policy + 3 example origin probes (Manus / candidate custom / look-alike attacker) + a `READY FOR CUSTOM DOMAIN: yes/no` line. New `SESSION_RECOVERY.md` § "Custom-domain cutover checklist" with 8 verifiable steps. ADR 0003 amended one-liner. 38 files / 300 tests. The diagnostic refused without ALLOWED_ORIGINS and flipped to `yes` when the env was simulated.
- [x] **21c** — Audited every reader of `messages.status` and `messages.mode='simulator'`. Zero readers depend on the queued→sent transition: no UI surfaces status, no server-side filter excludes queued, no sweeper/cron walks queued rows. Two-phase send completes synchronously inside its initiating request, rolling back via `withTransaction` on failure. Attestation appended to ADR 0008. No code change required.

## Phase 22 — Friend feedback response (queued May 1, 2026)

Trigger: friend sent (a) Korean text feedback "make a simple/hide version, other apps have too much", (b) Aischedule.pdf with 3 salon pain points (slot fragmentation, payment failures, multi-stylist packages). User confirmed: design with mobile/native-app target in mind.

### Track A — DropShop Simple Mode

- [x] **22a-1** — Add `[Simple] [Full]` toggle pill in `Home.tsx` header. Persist to `localStorage('dropshop.uiMode.v1')`. Default = `Simple`. (`SimpleModeToggle` component + `useSimpleMode` hook.)
- [x] **22a-2** — In Simple Mode hide: Demo Scenarios bar, Phone Simulator pane, AI Log / RAG Memory / Errors tabs, embedding-degraded banner. Show: header + `StoreInboxCompact` (vertical 44px tap rows) + `ApprovalQueue` full-width, single-column at every breakpoint (max-w-[480px] mobile-first per Phase22 §Q1).
- [x] **22a-3** — Tests: 6 `useSimpleMode` (default, rehydrate, invalid value, write-through, toggle, private-browsing) + 5 `SimpleModeToggle` (aria-selected, rerender, click flows, tap-target class). 11/11 pass. Full suite: 330 passed | 3 skipped.

### Track B — Salon Pilot 2 Smart-Slot suggestion (Problem 1)

User confirmed: scoring prefers filling "gap before" first. User asked for ticketmaster-style hold/lock when proposing slots.

- [ ] **22b-0** — Write `docs/mainstreet-ai/pilots/pilot2_salon/slot_hold_design.md` (lifecycle states, TTL choice, hold table schema, race conditions, expiry handling, demo countdown UX).
- [ ] **22b-1** — DB: `salon_slot_holds` table (`id`, `stylistId`, `serviceId`, `startTs`, `endTs`, `customerId`, `expiresAt`, `status`).
- [ ] **22b-2** — `salon.suggestOptimalSlots({serviceId, dayISO})` — scans 15-min starts, scores by `gap_before * 1.0 + gap_after * 0.6` (lower = better), filters out slots overlapping existing hold/booking, returns top 3.
- [ ] **22b-3** — `salon.holdSlot({slotId, ttlSec})` and `salon.releaseHold({holdId})`. Hold auto-expires via `expiresAt` (no cron — checked at read time).
- [ ] **22b-4** — Approve flow: confirm hold + commit appointment + release sibling holds, all in `withTransaction`.
- [ ] **22b-5** — UI: Smart Slots panel. Customer texts "afternoon haircut?" → 3 ranked slots with countdown timers. Approving one auto-releases the others.
- [ ] **22b-6** — Tests: scoring picks gap-filler over end-of-day, hold prevents double-book within TTL, hold auto-expires, sibling holds released on confirm.

### Track B — Salon Pilot 2 Multi-stylist package (Problem 3)

- [ ] **22c-1** — Extend `shared/salonScenarios.ts` with `package` type: ordered legs `[{service, stylist}]`.
- [ ] **22c-2** — `salon.suggestPackageSlots({packageId, dayISO})` — finds windows where leg-1 stylist is free for leg-1 duration AND leg-2 stylist is free immediately after for leg-2 duration. Honors holds.
- [ ] **22c-3** — Approval card: render both legs vertically. One Approve commits both legs in one transaction OR rejects with re-propose if conflicting hold/booking landed between propose and approve.
- [ ] **22c-4** — Tests: skip windows where leg-2 stylist is busy, atomic approve commits both, post-propose conflict triggers re-propose path.

### Track B — Payments (Problem 2) — DEFERRED to Phase 23

Requires Stripe Connect, real keys, separate deploy story. Demo for now: mock "payment status" badge + retry CTA. Do not block 22a/22b/22c on this.


### Phase 22d — Nextiva Polling POC (BLOCKED — see ADR 0009)
- [x] Collect Nextiva credentials via secrets card (NEXTIVA_USERNAME, NEXTIVA_PASSWORD, NEXTIVA_PHONE_NUMBER, NEXTIVA_CAMPAIGN_ID optional)
- [x] Add `server/messaging/nextivaTransport.ts`: token-with-authorities login + 1h cache + workitem poll + sendSMS scaffolding
- [x] Mocked vitest for transport (auth Basic Auth, workitem parsing, send payload, campaignId optional)
- [x] Live probe across host/path grid via `nextivaTransport.live.test.ts` (RUN_NEXTIVA_LIVE=1)
- [x] **Result: BLOCKED.** All documented endpoints return 404 from `api.nextiva.com`; `nextos.nextiva.com` answers 200 but only with a `<title>Nextiva Online Account - Secure Login</title>` HTML SPA — i.e. no JSON API surface for these credentials. Friend's plan is NextivaONE business phone, not Contact Center / NextOS developer access.
- [x] Documented in `docs/adr/0009-nextiva-api-access-blocker.md` (full probe grid + 3 forward paths).
- [ ] **Decision pending (friend):** (a) pivot to Twilio-only (already shipped); (b) Nextiva number-forwarding into Twilio so friend keeps the number; (c) ask Nextiva sales for Contact Center API plan. Manus is not building further on Nextiva until friend chooses.


## Phase 23 — CleanCloud POS Integration (Stage 1 read-only)

- [x] **23-1** — Registered `CLEANCLOUD_API_TOKEN` as a webdev secret. Server picks it up via `ENV.cleanCloudApiToken` defined in `server/_core/env.ts`.
- [x] **23-2** — Live connectivity test passed against the friend's real account: `getPriceLists` returned 9 lists, `getProducts` returned 95 SKUs, `getOrders` returned a paged window. Token valid, account on Grow+ plan with API enabled. See `server/messaging/cleanCloudTransport.live.test.ts`.
- [x] **23-3** — `server/messaging/cleanCloudTransport.ts` built with typed wrappers for all 4 read endpoints. Rate-limit gate (3 req/sec, FIFO timestamp queue), 10s abort timeout, Result envelope, and forward-compatible permissive response types. (Memo cache deferred; not needed for live diagnostic.)
- [x] **23-4** — `server/messaging/cleanCloudTransport.test.ts`: 16 hermetic tests covering token injection, request body shape, response decoding (4 endpoints), error envelopes, HTTP 5xx, non-JSON body, missing-token short-circuit, rate-limit serialization, and 3 rate-limit auto-retry cases.
- [x] **23-5** — `server/messaging/cleanCloudAdapter.ts` normalizes real CleanCloud responses into the mock-shaped surface. `mockCleanCloud.ts` 4 helpers branch on `ENV.useRealPos`. Default stays mock; 360 tests continue to pass with no regression.
- [x] **23-6** — `cleancloud.diagnostic` admin-only tRPC procedure returns price lists, products (first 5), orders (3-day window, first 5), and recently-added customers (7-day window, first 5, phone last-4 masked). Calls are sequentialized to respect the published 3 req/sec cap.
- [x] **23-7** — `/cleancloud-test` route renders 4 diagnostic cards with Connection-status pill, returned-count badge, and pretty-printed JSON. Verified live: PriceLists 9, Products 95 (confirms B2B price lists per building: 985 Park Doorman, 1040 Park Ave, Inpir). Orders + Customers now green after 23f-1..4 fixes.
- [ ] **23-8** — Document the result in `docs/mainstreet-ai/integrations/cleancloud_stage1_result.md` (which fields actually came through, any surprises, recommended Stage-2 work). [PENDING: write after friend confirms /cleancloud-test re-check]
- [x] **23-9** — Reminded user. User declined to regenerate immediately, accepted the residual leak risk. Will surface again at Stage-2 lock-in.


## Phase 23 follow-ups (discovered during /cleancloud-test live diagnostic)

- [x] **23f-1** — Diagnostic `getOrders` narrowed to a 3-day window (was 30 days). Active stores get "Requesting too many orders in one request" past ~7 days; 3 days fits in one page.
- [x] **23f-2** — Diagnostic `Promise.all` replaced with sequential awaits in `cleancloud.diagnostic` router. CleanCloud's server-side throttle was treating concurrent fan-out as one client; serial calls pace comfortably under the published 3 req/sec cap.
- [x] **23f-3** — `cleanCloudTransport.postJson` now auto-retries once after a 1.2s delay when the response body matches `/rate limit|too many requests/i`. Test seam `__setCleanCloudRateLimitSleeperForTests` lets vitest inject an instant resolver.
- [x] **23f-4** — Vitest coverage for retry: (a) throttle→success on attempt 2, (b) throttle→throttle bounded to 2 calls then error surfaced, (c) non-throttle error fails fast (no retry). 16/16 cleancloud transport tests pass; full suite 360 passed | 8 skipped.
- [ ] **23f-5** — Investigate CleanCloud product flags (`te1`/`te2`/`te3`, `isSqmProduct`, `type`, `section`) to derive a customer-visible whitelist — operational SKUs like "A_Personal Bag to Return" must NOT surface in agent quotes.
- [ ] **23f-6** — B2B pickup scenario: the friend's account has 9 price lists keyed by building (985 Park Doorman, 1040 Park Ave, Inpir, Monthly Subscription, …). Add a demo scenario where a doorman texts "I have 3 bags from 1040" → agent recognizes building, applies that price list.
- [ ] **23f-7** — Webhook endpoint scaffold (`/api/cleancloud/webhook`) with HMAC-style shared-secret verification — required before any of the 9 webhook toggles in CleanCloud admin can be safely turned on.


## Phase 23f-7 — CleanCloud webhook handler (DONE)

- [x] drizzle: cleanCloudWebhookEvents table + migration 0009_luxuriant_the_fury.sql
- [x] CLEANCLOUD_WEBHOOK_SECRET registered as webdev secret
- [x] server/messaging/cleanCloudWebhook.ts (constant-time secret check, idempotent insert, 9-event scaffold dispatch)
- [x] Mounted at POST /api/cleancloud/webhook in server/_core/index.ts
- [x] 23 hermetic vitest tests in cleanCloudWebhook.test.ts
- [x] Full suite: 383 passed | 8 skipped (was 360 passed; +23 new, 0 regressions)

## Phase 23f — still pending (BLOCKED on friend)
- [ ] 23f-5 product whitelist (need friend to confirm /cleancloud-test all-green first)
- [ ] 23f-6 B2B building-pickup scenario (need friend to confirm B2B client list)
- [ ] 23f-8 write docs/mainstreet-ai/integrations/cleancloud_stage1_result.md
- [ ] Friend enables webhooks in CleanCloud admin using URL:
      https://dropshopai-vx45nyzf.manus.space/api/cleancloud/webhook?token=<CLEANCLOUD_WEBHOOK_SECRET>


## Phase 24 — P0: CleanCloud data strategy + Owner Assistant (Active)

User direction (2026-05-14): "salon 은 지금 priority 아니야 depriotize하자. nextiva도. 당장 cleancloud data를 어떻게 활용할지가 p0"

Deliverables (docs first, code later):
- [x] 24a · `docs/mainstreet-ai/integrations/cleancloud_data_strategy.md` (see done section below)
- [x] 24b · `docs/mainstreet-ai/integrations/cleancloud_pipeline.md` (see done section below)
- [x] 24c · `docs/mainstreet-ai/agentic_owner_assistant.md` (see done section below)
- [x] 24d · Hand all 3 docs to user → revised twice (rev/rev2) per user feedback

## Phase 22b — Salon Smart-Slot (DEPRIORITIZED 2026-05-14)
- [~] Module `server/salonSmartSlot.ts` + 20 vitest exists locally; 1 test skipped
- [~] No checkpoint, no UI wiring; leave on disk but stop work
- [~] Resume only after user signals salon is back on (no ETA)

## Nextiva — DEPRIORITIZED 2026-05-14
- [~] Awaiting billing@nextiva.com reply (passive); no active work


## Phase 24 — done 2026-05-14

- [x] 24a · `docs/mainstreet-ai/integrations/cleancloud_data_strategy.md`
- [x] 24b · `docs/mainstreet-ai/integrations/cleancloud_pipeline.md`
- [x] 24c · `docs/mainstreet-ai/agentic_owner_assistant.md`
- [x] 24d · Hand to user for review → Phase 25 build plan awaits user go-ahead


## Phase 24-rev (2026-05-14) — daily pull + POS migration redesign

User direction: "지금으로썬 daily pull하는게어때? ... 영업 종료 후 한번, 중간에 한번 ... POS만들꺼라서 나중에 Data migration을 할것도 염두해야해."

- [x] 24b-rev · Update `cleancloud_pipeline.md` — insert Stage 0 (daily pull 2x/day, no webhooks) before existing Stage 1; recommend Stage 0 as P0 launch; explain when to graduate to webhook stage and what triggers it
- [x] 24b-rev · Add new section "POS-future-proof schema" — rename `cc_*` tables to vendor-neutral names (`customers`, `orders`, `payments`, `products`), introduce `external_refs` mapping table, document migration path (CleanCloud adapter → DropShop POS adapter)
- [x] 24a-rev · Update `cleancloud_data_strategy.md` — adjust §5 mirror-target table names, add cross-reference to vendor-neutral schema, drop "webhook is P0" framing from §1 TL;DR
- [x] 24c-rev · Update `agentic_owner_assistant.md` — tool catalog references must use neutral table names; add freshness-display nuance ("as of last pull at HH:MM" instead of "N minutes ago")
- [x] 24-rev · Refresh "questions for friend" list — remove "activate webhooks" + "confirm 8 webhook names"; keep retention page screenshot, B2B, locker, mobile-app usage
- [x] 24-rev · Checkpoint + send updated doc bundle to user


## Phase 24-rev2 (2026-05-14) — single daily pull + NYC + tablet-only

User direction: "일단 daily pull 한번 하는걸로 하자. NYC, 테블랫 앱."

- [x] 24b-rev2 · Update `cleancloud_pipeline.md` — collapse 11:00+22:00 dual-pull into single 03:00 America/New_York pull, update overlap window to 28h (24h business day + 4h buffer), update API budget math, update friend-question list to drop timezone (now confirmed NYC)
- [x] 24a-rev2 · Update `cleancloud_data_strategy.md` — adjust §5 mirror-target trigger column, update §7 friend-questions list (NYC confirmed, app=tablet POS only)
- [x] 24c-rev2 · Update `agentic_owner_assistant.md` — adjust freshness wording to "data as of last pull at 03:00 ET" + note that mid-day "today's revenue" type queries route through fast-path tools
- [x] 24-rev2 · Draft friend-facing KakaoTalk-style question batch (3 remaining items: retention page screenshot, B2B accounts, locker service)
- [x] 24-rev2 · Checkpoint + deliver updated bundle + friend-message draft + ask user whether to start Phase 25a code work


## Phase 25a (2026-05-14) — Vendor-neutral mirror schema + CleanCloud adapter + daily 03:00 ET pull

User direction: "걍 나한테 상담해 내가 admin 계정 가지고 있어. 진행시켜"

All items completed — see "Phase 25a — done 2026-05-14" section below for the truth-of-record.

- [x] 25a-1..25a-9 · Implementation done (32 vitest pass)
- [x] 25a-7 · Heartbeat cron registered: `dropshop-cleancloud-daily-pull` at 0 0 8 * * * UTC (= 03:00 ET); task_uid 3kzaRy73L7wQ9M4D9DyL3B; first execution 2026-05-15 confirmed successful
- [ ] 25a-10 · retention/B2B/locker answers — pending user input


## Phase 25a — done 2026-05-14

- [x] vendor-neutral schema (`posCustomers` / `posOrders` / `posPayments` / `posProducts` / `posExternalRefs` / `posSyncLog` / `posProductChanges`); migration `0010_pink_firebird.sql` applied
- [x] `server/integrations/cleancloud/statusMap.ts` — int → neutral enum mapping (orders + payments)
- [x] `server/integrations/cleancloud/adapter.ts` — CleanCloud → neutral row converters with timestamp / E.164 / cents helpers
- [x] `server/integrations/cleancloud/db.ts` — idempotent ON DUPLICATE KEY UPDATE upserts + sync_log writes + product diff
- [x] `server/integrations/cleancloud/pullJob.ts` — 3-endpoint orchestrator with 28h overlap window, dependency-injectable for tests
- [x] `server/integrations/cleancloud/backfill.ts` — month-by-month historical seed (default 12 mo)
- [x] `server/integrations/cleancloud/scheduledHandler.ts` — `/api/scheduled/cleancloud-daily-pull` mounted in `_core/index.ts`
- [x] `posMirror` admin tRPC sub-router: `runDailyPullNow`, `runBackfill`, `syncStatus`
- [x] vitest: 32 new tests (statusMap 6 + adapter 20 + pullJob 6) — all green
- [x] full suite: 434 passed | 9 skipped (1 salon test deferred with comment)
- [x] Heartbeat cron registered + first execution confirmed (2026-05-16 08:00 UTC)
- [ ] retention / B2B / locker answers — folded in incrementally as user provides them
- [x] deploy already happened + cron live


## Phase 25b-recovery (2026-05-15) — sandbox-reset data loss

SUPERSEDED — Claude Code took on Phase 25c instead; Phase 25b was rebuilt directly in Manus sandbox. See `Phase 25b-rebuild — done 2026-05-17` below.

- [~] All 25b-rec items moot (alternate path taken)
- [x] 25c-prep · Draft Phase 25c blueprint (`docs/mainstreet-ai/phase25c_implementation_plan.md`)


## Phase 25c-pull (2026-05-15) — pull Claude branch into sandbox — done 2026-05-17

- [x] git fetch + checkout feat/25c-owner-assistant
- [x] verify tsc + vitest in sandbox (clean)
- [x] grep pullJob endpoint label ("getOrders" verified correct)
- [x] resolveFreshnessHint label match confirmed — no adjustment needed
- [x] pnpm db:push for ownerConversations + ownerMessages (live DB confirmed)
- [x] merge feat/25c-owner-assistant into main, push (commit aba7561c)
- [x] checkpoint aba7561c saved

## Phase 25b-rebuild — done 2026-05-17 (checkpoint 2cbd0d08)

- [x] drizzle/schema.ts: dailyBriefings table aligned with live DB (13 cols); migration 0012 idempotent (IF NOT EXISTS)
- [x] server/analytics/dailyMetrics.ts (NYC business-day window 04:00-04:00 ET, top spenders, deltas)
- [x] server/briefing/dailyBriefing.ts (Korean LLM prompt, DI-friendly runner, fail-safe fallback row)
- [x] server/briefing/db.ts (latest/byDate/list helpers — folded into dailyBriefing.ts module)
- [x] server/briefing/scheduledHandler.ts (/api/scheduled/daily-briefing)
- [x] mount cron handler in server/_core/index.ts
- [x] briefing tRPC sub-router (latest/byDate/list/generateNow) — admin-gated
- [x] client/src/components/DailyBriefingPanel.tsx (hero card + history + manual regen)
- [x] add Briefing tab to Home.tsx (admin-only)
- [x] vitest: dailyMetrics 15 cases + dailyBriefing 15 cases (30 total, all green)
- [x] full suite 503 pass | 9 skip
- [x] Heartbeat cron `dropshop-daily-briefing` already live at 12:00 UTC daily; task_uid 5wdNx6YKseqreEiHJrGx9y
- [x] checkpoint 2cbd0d08 saved
- [ ] user clicks Publish so production picks up the new handler (next cron fire = 2026-05-17 12:00 UTC if published in time)


## Phase 25-verify (2026-05-17) — post-publish health + backfill + briefing

User direction (2026-05-17): "눌렀어. backfill 하고, 지금 AI summary 이거 작동 돼? 다 해. 클로드 코드 시킬 todo 만들어줘"

- [ ] 25v-1 · Production health probe — confirm `/api/scheduled/cleancloud-daily-pull` and `/api/scheduled/daily-briefing` return 200/401/405 (not 404) on dropshopai-vx45nyzf.manus.space
- [ ] 25v-2 · Trigger backfill 12 months — either (a) sandbox hits production scheduled handler, or (b) instruct user to click `posMirror.runBackfill({monthsBack: 12})` in admin UI
- [ ] 25v-3 · After backfill rows land in `posOrders` / `posCustomers` / `posPayments`, trigger `briefing.generateNow` and inspect Korean LLM output
- [ ] 25v-4 · Author `docs/mainstreet-ai/claude_code_prompts/phase25d_admin_mirror_dashboard.md` — self-contained prompt
- [ ] 25v-5 · Checkpoint + push + report status to user
