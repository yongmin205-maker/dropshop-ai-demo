# Pilot 2 — Salon / PT Scheduling AI (Research Notes)

Working notes file. Will be rewritten as a clean Notion page after research.

## Friend's Pain (verbatim from user)
- 미용실 운영 친구
- 평가 후보: Glow Genius, Phorest, Mindbody
- 핵심 페인: **중복 예약(overlap booking)이 안 됨**
- 예시: 펌 손님이 펌 굳히는 동안(idle time) 다른 컷트 손님 받을 수 있어야 하는데 시스템이 막음 → idle time 매출 손실

## Research Targets
1. Glow Genius / GlossGenius — overlap support 여부
2. Phorest — overlap support, interview/consulting 가능성
3. Mindbody — overlap support
4. Adjacent: Vagaro, Booksy, Acuity, Square Appointments, Fresha, Jane App


## Findings — GlossGenius

**Source**: https://glossgenius.elevio.help/en/articles/108- + /articles/667-

**Has overlap support? PARTIAL.**

- **Stylist manually scheduling**: Can freely double-book — system only shows a confirmation prompt. Many stylists already use this for processing time (perm, color, etc.).
- **Client self-booking online**: Blocked by default. Stylist must enable `Allow Processing Time Booking` in Settings + define `processingTime` per service. Then clients CAN book during another client's processing window IF there's enough room.
- **Processing time** = a built-in concept (e.g., 45 min perm where 30 min is hands-off). Service-level config.
- **Gap Time feature** also exists (post-service buffer for cleanup).

**Friend's pain interpretation**: Either (a) friend doesn't know about Allow Processing Time Booking, or (b) friend is on a different platform (Phorest/Mindbody) that lacks this granularity, or (c) the AI scheduler's manual prompt is too clunky to use during a busy day.

**AI agent edge candidates**:
1. *Auto-suggest* overlap slots when a client texts asking for a perm — "We have a 2pm perm slot, and we can also slip in your friend's haircut at 2:45pm during the perm processing time" (sells two appointments in one ask)
2. *Configure processing-time-by-service* automatically — friend just says "perms take 90 min total, 30 min hands-on at start, 30 min processing, 30 min hands-on at end" and AI sets up the service correctly
3. *Detect underutilized processing windows* and proactively text waitlist clients


## Findings — Phorest

**Source**: https://support.phorest.com/hc/en-us/articles/10407568273810

**Has overlap support? YES, but config-heavy.**

Phorest models services with three time fields:
- `Duration` — hands-on application time
- `Processing Time` — hands-off gap (color/perm sitting)
- `Finish Time` — final rinse/blowout

Three setup patterns the salon must choose per service:
1. **Back-to-Back** — no overlap possible
2. **A La Carte** — processing gap is "free" for another client to book
3. **Sandwich** — split appointment; middle block is free, both ends protected

Phorest also supports **per-staff duration overrides** + **multi-location chain library**.

### Catch
- The salon owner has to **correctly model every single service** with the right pattern. If a perm is set up as Back-to-Back (default for many services), no overlap is possible.
- Most stylists likely don't know which pattern to pick — friend's "annoying" complaint probably means services were set up wrong, OR the front desk doesn't know the calendar UI well enough to manually slot in overlap.
- The "second service must be added to the appointment to close the gap" UX is clunky.

### Friend mentioned Phorest does interview/consulting
This means we could potentially **partner / interview Phorest CSMs** to learn what salons struggle with most. Friend may have a contact there.

### AI agent edge candidates (Phorest)
1. **Service Setup Coach** — agent talks to owner: "Tell me about your perm service" → auto-generates the right A La Carte / Sandwich config and pushes it to Phorest API
2. **Real-time gap detector** — when a stylist's day starts, AI scans calendar for processing-time gaps and suggests waitlist clients to fill them
3. **SMS-based gap-fill** — "Hey Sarah, we have a 2:30pm slot opening for a 30-min cut while another client's color processes. Want it? Reply Y/N" (zero clicks for stylist)


## Findings — Mindbody

**Sources**:
- https://support.mindbodyonline.com/s/article/203253713 (Prep and Finish Time)
- https://support.mindbodyonline.com/s/article/I-Need-to-DoubleBook-My-Employees (Allow Staff Concurrency)

