# Phase 25-verify · Claude Code prompt — Backfill review and fix (multi-agent)

You are working in the repo `dropshop-ai-demo` (path: `/home/ubuntu/dropshop-ai-demo`). Branch off `main` as `phase/25v-backfill-review-fix`.

## Why you're being called

Manus rewrote `server/integrations/cleancloud/backfill.ts` to fix three production bugs that caused the first 12-month historical backfill to write 0 rows:

1. CleanCloud `getCustomer` rejects date-range windows longer than 31 days. The old code used a single 12-month window → `{"Error":"Date Range can not be longer than 31 days"}` → 0 customers.
2. CleanCloud `getOrders` returns HTTP 200 with `{"Error":"Requesting too many orders in one request..."}` once the window exceeds an undocumented per-store cap. On a busy NYC dry-cleaner the cap kicks in around ~7 days. The old code used 1-month windows → every month bounced → 0 orders.
3. The old backfill had no `getProducts` call at all → product mirror stayed empty.

The rewrite uses 30-day customer windows, 7-day order windows with adaptive bisection on the cap envelope, and a single `getProducts` call. Vitest passes (8 new cases, full suite 513 / 9 skipped, tsc clean) but no end-to-end run has been executed against production yet, and Manus is not 100% confident the rewrite is safe to point at the friend's live store.

**Your job is to (a) review and (b) fix anything that's wrong before we re-run it for real.** You must use parallel sub-agents (Anthropic's `Task` tool / sub-agents — exact mechanism per your environment, but the contract is: 3 separate review passes that read the same code with different lenses, then a lead pass that merges and ships).

## Hard constraints

- Do **not** invent new endpoints or new tables. The mirror schema (`posCustomers`, `posOrders`, `posPayments`, `posProducts`, `posProductChanges`, `posSyncLog`) is fixed and other code already depends on it.
- Do **not** change `server/messaging/cleanCloudTransport.ts` request shape unless you find an actual transport bug — the daily `runDailyPull` job already uses it in production and works.
- Every `posSyncLog` row that gets a `startSyncLog` MUST get a matching `finishSyncLog`. The original bug left 13 rows with `finishedAt = NULL`; that regression is the single most important thing to keep dead.
- Backfill must be **idempotent** — every upsert is keyed on `(source, externalId)`, so re-running 12-month backfill on top of existing data must be safe (no dupes, no FK explosions).
- Backfill must be **resumable** — a partial failure (e.g., one bad week) must leave earlier weeks intact and surface the failure in `posSyncLog`, not throw out of the procedure.
- The whole job must finish well under Cloud Run's 180s request timeout for a 12-month run on a store doing ~50 orders/day. If it can't, propose moving it to a `manus-heartbeat` background job rather than expanding the request budget.
- Frontend trigger lives in `client/src/components/PosMirrorPanel.tsx` (a temporary admin tab). The tRPC contract must stay `posMirror.runBackfill({ monthsBack: number }) → BackfillSummary`. If you change the return shape, update the panel and its test in the same PR.

## Files you'll be reviewing

| Path | Lines | Why it matters |
|---|---|---|
| `server/integrations/cleancloud/backfill.ts` | 351 | The rewrite under review |
| `server/integrations/cleancloud/backfill.test.ts` | 195 | New tests, may have gaps |
| `server/integrations/cleancloud/pullJob.ts` | — | Daily pull, do NOT regress |
| `server/integrations/cleancloud/db.ts` | 322 | `startSyncLog`, `finishSyncLog`, `upsert*` helpers — mirror DB contract |
| `server/integrations/cleancloud/adapter.ts` | 312 | CleanCloud → mirror row mappers; pure functions |
| `server/messaging/cleanCloudTransport.ts` | 379 | Transport layer — rate limiter, envelope decoding |
| `server/routers.ts` (lines around `posMirror`) | — | tRPC procedures the UI calls |
| `client/src/components/PosMirrorPanel.tsx` | — | The admin tab that triggers backfill |
| `drizzle/schema.ts` (`posSyncLog`, mirror tables) | — | Schema contract, do NOT change |

You are allowed to read any other file you want for context, but only modify files relevant to the backfill path.

## Operating mode — three sub-agents in parallel, then a lead pass

