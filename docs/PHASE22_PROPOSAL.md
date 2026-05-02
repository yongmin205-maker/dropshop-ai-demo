# Phase 22 Proposal — Friend Feedback Response

**Date**: May 1, 2026
**Trigger**: Friend feedback (Korean) + `Aischedule.pdf` (3 problem statements for Pilot 2)

---

## Track A — DropShop "Simple Mode" toggle

### Friend's words (verbatim)
> "다 필요한부분이긴한데 만들때 진짜 좀 간편하고 필요없는부분들은 너가 만들려고하는앱에서 숨기기버젼 만들어서 심플하게 하면 좋을듯, 다른앱들 필요없는것들이 너무 많아"

**Translation:** "Everything is necessary, but when building, make a simple version that hides the unnecessary parts. Other apps have too many unnecessary things."

### Reading of the feedback
The friend is **not** asking us to delete features — they explicitly say "all necessary". They're asking for **a hide-by-default mode** so the daily user (a busy store owner texting between customers) sees only the one thing that matters: **the next reply to approve**.

This matches the dominant "minimal POS" pattern in mom-and-pop SaaS (Square's "tip-only" view, Toast's "expo mode", Twilio's Frontline). Operator looks at the screen, sees one card, taps Approve or Reject, moves on.

### Proposal: a `SIMPLE / FULL` mode toggle in the header
- New top-right toggle pill: `[Simple] [Full]` (default = Simple).
- Persisted in `localStorage` (`dropshop:viewMode`) so it sticks per-device.
- Owner can flip to Full whenever they want to see RAG memory, AI Log, escalations triage, etc.

### Simple Mode visible elements
| Element | Simple | Full |
|---|---|---|
| Header (logo, live-mode badge, Reset, Pitch deck) | ✅ | ✅ |
| Mode toggle | ✅ | ✅ |
| Demo Scenarios bar | ❌ hidden | ✅ |
| Phone Simulator pane | ❌ hidden | ✅ |
| Store Inbox pane | ✅ collapsed to single-column conversation list | ✅ full layout |
| Approval Queue | ✅ headline (now full-width center) | ✅ right-pane |
| AI Log tab | ❌ hidden | ✅ |
| RAG Memory tab | ❌ hidden | ✅ |
| Critical / Escalation count | ✅ shown only if count > 0 | ✅ always |
| Errors tab (admin) | ❌ hidden | ✅ |
| Embedding-degraded banner | ❌ hidden | ✅ |

**Rationale:** in Simple Mode the screen has exactly two regions: (1) "what came in" (inbox list), (2) "what should I send" (approval card). Everything else is one click away via Full mode.

### Implementation footprint (estimate)
- ~50 LOC in `Home.tsx` (new state + conditional render). No new files.
- Add `SimpleModeToggle.tsx` component (~30 LOC).
- 2 new vitest tests: (i) Simple Mode hides scenarios/RAG/log/errors tabs, (ii) toggle persists to localStorage.
- Zero behavior change to backend / approve / reject flow. Pure CSS reshuffle + conditional render.

---

## Track B — Salon Pilot 2 build plan (from Aischedule.pdf)

### What the PDF actually contains (3 pages)
- **p1**: Screenshot of friend's current calendar app (May 17–23 week view, ~7 stylists' bookings, lunch blocks). One booking circled.
- **p2–p3**: Three problem statements in Korean.

### Problem 1 — Smart slot suggestion
**Pain:** 15-min booking grid creates orphan 15- or 45-min gaps. Schedule fragments.
**Want:** AI looks at the day's bookings and proposes only optimal start times (e.g., "only 3:00") to the next customer, so the day packs cleanly.

**Build approach (demo):**
- New `salon.suggestOptimalSlots(serviceId, dayISO)` tRPC procedure.
- Server-side algorithm (no LLM needed): brute-force scan all 15-min starts in the day, score each by `(post_gap_minutes + pre_gap_minutes)` to current bookings; return top 3 lowest-fragmentation starts.
- New "Smart Slots" panel in the salon demo: customer texts "tomorrow afternoon haircut?", AI proposes 3 ranked slots, owner approves one, it commits via existing `salon.approveBooking`.
- Reuses the approval-queue pattern from Pilot 1.

