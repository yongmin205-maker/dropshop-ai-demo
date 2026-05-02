# Phase 22 — Detailed answers to the three open questions

This document expands the answers I gave too briefly in the proposal. It also records the user's answers so future sessions don't have to re-derive them.

---

## Q1. Default mode of the toggle

**User's answer:** Default to **Simple**. Important note: the end target is a **native iOS/Android app**, not a web dashboard. The simple mode design must already be one-thumb usable on a 375 × 812 phone screen — anything that doesn't fit that shape is the wrong shape.

**Implication for design:**

- Simple mode must use a **single vertical stack** at every breakpoint (mobile-first, no `lg:grid grid-cols-12` branch).
- Tap targets minimum 44 × 44 px (Apple HIG).
- The two primary actions — **Approve** and **Reject** — must be reachable with the right thumb without scrolling on a 6.1" iPhone.
- No hover-only affordances. Everything tap-revealed.
- The "Pitch deck" link, the live-mode badge, and the reset button move into a hamburger or a `…` overflow once we go native; for the web demo we keep them in the header but de-emphasize them.

---

## Q2. Smart Slot scoring — what does "score" actually mean?

I was too terse before. Here is the full picture.

### The problem (concrete example)

Stylist A's day before the new request comes in:

```
10:00 — booked (Mid-Long Haircut, 60 min)  → ends 11:00
11:00 — empty
12:00 — empty
12:30 — booked (Short Haircut, 45 min)     → ends 13:15
13:15 — empty
14:00 — booked (Color, 90 min)             → ends 15:30
```

A new customer texts: "Can I get a 45-min Short Haircut today?"

A naive 15-min calendar offers them every legal start: 11:00, 11:15, 11:30, 11:45, 13:15, 13:30 (and 15:30 onwards). Customer picks 11:30 because it's a "round number". Stylist A's day now ends up:

```
10:00–11:00 booked
11:00–11:30 ORPHAN GAP (30 min, too short for most services)
11:30–12:15 NEW BOOKING
12:15–12:30 ORPHAN GAP (15 min)
12:30–13:15 booked
... etc
```

That's two orphan gaps that almost certainly will never be filled. Day capacity wasted ≈ 45 min.

### The fix

Don't show the customer all legal starts. Show the customer **only the starts that pack the day cleanly**. Use a score:

```
score(start) = gap_BEFORE_this_booking + gap_AFTER_this_booking × 0.6
                   ↑                          ↑
            adjacency to prior booking   adjacency to next booking
            (lower = better)             (lower = better, weighted half)
```

Lower score = better packing. We return the top 3 lowest-score slots.

In the example above:

| Candidate start | Gap before | Gap after | Score |
|---|---|---|---|
| 11:00 | 0 min (touches 11:00) | 15 min (until 12:30 booking with 30min buffer = ends 11:45, so 45 free) | **0 + 27 = 27** ← best |
| 11:15 | 15 | 30 | 33 |
| 11:30 | 30 | 15 | 39 |
| 13:15 | 0 (touches end of 12:30 booking) | 0 (touches start of 14:00 booking) — actually 13:15 + 45 = 14:00 exactly | **0 + 0 = 0** ← perfect |
| 13:30 | 15 | 0 | 15 |

So the AI offers the customer **13:15** (perfect packing, score 0) and **11:00** (score 27) and **15:30** (after the color booking, score 0 + leftover).

Why weight gap_after at 0.6 not 1.0?
- "Gap before" matters more because that gap is *trapped* between two bookings — you'll lose it.
- "Gap after" is open-ended, you can still fill it later in the day with a walk-in.

### What the customer sees in the UI

Not a calendar grid with 96 cells. Just three cards:

```
┌─────────────────────────────┐  ← #1, score 0, "Best fit"
│ 1:15 PM                     │
│ A · Short Haircut · 45 min  │
│ [ Hold for 3 min ]          │
└─────────────────────────────┘
┌─────────────────────────────┐  ← #2, "Also fits well"
│ 11:00 AM                    │
└─────────────────────────────┘
┌─────────────────────────────┐  ← #3
│ 3:30 PM                     │
└─────────────────────────────┘
```

**The friend's app will hide all bad options.** That's the AI value-add.

### What the owner sees

A normal Approval Queue card (same component we already ship for SMS replies). The card shows the proposed slot + the customer + a one-tap Approve. Approve = confirm the hold + commit the booking. Reject = re-propose (or escalate).

---

## Q3. Ticketmaster-style hold/lock — full design

You asked: "lock 하는 방법은? 티켓마스터처럼." Yes, exactly that pattern. Here it is in our context.

### What Ticketmaster actually does

