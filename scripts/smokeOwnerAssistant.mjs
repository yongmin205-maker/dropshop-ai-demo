/**
 * Smoke test: does the live planner produce valid args, and does the
 * Phase 26 critic agree the plan is correct?
 *
 * Calls planTools() with the real Gemini LLM (no mock) and prints the
 * plan, then runs evaluatePlan() with empty toolResults/toolCalls so
 * the LLM critic can opine on whether the plan _shape_ is correct
 * (static S4 — "all tools failed" — is skipped when toolCalls is
 * empty, so the critic gets to do its semantic job here).
 *
 * Per phase26_architecture.md §9.3 commit 7: smoke prints critic
 * verdict per question. Operator reads this to confirm the new loop
 * catches the regressions the Phase 26 PM set named:
 *   - "지난 달 vs 이번 달" → critic ok (fair-pace)
 *   - "60일 이상 안 온 손님" → critic ok (legitimate 0-row or rows)
 *   - "최근 2주 단골" → critic ok (14d window)
 *   - "지난 주 어느 요일" → critic ok (groupBy=dayOfWeek required)
 *
 * Asserts that:
 *   - planner produces non-empty plans for all 4 questions
 *   - compareTimeWindows (when present) has non-empty windowA/B/metric
 *   - critic does NOT veto on S1-S3 (those are hard plan defects)
 *
 * The critic LLM verdict is logged but NOT used as a pass/fail
 * threshold — Manus uses the smoke output to decide whether the
 * critic is finding real regressions vs over-triggering.
 */
import "dotenv/config";
import { planTools } from "../server/ownerAssistant/planner.ts";
import { evaluatePlan } from "../server/ownerAssistant/critic.ts";

const QUESTIONS = [
  { q: "지난 달 대비 이번 달 매출 어떨어?", cat: "compare" },
  { q: "60일 이상 안 온 손님 알려줘", cat: "aggregate" },
  { q: "최근 2주 동안 단골 손님 동향", cat: "aggregate" },
  { q: "지난 주 어떤 요일에 매출이 제일 높았어?", cat: "aggregate" },
];

const now = new Date();
console.log(`[smoke] now=${now.toISOString()}`);

let pass = 0;
let fail = 0;
for (const { q, cat } of QUESTIONS) {
  console.log(`\n=== Q: ${q} (cat=${cat})`);
  try {
    const plan = await planTools(q, cat, now);
    console.log(JSON.stringify(plan, null, 2));
    if (!plan.steps || plan.steps.length === 0) {
      console.error(`  ✗ plan has zero steps (llmCalls=${plan.llmCalls})`);
      fail++;
      continue;
    }
    let ok = true;
    for (const c of plan.steps) {
      let args = {};
      try { args = JSON.parse(c.argsJson); } catch {}
      if (Object.keys(args).length === 0 && c.toolName !== "countActiveGarments" && c.toolName !== "aggregateRevenueLive") {
        console.error(`  ✗ ${c.toolName} got empty args after planner`);
        ok = false;
      }
      if (c.toolName === "compareTimeWindows") {
        const a = args;
        if (!a.windowA?.from || !a.windowA?.to || !a.windowB?.from || !a.windowB?.to || !a.metric) {
          console.error(`  ✗ compareTimeWindows missing fields:`, a);
          ok = false;
        } else {
          console.log(`  ✓ compareTimeWindows windowA=${a.windowA.from}→${a.windowA.to}, windowB=${a.windowB.from}→${a.windowB.to}, metric=${a.metric}, mode=${a.mode ?? "(default)"}`);
          if (q.includes("이번") && a.mode !== "fair-pace") {
            console.error(`  ✗ question references in-progress period but mode is not fair-pace`);
            ok = false;
          }
        }
      } else {
        console.log(`  ✓ ${c.toolName} args ok`);
      }
    }

    // Phase 26 — critic pass on the planner's output. Empty
    // toolResults/toolCalls so we're asking the critic about the
    // plan _shape_, not the result data. S4 (all-tools-failed)
    // skips when toolCalls is empty; S1-S3 should pass on a real
    // planner-produced plan.
    let criticVerdict = "?";
    let criticReason = "";
    let criticInvariant = "";
    try {
      const verdict = await evaluatePlan({
        question: q,
        category: cat,
        plan: plan.steps,
        toolResults: {},
        toolCalls: [],
        now,
        history: [],
      });
      criticVerdict = verdict.verdict;
      criticReason = verdict.reason;
      criticInvariant = verdict.failedInvariant ?? "";
      const usedTag = verdict.usedLlm ? "LLM" : "static";
      console.log(`  · critic (${usedTag}): ${criticVerdict}${criticInvariant ? ` [${criticInvariant}]` : ""} — ${criticReason}`);
      if (verdict.replanHint) console.log(`    ↳ replan: ${verdict.replanHint}`);
      if (verdict.disclaimer) console.log(`    ↳ disclaimer: ${verdict.disclaimer}`);
      // S1-S3 violations are hard plan defects we want to flag.
      if (!verdict.usedLlm && /^S[123]$/.test(criticInvariant)) {
        console.error(`  ✗ critic static-veto on S1-S3 — planner emitted a hard plan defect`);
        ok = false;
      }
    } catch (err) {
      console.error(`  · critic threw:`, err.message);
    }

    if (ok) {
      console.log(`  ✓ all tool calls have valid args`);
      pass++;
    } else {
      fail++;
    }
  } catch (err) {
    console.error(`  ✗ planTools threw:`, err.message);
    fail++;
  }
}

console.log(`\n[smoke] pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