Spawn three sub-agents (or three sequential review passes if your environment can't parallelise; the deliverables are what matters). Each sub-agent gets the same repo state and the same constraints above, but a different brief. Do **not** merge or apply fixes during the sub-agent passes — they only produce structured findings. The lead pass aggregates and applies fixes.

### Agent A — Correctness reviewer

Lens: "Does this code match the actual semantics of the CleanCloud API and the mirror schema?"

Specifically check:

1. Window math in `rollingWindows`: are windows truly contiguous and non-overlapping? Is the final window correctly clamped to `to`? Does it ever skip a day (e.g., because `endOfDayUTC` produces `T23:59:59` and the next window starts at `T23:59:59`, so the next start is one second late)? Does it double-count the boundary day (next window starts at the previous window's end)?
2. `toCleanCloudDate` formatting: CleanCloud expects `"YYYY-MM-DD HH:MM:SS"` UTC. Confirm by reading the function in `pullJob.ts`. Confirm a window like `Date.UTC(2026,4,1,0,0,0)` … `Date.UTC(2026,4,8,0,0,0)` produces strings the API actually accepts.
3. `getCustomer` shape handling: when CleanCloud returns a single customer (single-ID mode) vs. an array (date-range mode), does our code (and the transport) consistently produce a `CleanCloudCustomer[]`? The backfill calls date-range mode only — confirm we never accidentally feed a single-customer envelope into `arr.map(adaptCustomer)`.
4. `getOrders` cap detection: the magic strings are `"too many orders"` and `"narrow or restructure"`. Are these stable enough? Should we additionally treat any `Error` containing `"limit"` or `"cap"` as bisectable? Be conservative — false-positive bisection just costs API calls; false-negative leaves us back at 0 rows.
5. Bisection floor: is `> 6h` (`ONE_DAY_MS / 4`) the right floor? Could a single 6-hour window for an extreme store still hit the cap? What's the failure mode if so?
6. Off-by-one between `monthsBack` and `overallFrom`: `startOfMonthUTC(now, monthsBack - 1)` — is that 12 months back or 11? Does the user's "12개월" expectation match what the code emits? Spell out the inclusive/exclusive contract.
7. Empty-success path: if `getOrders` returns `{Success:"True", Orders:[]}`, the transport returns `{ok:true, data:[]}` and the backfill writes 0 upserts but `windowsCompleted += 1`. Is that what we want? (Yes — but confirm it doesn't poison `monthsCompleted`-style downstream logic.)
8. Adapter null-filtering: `arr.map(adaptCustomer).filter(notNull)` — under what conditions does `adaptCustomer` return `null`? If a meaningful fraction of real-store customers fall through, the upsert count will lie about coverage. Read `adapter.ts` and grade the filter.

Output (Markdown):
- For each finding: severity (`blocker` / `should-fix` / `nit`), file + line range, one-paragraph explanation, suggested fix as a unified diff or pseudocode.
- A final "ship / hold" verdict with a one-sentence justification.

### Agent B — Robustness & runtime reviewer

Lens: "What happens when this runs against the actual production store for 12 months at 03:13 AM with a flaky network?"

Specifically check:

1. Total runtime budget: 12 months × ~52 weekly windows + 12 monthly customer windows + 1 product call ≈ 65 API calls, plus bisection multiplier (worst case 2–3× on busy weeks). Transport rate limit is 3 req/s. Is the worst-case wallclock under 180 s (Cloud Run request limit)? Show the math.
2. Cold-start failure: if the request times out at 180 s while the loop is in the middle of week 27, what's the DB state? (Some `posSyncLog` rows will have started but never finished because the Lambda was killed mid-await.) Propose either (a) lowering `monthsBack` defaults, (b) moving to a heartbeat-style background job, or (c) chunking with a "resumable cursor" stored in a new sync_log column. Recommend exactly one.
3. Concurrency: the global rate-limiter in `cleanCloudTransport.ts` is **module-level state** (`recentDispatches`). If two admins click "백필" simultaneously, both runs share the same rate slots — does anything bad happen? Does anything break in the upsert path under concurrent backfills (deadlocks, FK contention)?
4. Memory: each `getOrders` weekly call returns up to ~600 orders × `sendProductDetails:1`. That's potentially thousands of payment rows held in memory at once. Estimate per-week memory; flag if a 12-month run's peak heap could approach 256 MiB.
5. Error visibility: the bisection path writes `finishSyncLog(logId, { error: "bisecting (depth N): <msg>" })` to the *parent* row. Is this misleading in the UI (the row shows red but the work succeeded via children)? Propose a cleaner status — e.g., a new `posSyncLog.status` enum (`ok` / `bisected` / `failed`).
6. Retry/idempotency on transient HTTP 5xx: the transport's `postJson` retries throttle envelopes once. It does NOT retry generic 5xx. Should backfill itself retry the window once on `result.error` matching `^CleanCloud HTTP 5\d\d`?
7. Node timer / fetch leak: `setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)` — confirm the timer is cleared on the success path (look at `postJsonOnce`'s `finally`). If not, a 65-call backfill leaks 65 timers, which on a small Cloud Run instance is fine but worth noting.
8. Logging: the only operational telemetry is `posSyncLog` rows. Should we additionally emit `console.info`/`console.error` lines so the deploy-time logs show progress? Be opinionated.

Output (same Markdown structure as Agent A).

### Agent C — Test coverage auditor

Lens: "What real-world failure modes do the current tests miss?"

Specifically check:

1. The 8 existing tests in `backfill.test.ts`. Read them all.
2. Missing scenarios you should propose new tests for, at minimum:
   - Bisection that hits the depth limit and surfaces the cap error as a final failure.
   - A 6-month run (not just 1-month) to verify the loop counts customer/order windows correctly.
   - `getCustomer` returning a single object instead of an array (single-ID mode masquerading as date-range mode) — does the backfill survive?
   - Mid-run failure of `upsertOrders` (DB error) — is the sync_log finished with the right error string?
   - Concurrent `runBackfill` calls — does the rate-limiter serialise them, and do both produce sensible `posSyncLog` rows?
   - Adapter returning `null` for some rows — does `upserted` count match `rows.length` rather than `arr.length`? (Currently `summary.customers.upserted += upserted` uses the upsert return; verify.)
   - `now` set so `monthsBack` straddles a year boundary (e.g., now = Feb 2026, monthsBack = 12 → starts in Mar 2025) — `startOfMonthUTC` math.
3. For each missing scenario, write the actual `it("...")` block as a unified diff against `backfill.test.ts`. Don't just describe — produce code.

Output: ranked list (most-important-first) of missing tests, each with (a) one-paragraph rationale, (b) full `it(...)` block.

### Lead pass — merge findings, apply fixes, ship

After the three sub-agents complete:

1. Read all three outputs end-to-end. Resolve conflicts (Agent A says window math is fine; Agent C wrote a test that proves it's off-by-one — go with the test).
2. Triage findings: `blocker` → must fix in this PR; `should-fix` → fix unless it materially expands scope; `nit` → log as todo.
3. Apply the agreed fixes:
   - Modify `backfill.ts` (and only `backfill.ts` plus its tests, unless a finding genuinely lives in a sibling file).
   - Add the missing tests Agent C proposed for blocker/should-fix scenarios.
   - Update `client/src/components/PosMirrorPanel.tsx` only if the return shape of `runBackfill` changed.
4. Run the gauntlet:
   - `pnpm exec tsc --noEmit` — must be clean.
   - `pnpm test --run` — must be 100% green.
   - `pnpm test --run server/integrations/cleancloud/backfill.test.ts` — must show all new cases passing.
5. Append a `## Phase 25-verify (review pass)` section to `todo.md` under `/home/ubuntu/dropshop-ai-demo/todo.md` with `[x]` for fixes applied and `[ ]` for nits deferred.
6. Commit on the branch with this message format:

   ```
   25v: harden backfill (review pass)

   - Agent A (correctness): <one-line summary of fixes>
   - Agent B (robustness): <one-line summary of fixes>
   - Agent C (tests): +N new vitest cases, full suite NNN/NNN passing

   Deferred (nits): <comma-separated list>
   ```

7. **Do not** push or open a PR. Leave the branch local; Manus will checkpoint and the user will publish from the Manus UI.

## What "done" looks like

- A single commit on `phase/25v-backfill-review-fix` containing the merged fixes + new tests.
- A self-contained review report file at `docs/mainstreet-ai/reviews/phase25v_backfill_review.md` that includes:
  - Each sub-agent's full output (verbatim).
  - The lead-pass diff summary (what was applied, what was deferred, why).
  - A "ready for production re-run?" verdict (yes / no / yes-with-caveats) with caveats spelled out.
- `todo.md` updated.
- `pnpm test --run` green; `pnpm exec tsc --noEmit` clean.
- No changes outside `server/integrations/cleancloud/*`, `server/routers.ts` (only if absolutely needed), `client/src/components/PosMirrorPanel.tsx` (only if absolutely needed), `docs/mainstreet-ai/reviews/`, and `todo.md`.

## Quick context you'll want before you start

- Friend's CleanCloud store is real and live. Empirical caps observed by Manus during diagnosis:
  - `getOrders` 1d → 17, 3d → 159, 7d → 571, 14d → cap error.
  - `getCustomer` 30d → 47 customers; > 31d → "Date Range" error.
  - `getProducts` (no date) → 95 products.
- Daily pull (`runDailyPull` in `pullJob.ts`) runs at 12:00 UTC = 07:00 ET, against the same store, and works. Use it as a known-good reference for the per-call shape.
- The backfill is gated behind `adminProcedure` and triggered manually from the "POS 미러" admin tab. There is no public-facing surface to abuse.
- After this PR ships and the user re-runs the 12-month backfill, the next deliverable is Phase 25d (full Admin Mirror Dashboard), prompt at `docs/mainstreet-ai/claude_code_prompts/phase25d_admin_mirror_dashboard.md`. The temporary `PosMirrorPanel.tsx` will be replaced there, so don't over-invest in its UX during this review.

## Tone

Be terse. No filler. If you find nothing wrong in a section, say "No findings." and move on. Manus will read every word.
