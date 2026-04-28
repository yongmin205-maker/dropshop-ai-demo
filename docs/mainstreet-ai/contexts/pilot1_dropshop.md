# DropShop AI — Project Context

> **Read this file at the start of every session before doing anything else.**
> Manus context windows get compacted; this file is the source of truth that survives.

Last updated: 2026-04-26 (folder migrated into mainstreet-ai/)

---

## Project owner
- **Yongmin** (formerly Meta, exploring Front-End Developer / agent product roles)
- Building this as a real pilot, not a portfolio piece. Goal: deploy to a real laundromat (DropShop) and prove deflection rate.

## The pilot business — DropShop
- New York City dry-cleaning / laundromat (independent, not chain — aligns with Yongmin's "small business engagement" preference).
- Customer-facing brand: **DropShop** (visitdropshop.com).
- Friend (operator) handles all inbound customer SMS today.
- High volume of repetitive questions: "Where is my order?", "What time do you close?", "Quote for zipper repair", "Membership pricing", etc.

## Friend's existing stack (DO NOT replace — we shadow-forward only)

### POS — CleanCloud
- URL: https://cleancloudapp.com/login
- Test login: **REDACTED — see `~/sensitive/creds-pilot1-dropshop.md` (git-outside) or Notion private page**
- After login: click **"CleanCloud Test"** workspace.
- Holds: customer records, orders (with statuses), pricing, membership info.
- Our `mockCleanCloud.ts` is a faithful mock of this — same field shapes, same 4 order statuses, same membership tiers.
- Production integration path: CleanCloud REST API (need to research auth + rate limits when we go live).

### SMS / Messaging — Nextiva (NextOS)
- URL: https://auth.nextos.com/Platform/login?goto=https%3A%2F%2Faccopros.nextos.com%2Fapps%2Fnextiva-connect%2F%23%2F
- Login: **REDACTED — friend's real operator account; see `~/sensitive/creds-pilot1-dropshop.md` or Notion private page**
- After login: click **"Messaging"** in the left nav.
- This is where ALL inbound customer SMS arrives today. Friend reads + replies manually here.
- We need to figure out: does Nextiva expose an outbound webhook (push to our endpoint on every inbound) or only polling/API pull?
- Critical constraint: **we must NOT disrupt the friend's normal workflow**. Shadow mode only — we receive a copy, generate a draft, friend never sees us in their UI unless they want to.

## Shadow-mode integration plan (the actual ask)
1. Forward Nextiva inbound SMS → our `POST /api/shadow/inbound` endpoint.
2. We process through the same pipeline (intent → mock-CleanCloud-API → draft generation → RAG retrieval) but **never call sendSms** — `shadowMode: true` flag on the conversation.
3. Drafts land in a separate "Shadow Drafts" tab in our admin UI so we can compare our reply vs. what the friend actually sent.
4. Goal: prove deflection accuracy + response quality without any risk to the friend's customers.

## Our prototype (`dropshop-ai-demo`)
- Path: `/home/ubuntu/dropshop-ai-demo`
- Live: https://dropshopai-vx45nyzf.manus.space
- Stack: React 19 + Tailwind 4 + Express + tRPC 11 + Drizzle (MySQL) + Manus OAuth + Twilio (live-mode behind env flag).
- Phases 1–9 shipped (HITL approval queue, RAG memory, PII redaction, transactions, idempotency, signature validation, rate limits, customer profiles, error logging admin tab, etc.).
- Test suite: 135 vitest passing across 25 files. tsc 0 errors.

## Workflow rules with Yongmin (preferences)
- **Casual conversational tone**, not corporate. 친구한테 설명하듯이.
- Ask for clarification rather than guessing — especially for vague terms.
- Update this `CONTEXT.md` AND mirror to Notion any time we learn something durable about the friend's stack, the deal terms, or strategic direction.
- Quality > cost. Prefer clean, premium solutions.
- Security review on every infra change. Conservative on infra requirements.

## Latest research finding (2026-04-26)

**Nextiva does NOT expose inbound SMS webhooks.** Confirmed via Zapier integration page — only `New Missed Call`, `New Received Call`, `New Voicemail`, `New Contact` triggers exist; **no `New SMS Received`**. NextOne/Connect (the product the friend uses) is separate from Nextiva Contact Center (NCC) which does have webhooks.

→ Shadow forwarding from Nextiva is not directly possible. Decision matrix:

| Option | Friend risk | Effort | Decided |
|---|---|---|---|
| **A. Migrate friend to OpenPhone** (Twilio-based, native webhooks, $19/mo unlimited SMS) | Low — better SMS app, same number | Medium (port 5–10 days, no code) | **Pending friend OK** |
| B. Email forwarding (if Nextiva sends SMS-arrival emails) | 0 | Low | Backup plan |
| C. Browser RPA polling Nextiva UI | 0 | High, fragile | Not pursued |
| D. Manual paste demo page | 0 | Low | MVP fallback |

Proposal already drafted: `pilots/pilot1_dropshop/proposals/openphone_migration_pitch.md`. Owner will mention OpenPhone to friend casually rather than send the proposal as-is.

## Open questions / next session
- Friend's reply on OpenPhone migration → if yes, build `/api/shadow/inbound` + Shadow Drafts tab in dropshop-ai-demo.
- DropShop's actual phone number(s) to whitelist for shadow forwarding.
- Retention policy for shadow conversation data (PII concern).
