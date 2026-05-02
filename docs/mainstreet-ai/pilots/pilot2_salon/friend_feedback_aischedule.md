# Friend Feedback — Aischedule.pdf (received May 1, 2026)

> Source PDF: `/home/ubuntu/upload/Aischedule.pdf` (3 pages, friend's screenshot of current calendar app + 3 pain points in Korean)

## Page 1 — Current state screenshot

A salon's existing calendar app (iPhone, Square Appointments-like). May 17–23 week view. Bookings include "Yoon Yu — Mid-Long Haircut", "joonho lee — Short haircut", "taewan roh — Mid-Long Haircut", "Jocelin Su — all of color single process", "benjamin tso — Short haircut" (circled by friend), "Dami Kim — Mid-Long Haircut", "arden ham — Short haircut". Lunch block 1:00–2:00 PM every day. Multiple "Block" markers. The friend's circle around "benjamin tso" likely highlights a typical short slot causing scheduling fragmentation.

## Page 2–3 — Three problem statements

### Problem 1 — 15-min slot fragmentation
Current app lets customers book at 10:00 / 10:15 / 10:30 / 10:45 etc. This creates awkward 15- or 45-min gaps and wastes capacity. **Wanted feature:** an AI that analyzes current bookings and only surfaces *optimal* start times (e.g., only 3:00) to the next customer, so the day packs cleanly.

Goals:
- Minimize schedule whitespace
- Maximize booking density
- Optimize operating hours

### Problem 2 — Payment failures + payment options
Customers frequently fail to complete payment in-app, leading to unconfirmed bookings and lost revenue.

Wanted:
- Immediate retry guidance / alternate payment method when a charge fails
- Simpler checkout, fewer error states
- More payment options (Apple Pay, Venmo)
- Open question quoted verbatim: "결제시 현금결제 카드결제 반반하고 싶을때 한번에 설정해서 될수있을까?" → "When a customer wants to split payment 50/50 cash + card, can the app set this in one step?"

### Problem 3 — Multi-stylist package booking
When a package menu (e.g., **Haircut + Head Spa**) requires two different stylists (Haircut by A stylist, Head Spa by B stylist), the customer should be able to book the package as a single flow and the app should auto-find both stylists' available consecutive slots.

Example desired output:
- 1:00 PM — Haircut with A Stylist
- 2:00 PM — Head Spa with B Stylist

## Friend's closing note (translated)

> "You've correctly identified the problems currently happening, and most of the solution directions you're proposing are practical. If you keep adding and refining features in this direction, I expect a much more polished result. The 3 items shared above are additional ideas that came up while reading the review — please use them as reference."

## Implications for Pilot 2 build plan

1. **Smart-slot suggestion** (Problem 1) is the highest-leverage AI feature — directly competes with vanilla calendar apps. Should be the headline differentiator. Aligns with our existing `salonAgent.runGapFillerPipeline` work but reverses direction (forward-looking pack vs. backfilling cancellations).

2. **Payment** (Problem 2) is partially out of scope for the demo — Stripe + Apple Pay + Venmo + split-tender is a full payments pillar. For demo: scope to "show a graceful retry UI mock + accept Apple Pay via Stripe" and explicitly defer split-tender to a follow-up.

3. **Multi-stylist package booking** (Problem 3) is a constraint-solver problem. The "AI" angle: when customer texts "haircut + head spa Saturday afternoon", the agent (a) identifies both services, (b) queries each stylist's calendar, (c) proposes a paired slot ("1pm A / 2pm B"), (d) pushes one approval card to the owner that books both legs atomically.

All three problems share one through-line: **let the AI pre-filter the option space so customers and owners see only the good choices.** That maps cleanly onto the existing approval-queue pattern (AI proposes, owner confirms).
