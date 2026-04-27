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
- [ ] Build `POST /api/shadow/inbound` endpoint with shared-secret auth + payload normalizer (deferred until friend OK)
- [x] Add `shadowMode` flag to conversations + shadowSource on messages (DB scaffolding only)
- [ ] vitest: shadow inbound auth gate, shadowMode draft-only contract (deferred)
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
- [ ] Update CONTEXT.md & Notion Pilot 2 page with sandbox URL once shipped (post-deploy step — pending user request)


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
- [ ] Final checkpoint
- [ ] Deliver to user with updated demo URL/checkpoint
