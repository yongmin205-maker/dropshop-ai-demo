# Smart Slot Scoring — Salon AI

> **What this doc is for:** explaining to the friend (and to any future engineer) **why our slot suggestion is the AI value-add**, not just another calendar grid. Read time: 60 seconds. Diagram + 1 example + 1 formula.

---

## The problem in one picture

What every other booking app does today: shows the customer **every legal 15-min start**.

```
Stylist A's day, after the first 3 bookings landed:

10:00  ████████████████████  Mid-Long Haircut
11:00  · · · · · · · · · ·   open
12:00  · · · · · · · · · ·   open
12:30  ████████████  Short Haircut
13:15  · · · · · · · · · ·   open
14:00  ██████████████████████████  Color
15:30  · · · · · · · · · ·   open
                    ↑
   Customer texts "45-min Short Haircut please"
   Most apps now offer: 11:00, 11:15, 11:30, 11:45,
                        13:15, 13:30, 15:30, 15:45 ...

   Customer picks "11:30" because it's a round number.
```

**Result after the customer picks 11:30:**

```
10:00  ████████████████████  Mid-Long Haircut
11:00  · · · ✗ ORPHAN GAP ✗  ← 30 min, too short for any service
11:30  ████████████████  NEW Short Haircut
12:15  · · ✗ ORPHAN ✗        ← 15 min, dead
12:30  ████████████  Short Haircut
...
```

**Two orphan gaps were just created.** They almost never get filled. Over a full day, ~3-4 of these gaps × 15-30 min each = **roughly one full slot of revenue lost. Every. Single. Day.**

---

## Our fix in one formula

Don't show the customer all legal starts. Show only the starts that **pack the day cleanly**.

```
score(candidate_start) = gap_BEFORE × 1.0  +  gap_AFTER × 0.6
                            ↑                     ↑
                  minutes between this        minutes between this
                  candidate and the           candidate's end and the
                  prior booking's end         next booking's start
```

**Lower score = better.** Surface only the top 3 lowest-score slots to the customer. Hide everything else.

---

## Why two different weights

- **`gap_before` is sandwiched** between two bookings — once we leave a gap there, no future booking can pick it up (too short to be useful). It's *dead capacity*. Weight = 1.0.
- **`gap_after` is open-ended** — the rest of the day is still uncommitted, a walk-in or another text-in customer can still consume that gap. It's *recoverable capacity*. Weight = 0.6 (half-discounted).

The 0.6 number is a starting heuristic. We can tune from real bookings later (could be 0.4 if walk-ins are common, 0.8 if text-only).

---

## Same example, scored

Customer wants **45 min**. Stylist A has the calendar above. We score every legal 15-min start:

| Candidate | Gap before | Gap after | Score | Surfaced? |
|---|---|---|---|---|
| **13:15 PM** | 0 min (touches end of 12:30 booking) | 0 min (45 min ends exactly at 14:00 start) | **0.0** | ✅ #1 "Best fit" |
| 11:00 AM | 0 (touches end of 10:00 booking) | 45 (until 12:30) | **27.0** | ✅ #2 "Also fits" |
| 15:30 PM | 0 (touches end of 14:00 color) | end of day | **30.0** | ✅ #3 |
| 11:15 AM | 15 | 30 | 33.0 | ❌ hidden |
| 11:30 AM | 30 | 15 | 39.0 | ❌ hidden |
| 11:45 AM | 45 | 0 | 45.0 | ❌ hidden |
| 13:30 PM | 15 | 0 | 15.0 | (would be #2 actually) |

(Reordering: 13:15 → 13:30 → 11:00 → 15:30 → ... we still cap at 3.)

---

## What the customer sees on their phone

Not a 96-cell grid. Just three cards:

```
┌─────────────────────────────────┐
│  1:15 PM  · Best fit            │  ← #1
│  Stylist A · Short Haircut · 45m│
│  [ Hold this slot · 3:00 ]      │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  1:30 PM                        │  ← #2
│  Stylist A · 45m                │
│  [ Hold ]                       │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  11:00 AM                       │  ← #3
│  Stylist A · 45m                │
│  [ Hold ]                       │
└─────────────────────────────────┘
```

Three thumb-taps, one decision. That's the whole experience.

---

## What the owner sees

A normal Approval Queue card (same UI we already built for the SMS pilot):

```
┌─────────────────────────────────────┐
│ 📅 Booking request — Sarah Park      │
│                                     │
│ Wants: Short Haircut (45m)          │
│ AI proposes: 1:15 PM with A stylist │
│ Why: 0-minute gaps on both sides    │
│ Hold expires: 2:34                  │
│                                     │
│ [ ✓ Approve ]  [ ✗ Reject ]         │
└─────────────────────────────────────┘
```

Approve = hold becomes a real appointment + the other 2 holds for this customer auto-release. Reject = re-propose.

---

## Why this is "AI", not just sorting

A static `ORDER BY proximity DESC` query on the day's bookings could surface the same 3 slots. The AI part is everything around the score:

1. **Service-to-stylist matching.** "Short Haircut" might be doable by A or C; "Color" only by B. The agent reads the customer's free-text, classifies the service, then computes scores per eligible stylist. (LLM step.)
2. **Customer history weighting.** Sarah has been to A 4 times in the last year. Even if score(B's slot) = 0 and score(A's slot) = 12, we promote A. (RAG retrieval over customer history.)
3. **Holiday / weather context.** "tomorrow" on a snow-day or holiday should warn instead of book. (Tool call to a weather/calendar API.)
4. **Natural-language intake.** "afternoon-ish, before the kids' soccer at 4" → AI parses 12:00–15:30 window before scoring. (LLM extraction.)

The score is the deterministic core; the AI is everything that decides **what's a candidate in the first place**.

---

## Implementation hooks (for the engineer)

- File: `server/salon/scoreSlot.ts` — pure function, no I/O, fully unit-testable.
- Tests: `server/salon/scoreSlot.test.ts` — pin the score-formula contract so we don't drift the 0.6 weight by accident.
- Caller: `salon.suggestOptimalSlots` tRPC procedure — fetches day's bookings + holds, generates 15-min candidates, calls scoreSlot for each, returns top 3.
- See also: `slot_hold_design.md` (sibling doc, TBD) for what happens to the 3 returned slots once the customer taps Hold.

---

## How to demo this in 60 seconds

1. Show the friend the "before" picture: booking grid with orphan gaps highlighted in red.
2. Say: "Other apps show your customer all 16 legal start times. They pick the round number. You lose 30 min × 4 times a day."
3. Show the "after" picture: 3 cards. Customer taps the green one.
4. Say: "Our AI hides 13 of the 16 options. Only the ones that pack your day. That's the difference."

Done.
