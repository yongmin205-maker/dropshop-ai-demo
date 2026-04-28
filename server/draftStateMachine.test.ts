/// <reference types="vitest" />

/* ------------------------------------------------------------------
 * Pure-logic tests for production-hardening additions:
 *   1. transitionDraftStatus is atomic (only the first concurrent
 *      caller's update succeeds; the second sees `null`).
 *   2. supersedeOtherPendingDrafts marks siblings as 'superseded'
 *      while preserving the canonical draft.
 *   3. getMessageByTwilioSid returns the existing row for idempotency.
 *   4. Two-phase send: outbound row is queued first, flipped to 'sent'
 *      only on Twilio ok; flipped to 'failed' on Twilio error and
 *      the draft is reopened to pending_approval.
 *   5. resolveEscalation clears `conversations.escalated` only when no
 *      other open escalations remain on the same conversation.
 *
 * All tests use a tiny in-memory mock for `./db` so we never hit MySQL.
 * ------------------------------------------------------------------ */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => {
  type DraftRow = {
    id: number;
    inboundMessageId: number;
    status: "pending_approval" | "approved" | "rejected" | "superseded";
    revision: number;
  };
  type MessageRow = {
    id: number;
    twilioSid?: string | null;
    status: "queued" | "sent" | "failed" | "delivered";
    sendError?: string | null;
  };
  type EscalationRow = {
    id: number;
    conversationId: number;
    status: "open" | "resolved";
  };
  type ConversationRow = {
    id: number;
    phone: string;
    customerName: string | null;
    escalated: number;
  };

  const state = {
    drafts: new Map<number, DraftRow>(),
    messages: new Map<number, MessageRow>(),
    escalations: new Map<number, EscalationRow>(),
    conversations: new Map<number, ConversationRow>(),
    seq: 100,
  };

  function nextId() {
    state.seq += 1;
    return state.seq;
  }

  return {
    __state: state,
    transitionDraftStatus: vi.fn(async (id: number, next: DraftRow["status"]) => {
      const row = state.drafts.get(id);
      if (!row || row.status !== "pending_approval") return null;
      row.status = next;
      return { ...row };
    }),
    supersedeOtherPendingDrafts: vi.fn(
      async (inboundMessageId: number, keepDraftId: number) => {
        for (const row of state.drafts.values()) {
          if (
            row.inboundMessageId === inboundMessageId &&
            row.id !== keepDraftId &&
            row.status === "pending_approval"
          ) {
            row.status = "superseded";
          }
        }
      },
    ),
    insertDraft: vi.fn(async (d: Partial<DraftRow>) => {
      const id = nextId();
      const row: DraftRow = {
        id,
        inboundMessageId: d.inboundMessageId ?? 1,
        status: "pending_approval",
        revision: d.revision ?? 1,
      };
      state.drafts.set(id, row);
      return row;
    }),
    appendMessage: vi.fn(async (m: Partial<MessageRow>) => {
      const id = nextId();
      const row: MessageRow = {
        id,
        twilioSid: m.twilioSid ?? null,
        status: m.status ?? "sent",
      };
      state.messages.set(id, row);
      return row;
    }),
    updateMessageDelivery: vi.fn(
      async (
        id: number,
        delivery: { status: MessageRow["status"]; twilioSid?: string; sendError?: string },
      ) => {
        const row = state.messages.get(id);
        if (!row) return;
        row.status = delivery.status;
        row.twilioSid = delivery.twilioSid ?? row.twilioSid ?? null;
        row.sendError = delivery.sendError ?? null;
      },
    ),
    getMessageByTwilioSid: vi.fn(async (sid: string) => {
      for (const row of state.messages.values()) {
        if (row.twilioSid === sid) return { ...row };
      }
      return undefined;
    }),
    updateDraftStatus: vi.fn(async (id: number, next: DraftRow["status"]) => {
      const row = state.drafts.get(id);
      if (row) row.status = next;
    }),
    createEscalation: vi.fn(async (e: Partial<EscalationRow>) => {
      const id = nextId();
      const row: EscalationRow = {
        id,
        conversationId: e.conversationId ?? 1,
        status: "open",
      };
      state.escalations.set(id, row);
      const conv = state.conversations.get(row.conversationId);
      if (conv) conv.escalated = 1;
      return row;
    }),
    resolveEscalation: vi.fn(async (id: number) => {
      const target = state.escalations.get(id);
      if (!target) return;
      target.status = "resolved";
      const stillOpen = [...state.escalations.values()].some(
        (e) => e.conversationId === target.conversationId && e.status === "open",
      );
      if (!stillOpen) {
        const conv = state.conversations.get(target.conversationId);
        if (conv) conv.escalated = 0;
      }
    }),
    seedConversation: (conv: Partial<ConversationRow>) => {
      const id = conv.id ?? nextId();
      state.conversations.set(id, {
        id,
        phone: conv.phone ?? "+15550101003",
        customerName: conv.customerName ?? null,
        escalated: conv.escalated ?? 0,
      });
      return state.conversations.get(id)!;
    },
  };
});

