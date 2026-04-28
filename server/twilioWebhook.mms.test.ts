import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";

/**
 * Contract: when Twilio delivers an MMS (NumMedia >= 1), the webhook MUST
 *
 *   1. Skip the LLM agent entirely (we cannot see the photo).
 *   2. Persist the inbound message with `attachments` set.
 *   3. Create an escalation row so a manager looks at it.
 *   4. Never auto-send a reply, even if `DROPSHOP_AUTO_SEND=1`.
 *   5. Respond 200 OK with `<Response/>` so Twilio stops retrying.
 *
 * This pins the §3.13 fix in place.
 */

vi.mock("./twilio", () => ({
  isLiveMode: () => true,
  isE164: (s: string) => /^\+\d{8,15}$/.test(s),
  validateTwilioSignature: () => true,
  reconstructWebhookUrl: () => "https://example.test/api/twilio/sms",
  sendSms: vi.fn(async () => ({ ok: true as const, sid: "SHOULDNOTBECALLED" })),
}));

vi.mock("./aiAgent", () => ({
  draftAgentReply: vi.fn(async () => {
    throw new Error("draftAgentReply must NOT be called when MMS arrives");
  }),
}));

vi.mock("./mockCleanCloud", () => ({
  ensureSeeded: vi.fn(async () => {}),
  getCustomerByPhone: vi.fn(async () => ({ id: 1, name: "Marie", phone: "+15550101001" })),
}));

const dbState: any = {
  appendedMessages: [] as any[],
  appendedLogs: [] as any[],
  createdEscalations: [] as any[],
  insertedDrafts: [] as any[],
  intentUpdates: [] as any[],
};

vi.mock("./db", () => ({
  withTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({}),
  appendMessageTx: vi.fn(async (_tx: any, value: any) => {
    const row = { id: dbState.appendedMessages.length + 1, ...value };
    dbState.appendedMessages.push(row);
    return row;
  }),
  appendMessage: vi.fn(),
  appendProcessingLog: vi.fn(async (v: any) => dbState.appendedLogs.push(v)),
  appendProcessingLogs: vi.fn(),
  appendProcessingLogTx: vi.fn(async (_tx: any, v: any) => dbState.appendedLogs.push(v)),
  appendProcessingLogsTx: vi.fn(async (_tx: any, v: any[]) => dbState.appendedLogs.push(...v)),
  createEscalation: vi.fn(),
  createEscalationTx: vi.fn(async (_tx: any, value: any) => {
    const row = { id: dbState.createdEscalations.length + 1, ...value };
    dbState.createdEscalations.push(row);
    return row;
  }),
  getMessageByTwilioSid: vi.fn(async () => undefined),
  getOrCreateConversation: vi.fn(async () => ({ id: 7, customerName: "Marie", customerPhone: "+15550101001" })),
  insertDraft: vi.fn(),
  insertDraftTx: vi.fn(async (_tx: any, v: any) => {
    dbState.insertedDrafts.push(v);
    return { id: 999 };
  }),
  transitionDraftStatus: vi.fn(),
  transitionDraftStatusTx: vi.fn(),
  updateConversationIntent: vi.fn(),
  updateConversationIntentTx: vi.fn(async (_tx: any, _id: number, intent: string) => {
    dbState.intentUpdates.push(intent);
  }),
  updateDraftStatusTx: vi.fn(),
  updateMessageDelivery: vi.fn(),
  updateMessageDeliveryTx: vi.fn(),
}));

import { registerTwilioWebhook } from "./twilioWebhook";
import { sendSms } from "./twilio";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { draftAgentReply } from "./aiAgent";

interface RouteHandler {
  (req: Request, res: Response): Promise<void>;
}

function buildHarness(): { handler: RouteHandler; res: () => MockRes } {
  let captured: RouteHandler | null = null;
  const fakeApp = fromPartial<Express>({
    post: (path: string, h: RouteHandler) => {
      if (path === "/api/twilio/sms") captured = h;
    },
  });
  registerTwilioWebhook(fakeApp);
  if (!captured) throw new Error("webhook handler not registered");
  return { handler: captured, res: makeRes };
}

class MockRes {
  statusCode = 200;
  bodyText = "";
  contentType = "";
  status(c: number) { this.statusCode = c; return this; }
  type(t: string) { this.contentType = t; return this; }
  send(b: string) { this.bodyText = b; return this; }
}
function makeRes(): MockRes { return new MockRes(); }