When you click a seat:
1. The seat is **soft-reserved** for you for ~5 minutes (a "hold").
2. Other browsers see it as gray/taken during that 5 min.
3. You have 5 min to enter card info and confirm.
4. If you confirm → hold becomes a real booking.
5. If you abandon / timeout → hold expires, seat goes back to green.

This is the only way to prevent two buyers from grabbing the same seat at the same time.

### Mapping to our salon

The "seat" is a `(stylist, start_time, duration)` tuple. The hold lifecycle is the same:

```
proposed → held (TTL 3 min) → confirmed (becomes appointment)
                          ↘ expired (auto)
                          ↘ released (manual / sibling-released)
```

### DB schema

```sql
CREATE TABLE salon_slot_holds (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  stylist_id  VARCHAR(64) NOT NULL,
  service_id  VARCHAR(64) NOT NULL,
  start_ts    BIGINT NOT NULL,        -- ms since epoch
  end_ts      BIGINT NOT NULL,
  customer_id VARCHAR(64),            -- nullable while AI is still proposing
  expires_at  BIGINT NOT NULL,        -- start_ts + ttl
  status      ENUM('held','confirmed','expired','released') NOT NULL DEFAULT 'held',
  created_at  BIGINT NOT NULL,
  -- For fast "is this slot already held?" query:
  INDEX ix_active (stylist_id, start_ts, end_ts, status, expires_at)
);
```

### TTL choice

**Recommendation: 3 minutes.**

- Long enough that the owner has time to glance, decide, tap Approve.
- Short enough that a forgotten hold doesn't waste a slot for the rest of the day.
- Mirrors the "you have 3:00 to checkout" pattern most users have already seen in event ticketing.
- Configurable via env (`SALON_SLOT_HOLD_TTL_SEC`, default 180).

### Atomic creation: how we prevent double-hold

In SQL terms, when we propose 3 slots and call `salon.holdSlot(slotId)`:

```sql
BEGIN;
SELECT 1 FROM salon_slot_holds
  WHERE stylist_id = ? AND status='held'
    AND expires_at > NOW()
    AND (start_ts < ? AND end_ts > ?)   -- overlap check
  FOR UPDATE;
-- if any row returned → reject the hold
INSERT INTO salon_slot_holds (...) VALUES (...);
COMMIT;
```

`SELECT ... FOR UPDATE` is the row-level lock. Two simultaneous hold attempts for the same slot → first one wins, second one sees the row, gets rejected, has to pick a different slot.

### No expiry cron needed

We never run a "delete expired holds" job. Instead, **every read query filters `WHERE status='held' AND expires_at > NOW()`**. Expired rows are simply ignored. We can run a daily cleanup if the table grows, but it's a hygiene job, not a correctness job.

### Sibling release on confirm

When the owner approves slot #1, we:
1. `UPDATE salon_slot_holds SET status='confirmed' WHERE id=#1`
2. `UPDATE salon_slot_holds SET status='released' WHERE customer_id=? AND status='held' AND id != #1`
3. `INSERT INTO salon_appointments ...`
4. All inside one `withTransaction`.

So the moment one of the 3 cards is approved, the other two are freed for other customers.

### What the demo viewer sees

Each of the 3 proposed slot cards has a tiny countdown:

```
┌─────────────────────────────┐
│ 1:15 PM · A · Short Haircut │
│ Held for you · 2:34 left    │  ← updates every second
│ [ Approve ]   [ Skip ]      │
└─────────────────────────────┘
```

If the owner is slow and the timer hits 0:00, the card grays out and shows:

```
│ Hold expired — re-propose?  │
```

Tapping "re-propose" calls `salon.suggestOptimalSlots` again with the latest day state.

### Security / abuse note

Because a hold takes a slot off the market, a bad actor could spam-hold every slot of a stylist's day. Mitigations baked in:
- Per-customer hold limit (max 3 active holds at once, enforced in `holdSlot`).
- Hold creation rate-limited per phone (5 per 5 min — reuses our existing rate-limit middleware).
- Holds are owner-approved before they become bookings, so even a flood of holds expires harmlessly within 3 min and never costs revenue.

---

## Recap — what's locked in

| Q | Decision |
|---|---|
| 1 | Default = Simple. Native-app target — design as a single-thumb mobile screen first. |
| 2 | Score = `gap_before × 1.0 + gap_after × 0.6`. Show top 3 lowest-score slots. Hide the rest. |
| 3 | 3-minute hold (env-overridable), `salon_slot_holds` table, `SELECT FOR UPDATE` on overlap, sibling-release on confirm, no cron — read-time filter. Per-customer 3-hold cap to prevent abuse. |

Ready to start building once you confirm.