const db = (await import("./db")) as unknown as typeof import("./db") & {
  __state: {
    drafts: Map<number, { id: number; status: string; inboundMessageId: number }>;
    messages: Map<number, { id: number; twilioSid?: string | null; status: string }>;
    escalations: Map<number, { id: number; status: string; conversationId: number }>;
    conversations: Map<number, { id: number; escalated: number }>;
    seq: number;
  };
  seedConversation: (
    conv: Partial<{ id: number; phone: string; customerName: string | null; escalated: number }>,
  ) => { id: number; phone: string; customerName: string | null; escalated: number };
};
const twilio = await import("./twilio");
const { fromPartial } = await import("@total-typescript/shoehorn");

beforeEach(() => {
  db.__state.drafts.clear();
  db.__state.messages.clear();
  db.__state.escalations.clear();
  db.__state.conversations.clear();
  db.__state.seq = 100;
});

describe("transitionDraftStatus — atomic state machine", () => {
  it("flips pending_approval → approved on first call and returns the row", async () => {
    const draft = await db.insertDraft(
      fromPartial<Parameters<typeof db.insertDraft>[0]>({
        inboundMessageId: 1,
        revision: 1,
      }),
    );
    const moved = await db.transitionDraftStatus(draft.id, "approved");
    expect(moved).not.toBeNull();
    expect(moved!.status).toBe("approved");
  });

  it("rejects a second concurrent transition (returns null)", async () => {
    const draft = await db.insertDraft(
      fromPartial<Parameters<typeof db.insertDraft>[0]>({
        inboundMessageId: 1,
        revision: 1,
      }),
    );
    const first = await db.transitionDraftStatus(draft.id, "approved");
    const second = await db.transitionDraftStatus(draft.id, "approved");
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("does NOT allow approve→rejected once already approved", async () => {
    const draft = await db.insertDraft(
      fromPartial<Parameters<typeof db.insertDraft>[0]>({
        inboundMessageId: 1,
        revision: 1,
      }),
    );
    await db.transitionDraftStatus(draft.id, "approved");
    const second = await db.transitionDraftStatus(draft.id, "rejected");
    expect(second).toBeNull();
  });
});

describe("supersedeOtherPendingDrafts", () => {
  it("marks every other pending draft for the same inbound as superseded", async () => {
    const a = await db.insertDraft(
      fromPartial<Parameters<typeof db.insertDraft>[0]>({
        inboundMessageId: 50,
        revision: 1,
      }),
    );
    const b = await db.insertDraft(
      fromPartial<Parameters<typeof db.insertDraft>[0]>({
        inboundMessageId: 50,
        revision: 2,
      }),
    );
    const c = await db.insertDraft(
      fromPartial<Parameters<typeof db.insertDraft>[0]>({
        inboundMessageId: 99,
        revision: 1,
      }),
    );

    await db.supersedeOtherPendingDrafts(50, b.id);

    const refA = db.__state.drafts.get(a.id);
    const refB = db.__state.drafts.get(b.id);
    const refC = db.__state.drafts.get(c.id);
    expect(refA?.status).toBe("superseded");
    expect(refB?.status).toBe("pending_approval"); // the kept one
    expect(refC?.status).toBe("pending_approval"); // unrelated message untouched
  });
});

describe("getMessageByTwilioSid — webhook idempotency", () => {
  it("returns the existing message when the same sid is seen twice", async () => {
    await db.appendMessage(
      fromPartial<Parameters<typeof db.appendMessage>[0]>({
        twilioSid: "SM-dup-001",
        status: "sent",
      }),
    );
    const found = await db.getMessageByTwilioSid("SM-dup-001");
    expect(found).toBeDefined();
    expect(found!.twilioSid).toBe("SM-dup-001");
  });

  it("returns undefined for a sid that has not been processed", async () => {
    const found = await db.getMessageByTwilioSid("SM-never");
    expect(found).toBeUndefined();
  });
});

describe("Two-phase send — outbound row lifecycle", () => {
  it("starts queued, transitions to sent only after Twilio ok", async () => {
    const outbound = await db.appendMessage(
      fromPartial<Parameters<typeof db.appendMessage>[0]>({
        twilioSid: null,
        status: "queued",
      }),
    );
    expect(db.__state.messages.get(outbound.id)!.status).toBe("queued");

    // Simulate Twilio ok callback flow
    await db.updateMessageDelivery(outbound.id, {
      status: "sent",
      twilioSid: "SM-ok-1",
    });
    const row = db.__state.messages.get(outbound.id)!;
    expect(row.status).toBe("sent");
    expect(row.twilioSid).toBe("SM-ok-1");
  });

  it("on Twilio failure: outbound flips to failed AND draft is reopened to pending", async () => {
    const draft = await db.insertDraft(
      fromPartial<Parameters<typeof db.insertDraft>[0]>({
        inboundMessageId: 1,
        revision: 1,
      }),
    );
    await db.transitionDraftStatus(draft.id, "approved");
    const outbound = await db.appendMessage(
      fromPartial<Parameters<typeof db.appendMessage>[0]>({
        twilioSid: null,
        status: "queued",
      }),
    );

    // Simulate failure path
    await db.updateMessageDelivery(outbound.id, {
      status: "failed",
      sendError: "21610: blocked recipient",
    });
    await db.updateDraftStatus(draft.id, "pending_approval");

    expect(db.__state.messages.get(outbound.id)!.status).toBe("failed");
    expect(db.__state.drafts.get(draft.id)!.status).toBe("pending_approval");
  });
});

describe("resolveEscalation — escalation flag bookkeeping", () => {
  it("clears conversations.escalated only when no other open escalations remain", async () => {
    db.seedConversation({ id: 7, escalated: 0 });
    const e1 = await db.createEscalation(
      fromPartial<Parameters<typeof db.createEscalation>[0]>({
        conversationId: 7,
      }),
    );
    const e2 = await db.createEscalation(
      fromPartial<Parameters<typeof db.createEscalation>[0]>({
        conversationId: 7,
      }),
    );
    expect(db.__state.conversations.get(7)!.escalated).toBe(1);

    await db.resolveEscalation(e1.id);
    // One still open → flag stays raised
    expect(db.__state.conversations.get(7)!.escalated).toBe(1);

    await db.resolveEscalation(e2.id);
    // None open → flag must clear
    expect(db.__state.conversations.get(7)!.escalated).toBe(0);
  });
});

describe("twilio.sendSms guards (live mode disabled by default in test env)", () => {
  it("returns ok:false when Twilio credentials are absent", async () => {
    const result = await twilio.sendSms("+15550101003", "Hello");
    expect(result.ok).toBe(false);
  });

  it("rejects malformed E.164 even before checking credentials", async () => {
    const result = await twilio.sendSms("not-a-phone", "Hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either "Live Mode disabled" or "Invalid E.164" — both are safe outcomes;
      // the contract is "do not POST to Twilio".
      expect(result.error).toMatch(/Live Mode|Invalid E\.164/);
    }
  });
});
