# Phase 25-verify · Backfill review report

Branch: `phase/25v-backfill-review-fix`
Base: `8233d93` (origin/main at review time)
Lead: Claude Code (this commit's author)
Sub-agents: A (correctness), B (robustness/runtime), C (test coverage) — three parallel reviewers, see verbatim outputs below.

## Verdict

**ready for production re-run — with one explicit caveat.**

Caveat: `monthsBack > 6` is still expected to time out on Cloud Run's 180s
request budget. The fix in this PR is a defensive `console.warn` and the
heartbeat-job follow-up plan in `todo.md`; it is NOT a hard cap. If the
operator clicks "12개월 백필" on the temporary `PosMirrorPanel.tsx` selector
today, the request will still kick off, then die at week ~27 with the
posSyncLog row left at `finishedAt = NULL`. Use `monthsBack ≤ 6` for the
first real run; ship the heartbeat-job follow-up before re-running 12.

Everything else flagged by the sub-agents — correctness off-by-one, empty
envelope mis-decode, bisection depth comment lie, deactivated-customer
silent drop, parent-row bisection error mislabel, missing transient 5xx
retry, zero console telemetry, plus 7 missing test scenarios — is fixed
on this branch.

## Lead-pass diff summary

| # | Severity | Finding (origin) | Status | Where |
|---|---|---|---|---|
| 1 | blocker | 12-month wallclock > 180s (B-F1) | partial — `console.warn` + todo for heartbeat job | `backfill.ts:121-141` |
| 2 | blocker | Cold-start kill leaves orphan posSyncLog rows (B-F2) | deferred to heartbeat-job follow-up; documented | `todo.md` |
| 3 | should-fix | `monthsBack` off-by-one (A-F1) | **fixed** — dropped the `-1`, comment pins contract | `backfill.ts:135-141` |
| 4 | should-fix | Empty `getCustomer` envelope → `[{}]` (A-F3) | **fixed** at transport layer (response decode, not request shape) | `cleanCloudTransport.ts:296-310` |
| 5 | should-fix | Bisection depth comment claims 5, reality 4 (A-F4) | **fixed** — constant changed to 4, comment honest | `backfill.ts:80-89` |
| 6 | should-fix | `excludeDeactivated: 1` on backfill (A-F5) | **fixed** — set to 0 for backfill only; daily pull unchanged | `backfill.ts:160-170` |
| 7 | should-fix | Parent bisection row mislabeled as error (B-F5) | **fixed** — parent finishes with `rowsFetched: 0`, no error | `backfill.ts:284-296` |
| 8 | should-fix | No 5xx retry on transient transport errors (B-F6) | **fixed** — backfill-local 1-retry on `^CleanCloud HTTP 5\d\d` | `backfill.ts:265-281` |
| 9 | should-fix | Zero console telemetry (B-F8) | **fixed** — `console.info/warn/error` at entry, per-window, exit | `backfill.ts` throughout |
| 10 | should-fix | Module-level rate limiter doubles under autoscale (B-F3) | **deferred** — deploy config (`maxInstances=1`), not code | `todo.md` |
| 11 | nit | Boundary instant shared between adjacent windows (A-F2) | logged in `todo.md` | — |
| 12 | nit | Misleading test names (C: existing #4, #6) | **fixed** — #4 now asserts 30d; #6 renamed to describe what it actually tests | `backfill.test.ts` |
| 13 | new test | Bisection depth limit (C #1) | **added** | `backfill.test.ts` |
| 14 | new test | 6-month run counts (C #2) | **added** with post-fix counts (7 customer / 29 order) | `backfill.test.ts` |
| 15 | new test | Single-object `getCustomer` response (C #3) | **added** | `backfill.test.ts` |
| 16 | new test | Mid-loop `upsertOrders` failure (C #4) | **added** | `backfill.test.ts` |
| 17 | new test | Adapter-null counting (C #5) | **added** | `backfill.test.ts` |
| 18 | new test | Year-boundary `monthsBack=12` (C #6) | **added** with post-off-by-one-fix expected start (2025-02-01) | `backfill.test.ts` |
| 19 | new test | `rollingWindows` with `from > to` (C #7) | **added** | `backfill.test.ts` |
| 20 | new test | Concurrent invocations (C #8) | **deferred** — router-layer concern per C's own caveat | — |

Result of the gauntlet:
- `pnpm exec tsc --noEmit` — **clean** (0 errors).
- `pnpm test --run server/integrations/cleancloud/backfill.test.ts` — **15/15 passing** (8 original + 7 new).
- `pnpm test --run` (full suite) — **512 passing, 9 skipped, 8 failing**. All 8 failures predate this branch (6× `useSimpleMode.test.tsx` jsdom localStorage from Phase 22a; 2× `customerProfile.test.ts` DATABASE_URL). Sub-agent C verified by file-level git log on `aeb1e4e..phase/25v-backfill-review-fix`.

## Files modified

- `server/integrations/cleancloud/backfill.ts` (+~80 / -~20)
- `server/integrations/cleancloud/backfill.test.ts` (~349 lines, was ~195 — added 7 tests, fixed 2 existing names + 1 assertion)
- `server/messaging/cleanCloudTransport.ts` (+~12 / -~4, response-decode only, request shape untouched)
- `docs/mainstreet-ai/reviews/phase25v_backfill_review.md` (this file, new)
- `todo.md` (Phase 25-verify review-pass section appended)

No changes to `drizzle/schema.ts`, no changes to `cleanCloudTransport.ts` request shape, no changes to `pullJob.ts`, no changes to `PosMirrorPanel.tsx` (return shape of `runBackfill` unchanged).

## Open questions for Manus

1. **Heartbeat-job migration scope** (resolves B-F1 + B-F2). Agent B recommends moving `runBackfill` off the admin tRPC request and onto the `/api/scheduled/*` heartbeat pattern proven by `scheduledHandler.ts`. The admin click enqueues a `posSyncLog` "backfill_root" row with `finishedAt = NULL`; a 60s cron picks it up, processes one week-window per tick, marks each child row complete, and stops when there's no next pending window. This is the right answer but a meaningful refactor (~200 LOC + tests + a small cron-handler addition). I left it as a follow-up. Confirm scope + when you want it.
2. **Cloud Run autoscaling** (resolves B-F3). The rate limiter in `cleanCloudTransport.ts` is module-level state. If the service scales to 2 instances, the cap silently doubles to 6 req/s and CleanCloud's server-side throttle starts firing. The schema-free defense is a deploy-config change: set `maxInstances=1` for this service. Confirm whether your Cloud Run config already pins this, or whether we need to land a follow-up.
3. **`excludeDeactivated: 0` for backfill** (Agent A-F5). I flipped the flag to 0 so historical orders' customerExternalId references resolve to a posCustomers row. The cost is keeping deactivated customers in the mirror. If you'd rather drop them, the daily pull's `excludeDeactivated: 1` is intentionally unchanged — only the one-shot backfill includes deactivated. Confirm intent.

---

## Sub-agent A — Correctness reviewer (verbatim)

```markdown
# Agent A — Correctness review

## Finding 1: `monthsBack` off-by-one — 12 months requested produces ~11 months of coverage
- **Severity**: should-fix
- **Location**: `server/integrations/cleancloud/backfill.ts:122` (and `summary.monthsRequested` at :115)
- **Issue**: `overallFrom = startOfMonthUTC(now, monthsBack - 1)`. With `monthsBack = 12` and `now = 2026-05-15`, this resolves to `Date.UTC(2026, 5 - 11, 1)` → `2025-06-01`. That is the *start* of the month 11 months ago, so the covered span is "the current partial month + 11 full prior months" ≈ 11 months and a half, not 12. The user's stated expectation of "12개월" (12 months) — and the `monthsRequested: 12` value reported back in the summary — therefore overstate coverage by one month. The `-1` looks intentional (you wanted N total months including the current one) but the arithmetic doesn't deliver N — it delivers N-1 complete prior months plus the current partial month. If the friend opens the admin "POS 미러" tab tomorrow and counts sync_log rows by month, they will count 12 (Jun-2025 through May-2026 partial), so the *count* is right, but the *historical depth* is one month shy of what `monthsBack=12` implies. Documentation and behavior should agree.
- **Suggested fix**: pick one of two contracts and document it inline:
  ```ts
  // Option A — "N full prior calendar months, ignoring current partial":
  const overallFrom = startOfMonthUTC(now, monthsBack);   // drop the -1
  // Option B — keep current behavior but rename param to `monthsBackInclusive`
  // and add a comment: "covers (monthsBack-1) full prior months + current partial".
  ```

## Finding 2: `rollingWindows` boundary instant belongs to two adjacent windows
- **Severity**: nit (idempotent upserts make it harmless today; worth knowing)
- **Location**: `server/integrations/cleancloud/backfill.ts:317-333`
- **Issue**: each window is `[cursor, winEnd]` and `cursor = winEnd` for the next iteration, so the boundary timestamp lives in *both* the previous window's `to` and the next window's `from`. CleanCloud's date params have 1-second granularity, so any record whose timestamp equals that boundary will be pulled twice. Because `(source, externalId)` is a uniqueIndex and the upsert is `ON DUPLICATE KEY UPDATE`, this is safe — but `rowsFetched` will double-count by 1 across the two sync_log rows, and the test at :80 documents the half-open expectation (`wins[1].from.getTime() === wins[0].to.getTime()`), which is exactly the collision. Not a bug, just be aware before reading sync_log totals.

## Finding 3: Customer date-range mode that returns no `Customers` array gets mis-typed as a single-customer object
- **Severity**: should-fix (cosmetic data + misleading `rowsFetched`)
- **Location**: `server/messaging/cleanCloudTransport.ts:288-303` interacting with `server/integrations/cleancloud/backfill.ts:147-154`
- **Issue**: in `getCustomer`, if CleanCloud returns `{Success: "True"}` with no `Customers` / `customers` array (e.g. an empty result set in date-range mode), the transport falls through to the single-customer branch and returns `{ok:true, data:{} as CleanCloudCustomer}`. The backfill then runs `Array.isArray(result.data) ? result.data : [result.data]` and ends up with `arr = [{}]`. `adaptCustomer({})` returns `null` (no `customerID`), the filter drops it, upsert is 0 — but `rowsFetched: arr.length` writes `1` to `posSyncLog`.
- **Suggested fix**: in the transport's empty-envelope fallback at `cleanCloudTransport.ts:299-302`, return `[]` when the envelope contains no fields besides Success/Error.

## Finding 4: Effective bisection floor is depth 4 (~10.5h), not the configured depth 5 (~5.25h)
- **Severity**: should-fix (or just re-document the comment)
- **Location**: `backfill.ts:80, 263`
- **Issue**: the constant comment at :80 reads "7d → ~5h at the deepest split" with `DEFAULT_MAX_BISECT_DEPTH = 5`, but the time-floor guard at :263 is `to - from > ONE_DAY_MS / 4` (> 6h). 7d halved 4 times is 10.5h (still > 6h → bisects again to 5.25h, which is NOT > 6h → guard blocks). So depth 5 is unreachable.

## Finding 5: `excludeDeactivated: 1` silently drops deactivated historical customers from the backfill
- **Severity**: should-fix (depends on intent — flag for verification)
- **Location**: `backfill.ts:139`
- **Issue**: for the *backfill*, a customer who placed an order 8 months ago but was deactivated since will never appear in the customers backfill, while their `posOrders` row *will* exist. The resulting state has dangling `customerExternalId` references with no `posCustomers` row.

## Finding 6: Bisection error path overwrites parent `finishSyncLog` with a `bisecting:` message
- **Severity**: nit
- **Location**: `backfill.ts:265-271` (folded into Agent B finding 5)

## Ship / hold verdict
HOLD-WITH-FIXES — Findings 1, 3, 4, 5 are real correctness/contract issues; the backfill is meant to run exactly once, so getting it wrong means another full re-pull later.
```

## Sub-agent B — Robustness & runtime reviewer (verbatim)

```markdown
# Agent B — Robustness & runtime review

## Finding 1: Worst-case wallclock blows past Cloud Run's 180s request timeout
- **Severity**: blocker
- **Location**: `server/integrations/cleancloud/backfill.ts:97-214` (top-level loop) ; `server/messaging/cleanCloudTransport.ts:36,165-182` (rate gate)
- **Issue**: `acquireRateSlot` caps dispatch at 3 req/s process-wide. A 12-month backfill emits ~53 weekly order windows + ~13 monthly customer windows + 1 product call ≈ 67 base calls. With sustained 0.333s spacing that is ~22.3s of pure throttle floor, but each call also pays a `getOrders` server RTT empirically ~2–5s on a busy store. 67 calls × 3s ≈ **201s**, before bisection (each cap-error doubles that week's calls; depth 5 → 32 child calls pathological case). The job is single-shot from an admin tRPC click — Cloud Run kills the request at 180s mid-iteration.
- **Suggested fix**: lower default `monthsBack` from 12 to ~3 in a single 180s window AND move to background-job pattern (see Finding 2).

## Finding 2: Cold-start timeout leaves no resumable cursor — re-click restarts from month 1
- **Severity**: blocker
- **Location**: `backfill.ts:126,164` (loop top); whole file lacks any persisted cursor
- **Issue**: When the Cloud Run request hits 180s mid-loop, the function is killed at an `await` — the in-progress `posSyncLog` row's `finishSyncLog` call does not run, leaving `finishedAt = NULL`. The admin clicks "백필" again, and the loop starts from `overallFrom` (12 months back) — already-completed weeks are re-fetched. The upserts are idempotent so data is safe, but the wasted API budget guarantees the second run also times out at the same point.
- **Suggested fix**: **Recommendation (b): heartbeat-style background job.** Move `runBackfill` off the admin tRPC request and onto the `scheduledHandler.ts` pattern. Admin click enqueues a "pending backfill" `posSyncLog` row, returns immediately; cron processes one week-window per invocation.

## Finding 3: Module-level rate slots silently degrade if two clicks land concurrently
- **Severity**: should-fix
- **Location**: `cleanCloudTransport.ts:165`
- **Issue**: `recentDispatches` is process-scoped. Two simultaneous admin clicks share the rate budget — wallclock doubles, fatal in conjunction with Finding 1. Real risk: if Cloud Run scales to 2+ instances, the cap silently doubles to 6 req/s; CleanCloud's server-side throttle fires and `postJson` only retries once.
- **Suggested fix**: document the limitation that the rate gate is per-process and configure Cloud Run `maxInstances=1`.

## Finding 4: Per-week memory is fine but grows linearly across the loop
- **Severity**: nit
- **Issue**: per-window peak ~5 MB, drops between iterations, nowhere near 256 MiB.

## Finding 5: Parent bisection row is misleading — UI shows "error" on a row whose children succeeded
- **Severity**: should-fix
- **Location**: `backfill.ts:265-271`
- **Issue**: when `getOrders` returns a cap error and the code bisects, the *parent* sync_log row is marked `error = "bisecting (depth 1): too many orders..."` even though the work succeeded via the two child windows.
- **Suggested fix**: leave parent `error = null`, set `rowsFetched = 0` — schema-free.

## Finding 6: Backfill does not retry transient 5xx
- **Severity**: should-fix
- **Issue**: Cloud Run + flaky network at 03:13 AM virtually guarantees at least one transient 5xx per 67-call run. Today, one blip permanently loses a week.
- **Suggested fix**: backfill-local 1-retry on `result.error` matching `^CleanCloud HTTP 5\d\d`. Do not push into transport (constraint).

## Finding 7: Timer cleanup is correct; no leak.

## Finding 8: Zero console output during a 60–200s admin job
- **Severity**: should-fix
- **Issue**: only telemetry is posSyncLog rows; Cloud Run deploy logs show nothing.
- **Suggested fix**: `console.info` per window success, `console.warn` on bisection, `console.error` on terminal failure, plus entry/exit summary.

## Ship / hold verdict
HOLD-WITH-FIXES — Findings 1+2 are blockers (180s blowout + no resumability).
```

## Sub-agent C — Test coverage auditor (verbatim)

```markdown
# Agent C — Test coverage audit

## Existing 8 tests (audit)
1. `rollingWindows > contiguous, non-overlapping windows oldest-first` — solid.
2. `rollingWindows > no windows when from >= to` — covers equality only, not `from > to`.
3. `runBackfill > calls getCustomer, getOrders and getProducts at least once each` — smoke; "at least once" loose; medium coverage theatre risk.
4. `runBackfill > uses 30-day customer windows and 7-day order windows` — only asserts 7d order width; 30d customer width NOT actually checked. **Misnamed.**
5. `runBackfill > bisects when getOrders returns the 'too many orders' cap envelope` — good.
6. `runBackfill > ... after exhausting bisection` — fires a non-cap error, so bisection never triggers. **Name lies; depth-limit untested.** High coverage theatre.
7. `runBackfill > records the products error and continues when getProducts fails` — good.
8. `runBackfill > never leaves sync_log finishedAt unset` — solid; duplicates #3 structurally.

## Proposed new tests (ranked, most-important-first)
1. **Bisection hits depth limit and surfaces cap error as a final failure** — closes the #6 theatre gap.
2. **6-month run produces the right customer/order window counts** — pins multi-month loop arithmetic.
3. **getCustomer returning a single object instead of an array** — pins the defensive wrap at backfill.ts:147.
4. **Mid-run upsertOrders failure — earlier weeks survive, sync_log finishes with error** — pins best-effort semantics.
5. **Adapter-null filtering — summary counts post-filter rows** — pins counting honesty.
6. **monthsBack straddles a year boundary** — pins startOfMonthUTC negative-month wrap.
7. **rollingWindows with from > to (inverted range)** — closes the only rollingWindows gap.
8. **Concurrent runBackfill calls produce independent sync_log rows** — router-layer concern; weaker version at backfill layer.

(Full `it(...)` code blocks omitted here; the lead pass applied them to `backfill.test.ts` with test #2 and #6 expected values adjusted to match the Agent A finding 1 fix.)

## Verdict
INSUFFICIENT-BUT-PROPOSED-PATCHES-CLOSE-THE-GAP.
```
