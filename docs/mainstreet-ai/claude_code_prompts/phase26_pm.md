# Phase 26 PM — Owner Assistant Self-Correcting Loop

**Role:** Claude Code, PM hat. No code in this commit — product framing only.
**Branch:** `phase26/critic-loop` off origin/main `3714165`.
**Baseline:** 571 pass / 9 skipped / 8 env-gap (treated as skipped per user direction; `DATABASE_URL` + jsdom shims out of Phase 26 scope). `tsc --noEmit` clean.

## What we are changing & why

The current `server/ownerAssistant/` pipeline trusts the Planner's first answer. When the Planner mis-routes a question, we've been patching `planner.basePrompt` with one-line rules: dayOfWeek, fair-pace, "args 비우지 말라." That pattern is now ~5 rules deep and the model is starting to drop the older ones to satisfy newer ones. We replace heuristic prompt patching with a **plan → execute → critic → (replan if needed)** loop, capped at 2 critic passes (≤ 4 LLM calls total).

## Failure cases (locked PM set)

| # | Question (Korean) | Expected | Status |
|---|---|---|---|
| 1 | 지난 달 대비 이번 달 매출 어땠어? | `compareTimeWindows` `mode='fair-pace'` | Just-fixed in `8f3e333`. Critic must protect from regression. |
| 2 | 60일 이상 안 온 손님 알려줘 | `findInactiveCustomers` defaults | Stable. Critic must not over-trigger replan on legitimate zero-row results. |
| 3 | 최근 2주 동안 단골 손님 동향 | `aggregateRepeatCustomers` last-14d window, lookback 90 | Stable. |
| 4 | 지난 주 어떤 요일에 매출이 제일 높았어? | `aggregateRevenue` `groupBy='dayOfWeek'`, last 7 days | **Active failure.** Currently emits `groupBy='day'` + month-long window. The motivating case for this phase. |
| R | `topSpenderProfiles` showing externalId instead of name | `displayNameOf()` already pulls `name`/`phoneE164` | Just-fixed in `a7cccef9`. Synthesizer addressing rule; out of critic's direct path but tracked. |

Additional cases will be appended by **Manus's smoke transcript** (per user's option (c) procedure — Manus runs `scripts/smokeOwnerAssistant.mjs` locally and pastes raw output back). PM set may grow before Architect role starts.

## Metric the owner cares about

**Accuracy ≫ speed.** Owner Assistant is a deliberation tool (asked once when the owner sits down to review the day), not a chat surface. Brief §0 already permits ~30s budget. We trade today's ~5s for ~12–15s expected post-critic; that's well inside the envelope. Concrete trade-off accepted: **one critic pass costs ~3s; one replan costs ~5s. Worst-case happy path 4 LLM hops ~15s.** The UI's "분석 중…" indicator carries the perceived-latency cost.

## Success criteria (measurable)

- **4 canon PM questions** above: 100% pass on first critic check (no replan) once Phase 26 ships.
- **6 regression questions** (the 4 + topSpenderProfiles addressing + fair-pace partial-vs-full month): 100% pass after ≤ 1 critic-triggered replan.
- **p95 wall time** for the full agent loop ≤ 18s on Manus's live smoke.
- **Critic prompt size** ≤ 80 lines (Reviewer's red flag is 200; we set internal target lower so future contributors don't accumulate heuristics there).
- `planner.basePrompt` net **−15 to −30 lines** (the fair-pace + dayOfWeek + "don't emit empty args" heuristic blocks come out).
- Test surface: ≥ 5 new vitest contract cases (per brief §2 checklist).
- `tsc --noEmit` clean. `pnpm test` only adds tests, removes none.

## Clarifying questions for user

**Q1. Critic skip vs OK-stamp on trivial plans.** When the planner emits a plan that's already obviously correct (e.g. case #2 above), do we (a) always call the critic LLM for trace uniformity + semantic safety net, (b) deterministically skip critic when the plan passes lightweight static rules (every step's args zod-parse, no in-progress windows compared full-vs-partial without `fair-pace`, no `groupBy='day'` on questions mentioning 요일), or (c) hybrid — run a cheap static pre-check that can OK-stamp without calling the LLM but defers anything novel to the LLM critic. My lean: **(c)**, because it gives us deterministic regression nets for the cases we've already learned + LLM coverage for the long tail; downside is the static pre-check rules ARE heuristics, which is the thing we're trying to retire.

**Q2. Critic verdict on legitimate "no data" results.** Cases like #2 may legitimately return 0 rows (everyone's been in recently). Critic must distinguish that from "synthesizer is about to fabricate a number." My lean: critic evaluates **plan + tool results, not the synthesizer's answer.** The fabrication-prevention surface is a separate concern — synthesizer prompt already has "추측 금지." If you want answer-grounding too, that's a 2nd critic pass on synth output, +3s.

**Q3. Replan-hint shape.** Critic verdict is `{ verdict: "retry", reason, replanHint? }`. When `verdict === "retry"`, does the hint go to the next planner call as (a) extra system context on a fresh planner run, or (b) a step-targeted diff ("change step 1's `groupBy` from 'day' to 'dayOfWeek'"). My lean: **(a)** — keeps planner authoritative on plan shape and easier to test; (b) leaks plan structure into critic and would tempt us to add planner-internal hints later.

**Q4 (optional). Graceful-degrade disclaimer source.** When 2 critic passes both fail, brief §2 says "데이터 확인이 필요" disclaimer. Authored by (a) hardcoded Korean const in synthesizer entry path, (b) synthesizer LLM with an "uncertain mode" flag in its system prompt, (c) critic outputs the disclaimer text itself. My lean: **(a)** — predictable wording, no extra tokens, trivially testable.

Pick A/B/C/etc. on Q1–Q3 (Q4 optional) and I'll move to Architect role with the answers locked.

## Out-of-PM-scope, flagged for visibility

- The smoke transcript Manus paste-back is the only way to grow the PM failure set. If you've seen failures in production beyond #1–#4, add them here before I lock the set for Architect role.
- env-gap baseline tests (8 of them) excluded from Phase 26 — separate chore branch per user direction.
- Critic latency tax (~7–10s added) will show in the existing AgentTracePanel; new "critic" trace row covers it.

Waiting on Q1–Q4 answers before switching to Architect role.
