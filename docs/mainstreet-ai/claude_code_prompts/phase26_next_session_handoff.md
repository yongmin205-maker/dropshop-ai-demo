# Phase 26 — Next Session Handoff

**Status as of this commit:** Phase 26 code is fully landed on `phase26/critic-loop` (PR #1 open against `main`). All 9 critic tests + 12 agent tests + 580 total pass. tsc clean. **Manus access was cut off before the live-LLM smoke could run** — so the unchecked items on the PR's test plan need to be resolved by the next session (you).

This doc is the single entry point for the next Claude session. Read it first.

---

## 1. What you're walking into

- **Branch:** `phase26/critic-loop` (origin synced, working tree clean)
- **PR:** https://github.com/yongmin205-maker/dropshop-ai-demo/pull/1 — has full commit-by-commit narrative + acceptance bar
- **10 commits ahead of `origin/main`:**
  - 3 docs (PM, Architecture, DP1-DP4 lock)
  - 7 code commits (TDD red → green sequence, see PR body for the table)
- **Test math at HEAD:** 580 pass / 8 fail (pre-existing env-gap — 2 customerProfile DATABASE_URL + 6 useSimpleMode jsdom) / 9 skipped. `pnpm tsc --noEmit` clean.

If those numbers don't reproduce locally, something drifted — read `git log --oneline phase26/critic-loop ^origin/main` and compare against the commit table in the PR.

## 2. Decisions you do NOT relitigate

Locked in `phase26_pm.md` (Q1–Q4) and `phase26_architecture.md` (DP1–DP4). The summary that matters when you're reading code:

- **Q1 / DP1:** Static = veto-only. `staticPreCheck` cannot stamp `"ok"`. The only path to `verdict: "ok"` is `llmCritic`. No S0 allowlist.
- **Q2 / arch §6:** Phase 26 critic evaluates plan + tool results ONLY. **Synthesizer answer hallucination is Phase 27 work** (deferred — marker in agent.ts, todo.md section).
- **Q3:** Replan = fresh `planTools()` call with `extraContext: critic.replanHint` as additional system context. NOT a step-targeted diff.
- **Q4:** Disclaimer is critic-authored. When 2 critic passes both retry, the orchestrator uses `verdict.disclaimer` (falls back to `verdict.reason` if empty).
- **DP2:** 25s hard wall, 22s preflight bail before critic-pass-2, per-stage soft budgets. **Constants live at the top of `critic.ts` as `PHASE26_BUDGETS`** — tune retroactively from prod data.
- **DP3:** On pass-2 retry, `disclaimer` is required by schema; `reason` is the safety-net fallback only.
- **DP4:** `events: TraceEvent[]` chronological union on `AgentTrace`. UI sorts by `t`. `toolCalls[]` retained for backward compat (derive from events).

## 3. Outstanding acceptance-bar items (the reason this doc exists)

The PR body has two unchecked boxes:

> - [ ] **Manus smoke**: `node --import=tsx scripts/smokeOwnerAssistant.mjs` against live Gemini — verify critic returns `ok` on all 4 canon PM questions, and verify case #4 ("지난 주 어떤 요일") emits `dayOfWeek` (or gets corrected via I3 replan)
> - [ ] Manual UI check: trace panel shows the new critic chip + sub-section on a retry case

Manus is gone, so neither happened. **Both need to be resolved before merge.** Options for each:

### 3a. The live-Gemini smoke

The smoke script (`scripts/smokeOwnerAssistant.mjs`) needs `OPENAI_API_KEY` and `FORGE_API_URL` env vars to talk to Gemini via Forge. Three options, in order of preference:

1. **Run it yourself locally if you have access to the Forge gateway.** Drop the keys into `.env`, run `node --import=tsx scripts/smokeOwnerAssistant.mjs`, paste the output into a new commit or a PR comment. The 4 questions should produce:
   - "지난 달 대비 이번 달 매출" → `compareTimeWindows mode='fair-pace'`, critic verdict `ok`
   - "60일 이상 안 온 손님" → `findInactiveCustomers` defaults, critic verdict `ok` (legitimate 0-row is fine per I6)
   - "최근 2주 동안 단골 손님 동향" → `aggregateRepeatCustomers` with 14-day window, critic verdict `ok`
   - **"지난 주 어떤 요일에 매출이 제일 높았어?"** — this is the motivating bug. Two acceptable outcomes:
     - Best case: planner emits `groupBy='dayOfWeek'` on the first call (because retiring the heuristic didn't break Gemini's ability to infer it), critic verdict `ok`. Test of whether Gemini actually needed the heuristic.
     - Acceptable: planner emits `groupBy='day'`, critic returns `retry` with `failedInvariant: "I3"`, replan happens, critic-pass-2 returns `ok`. This is the loop doing its job.

   Anything else (critic fails to flag, or planner emits something wholly wrong) means investigate.

2. **Ask the human user to run the smoke and paste output.** Same script, but they run it. Then you read the paste, decide if behavior is acceptable, and check the PR boxes.

3. **Skip the live smoke entirely and document the gap.** Acceptable only if option 1/2 are both impossible. Convert the PR's unchecked box into a "Phase 26.5 — live smoke" follow-up issue/branch, merge Phase 26 on the strength of the unit tests, plan to land the smoke verification before any real owner uses the feature.

The user's brief explicitly said acceptance bar requires the smoke. **Default to option 1 or 2 unless the user tells you to skip.**

### 3b. The UI check

`OwnerChat.test.tsx` exercises the no-critic-events path (empty `criticCalls: []`). It does NOT exercise the retry case where the new chip + sub-section render with real content. Two options:

1. **Add a vitest case** to `OwnerChat.test.tsx` that supplies a sample trace with a populated `criticCalls` array (one `retry` followed by one `ok`) and asserts:
   - The header chip text reads `critic 2× · ok`
   - The Critic sub-section is rendered and shows both rows
   - The retry row's `replanHint` is visible
   This is option 1 because it's the cleanest — you don't need a running app.

2. **Boot the app locally** (`pnpm dev`), ask a question that triggers a retry, screenshot the trace panel, attach to the PR. The smoke script can't trigger this because it doesn't call `ask()` — only `planTools()` + `evaluatePlan()`.

Default to option 1.

## 4. Specific files you'll touch first

Order of reading on session start:

1. **This doc** (you're already here).
2. **`docs/mainstreet-ai/claude_code_prompts/phase26_pm.md`** — the 4 canon questions + their expected tool calls. Memorize these.
3. **`docs/mainstreet-ai/claude_code_prompts/phase26_architecture.md`** — §3 (invariants S1-S4 + I1-I7), §9 (Coder hand-off contracts).
4. **`server/ownerAssistant/critic.ts`** — the whole thing. ~370 lines.
5. **`server/ownerAssistant/critic.test.ts`** — 7 fixtures = the regression net.
6. **`server/ownerAssistant/agent.ts`** — the loop. Look for the `for (let pass = 1; pass <= MAX_CRITIC_PASSES; pass++)` block.
7. **`server/ownerAssistant/planner.ts`** — heuristic-retirement landed here; `extraContext` plumbed through.
8. **`todo.md`** — bottom section has the Phase 27 spec verbatim.

You should NOT need to read the rest of `server/ownerAssistant/` (router, executor, synthesizer, tools/) unless something specific breaks.

## 5. If the user says "now do Phase 27"

The architecture for Phase 27 is already pinned in two places:

- `docs/mainstreet-ai/claude_code_prompts/phase26_architecture.md` §6 — explicit deferred bullets (a) – (d)
- `todo.md` bottom — "Phase 27 — synth-answer critic" section, same content

Short version of what Phase 27 needs:

- **Separate LLM/pass** from Phase 26's plan critic (different prompt, different model decision, different trigger)
- **Trigger: answer contains ≥ N numeric tokens** (threshold tuned from logged answers in prod — start with N=3 as a placeholder, log everything, retune)
- **Integration point already marked** with `// TODO(phase27)` in `server/ownerAssistant/agent.ts` (between `synth(...)` and `appendDisclaimer(...)`)
- **Test fixtures Phase 27 needs** (NOT pinned yet — pin them in a Phase 27 PM doc before coding):
  - Answer fabricates a number not in tool results (the "hallucinates a store name" case from the brief's 4 named fixtures, but with a number instead of a name)
  - Answer correctly cites a number that IS in tool results (negative case — critic should pass it)
  - Answer for a smalltalk/oos question (no numbers — critic should skip entirely, no LLM cost)

When the user kicks off Phase 27, **start by writing the Phase 27 PM doc** with the same 4-role discipline (PM → Architect → Coder → Reviewer). Do NOT just dive into code. The Phase 26 doc layout is the template.

## 6. Things that will trip you up (gotchas from the Phase 26 work)

- **`pnpm` working dir matters.** Run all `pnpm test` / `pnpm tsc` commands from `/Users/ethjo/Claude/review/dropshop-ai-demo` (or whatever the repo root is in your environment). From `/Users/ethjo/Claude` you'll get `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`.

- **Aggregate tool schemas use `dateFrom`/`dateTo`, not `windowFrom`/`windowTo`.** Phase 26 fixture-1 (commit 1) used the wrong field names; commit 2 fixed them. If you author new fixtures, copy from the actual zod schema in `server/ownerAssistant/tools/aggregates.ts`, not from memory.

- **`findInactiveCustomers` arg is `inactiveSinceDays`**, not `inactiveDays`. Same lesson.

- **`aggregateRevenue.groupBy` enum is `["day", "week", "month", "dayOfWeek"]`**. No `"hour"`. Commit 2 dropped a bad fixture that used `"hour"` — if you find yourself wanting hour-level granularity, that's a new tool, not a new enum value.

- **Critic test mocking pattern:** `vi.hoisted` + `vi.mock("../_core/llm")` — the same pattern `planner.test.ts` uses. Don't try to mock `invokeLLM` after the file imports it; vitest hoists `vi.mock` calls.

- **`llmCallCount` accounting changed in Phase 26.** smalltalk is still 2 (Router + Synth — no critic), but tool-running turns are now 4 (Router + Planner + Critic + Synth). If you add a new agent.test.ts case, expect 4 not 3 unless you intend a static-veto path.

- **Static `staticPreCheck` does NOT count toward `llmCallCount`** (gated on `verdict.usedLlm`). If you write a test that mocks the critic with `usedLlm: false`, expect llmCallCount to NOT increment.

- **`makeCritic()` helper in agent.test.ts** is your friend. Every tool-running test injects it. If you forget, the test will actually hit the real LLM (Forge) and either time out or burn quota.

- **Don't combine roles in one message.** The original brief said "한 메시지에서 두 역할을 겸하지 마세요." When you do Phase 27, write the PM doc in one turn, get user lock on Q1-Q4, THEN switch to Architect, etc. The user enforced this on Phase 26 and it was right.

## 7. Environment notes

- The 8 env-gap test failures (`customerProfile.test.ts` × 2, `useSimpleMode.test.tsx` × 6) are **pre-existing and out of Phase 26 scope**. The user explicitly accepted them as baseline. Do NOT try to fix them in a Phase 27 PR — separate chore branch.

- The repo uses pnpm 9. Forge gateway is at `https://forge.manus.im/v1/chat/completions` by default (override with `FORGE_API_URL`). API key is `OPENAI_API_KEY` (legacy name; it's actually the Forge key). Hardcoded model is `gemini-2.5-flash`.

- **Manus is the user's previous LLM provider for the smoke. They lost access on 2026-05-20.** If you need to run the live smoke, you'll need either (a) the user to provide alternate Forge credentials, (b) a direct Gemini API key with a small adapter to `server/_core/llm.ts`, or (c) the explicit instruction to skip the live smoke. Ask before assuming.

## 8. Quick-start commands

```bash
# Sanity:
git status                              # should be clean on phase26/critic-loop
git log --oneline -12                   # should show 10 phase26 commits
pnpm tsc --noEmit                       # clean
pnpm test --run                         # 580 pass / 8 fail (env-gap) / 9 skipped

# Just the critic surface:
pnpm test --run server/ownerAssistant/critic.test.ts server/ownerAssistant/agent.test.ts

# Live smoke (needs OPENAI_API_KEY in .env):
node --import=tsx scripts/smokeOwnerAssistant.mjs

# Open the PR:
gh pr view 1 --web
```

## 9. The one-paragraph summary

Phase 26 retired heuristic prompt-patching in the Owner Assistant by adding a plan→execute→critic→(replan?)→synth loop with a two-stage critic (static veto + LLM semantic). The motivating bug was "지난 주 어느 요일이 매출 좋아" emitting `groupBy='day'` instead of `dayOfWeek`. The critic catches that via invariant I3 and replans with a targeted hint. Code lives on `phase26/critic-loop` (PR #1). Tests are green. **The only outstanding items are the live-LLM smoke verification and a UI test for the critic chip on retry traces — both blocked when Manus access died. Resolve those before merge; do NOT jump straight to Phase 27.**
