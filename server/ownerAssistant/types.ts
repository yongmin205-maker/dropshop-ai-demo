/**
 * Phase 25c Owner Assistant — shared types.
 *
 * The orchestrator at agent.ts walks the 4-stage loop (Router → Planner →
 * Executor → Synthesizer). Each stage exchanges these types so the loop can
 * be unit-tested without a real LLM and so the trace surfaced to the UI is
 * stable.
 */

import { z } from "zod";

/* ----- Question categories the Router classifies into ----- */

export const QuestionCategorySchema = z.enum([
  "lookup", // category 1: single customer / single order lookup
  "aggregate", // category 2: counts, revenue, repeat customers, inactive customers
  "compare", // category 3: A vs B time-window comparisons
  "action", // category 4: send-bulk, mark-as-paid, etc — Phase 25c is read-only
  "search_text", // category 5: free-text search over notes — Phase 25e
  "smalltalk", // greetings, "고마워" — no tool, friendly LLM-only reply
  "out_of_scope", // staff hours, inventory, anything outside our data
]);
export type QuestionCategory = z.infer<typeof QuestionCategorySchema>;

/* ----- Tool registry ----- */

export const TOOL_NAMES = [
  "findCustomerByPhoneOrName",
  "getCustomerRecentOrders",
  "getOrderDetails",
  "getActiveOrdersByStatus",
  "fetchLiveOrder",
  "countActiveGarments",
  "aggregateRevenueLive",
  "aggregateRevenue",
  "aggregateNewCustomers",
  "aggregateRepeatCustomers",
  "findInactiveCustomers",
  "compareTimeWindows",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolDefinition<TIn, TOut> = {
  name: ToolName;
  /** Which Router category this tool serves; the Planner uses this to
   *  prune the option set per turn. */
  category: QuestionCategory;
  /** Korean one-liner the Planner LLM sees. Keep it tight; the model
   *  re-reads this every turn. */
  description: string;
  inputSchema: z.ZodType<TIn>;
  outputSchema: z.ZodType<TOut>;
  /** Concrete literal example of the args the Planner should produce.
   *  Surfaced verbatim in the Planner prompt so the LLM has a working
   *  template to copy field names + value shapes from. Without this
   *  the Planner LLM can emit `{}` and the Executor zod-fails. */
  argsExample: TIn;
  invoke(input: TIn, ctx: AgentContext): Promise<TOut>;
};

/** Type-erased view of a tool registry entry, used by the Executor so it
 *  can run any tool without compile-time knowing the I/O types. */
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

/* ----- Runtime context threaded through every tool ----- */

export type AgentContext = {
  source: "cleancloud"; // hardcoded for Phase 25c; multi-source ships when
  // DropShop POS does.
  /** Korean string the Synthesizer appends as a footer so the Owner
   *  knows what timestamp the answer reflects. Filled by the
   *  orchestrator from the latest posSyncLog row, or replaced with
   *  "방금 확인한 실시간 데이터" when any live-tool ran. */
  freshnessHint: string;
  /** Injectable clock — tests pass a fixed Date so date arithmetic
   *  (e.g. "60일 이상 안 온 손님") is deterministic. */
  now: Date;
};

/* ----- Trace shape ----- */

export type PlanStep = {
  toolName: ToolName;
  /** JSON-stringified args the Planner produced. Validated by the
   *  tool's inputSchema in the Executor. */
  argsJson: string;
  /** Korean rationale the Planner gives. Helpful in the UI trace box. */
  reason: string;
};

export type ToolCall = {
  toolName: ToolName;
  inputJson: string;
  outputJson: string;
  startedAt: number; // epoch ms
  finishedAt: number; // epoch ms
  /** Non-null only when the tool threw OR inputSchema/outputSchema
   *  validation failed. The Executor is best-effort: one tool's failure
   *  does not abort the rest of the plan. */
  errorMessage: string | null;
};

export type AgentTrace = {
  question: string;
  category: QuestionCategory;
  plan: PlanStep[];
  toolCalls: ToolCall[];
  answerMarkdown: string;
  totalLatencyMs: number;
  /** Router + Planner + Synthesizer calls; smalltalk path is 2 (Router +
   *  Synthesizer), happy-path tool turn is 3 (Router + Planner +
   *  Synthesizer), Planner-retry adds 1. */
  llmCallCount: number;
};

/* ----- Output of the orchestrator ----- */

export type AgentAnswer = {
  answerMarkdown: string;
  trace: AgentTrace;
};

/**
 * Planner result. Pre-fix this was just `PlanStep[]`, which forced the
 * orchestrator to infer "did the planner retry?" from `steps.length >
 * MAX_PLAN_STEPS` — a check that is unreachable in practice because the
 * planner truncates to the cap before returning. The orchestrator's
 * `llmCallCount=4` invariant therefore only held in tests that stubbed
 * the planner; in production a real model that overproduced 6→3 would
 * still report llmCallCount=3. Reviewing this as a bug, we surface the
 * retry honestly: the planner returns its own LLM-call count, the
 * orchestrator simply adds it.
 */
export type PlanResult = {
  steps: PlanStep[];
  /** Number of times the planner LLM was called for this turn. 1 on
   *  the happy path; 2 if the model over-produced and got the
   *  shorten-to-N nudge. */
  llmCalls: number;
};
