import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * §4.3 Cursor pagination contract
 * -------------------------------
 * The four list helpers in db.ts (`listConversations`, `listStyleExamples`,
 * `listRejections`, `listKnowledge`) MUST all
 *   (a) accept a `{ limit?, beforeId? }` options object, and
 *   (b) translate `beforeId` into a `lt(table.id, beforeId)` predicate
 *       attached via `.where(...)`.
 *
 * Because vitest's `vi.mock("./db", ...)` cannot intercept *intra-module*
 * `getDb()` calls (the helpers reference the closure-bound `getDb`, not
 * an external import), we cannot exercise the helpers against a fake
 * drizzle chain. The next-best contract is a **static source assertion**:
 * we read db.ts and verify the predicate exists for each table.
 *
 * This is exactly the test that would have caught the original gap where
 * `listKnowledge` only honored `limit` and silently ignored `beforeId`.
 *
 * §4.9 correlationId tracing
 * --------------------------
 * Verified dynamically below by stubbing `tx.insert(...).values(...)` and
 * confirming the helpers forward correlationId verbatim.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbSource = readFileSync(path.join(__dirname, "db.ts"), "utf8");

/** Slice db.ts source between `export async function <name>` and the next
 *  top-level `export ` declaration so each helper is examined in isolation. */
function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`${name} not found in db.ts`);
  // Find the next top-level `export ` after the start (allow some same-line
  // false-positives by requiring it begins a line).
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? src.length : after);
}

describe("§4.3 cursor pagination — static source contract on db.ts", () => {
  const tablePerHelper: Record<string, string> = {
    listConversations: "conversations",
    listStyleExamples: "styleExamples",
    listRejections: "rejections",
    listKnowledge: "knowledgeChunks",
  };

  for (const [helper, table] of Object.entries(tablePerHelper)) {
    it(`${helper} honors beforeId via lt(${table}.id, ...)`, () => {
      const body = sliceFunction(dbSource, helper);
      expect(body, `${helper} missing lt(${table}.id, ...) predicate`).toMatch(
        new RegExp(`lt\\(\\s*${table}\\.id\\s*,\\s*opt(s|ions)\\.beforeId`),
      );
    });
  }

  it("all four list helpers expose `{ limit?, beforeId? }` in their signature", () => {
    for (const name of Object.keys(tablePerHelper)) {
      const body = sliceFunction(dbSource, name);
      expect(body, `${name} missing beforeId option`).toMatch(/beforeId\?:\s*number/);
    }
  });

  it("listConversations caps limit at 200", () => {
    expect(sliceFunction(dbSource, "listConversations")).toMatch(/Math\.min\([\s\S]{0,120}200\)/);
  });

  it("listStyleExamples and listRejections cap limit at 500", () => {
    expect(sliceFunction(dbSource, "listStyleExamples")).toMatch(/Math\.min\([\s\S]{0,120}500\)/);
    expect(sliceFunction(dbSource, "listRejections")).toMatch(/Math\.min\([\s\S]{0,120}500\)/);
  });
});

describe("§4.9 correlationId tracing — dynamic contract", () => {
  it("appendMessageTx forwards correlationId verbatim into the insert payload", async () => {
    const captured: any[] = [];
    const fakeTx = {
      insert: () => ({
        values: async (v: any) => {
          captured.push(v);
          return [{ insertId: 1 }];
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 1, correlationId: captured[0]?.correlationId }],
          }),
        }),
      }),
    } as any;

    const { appendMessageTx } = await import("./db");
    await appendMessageTx(fakeTx, {
      conversationId: 7,
      direction: "inbound",
      sender: "customer",
      body: "where is my order",
      mode: "live",
      status: "sent",
      correlationId: "abc-123-fixture",
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].correlationId).toBe("abc-123-fixture");
  });

  it("appendProcessingLogsTx forwards correlationId on every row in the batch", async () => {
    const captured: any[] = [];
    const fakeTx = {
      insert: () => ({
        values: async (rows: any[]) => {
          captured.push(...rows);
          return [{ insertId: rows.length }];
        },
      }),
    } as any;

    const { appendProcessingLogsTx } = await import("./db");
    const correlationId = "turn-xyz-001";
    await appendProcessingLogsTx(fakeTx, [
      { conversationId: 1, step: "intent_classified", label: "ETA", correlationId } as any,
      { conversationId: 1, step: "rag_retrieved", label: "k=3", correlationId } as any,
      { conversationId: 1, step: "response_drafted", label: "draft saved", correlationId } as any,
    ]);

    expect(captured).toHaveLength(3);
    for (const row of captured) {
      expect(row.correlationId).toBe(correlationId);
    }
  });

  it("newCorrelationId returns a non-empty short id and is unique across two synchronous calls", async () => {
    const { newCorrelationId } = await import("./db");
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toMatch(/^[a-z0-9]{6,16}$/);
    expect(b).toMatch(/^[a-z0-9]{6,16}$/);
    expect(a).not.toBe(b);
  });

  it("production code paths in routers.ts + twilioWebhook.ts pass correlationId on every appendMessageTx call", () => {
    const routersSrc = readFileSync(path.join(__dirname, "routers.ts"), "utf8");
    const webhookSrc = readFileSync(path.join(__dirname, "twilioWebhook.ts"), "utf8");

    // Find every appendMessageTx(...) call and assert correlationId appears
    // within ~12 lines after it (the property is part of the same object literal).
    /**
     * Find every appendMessageTx call site by locating the start, then
     * walking forward to find the matching closing paren (proper depth
     * counting — the body contains nested object literals).
     */
    function eachCallBody(src: string): string[] {
      const calls: string[] = [];
      const re = /appendMessageTx\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        let i = m.index + m[0].length;
        let depth = 1;
        const start = i;
        while (i < src.length && depth > 0) {
          const ch = src[i];
          if (ch === "(" || ch === "{" || ch === "[") depth += 1;
          else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
          i += 1;
        }
        calls.push(src.slice(start, i - 1));
      }
      return calls;
    }

    function assertEveryCallHasCorrelationId(src: string, file: string) {
      const calls = eachCallBody(src);
      expect(calls.length, `${file} should have at least one appendMessageTx call`).toBeGreaterThan(0);
      calls.forEach((body, i) => {
        expect(body, `${file} appendMessageTx call #${i + 1} missing correlationId`)
          .toMatch(/correlationId/);
      });
    }
    assertEveryCallHasCorrelationId(routersSrc, "routers.ts");
    assertEveryCallHasCorrelationId(webhookSrc, "twilioWebhook.ts");
  });
});
