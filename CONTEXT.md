# DropShop AI — Project Context

> **Read this file at the start of every session before doing anything else.**
> Manus context windows get compacted; this file is the source of truth that survives.

Last updated: 2026-04-26

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
- Test login: `yongmin205@gmail.com` / `admin1234`
- After login: click **"CleanCloud Test"** workspace.
- Holds: customer records, orders (with statuses), pricing, membership info.
- Our `mockCleanCloud.ts` is a faithful mock of this — same field shapes, same 4 order statuses, same membership tiers.
- Production integration path: CleanCloud REST API (need to research auth + rate limits when we go live).

### SMS / Messaging — Nextiva (NextOS)
- URL: https://auth.nextos.com/Platform/login?goto=https%3A%2F%2Faccopros.nextos.com%2Fapps%2Fnextiva-connect%2F%23%2F
- Login: `care@visitdropshop.com` / `957Parkave!`
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

## Open questions / next session
- Confirm whether Nextiva Messaging exposes inbound webhooks (vs. only API polling). If webhook: 15-minute setup. If polling only: need a periodic job + dedup logic.
- Get DropShop's actual phone number(s) to whitelist for shadow forwarding.
- Decide retention policy for shadow conversation data (PII concern — even though we don't reply, we still store inbound text).
