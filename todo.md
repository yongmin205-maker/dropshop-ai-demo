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
