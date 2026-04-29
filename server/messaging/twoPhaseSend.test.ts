/// <reference types="vitest" />

/**
 * Contract tests for `recordTwoPhaseSendSuccess` / `recordTwoPhaseSendFailure`.
 *
 * Why these tests exist (fix/2 invariant): the helpers' callers (drafts.approve,
 * simulator.sendMessage auto-send, twilioWebhook auto-send) all rely on three
 * properties holding atomically inside the supplied tx:
 *
 *   1. Success branch flips the outbound row to `sent` AND records a `sent`
 *      processing-log row. Pre-fix/2 the routers.ts caller did the delivery
 *      flip outside any tx and the log row in a separate write; a crash
 *      between the two left the audit trail inconsistent with the row state.
 *
 *   2. Failure branch flips the outbound row to `failed` with the upstream
 *      error truncated at SEND_ERROR_MAX (256), re-opens the originating
 *      draft to `pending_approval`, and records a `send_failed` log row.
 *      All three writes commit together or none of them do.
 *
 *   3. Failure recovery never silently drops: a draft that was approved but
 *      whose carrier send failed must always be visible to the manager again.
 *
 * We exercise the helpers directly (not via the three callers) so a future
 * regression in any one caller is caught here once instead of in three
 * different integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordTwoPhaseSendFailure,
  recordTwoPhaseSendSuccess,
  SEND_ERROR_MAX,
} from "./twoPhaseSend";

// --- In-memory DB stub.
//
// We can't use the real ./db (no MySQL in test env). Instead we mock the *Tx
// helpers, threading writes through a shared `state` object that mirrors the
// rows under test. The fake tx is a sentinel — the helpers don't introspect
// it, they just pass it through to the *Tx functions, which we control.

type OutboundRow = {
  id: number;
  status: "queued" | "sent" | "failed";
  twilioSid?: string | null;
  sendError?: string | null;
};
type DraftRow = {
  id: number;
  status: "pending_approval" | "approved" | "rejected" | "superseded";
};
type LogRow = {
  conversationId: number;
  messageId: number;
  step: string;
  label: string;
  detail: unknown;
  correlationId: string;
};

const state: {
  outbound: Map<number, OutboundRow>;
  drafts: Map<number, DraftRow>;
  logs: LogRow[];
  // Hook for the atomicity test: when set, the next `appendProcessingLogTx`
  // call throws. Used to simulate a partial-write failure inside a tx.
  failNextLog: boolean;
  // True iff we are currently inside a withTransaction callback. The mock
  // commits the in-memory mutations only when the callback resolves; if it
  // rejects we roll the snapshot back.
  insideTx: boolean;
} = {
  outbound: new Map(),
  drafts: new Map(),
  logs: [],
  failNextLog: false,
  insideTx: false,
};

vi.mock("../db", () => {
  const FAKE_TX = { __mockTx: true };
  return {
    appendProcessingLogTx: vi.fn(async (_tx: unknown, value: LogRow) => {
      if (state.failNextLog) {
        state.failNextLog = false;
        throw new Error("simulated DB error in second write");
      }
      state.logs.push({ ...value });
    }),
    updateMessageDeliveryTx: vi.fn(
      async (
        _tx: unknown,
        id: number,
        delivery: {
          status: OutboundRow["status"];
          twilioSid?: string;
          sendError?: string;
        },
      ) => {
        const row = state.outbound.get(id);
        if (!row) throw new Error(`outbound ${id} not found`);
        row.status = delivery.status;
        if (delivery.twilioSid !== undefined) row.twilioSid = delivery.twilioSid;
        if (delivery.sendError !== undefined) row.sendError = delivery.sendError;
      },
    ),
    updateDraftStatusTx: vi.fn(
      async (_tx: unknown, id: number, next: DraftRow["status"]) => {
        const row = state.drafts.get(id);
        if (!row) throw new Error(`draft ${id} not found`);
        row.status = next;
      },
    ),
    /** Snapshot/rollback helper so we can pin atomicity in case 4. */
    withTransaction: async <T>(
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      const snap = {
        outbound: new Map(
          [...state.outbound.entries()].map(([k, v]) => [k, { ...v }]),
        ),
        drafts: new Map(
          [...state.drafts.entries()].map(([k, v]) => [k, { ...v }]),
        ),
        logs: state.logs.slice(),
      };
      state.insideTx = true;
      try {
        const out = await fn(FAKE_TX);
        return out;
      } catch (err) {
        // Roll back to the snapshot — same as a real tx would.
        state.outbound = snap.outbound;
        state.drafts = snap.drafts;
        state.logs = snap.logs;
        throw err;
      } finally {
        state.insideTx = false;
      }
    },
  };
});

