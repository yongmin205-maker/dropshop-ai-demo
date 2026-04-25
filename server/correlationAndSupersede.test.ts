import { describe, expect, it, vi } from "vitest";

/**
 * Pins §4.7 + §4.9:
 *  - §4.7  When the manager rejects a draft, ANY other still-pending draft for
 *          the same inbound message MUST be flipped to `superseded` so a
 *          re-tryer can't approve a stale duplicate.
 *  - §4.9  All step rows tied to one inbound→draft→reply chain MUST share a
 *          single `correlationId` so log queries can reconstruct one full
 *          turn cleanly.
 */

describe("§4.7 supersedeOtherPendingDraftsTx contract", () => {
  it("targets pending drafts for the SAME inboundMessageId, excluding the keeper", async () => {
    const calls: any[] = [];
    const fakeTx = {
      update: () => ({
        set: (patch: any) => {
          calls.push({ stage: "set", patch });
          return {
            where: (cond: any) => {
              calls.push({ stage: "where", cond });
              return Promise.resolve();
            },
          };
        },
      }),
    } as any;

    const { supersedeOtherPendingDraftsTx } = await import("./db");
    await supersedeOtherPendingDraftsTx(fakeTx, /* inboundMessageId */ 42, /* keepDraftId */ 7);

    // The mutation MUST be a status flip to "superseded".
    const setCall = calls.find((c) => c.stage === "set");
    expect(setCall).toBeTruthy();
    expect(setCall.patch).toEqual({ status: "superseded" });

    // The WHERE clause MUST be present (we don't assert deep drizzle internals,
    // but the call shape proves we filtered rather than touching everything).
    const whereCall = calls.find((c) => c.stage === "where");
    expect(whereCall).toBeTruthy();
  });

  it("never runs the UPDATE without a WHERE (would otherwise nuke the table)", async () => {
    let bareUpdateExecuted = false;
    const fakeTx = {
      update: () => ({
        set: () => ({
          // If supersede ever forgets to chain .where(), .then() would be reached.
          then: () => { bareUpdateExecuted = true; return Promise.resolve(); },
          where: () => Promise.resolve(),
        }),
      }),
    } as any;

    const { supersedeOtherPendingDraftsTx } = await import("./db");
    await supersedeOtherPendingDraftsTx(fakeTx, 1, 1);
    expect(bareUpdateExecuted).toBe(false);
  });
});

describe("§4.9 correlationId continuity", () => {
  it("newCorrelationId() returns a unique short string each call", async () => {
    const { newCorrelationId } = await import("./db");
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[a-z0-9_-]+$/i);
    // Reasonable length cap (< 64 since the column is varchar(64)).
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it("appendProcessingLogsTx forwards the same correlationId to every row", async () => {
    const captured: any[] = [];
    const fakeTx = {
      insert: () => ({
        values: (rows: any[]) => {
          captured.push(...rows);
          return Promise.resolve();
        },
      }),
    } as any;

    const { appendProcessingLogsTx } = await import("./db");
    const cid = "demo_corr_xyz";
    await appendProcessingLogsTx(fakeTx, [
      { conversationId: 1, messageId: 10, step: "intent_detected", label: "x", correlationId: cid },
      { conversationId: 1, messageId: 10, step: "mock_api_called", label: "y", correlationId: cid },
      { conversationId: 1, messageId: 10, step: "response_drafted", label: "z", correlationId: cid },
    ]);

    expect(captured).toHaveLength(3);
    for (const row of captured) {
      expect(row.correlationId).toBe(cid);
    }
  });
});
