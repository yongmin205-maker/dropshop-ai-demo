/**
 * Smoke test: does the live planner produce valid args for the
 * "last month vs this month" question?
 *
 * Calls planTools() with the real Gemini LLM (no mock) and prints the plan.
 * Asserts that:
 *   - at least one tool call is compareTimeWindows
 *   - its args include non-empty windowA, windowB, metric
 */
import "dotenv/config";
import { planTools } from "../server/ownerAssistant/planner.ts";

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
          console.log(`  ✓ compareTimeWindows windowA=${a.windowA.from}→${a.windowA.to}, windowB=${a.windowB.from}→${a.windowB.to}, metric=${a.metric}`);
        }
      } else {
        console.log(`  ✓ ${c.toolName} args ok`);
      }
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
