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
