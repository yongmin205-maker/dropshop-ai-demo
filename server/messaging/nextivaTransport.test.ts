/**
 * Vitest for `nextivaTransport.ts`.
 *
 * Strategy:
 *  - We do NOT hit the real Nextiva API in CI. All HTTP is injected via a
 *    `fetchImpl` mock so tests are deterministic + offline-safe.
 *  - A *separate* live-credentials integration test
 *    (`nextivaTransport.live.test.ts`) opt-in via `RUN_NEXTIVA_LIVE=1` covers
 *    the real network path. Keeping the two test files split prevents flaky
 *    network failures from poisoning the default `pnpm test` run.
 *
 * Endpoint contract under test (confirmed from developer.nextiva.com):
 *  - Auth:  GET /provider/token-with-authorities + `Authorization: Basic ...`
 *           → response `{ location, token }`
 *  - Poll:  GET /data/api/types/workitem?q=type:InboundSMS&rows=...
 *           → response `{ count, total, objects: [...] }`
 *  - Send:  POST /users/api/sms { to, message, campaignId?, from? }
 *           → response `{ canDial, consentType }`
 */

import { describe, expect, it, vi } from "vitest";

import {
  createNextivaClient,
  readNextivaCredsFromEnv,
} from "./nextivaTransport";

/** Build a fetch mock that replies with `status` and `body` for a sequence of calls. */
function mockFetchSequence(
  responses: Array<{ status: number; body: unknown; statusText?: string }>,
) {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const slot = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(slot.body), {
      status: slot.status,
      statusText: slot.statusText ?? "",
      headers: { "Content-Type": "application/json" },
    });
  });
  return { impl, calls };
}

describe("nextivaTransport — authenticate", () => {
  it("GETs /provider/token-with-authorities with Basic Auth and caches token+location", async () => {
    const { impl, calls } = mockFetchSequence([
      { status: 200, body: { location: "https://us-east-1.nextiva.com", token: "tok_abc" } },
    ]);
    const client = createNextivaClient(
      { username: "u@example.com", password: "pw" },
      { fetchImpl: impl, now: () => 1_000_000 },
    );
    const r = await client.authenticate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token).toBe("tok_abc");
    expect(r.location).toBe("https://us-east-1.nextiva.com");
    expect(r.expiresAt).toBe(1_000_000 + 50 * 60 * 1000);

    // Verify the request shape
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/provider\/token-with-authorities$/);
    expect(calls[0].init?.method).toBe("GET");
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    // Basic base64("u@example.com:pw")
    const expected = "Basic " + Buffer.from("u@example.com:pw", "utf-8").toString("base64");
    expect(headers.Authorization).toBe(expected);
    // No body on GET
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("returns structured failure on 401", async () => {
    const { impl } = mockFetchSequence([
      { status: 401, body: { error: "invalid_credentials" } },
    ]);
    const client = createNextivaClient(
      { username: "u", password: "wrong" },
      { fetchImpl: impl },
    );
    const r = await client.authenticate();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.error).toContain("invalid_credentials");
  });

  it("accepts legacy token field names (accessToken / jwt) for forward compat", async () => {
    const { impl } = mockFetchSequence([
      { status: 200, body: { jwt: "nested_jwt", location: "https://x.nextiva.com" } },
    ]);
    const client = createNextivaClient({ username: "u", password: "p" }, { fetchImpl: impl });
    const r = await client.authenticate();
    expect(r.ok && r.token).toBe("nested_jwt");
  });

  it("flags missing token in auth response", async () => {
    const { impl } = mockFetchSequence([{ status: 200, body: { foo: "bar" } }]);
    const client = createNextivaClient({ username: "u", password: "p" }, { fetchImpl: impl });
    const r = await client.authenticate();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing token/);
  });

  it("falls back location to baseUrl when omitted in response", async () => {
    const { impl } = mockFetchSequence([
      { status: 200, body: { token: "t" } }, // no location
    ]);
    const client = createNextivaClient({ username: "u", password: "p" }, { fetchImpl: impl });
    const r = await client.authenticate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.location).toBe("https://api.nextiva.com");
  });
});