**Has overlap support? YES, two distinct mechanisms.**

1. **Prep and Finish Time** — same Phorest concept. Service has 3 blocks: Prep / Process / Finish. Process block shows in color and can be double-booked.
2. **Allow Staff Concurrency** setting — controls who can be double-booked and how many concurrent appointments are allowed per staff. Stronger than GlossGenius.

### Square Appointments Comparison
Multiple Reddit/community threads confirm: **Square Appointments does NOT support overlap at all.** "A single appointment slot can only be booked by one client." This is a competitive advantage point — if friend's competitor uses Square, they literally can't do this.

### Mindbody UX issues from reviews
- Operationally powerful but **interface is dated and complex**
- High learning curve — front desk staff often don't use overlap features even when configured
- Class overbooking FAQ admits: "Technically, the software cannot completely prevent this from happening if you allow [it]" — implying their state model has edge cases

### So summary across all 3
| Tool | Overlap (manual) | Overlap (online client) | UX friction |
|---|---|---|---|
| GlossGenius | ✅ confirm prompt | ✅ if "Allow Processing Time Booking" on | Low |
| Phorest | ✅ via service config | ✅ if A La Carte/Sandwich pattern | High (config-heavy) |
| Mindbody | ✅ via Concurrency | ✅ via Prep/Finish Time | High (dated UI) |

**They ALL technically support overlap.** Friend's pain is almost certainly a **configuration / UX problem**, not a missing feature.

→ This is actually GREAT news for our AI agent thesis: the feature exists but nobody can configure or operate it well. **AI agent that abstracts this away wins.**


## Findings — Adjacent tools (Vagaro / Booksy / Fresha / Jane / Square)

### Jane App (PT, chiro, acupuncture)
**Source**: https://jane.app/guide/online-double-booking + /guide/double-booking

- **Administrative double-booking**: just press 'D' in the schedule → appointments slide. Easiest UX in the market.
- **Online (client-initiated) double-booking**: requires Thrive plan + Rooms feature. Each shift gets a Room (treatment bed/space). System lets clients book different rooms in the same time slot.
- **Stagger Online Bookings**: per-staff setting, prevents two clients starting at the exact same time (e.g., physiotherapist starts patient A at 2:00, patient B at 2:15, manages both alternately)

→ This is the **gold standard model**. Salons would benefit massively from a Rooms/Stagger concept.

### Square Appointments
**No overlap support at all.** Single competitor where the feature literally doesn't exist. If friend's Mindbody alternative is Square, switching loses overlap entirely.

### Vagaro / Booksy / Fresha
- All support overlap via prep/finish time (similar to Mindbody/Phorest)
- Reviews mention double-booking is most often a **MISTAKE** (front desk error) → AI agent could prevent unintentional overlaps too
- Fresha: complaints about new client fees, poor support — owner trust low
- Booksy: marketplace-driven (clients find you via Booksy app), strong in beauty space

### Common pain themes from reviews
1. **Setup is too hard** — owners don't know which service config to use
2. **Front desk staff don't use overlap features** even when configured (training gap)
3. **Online booking widget UX is intimidating** — clients give up and call instead
4. **No proactive gap-filling** — empty slots stay empty even with a waitlist
5. **No-shows kill margins** — most don't enforce deposits
6. **Reschedule chaos** — when one client cancels, the gap doesn't auto-route to waitlist


## API Availability (critical for AI agent integration feasibility)