// Late import so the vi.mock above wins.
const dbMod = await import("../db");

beforeEach(() => {
  state.outbound.clear();
  state.drafts.clear();
  state.logs.length = 0;
  state.failNextLog = false;
  state.insideTx = false;
  // Seed one draft + one queued outbound shared across cases.
  state.drafts.set(101, { id: 101, status: "approved" });
  state.outbound.set(202, { id: 202, status: "queued" });
});

afterEach(() => {
  vi.clearAllMocks();
});

const ctx = {
  conversationId: 7,
  inboundMessageId: 70,
  outboundMessageId: 202,
  draftId: 101,
  correlationId: "corr-test",
};

describe("twoPhaseSend helpers — contract", () => {
  it("recordTwoPhaseSendSuccess flips outbound to 'sent' with sid AND writes a 'sent' log row", async () => {
    await dbMod.withTransaction((tx) =>
      recordTwoPhaseSendSuccess(tx as never, {
        ...ctx,
        twilioSid: "SM_OK_123",
        logLabel: "Approved & dispatched via Twilio",
      }),
    );
    const row = state.outbound.get(202);
    expect(row?.status).toBe("sent");
    expect(row?.twilioSid).toBe("SM_OK_123");
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({
      step: "sent",
      label: "Approved & dispatched via Twilio",
      correlationId: "corr-test",
      detail: {
        draftId: 101,
        outboundId: 202,
        twilioSid: "SM_OK_123",
      },
    });
  });

  it("recordTwoPhaseSendFailure flips outbound to 'failed' with the error truncated at SEND_ERROR_MAX", async () => {
    // Build a >256 char error to confirm truncation lands at exactly the cap.
    const longErr = "X".repeat(SEND_ERROR_MAX + 50);
    await dbMod.withTransaction((tx) =>
      recordTwoPhaseSendFailure(tx as never, {
        ...ctx,
        error: longErr,
        logLabel: "Twilio rejected the message — draft re-opened for retry",
      }),
    );
    const row = state.outbound.get(202);
    expect(row?.status).toBe("failed");
    expect(row?.sendError?.length).toBe(SEND_ERROR_MAX);
    expect(row?.sendError).toBe("X".repeat(SEND_ERROR_MAX));
    // The full untruncated error stays in the log row's detail field for forensics.
    expect(state.logs[0]?.detail).toMatchObject({ error: longErr });
  });

  it("recordTwoPhaseSendFailure re-opens the draft to pending_approval (visibility for the manager)", async () => {
    await dbMod.withTransaction((tx) =>
      recordTwoPhaseSendFailure(tx as never, {
        ...ctx,
        error: "Twilio 21610 blocked recipient",
        logLabel: "Twilio rejected the message — draft re-opened for retry",
      }),
    );
    expect(state.drafts.get(101)?.status).toBe("pending_approval");
    // And the audit log records the send_failed step + the original error.
    expect(state.logs[0]).toMatchObject({
      step: "send_failed",
      detail: { error: "Twilio 21610 blocked recipient", outboundId: 202, draftId: 101 },
    });
  });

  it("a tx error in the middle of a helper rolls back ALL writes (no partial state)", async () => {
    // Arrange: the second write inside recordTwoPhaseSendFailure (the
    // appendProcessingLogTx call — wait, in the failure flow the order is
    // updateMessageDeliveryTx → updateDraftStatusTx → appendProcessingLogTx,
    // so we fail on the third write) must take the first two with it.
    state.failNextLog = true;
    await expect(
      dbMod.withTransaction((tx) =>
        recordTwoPhaseSendFailure(tx as never, {
          ...ctx,
          error: "downstream failure",
          logLabel: "should-not-stick",
        }),
      ),
    ).rejects.toThrow(/simulated DB error/);
    // Outbound was queued before; if the tx rolled back nothing should have
    // moved.
    expect(state.outbound.get(202)?.status).toBe("queued");
    expect(state.outbound.get(202)?.sendError ?? null).toBeNull();
    // Draft was approved before; rollback restores that.
    expect(state.drafts.get(101)?.status).toBe("approved");
    // No log row landed.
    expect(state.logs).toHaveLength(0);
  });
});