describe("nextivaTransport — pollInbound", () => {
  it("authenticates lazily then GETs /data/api/types/workitem with Bearer token", async () => {
    const { impl, calls } = mockFetchSequence([
      { status: 200, body: { location: "https://x.nextiva.com", token: "tok_xyz" } },
      {
        status: 200,
        body: {
          count: 1,
          total: 1,
          objects: [
            {
              _id: "abc123",
              workitemId: "wi_1",
              state: "inqueue",
              channelType: "sms",
              type: "InboundSMS",
              priority: 3,
              agentUsername: "care",
              createdAt: 1715551800000,
              modifiedAt: 1715551800000,
            },
          ],
        },
      },
    ]);
    const client = createNextivaClient(
      { username: "u", password: "p" },
      { fetchImpl: impl },
    );
    const r = await client.pollInbound({ rows: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0].workitemId).toBe("wi_1");
    expect(r.items[0]._id).toBe("abc123");
    expect(r.items[0].type).toBe("InboundSMS");
    expect(r.items[0].priority).toBe(3);

    // First call = auth, second = poll
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("/data/api/types/workitem");
    expect(calls[1].url).toContain(encodeURIComponent("type:InboundSMS"));
    expect(calls[1].url).toContain("rows=10");
    const headers = (calls[1].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok_xyz");
  });

  it("reuses the cached JWT across multiple polls", async () => {
    const { impl, calls } = mockFetchSequence([
      { status: 200, body: { location: "x", token: "tok_z" } },
      { status: 200, body: { count: 0, total: 0, objects: [] } },
      { status: 200, body: { count: 0, total: 0, objects: [] } },
    ]);
    const client = createNextivaClient(
      { username: "u", password: "p" },
      { fetchImpl: impl, now: () => 1_000_000 },
    );
    await client.pollInbound();
    await client.pollInbound();
    // 1 auth + 2 polls = 3 fetches total (no re-auth)
    expect(calls).toHaveLength(3);
  });

  it("retries auth once on 401 then succeeds", async () => {
    const { impl, calls } = mockFetchSequence([
      { status: 200, body: { token: "tok1" } },
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { token: "tok2" } },
      { status: 200, body: { count: 0, total: 0, objects: [] } },
    ]);
    const client = createNextivaClient(
      { username: "u", password: "p" },
      { fetchImpl: impl },
    );
    const r = await client.pollInbound();
    expect(r.ok).toBe(true);
    // 1 auth + 1 poll(401) + 1 re-auth + 1 poll(200) = 4
    expect(calls).toHaveLength(4);
    const lastHeaders = (calls[3].init?.headers ?? {}) as Record<string, string>;
    expect(lastHeaders.Authorization).toBe("Bearer tok2");
  });

  it("propagates HTTP errors with status + body snippet", async () => {
    const { impl } = mockFetchSequence([
      { status: 200, body: { token: "t" } },
      { status: 403, body: { error: "forbidden", reason: "API not enabled" } },
    ]);
    const client = createNextivaClient({ username: "u", password: "p" }, { fetchImpl: impl });
    const r = await client.pollInbound();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.error).toContain("forbidden");
  });

  it("returns empty list on unknown envelope shape", async () => {
    const { impl } = mockFetchSequence([
      { status: 200, body: { token: "t" } },
      { status: 200, body: { weird: "shape" } },
    ]);
    const client = createNextivaClient({ username: "u", password: "p" }, { fetchImpl: impl });
    const r = await client.pollInbound();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([]);
  });
});

