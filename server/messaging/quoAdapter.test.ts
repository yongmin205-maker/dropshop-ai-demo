/**
 * Quo adapter contracts.
 *
 * The signature reference values are computed by the same Node.js example
 * shown in the official docs (mirrored in `quoAdapter.verifySignature`), so
 * regressing the algorithm will fail these tests.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { quoAdapter } from "./quoAdapter";
import { DEFAULT_REPLAY_WINDOW_MS } from "./types";

// Same key the official docs use as their sample signing secret.
const SIGNING_KEY = "R2ZLM2o0bFhBNVpyUnU2NG9mYXQ1MHNyR3pvSUhIVVg=";

function makeSignedRequest(
  body: string,
  timestamp: number,
  signingKey = SIGNING_KEY,
) {
  const signedData = `${timestamp}.${body}`;
  const signingKeyBinary = Buffer.from(signingKey, "base64").toString("binary");
  const sig = createHmac("sha256", signingKeyBinary)
    .update(Buffer.from(signedData, "utf8"))
    .digest("base64");
  return {
    body,
    headers: {
      "openphone-signature": `hmac;1;${timestamp};${sig}`,
    },
    timestamp,
    sig,
  };
}

const SAMPLE_PAYLOAD = JSON.stringify({
  id: "EVc67ec998b35c41d388af50799aeeba3e",
  object: "event",
  apiVersion: "v2",
  createdAt: "2022-01-23T16:55:52.557Z",
  type: "message.received",
  data: {
    object: {
      id: "AC24a8b8321c4f4cf2be110f4250793d51",
      object: "message",
      from: "+14155550100",
      to: "+14155550199",
      body: "Hi, can I pick up my order today?",
      conversationId: "CV0001",
      contactId: "CT0001",
      media: [],
    },
  },
});

describe("quoAdapter — verifySignature", () => {
  it("accepts a known-good signature against the sample body", () => {
    const now = 1_777_000_000_000;
    const req = makeSignedRequest(SAMPLE_PAYLOAD, now);
    const result = quoAdapter.verifySignature({
      headers: req.headers,
      rawBody: req.body,
      signingKey: SIGNING_KEY,
      nowMs: now,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a tampered body (signature was for the original)", () => {
    const now = 1_777_000_000_000;
    const req = makeSignedRequest(SAMPLE_PAYLOAD, now);
    const result = quoAdapter.verifySignature({
      headers: req.headers,
      rawBody: SAMPLE_PAYLOAD.replace("Hi", "HI"),
      signingKey: SIGNING_KEY,
      nowMs: now,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered timestamp (signed bytes no longer match)", () => {
    const now = 1_777_000_000_000;
    const req = makeSignedRequest(SAMPLE_PAYLOAD, now);
    // Forge a different timestamp in the header but keep the same digest.
    const forged = {
      ...req.headers,
      "openphone-signature": `hmac;1;${now + 5_000};${req.sig}`,
    };
    const result = quoAdapter.verifySignature({
      headers: forged,
      rawBody: req.body,
      signingKey: SIGNING_KEY,
      nowMs: now + 5_000,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects timestamps older than the replay window", () => {
    const ts = 1_777_000_000_000;
    const req = makeSignedRequest(SAMPLE_PAYLOAD, ts);
    const now = ts + DEFAULT_REPLAY_WINDOW_MS + 1;
    const result = quoAdapter.verifySignature({
      headers: req.headers,
      rawBody: req.body,
      signingKey: SIGNING_KEY,
      nowMs: now,
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects timestamps in the future beyond drift tolerance", () => {
    const ts = 1_777_000_000_000;
    const req = makeSignedRequest(SAMPLE_PAYLOAD, ts);
    // 5 minutes in the past = "now" is 5 min before signed timestamp
    const now = ts - 5 * 60 * 1000;
    const result = quoAdapter.verifySignature({
      headers: req.headers,
      rawBody: req.body,
      signingKey: SIGNING_KEY,
      nowMs: now,
    });
    expect(result).toEqual({ ok: false, reason: "future_timestamp" });
  });

  it("rejects when header missing", () => {
    const result = quoAdapter.verifySignature({
      headers: {},
      rawBody: SAMPLE_PAYLOAD,
      signingKey: SIGNING_KEY,
      nowMs: Date.now(),
    });
    expect(result).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects when key missing", () => {
    const now = 1_777_000_000_000;
    const req = makeSignedRequest(SAMPLE_PAYLOAD, now);
    const result = quoAdapter.verifySignature({
      headers: req.headers,
      rawBody: req.body,
      signingKey: "",
      nowMs: now,
    });
    expect(result).toEqual({ ok: false, reason: "missing_key" });
  });

  it("rejects malformed header (wrong field count)", () => {
    const now = 1_777_000_000_000;
    const result = quoAdapter.verifySignature({
      headers: { "openphone-signature": "hmac;1;deadbeef" },
      rawBody: SAMPLE_PAYLOAD,
      signingKey: SIGNING_KEY,
      nowMs: now,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("rejects malformed header (bad scheme)", () => {
    const now = 1_777_000_000_000;
    const result = quoAdapter.verifySignature({
      headers: { "openphone-signature": `bcrypt;1;${now};deadbeef==` },
      rawBody: SAMPLE_PAYLOAD,
      signingKey: SIGNING_KEY,
      nowMs: now,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("accepts the forward-compatible quo-signature header", () => {
    const now = 1_777_000_000_000;
    const req = makeSignedRequest(SAMPLE_PAYLOAD, now);
    const headers = {
      "quo-signature": req.headers["openphone-signature"],
    };
    const result = quoAdapter.verifySignature({
      headers,
      rawBody: req.body,
      signingKey: SIGNING_KEY,
      nowMs: now,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("quoAdapter — parsePayload", () => {
  const NOW = 1_777_000_000_000;

  it("normalizes a message.received event to InboundMessage", () => {
    const out = quoAdapter.parsePayload({ rawBody: SAMPLE_PAYLOAD, receivedAt: NOW });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("quo");
    expect(out!.providerMessageId).toBe("AC24a8b8321c4f4cf2be110f4250793d51");
    expect(out!.from).toBe("+14155550100");
    expect(out!.to).toBe("+14155550199");
    expect(out!.body).toBe("Hi, can I pick up my order today?");
    expect(out!.mediaUrls).toEqual([]);
    expect(out!.conversationId).toBe("CV0001");
    expect(out!.contactId).toBe("CT0001");
    expect(out!.receivedAt).toBe(NOW);
  });

  it("returns null for events the adapter ignores (message.delivered)", () => {
    const body = JSON.stringify({
      id: "EV1",
      type: "message.delivered",
      data: { object: { id: "AC1", from: "+1", to: "+2", body: "" } },
    });
    expect(quoAdapter.parsePayload({ rawBody: body, receivedAt: NOW })).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(quoAdapter.parsePayload({ rawBody: "{not json", receivedAt: NOW })).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const body = JSON.stringify({
      id: "EV1",
      type: "message.received",
      data: { object: { id: "AC1", from: "+14155550100" /* no `to` */ } },
    });
    expect(quoAdapter.parsePayload({ rawBody: body, receivedAt: NOW })).toBeNull();
  });

  it("extracts media URLs from the `media[]` array", () => {
    const body = JSON.stringify({
      type: "message.received",
      data: {
        object: {
          id: "AC2",
          from: "+14155550100",
          to: "+14155550199",
          body: "📷",
          media: [
            { url: "https://media.example.com/a.jpg" },
            { url: "https://media.example.com/b.jpg" },
          ],
        },
      },
    });
    const out = quoAdapter.parsePayload({ rawBody: body, receivedAt: NOW });
    expect(out?.mediaUrls).toEqual([
      "https://media.example.com/a.jpg",
      "https://media.example.com/b.jpg",
    ]);
  });

  it("normalizes a bare 10-digit number to E.164 (+1...)", () => {
    const body = JSON.stringify({
      type: "message.received",
      data: { object: { id: "AC3", from: "4155550100", to: "4155550199", body: "hi" } },
    });
    const out = quoAdapter.parsePayload({ rawBody: body, receivedAt: NOW });
    expect(out?.from).toBe("+14155550100");
    expect(out?.to).toBe("+14155550199");
  });
});