| Platform | Public API | Webhooks | Friendliness |
|---|---|---|---|
| **Mindbody** | ✅ Yes (https://developers.mindbodyonline.com) | ✅ Yes | Documented but reviewed as "inconsistent type definitions" |
| **Phorest** | ✅ Yes (https://developer.phorest.com) | ⚠️ Partial | Requires partnership / dev team. NOT easy self-serve |
| **Vagaro** | ✅ Yes — webhooks (https://www.vagaro.com/pro/updates/webhooks) | ✅ Yes | Designed for partners |
| **Jane App** | ⚠️ Limited integrations only | ❌ Not generally public | Closed ecosystem |
| **GlossGenius** | ❌ No public API | ❌ | Closed |
| **Square Appointments** | ✅ Square API | ✅ | Best DX of all |
| **Booksy** | ⚠️ Partner program only | ⚠️ | Closed-ish |
| **Fresha** | ⚠️ Partner program | ⚠️ | Closed-ish |

### Implications for our pilot
- **Mindbody and Phorest are the realistic targets** — both have APIs, both are big enough to have customer base for us to scale into.
- **Mindbody API** is the path of least resistance (no partnership gate, just signup).
- **Phorest** has a partnership gate but friend's "interview/consulting" hint may help us get fast-tracked.
- **GlossGenius / Jane** = no API → we'd have to be a SaaS replacement, not an add-on. Higher bar.

### So pilot strategy
**Phase 1 (1-2 weeks)**: Build standalone "Salon Schedule AI" demo with mock data (just like DropShop). No real platform connection.
**Phase 2 (2-4 weeks)**: Pick one platform (Mindbody if API self-serve OK, else Phorest with partnership intro). Build read-only integration to pull calendar.
**Phase 3 (1-2 months)**: Write-back integration (book appointments, send SMS confirmations).


## AI Agent Edges — Brainstorm

The research above shows that the **feature exists but UX/config kills adoption**. So our edge is not "build a new scheduler" — it's **"AI agent that operates the existing scheduler perfectly on the owner's behalf."** Below are the edges I think have the highest leverage, ranked by ROI for a single salon.

### Edge 1 — Overlap Slot Auctioneer (THE flagship)

When a client texts "Can I get a perm Saturday afternoon?", the AI:

1. Reads the calendar (e.g., already has a 2pm color appointment with 30-min processing gap)
2. Recognizes the perm has a 30-min hands-on application + 30-min processing + 30-min finish structure
3. Proposes: "Saturday 2pm! Sarah will start your perm at 2pm during another client's color processing — efficient use of her time. Confirm?"
4. Books the overlap **automatically** (Phorest A La Carte / Mindbody Prep+Finish / GlossGenius Allow Processing)

**Why this works**: The owner doesn't have to think about the 3D scheduling puzzle. AI does it. **Recovers 20-40% of "idle" hours that would otherwise be empty.** At $80/hour stylist rate, that's $200-400/day per stylist.

### Edge 2 — Gap Filler (proactive outbound)

Every morning at 8am, AI scans today's calendar for:
- Processing-time gaps (color/perm sitting time)
- Cancellation holes
- Late-day empty slots

For each gap, AI texts the **waitlist** ranked by:
1. Service that fits the gap duration
2. Repeat customer (LTV)
3. Recent message activity (engaged)

"Hi Lisa! We have a 30-min cut slot opening at 2:30pm today during another client's color. Want it?" → Y → auto-books.

**Why this works**: Most salons have a paper waitlist they never call. AI calls it for them. **Fills 5-15 extra appointments/week.**

### Edge 3 — No-Show Risk Score + Smart Deposit

For each booking:
- Score the client's no-show risk based on history (cancel rate, late rate, time-of-day pattern)
- High-risk: AI texts "Confirm with $20 deposit" the day before
- Low-risk: simple confirmation text

**Why this works**: 15-25% no-show rates are common in salons. Cuts revenue by ~20%. Smart deposits cut no-shows by ~60% without scaring loyal clients.

### Edge 4 — Service Setup Coach (one-time, high-trust onboarding)

AI interviews the owner once: "Tell me about your services. Tell me which ones have processing time."

Generates the correct Phorest/Mindbody service config and pushes via API. Owner doesn't have to learn the platform's terminology (A La Carte vs Sandwich vs Back-to-Back).

**Why this works**: This is the moment friend's pain probably starts — services were configured wrong on day 1, nobody fixed it, now overlap is impossible. **One-time fix unlocks every other edge.**

### Edge 5 — Upsell at Booking

When a client texts "Cut Saturday?", AI checks history:
- Last color was 6 weeks ago → "Cut on Saturday, sure. Want to add a root touchup? Last one was 6 weeks ago and we have time after your cut."

Or:
- New client → "Welcome! Want me to add a 15-min consultation so Sarah can plan your style first?"

**Why this works**: Stylists rarely upsell over text — too much typing. AI does it gently every time. **+10-15% avg ticket size.**

### Edge 6 — Reschedule Triage

Client texts "I need to move my Saturday appointment". AI:
1. Finds 3 alternative slots same week
2. Texts options
3. Confirms with one tap
4. Releases old slot back to Gap Filler queue

**Why this works**: Reschedules are 30% of inbound texts. Stylist spends 5-10 min/each. AI = 30 sec.

### Edge 7 — Multi-Service Bundling Detection

Client texts "Cut and color Saturday". Most schedulers block 3 hours straight.

AI knows color = 30 min app + 45 min process + 30 min finish, cut = 30 min. So it actually books:
- 1:00-1:30 color app (Sarah)
- 1:30-2:15 color process (Sarah free → can take another short client)
- 2:15-2:45 cut (Sarah)
- 2:45-3:15 color finish (Sarah)

While giving Sarah a 45-min "free" window during processing for another walk-in.

**Why this works**: Tightens 3-hour block into 2.25 hours of Sarah's time + sells the 45-min gap. **+1-2 extra appointments/day.**

### Edge 8 — Front Desk Whisperer (in-app suggestions)

When a stylist or front desk staff manually books, AI watches and suggests:
- "You're booking a perm at 2pm — you have 30 min gap during processing. Sarah's waitlist has Lisa for a cut. Want me to text her?"

**Why this works**: Catches missed opportunities even when humans book directly.

### Edge 9 — Day-of Calendar Optimizer

Each morning, AI proposes a "tightened" version of today's schedule:
- Move client A from 11am to 11:15am to leave a clean overlap slot at 11am
- Sarah's lunch shifted from 1pm to 1:30pm to align with a processing gap

Owner reviews and approves with one tap.

**Why this works**: Most owners don't optimize day-of. Just runs as scheduled. AI surfaces 1-3 high-value tweaks/day.

### Edge 10 — Lead Recovery for Unbooked Inquiries

When someone texts asking about availability and AI can't find a slot, **don't drop the lead**. AI puts them on a smart waitlist and texts them the moment a matching gap opens.

"Hey, you asked about a perm last week — Sarah just had a 2pm Saturday open up. Want it?"

**Why this works**: Most salons lose 20%+ of inquiries because they say "we're booked" and then never follow up.

---

## Combined Pitch (for friend)

"Imagine if your Phorest/Mindbody calendar managed itself. Every empty slot fills with a waitlist client. Every overlap sells two services in the time of one. Every no-show is prevented or covered. Your front desk just confirms — no clicks, no terminology, no setup pain. **You make 20-30% more revenue with the same hours and the same staff.**"

---

## Wedge Strategy (where to start)

We don't need to build all 10 edges. Pick the 1-2 with highest **demo wow factor** + **lowest integration cost**:

- **Edge 1 (Overlap Auctioneer) + Edge 2 (Gap Filler)** = the killer combo
- Both work off the same data (calendar + service config + waitlist)
- Both produce dramatic demo moments (text in → AI books an overlap nobody could see)
- Build mock-data version first (DropShop pattern), then integrate Mindbody API for live

---

## Demo Concept

Same split-screen as DropShop:
- **Left**: Customer phone simulator
- **Center**: Salon calendar (today's view, color-coded by stylist)
- **Right**: AI Log + "Smart Suggestions" panel showing the AI's reasoning

Preset scenarios:
1. "Can I get a cut Saturday at 2?" → AI finds overlap during another client's processing → books
2. "Cancel my Friday appointment" → AI cancels + immediately texts top 3 waitlist candidates → first Y wins
3. "Anytime next week for color?" → AI proposes 3 slots ranked by stylist productivity
4. Walk-in scenario: front desk types "Lisa just walked in for a cut" → AI checks calendar, finds an overlap slot AT 11:15 during a perm process, slots her in

---

## Open questions

- Does friend run a single-stylist or multi-chair salon? (Affects Edge 1 vs Edge 8)
- What % of bookings come via text/phone vs walk-in? (Affects which edges matter)
- What's friend's actual platform? (Need to confirm Phorest vs Mindbody vs GlossGenius)
- Can friend introduce us to Phorest's consulting/interview team for partnership?
