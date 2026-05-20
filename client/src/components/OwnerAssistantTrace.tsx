/**
 * OwnerAssistantTrace — collapsible trace panel for an Owner Assistant turn.
 *
 * Pure presentational. Takes an `AgentTrace` (the same shape the server
 * returns for `trpc.ownerAssistant.ask`) and renders three nested sections:
 *
 *   1. A header row — category badge, total latency, LLM call count. Always
 *      visible inside the outer expander.
 *   2. A "Plan" sub-section — tool name + reason + collapsed args JSON. The
 *      planner's blueprint for what *should* have been called.
 *   3. A "Tool calls" sub-section — actual invocations, per-call duration,
 *      collapsed output JSON, red errorMessage if the call failed.
 *
 * The outer wrapper is a `<details>` so the user has to click "🔍 Agent trace"
 * to even see this — keeps the chat clean. Inner plan/tool-calls are each
 * their own `<details>` so the operator can open one without the other.
 *
 * Phase 25c §7.3 — debug + trust UI. No tRPC, no side effects.
 */
import { Badge } from "@/components/ui/badge";
import type { AgentTrace, ToolCall } from "../../../server/ownerAssistant/types";

/** Pretty-print JSON args/outputs in the trace tables. Handles already-string
 *  blobs (the server stringifies before persistence) by attempting a parse;
 *  if that fails we just dump the raw string — better than blowing up on a
 *  malformed payload mid-render. */
function prettyJson(raw: string): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function categoryTone(category: AgentTrace["category"]): string {
  switch (category) {
    case "lookup":
      return "bg-sky-50 text-sky-700 border-sky-200";
    case "aggregate":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "compare":
      return "bg-violet-50 text-violet-700 border-violet-200";
    case "action":
      return "bg-amber-50 text-amber-800 border-amber-200";
    case "search_text":
      return "bg-indigo-50 text-indigo-700 border-indigo-200";
    case "smalltalk":
      return "bg-zinc-50 text-zinc-700 border-zinc-200";
    case "out_of_scope":
      return "bg-rose-50 text-rose-700 border-rose-200";
    default:
      return "bg-secondary text-foreground border-border";
  }
}

export function OwnerAssistantTrace({ trace }: { trace: AgentTrace }) {
  return (
    <details className="mt-2 rounded-md border border-border bg-secondary/60 px-2.5 py-1.5 text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        🔍 Agent trace
      </summary>
      <div className="mt-2 space-y-3">
        {/* Header row — always visible once outer expander is open. */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={`text-[10px] ${categoryTone(trace.category)}`}>
            {trace.category}
          </Badge>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {trace.totalLatencyMs}ms
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {trace.llmCallCount} LLM call{trace.llmCallCount === 1 ? "" : "s"}
          </span>
          {trace.criticCalls.length > 0 && (
            <Badge
              variant="outline"
              className={`text-[10px] ${
                trace.criticCalls[trace.criticCalls.length - 1]?.verdict === "ok"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-rose-50 text-rose-700 border-rose-200"
              }`}
            >
              critic {trace.criticCalls.length}× ·{" "}
              {trace.criticCalls[trace.criticCalls.length - 1]?.verdict}
            </Badge>
          )}
        </div>

        {/* Plan table. Each tool's args is a nested collapsible to keep the
            table from exploding on wide JSON payloads. */}
        <details open={trace.plan.length > 0} className="rounded border border-border bg-background">
          <summary className="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
            Plan ({trace.plan.length})
          </summary>
          {trace.plan.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              No tools planned (smalltalk / out-of-scope).
            </div>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Tool</th>
                  <th className="px-2 py-1 font-medium">Reason</th>
                  <th className="px-2 py-1 font-medium">Args</th>
                </tr>
              </thead>
              <tbody>
                {trace.plan.map((p, i) => (
                  <tr key={`plan-${i}`} className="border-t border-border align-top">
                    <td className="px-2 py-1 font-mono text-foreground/90">{p.toolName}</td>
                    <td className="px-2 py-1 text-foreground/80">{p.reason}</td>
                    <td className="px-2 py-1">
                      <details>
                        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                          view
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-secondary p-1.5 font-mono text-[10px] text-foreground/85">
                          {prettyJson(p.argsJson)}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </details>

        {/* Critic passes — Phase 26. One row per evaluatePlan call.
            Verdict gets a red/green chip per DP4; static-veto rows
            label themselves so the operator can tell which passes
            burned LLM tokens vs which were free. */}
        {trace.criticCalls.length > 0 && (
          <details
            open={trace.criticCalls.some((c) => c.verdict === "retry")}
            className="rounded border border-border bg-background"
          >
            <summary className="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
              Critic ({trace.criticCalls.length})
            </summary>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Pass</th>
                  <th className="px-2 py-1 font-medium">Verdict</th>
                  <th className="px-2 py-1 font-medium">Invariant</th>
                  <th className="px-2 py-1 font-medium">Reason</th>
                  <th className="px-2 py-1 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {trace.criticCalls.map((c, i) => (
                  <tr key={`crit-${i}`} className="border-t border-border align-top">
                    <td className="px-2 py-1 tabular-nums text-foreground/80">{c.pass}</td>
                    <td className="px-2 py-1">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${
                          c.verdict === "ok"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-rose-50 text-rose-700 border-rose-200"
                        }`}
                      >
                        {c.verdict}
                      </Badge>
                    </td>
                    <td className="px-2 py-1 font-mono text-foreground/80">
                      {c.failedInvariant ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-foreground/80">
                      <div>{c.reason}</div>
                      {c.replanHint && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          ↳ replan: {c.replanHint}
                        </div>
                      )}
                      {c.disclaimer && (
                        <div className="mt-0.5 text-[10px] italic text-amber-700">
                          {c.disclaimer}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1 text-[10px] text-muted-foreground">
                      {c.usedLlm ? "LLM" : "static"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

        {/* Tool-calls table — actuals, including failures. */}
        <details className="rounded border border-border bg-background">
          <summary className="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
            Tool calls ({trace.toolCalls.length})
          </summary>
          {trace.toolCalls.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              No tool calls executed.
            </div>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Tool</th>
                  <th className="px-2 py-1 font-medium">Duration</th>
                  <th className="px-2 py-1 font-medium">Output</th>
                  <th className="px-2 py-1 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {trace.toolCalls.map((c: ToolCall, i: number) => {
                  const duration = Math.max(0, c.finishedAt - c.startedAt);
                  return (
                    <tr key={`call-${i}`} className="border-t border-border align-top">
                      <td className="px-2 py-1 font-mono text-foreground/90">{c.toolName}</td>
                      <td className="px-2 py-1 tabular-nums text-muted-foreground">
                        {duration}ms
                      </td>
                      <td className="px-2 py-1">
                        <details>
                          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                            view
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-auto rounded bg-secondary p-1.5 font-mono text-[10px] text-foreground/85">
                            {prettyJson(c.outputJson)}
                          </pre>
                        </details>
                      </td>
                      <td className="px-2 py-1">
                        {c.errorMessage ? (
                          <span className="text-rose-700 break-words">{c.errorMessage}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </details>
      </div>
    </details>
  );
}

export default OwnerAssistantTrace;
