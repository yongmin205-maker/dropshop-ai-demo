/**
 * Executor — runs a Planner-produced plan against TOOL_REGISTRY.
 *
 * Best-effort semantics: one tool's failure does NOT abort the
 * remaining steps. The orchestrator surfaces failures to the
 * Synthesizer in the trace, and the Synthesizer is instructed to
 * say "일부 데이터를 못 가져왔어요" rather than make up missing
 * fields.
 *
 * Each step is wrapped in its own try/catch with timing capture so
 * the trace UI can show per-tool latency.
 *
 * Pure code, no LLM — easy to unit-test with stub tools.
 */

import { TOOL_REGISTRY } from "./tools";
import type { AgentContext, PlanStep, ToolCall } from "./types";

export type ExecutorResult = {
  toolCalls: ToolCall[];
  /** All successful outputs, keyed by toolName + step index. The
   *  Synthesizer reads this object to compose the answer. */
  results: Record<string, unknown>;
};

export async function executePlan(
  plan: PlanStep[],
  ctx: AgentContext,
  registry: typeof TOOL_REGISTRY = TOOL_REGISTRY,
): Promise<ExecutorResult> {
  const toolCalls: ToolCall[] = [];
  const results: Record<string, unknown> = {};

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i]!;
    const startedAt = Date.now();
    const tool = registry[step.toolName];
    if (!tool) {
      toolCalls.push({
        toolName: step.toolName,
        inputJson: step.argsJson,
        outputJson: "",
        startedAt,
        finishedAt: Date.now(),
        errorMessage: `Unknown tool: ${step.toolName}`,
      });
      continue;
    }
    let parsedInput: unknown;
    try {
      const raw = JSON.parse(step.argsJson || "{}");
      parsedInput = tool.inputSchema.parse(raw);
    } catch (err) {
      toolCalls.push({
        toolName: step.toolName,
        inputJson: step.argsJson,
        outputJson: "",
        startedAt,
        finishedAt: Date.now(),
        errorMessage: `Input validation failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }

    try {
      const output = await tool.invoke(parsedInput, ctx);
      // Output schema validation — surfaces drift between tool body
      // and declared output type without taking down the plan.
      const validatedRaw = tool.outputSchema.safeParse(output);
      const finalOutput = validatedRaw.success ? validatedRaw.data : output;
      const outputJson = JSON.stringify(finalOutput);
      const key = `${step.toolName}#${i}`;
      results[key] = finalOutput;
      toolCalls.push({
        toolName: step.toolName,
        inputJson: JSON.stringify(parsedInput),
        outputJson,
        startedAt,
        finishedAt: Date.now(),
        errorMessage: validatedRaw.success
          ? null
          : `Output validation failed: ${validatedRaw.error.message}`,
      });
    } catch (err) {
      toolCalls.push({
        toolName: step.toolName,
        inputJson: JSON.stringify(parsedInput ?? {}),
        outputJson: "",
        startedAt,
        finishedAt: Date.now(),
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { toolCalls, results };
}