describe("nextivaTransport — sendSms", () => {
  it("posts to + message (no campaignId) when none configured", async () => {
    const { impl, calls } = mockFetchSequence([
      { status: 200, body: { token: "t" } },
      { status: 200, body: { canDial: true, consentType: 0 } },
    ]);
    const client = createNextivaClient(
      { username: "u", password: "p" }, // no campaignId
      { fetchImpl: impl },
    );
    const r = await client.sendSms("+13105550111", "Hello from Drop Shop");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.canDial).toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("/users/api/sms");
    expect(calls[1].init?.method).toBe("POST");
    const sent = JSON.parse(String(calls[1].init?.body ?? "{}"));
    expect(sent).toEqual({ to: "+13105550111", message: "Hello from Drop Shop" });
    expect(sent.campaignId).toBeUndefined();
  });

  it("includes campaignId + from when configured", async () => {
    const { impl, calls } = mockFetchSequence([
      { status: 200, body: { token: "tok" } },
      { status: 200, body: { canDial: true, consentType: 1 } },
    ]);
    const client = createNextivaClient(
      { username: "u", password: "p", campaignId: "camp_1", fromNumber: "+16468892423" },
      { fetchImpl: impl },
    );
    const r = await client.sendSms("+13105550111", "Hi");
    expect(r.ok).toBe(true);

    const sent = JSON.parse(String(calls[1].init?.body ?? "{}"));
    expect(sent).toEqual({
      to: "+13105550111",
      message: "Hi",
      campaignId: "camp_1",
      from: "+16468892423",
    });
  });

  it("rejects invalid E.164 before calling Nextiva", async () => {
    const { impl, calls } = mockFetchSequence([{ status: 200, body: {} }]);
    const client = createNextivaClient(
      { username: "u", password: "p", campaignId: "camp_1" },
      { fetchImpl: impl },
    );
    const r = await client.sendSms("3105550111", "test");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_phone");
    expect(calls).toHaveLength(0);
  });

  it("rejects empty message before calling Nextiva", async () => {
    const { impl, calls } = mockFetchSequence([{ status: 200, body: {} }]);
    const client = createNextivaClient(
      { username: "u", password: "p" },
      { fetchImpl: impl },
    );
    const r = await client.sendSms("+13105550111", "  ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("empty_body");
    expect(calls).toHaveLength(0);
  });

  it("surfaces canDial=false from a 200 response", async () => {
    const { impl } = mockFetchSequence([
      { status: 200, body: { token: "t" } },
      { status: 200, body: { canDial: false, consentType: 2 } },
    ]);
    const client = createNextivaClient(
      { username: "u", password: "p" },
      { fetchImpl: impl },
    );
    const r = await client.sendSms("+13105550111", "Hi");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.canDial).toBe(false);
    expect(r.consentType).toBe(2);
  });

  it("surfaces 400 Bad Request body snippet", async () => {
    const { impl } = mockFetchSequence([
      { status: 200, body: { token: "t" } },
      { status: 400, body: { error: "missing campaignId" } },
    ]);
    const client = createNextivaClient(
      { username: "u", password: "p" },
      { fetchImpl: impl },
    );
    const r = await client.sendSms("+13105550111", "Hi");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toContain("missing campaignId");
  });
});

describe("nextivaTransport — env reader", () => {
  it("returns null when required env is missing", () => {
    const prev = { ...process.env };
    delete process.env.NEXTIVA_USERNAME;
    delete process.env.NEXTIVA_PASSWORD;
    try {
      expect(readNextivaCredsFromEnv()).toBeNull();
    } finally {
      Object.assign(process.env, prev);
    }
  });

  it("returns creds with optional campaignId + fromNumber when present", () => {
    const prev = { ...process.env };
    process.env.NEXTIVA_USERNAME = "u@x.com";
    process.env.NEXTIVA_PASSWORD = "pw";
    process.env.NEXTIVA_CAMPAIGN_ID = "camp_123";
    process.env.NEXTIVA_PHONE_NUMBER = "+16468892423";
    try {
      const r = readNextivaCredsFromEnv();
      expect(r).toEqual({
        username: "u@x.com",
        password: "pw",
        campaignId: "camp_123",
        fromNumber: "+16468892423",
      });
    } finally {
      Object.assign(process.env, prev);
    }
  });

  it("treats empty campaignId as undefined", () => {
    const prev = { ...process.env };
    process.env.NEXTIVA_USERNAME = "u";
    process.env.NEXTIVA_PASSWORD = "pw";
    process.env.NEXTIVA_CAMPAIGN_ID = "   ";
    delete process.env.NEXTIVA_PHONE_NUMBER;
    try {
      const r = readNextivaCredsFromEnv();
      expect(r?.campaignId).toBeUndefined();
      expect(r?.fromNumber).toBeUndefined();
    } finally {
      Object.assign(process.env, prev);
    }
  });
});