### Problem 2 — Payment failures + payment options
**Pain:** Customers fail to complete payment in-app → unconfirmed bookings → lost revenue.
**Want:** Retry guidance, simpler checkout, more options (Apple Pay, Venmo), split-tender (cash + card 50/50).

**Build scope decision:**
- **In demo scope**: A "Payment status" mock card on each booking (paid / failed / retrying / awaiting). Mock retry UI ("Send Apple Pay link").
- **Out of demo scope, document only**: actual Stripe + Apple Pay + Venmo + split-tender integration. Punt to "Phase 23 — Payments pillar" once friend signs off on the architecture. Split-tender requires Stripe Connect Multi-capture + isn't a 1-day demo feature.

### Problem 3 — Multi-stylist package booking
**Pain:** "Haircut + Head Spa" package needs Stylist A then Stylist B. Customer can't book the chain in one flow.
**Want:** Single-flow booking that auto-finds consecutive slots for both stylists.

**Build approach (demo):**
- Extend `shared/salonScenarios.ts` with a `package` type that lists ordered legs (`[{service: "Haircut", stylist: "A"}, {service: "Head Spa", stylist: "B"}]`).
- New `salon.suggestPackageSlots(packageId, dayISO)` procedure: finds time windows where stylist A is free for leg 1 AND stylist B is free for leg 2 starting immediately after leg 1.
- Approval card shows both legs (e.g., "1:00 PM Haircut · A / 2:00 PM Head Spa · B"). One Approve button commits both legs atomically (existing `withTransaction` pattern).

### Pilot 2 build phases (proposed sequence)
1. **Phase 22b** — Smart Slot suggestion (Problem 1). Highest leverage, no payments dependency. ~1–2 days.
2. **Phase 22c** — Multi-stylist package booking (Problem 3). Builds on Phase 22b's slot-search primitives. ~1 day.
3. **Phase 23** — Payments pillar (Problem 2). Needs Stripe account, real keys, separate deploy story. 1+ week.

---

## Recommended execution order (combined)

**Right now → 1 hour → Phase 22a — Simple Mode** (Track A)
- Why first: smallest scope, biggest UX win, addresses the most recent friend feedback. Lets the friend see a "ready-to-use" simplified app on their next look.
- One Claude Code prompt, ~80 LOC.

**Then → 2–3 days → Phase 22b — Smart Slot suggestion** (Track B, Problem 1)
- Why second: highest-leverage AI feature in the salon pitch. Differentiates from generic Square/Calendly.
- One Claude Code prompt for backend + UI panel.

**Then → 1 day → Phase 22c — Multi-stylist package** (Track B, Problem 3)
- Why third: builds on Phase 22b primitives. Cheap once 22b lands.

**Defer → Phase 23 — Payments pillar** (Track B, Problem 2)
- Why last: requires real Stripe integration, cannot demo without keys, friend cares about scheduling first.

---

## Open questions for user before kicking off

1. **Simple Mode default**: Default to Simple (friend sees minimal on first load) or Full (friend sees the impressive demo with all panels)? My recommendation: **default Simple** for the friend's daily-use perspective; the pitch deck can screenshot Full mode separately.
2. **Smart Slot scoring weight**: should it prefer "minimal gap before" (fill the hole) or "minimal gap after" (leave a contiguous open block) when both are equal? My recommendation: prefer "minimal gap before" — fills holes first.
3. **Package booking commit semantics**: if Stylist B becomes booked between proposal and approval, should we (a) auto-fall-back to a different B-stylist, or (b) reject the approval with "B no longer available, re-propose"? My recommendation: **(b) reject and re-propose** — owner stays in control, no surprise reassignment.
