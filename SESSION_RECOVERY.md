# Session recovery — read this if you are a new Manus/Claude session

If the previous Manus session was lost and you only have this GitHub repo, read the files below in order. Everything strategic is in-repo; the only things that are NOT in-repo are live third-party credentials (see § Credentials below).

## 1. What this project is — one paragraph

DropShop AI is a human-in-the-loop SMS concierge built as **Pilot 1** of the MainStreet AI program (turning Meta-FDE-style engagement inward to independent small businesses). The deployed prototype at `https://dropshopai-vx45nyzf.manus.space` receives customer SMS via Twilio, generates an AI draft, and requires Owner approval before sending (HITL default ON). The friend operates a real DropShop Tailoring business on CleanCloud POS + Nextiva SMS today; integration is planned in shadow-mode first (no customer-facing risk) — see `docs/adr/0007-shadow-mode-for-real-store-integration.md`. A second pilot (Salon AI Scheduler) is in the proposal stage — see `docs/mainstreet-ai/contexts/pilot2_salon.md`.

## 2. Read these four files first

1. **`docs/mainstreet-ai/README.md`** — master index of both pilots + owner preferences.
2. **`docs/mainstreet-ai/contexts/pilot1_dropshop.md`** — Pilot 1 (this project) context: the friend's real stack, shadow-mode plan, latest research (Nextiva webhook gap → OpenPhone migration proposed).
3. **`docs/adr/README.md`** — eight ADRs covering every non-obvious design decision (HITL default, Two-Phase Send, originGuard, MMS critical, embedding fallback, OAuth, shadow-mode, MessageTransport).
4. **`UBIQUITOUS_LANGUAGE.md`** — domain vocabulary and the four ambiguous terms that trip up new contributors (User vs Owner vs Customer; Reply vs Draft vs Outbound; Send overload; Mode overload).

## 3. Then read these for execution state

- **`todo.md`** — Phase 1–18 complete history with rationale per phase. Treat as the session log.
- **`CODE_AUDIT.md`** — current refactor candidates with Ousterhout vocabulary (Module / Interface / Depth / Seam / Adapter). § 5.3 names the three next-round candidates.
- **`ROBUSTNESS_AUDIT.md`** — earlier robustness review (retained for history; most items closed in Phases 5–9).

## 4. Current architectural seams (from Phase 18)

- **`server/messaging/transport.ts`** — `MessageTransport` interface with `TwilioAdapter`, `SimulatorTransport`, `ShadowGuardTransport`. *Defined but not yet consumed by the three live call sites*; migration triggered by OpenPhone integration per ADR 0008.
- **`server/originGuard.ts`** — CSRF defense for tRPC mutations. Uses Manus-host suffix policy because the Manus reverse proxy rewrites `Host`. Logs `[originGuard] fallback-used` in production as the trigger to tighten to explicit `ALLOWED_ORIGINS` once domain stabilizes (ADR 0003).

## 5. How to resume development

```bash
git clone https://github.com/yongmin205-maker/dropshop-ai-demo
cd dropshop-ai-demo
pnpm install
# Tests (should pass 37 files / 279 tests on Phase 18 head):
pnpm vitest run
```

Live deployment is managed via the Manus Management UI. The last deployed checkpoint is recorded as the latest commit message in `main`; to look back, `git log --oneline` shows every checkpoint (each `Checkpoint:` commit corresponds to a `webdev_save_checkpoint` in the Manus session).

## 6. Credentials — NOT in this repo

Two real third-party logins exist and are NOT checked in:

- **CleanCloud** (`yongmin205@gmail.com` test account) — the owner's own POS test login.
- **Nextiva NextOS** (`care@visitdropshop.com`) — the friend's live operator account for all customer SMS.

Both are stored in the sandbox at `~/sensitive/creds-pilot1-dropshop.md` (chmod 600, outside git) and mirrored to the owner's Notion private page. If a new session does not have sandbox access, the canonical copy is on Notion. If these credentials are leaked, rotate immediately per the "Protocol if these leak" section of the sensitive file.

## 7. Owner preferences

- Casual, conversational tone. 친구한테 설명하듯이, not corporate.
- Ask for clarification rather than guessing when terms are ambiguous.
- Prefer quality > cost; premium solutions over cheap ones.
- Security review on every infra change; conservative on infrastructure assumptions.
- Update this file and the Notion recovery page whenever something durable about the friend's stack, the deal terms, or strategic direction is learned.

## Custom-domain cutover checklist (run BEFORE flipping DNS)

The deploy currently rides the `originGuard` suffix fallback (`*.manus.space` / `*.manus.computer`, ADR 0003). The moment DNS moves to a custom domain — e.g. `app.visitdropshop.com` — every Approve mutation will 403 unless `ALLOWED_ORIGINS` has been set to that origin first. Run this checklist in order. Each step is verifiable.

1. **Decide the canonical origin string.** Pick the exact `scheme://host[:port]` you'll bind, e.g. `https://app.visitdropshop.com`. No trailing slash. If you need to support staging plus prod, list both — `ALLOWED_ORIGINS` is comma-separated, exact-match per entry (`https://app.visitdropshop.com,https://staging.dropshop.ai`).
2. **Set `ALLOWED_ORIGINS` via the Manus webdev secrets UI.** Save against the production environment. Do NOT push it through code — it's an env-only knob. The value is read at request time (getter on `ENV.allowedOrigins`), so a hot-env reload picks it up without a redeploy.
3. **Deploy.** Same checkpoint, no code change required — the env-var change alone suffices.
4. **Run the diagnostic against the live URL.** From a sandbox shell with the same env values:
   ```bash
   tsx scripts/verify-origin-config.ts
   ```
   Confirm the bottom line reads `READY FOR CUSTOM DOMAIN: yes` and the canonical origin probe shows `[ALLOW]`. If it shows `[DENY]` or "no", stop and fix the env value before flipping DNS.
5. **Verify Approve from the new domain succeeds.** Using a logged-in Owner session bound to the new origin, click Approve on a draft. Expect 200, not 403. If it 403s, the most common causes are a trailing slash in `ALLOWED_ORIGINS`, a wrong scheme (`http://` vs `https://`), or a cookie scoped to the old domain.
6. **Watch the logs for `[originGuard] fallback-used`.** The fallback warn fires ONLY when the suffix policy is approving requests. After the env is set correctly, those warnings should stop. If they keep coming, the env is being read as empty — `ALLOWED_ORIGINS` was applied to the wrong environment, or the deploy didn't pick it up.
7. **Only THEN remove the old origin.** If you're keeping both `manus.space` and the custom domain live during a soft cutover, leave the manus.space entry in `ALLOWED_ORIGINS` until the friend has been on the custom domain end-to-end for a day. Once you're confident, drop the old origin and rerun step 4.
8. **Update this file's § 4** if the architectural seam moved (e.g. custom-domain bound, ADR 0003 follow-up closed).