function makeReq(body: Record<string, string>, headers: Record<string, string> = {}): Request {
  return fromPartial<Request>({
    body,
    headers: { "x-twilio-signature": "sig", ...headers },
    protocol: "https",
    originalUrl: "/api/twilio/sms",
    get: (h: string) => headers[h.toLowerCase()],
  });
}

beforeEach(() => {
  dbState.appendedMessages = [];
  dbState.appendedLogs = [];
  dbState.createdEscalations = [];
  dbState.insertedDrafts = [];
  dbState.intentUpdates = [];
  delete process.env.DROPSHOP_AUTO_SEND;
});
afterEach(() => { vi.clearAllMocks(); });

describe("twilioWebhook MMS contract", () => {
  it("escalates a single-photo MMS, persists attachments, and never calls the LLM or sends SMS", async () => {
    const { handler } = buildHarness();
    const res = new MockRes();
    await handler(
      makeReq({
        From: "+15550101001",
        Body: "",
        MessageSid: "SM_mms_1",
        NumMedia: "1",
        MediaUrl0: "https://twilio.example/img1.jpg",
        MediaContentType0: "image/jpeg",
      }),
      fromAny<Response>(res),
    );

    expect(res.statusCode).toBe(200);
    expect(res.bodyText).toContain("<Response/>");

    // The agent must NOT have been consulted.
    expect((draftAgentReply as any)).not.toHaveBeenCalled();
    // We must NOT have auto-sent.
    expect((sendSms as any)).not.toHaveBeenCalled();

    // Inbound message must have been persisted with attachments.
    expect(dbState.appendedMessages).toHaveLength(1);
    expect(dbState.appendedMessages[0].attachments).toEqual([
      { url: "https://twilio.example/img1.jpg", contentType: "image/jpeg" },
    ]);
    // Body fallback "[photo]" because customer sent media-only.
    expect(dbState.appendedMessages[0].body).toBe("[photo]");

    // An escalation must exist.
    expect(dbState.createdEscalations).toHaveLength(1);
    expect(dbState.createdEscalations[0].reason).toMatch(/attachment/);

    // No draft created.
    expect(dbState.insertedDrafts).toHaveLength(0);

    // Intent forced to Critical Escalation.
    expect(dbState.intentUpdates).toContain("Critical Escalation");
  });

  it("handles multi-attachment MMS up to the 10-item cap", async () => {
    const { handler } = buildHarness();
    const res = new MockRes();
    const params: Record<string, string> = {
      From: "+15550101001",
      Body: "see pics",
      MessageSid: "SM_mms_3",
      NumMedia: "3",
    };
    for (let i = 0; i < 3; i += 1) {
      params[`MediaUrl${i}`] = `https://twilio.example/img${i}.jpg`;
      params[`MediaContentType${i}`] = "image/jpeg";
    }
    await handler(makeReq(params), fromAny<Response>(res));

    expect(res.statusCode).toBe(200);
    expect(dbState.appendedMessages).toHaveLength(1);
    expect(dbState.appendedMessages[0].attachments).toHaveLength(3);
    expect(dbState.appendedMessages[0].body).toBe("see pics");
    expect(dbState.createdEscalations).toHaveLength(1);
    expect((sendSms as any)).not.toHaveBeenCalled();
  });

  it("does NOT auto-send even when DROPSHOP_AUTO_SEND=1, because MMS forces HITL", async () => {
    process.env.DROPSHOP_AUTO_SEND = "1";
    const { handler } = buildHarness();
    const res = new MockRes();
    await handler(
      makeReq({
        From: "+15550101001",
        Body: "",
        MessageSid: "SM_mms_auto",
        NumMedia: "1",
        MediaUrl0: "https://twilio.example/x.jpg",
        MediaContentType0: "image/jpeg",
      }),
      fromAny<Response>(res),
    );

    expect((sendSms as any)).not.toHaveBeenCalled();
    expect(dbState.createdEscalations).toHaveLength(1);
  });

  it("rejects an empty body with no media as 400", async () => {
    const { handler } = buildHarness();
    const res = new MockRes();
    await handler(
      makeReq({
        From: "+15550101001",
        Body: "",
        MessageSid: "SM_mms_empty",
        NumMedia: "0",
      }),
      fromAny<Response>(res),
    );
    expect(res.statusCode).toBe(400);
    expect(dbState.appendedMessages).toHaveLength(0);
  });
});
