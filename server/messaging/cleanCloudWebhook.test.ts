import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB layer up-front so recordAndDispatch's "no db" branch returns
// cleanly. Individual tests can override this via vi.mocked(getDb).
vi.mock("../db", () => ({
  getDb: vi.fn(async () => null),
}));

// Mock errorLog so the warn-path noise doesn't fail under hermetic test env.
vi.mock("../errorLog", () => ({
  logServerError: vi.fn(async () => undefined),
}));

import {
  CLEANCLOUD_EVENT_TYPES,
  constantTimeStringEqual,
  deriveEventId,
  dispatchEvent,
  extractEventType,
  recordAndDispatch,
  registerCleanCloudWebhook,
} from "./cleanCloudWebhook";

describe("constantTimeStringEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeStringEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(constantTimeStringEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(constantTimeStringEqual("short", "much-longer-string")).toBe(false);
  });

  it("returns false when one side is empty", () => {
    expect(constantTimeStringEqual("", "secret")).toBe(false);
    expect(constantTimeStringEqual("secret", "")).toBe(false);
  });

  it("returns true for two empty strings (caller is responsible for the empty-secret guard)", () => {
    // The webhook handler itself rejects empty configured-secret with 503
    // BEFORE comparing; this helper just does math.
    expect(constantTimeStringEqual("", "")).toBe(true);
  });
});

describe("deriveEventId", () => {
  it("prefers payload.eventId when present", () => {
    expect(deriveEventId("order.created", { eventId: "evt_abc" })).toBe("evt_abc");
  });

  it("falls through to payload.id, then orderID, then customerID", () => {
    expect(deriveEventId("order.deleted", { id: "ord_1" })).toBe("ord_1");
    expect(deriveEventId("order.status_changed", { orderID: 42 })).toBe("42");
    expect(deriveEventId("customer.updated", { customerID: "cu_9" })).toBe("cu_9");
  });

  it("synthesizes a deterministic sha256 hash when no id field is present", () => {
    const id1 = deriveEventId("order.created", { foo: "bar" });
    const id2 = deriveEventId("order.created", { foo: "bar" });
    expect(id1).toBe(id2);
    expect(id1.startsWith("sha256:")).toBe(true);
  });

  it("different payloads yield different synthesized ids", () => {
    const a = deriveEventId("order.created", { foo: "bar" });
    const b = deriveEventId("order.created", { foo: "baz" });
    expect(a).not.toBe(b);
  });

  it("event type is part of the hash so same payload under different event types differs", () => {
    const a = deriveEventId("order.created", { foo: "bar" });
    const b = deriveEventId("order.deleted", { foo: "bar" });
    expect(a).not.toBe(b);
  });
});

describe("extractEventType", () => {
  it("reads body.event when present", () => {
    expect(extractEventType({ event: "order.created" })).toBe("order.created");
  });

  it("falls through to body.type for forward-compat", () => {
    expect(extractEventType({ type: "customer.updated" })).toBe("customer.updated");
  });

  it("returns empty string when neither is present", () => {
    expect(extractEventType({})).toBe("");
    expect(extractEventType(null)).toBe("");
    expect(extractEventType("not an object")).toBe("");
  });
});

describe("CLEANCLOUD_EVENT_TYPES", () => {
  it("matches the 9 events surfaced by the CleanCloud admin Webhooks panel (order.created appears twice in UI but is one event type)", () => {
    expect(new Set(CLEANCLOUD_EVENT_TYPES)).toEqual(
      new Set([
        "order.created",
        "order.status_changed",
        "order.pickup_rescheduled",
        "order.delivery_rescheduled",
        "order.nothing_to_pickup",
        "order.deleted",
        "customer.created",
        "customer.updated",
        "customer.deleted",
      ]),
    );
  });
});

describe("dispatchEvent (scaffold)", () => {
  it("returns an .acked step for every supported event type", async () => {
    for (const t of CLEANCLOUD_EVENT_TYPES) {
      const r = await dispatchEvent(t, { sample: true });
      expect(r.ok).toBe(true);
      expect(r.step.startsWith(`cleancloud.${t}`)).toBe(true);
      expect(r.step.endsWith(".acked")).toBe(true);
    }
  });
});

describe("recordAndDispatch (no-db short-circuit branch)", () => {
  it("returns inserted+no_db.skip for known events when DB is unavailable", async () => {
    const r = await recordAndDispatch({
      eventType: "order.status_changed",
      payload: { id: "ord_1" },
    });
    expect(r.status).toBe("inserted");
    expect(r.step).toBe("cleancloud.no_db.skip");
  });

  it("returns unknown_type for non-whitelisted event names even without DB", async () => {
    const r = await recordAndDispatch({
      eventType: "order.flux_capacitor_engaged",
      payload: {},
    });
    expect(r.status).toBe("unknown_type");
  });
});

// ---------- Express handler contract ----------
//
// We don't spin up Express. We capture the registered handler via a fake
// `Express` and invoke it with hand-rolled req/res mocks. This mirrors the
// pattern used in twilioWebhook.mms.test.ts.

type RouteHandler = (req: any, res: any) => Promise<void> | void;

function fakeApp() {
  let handler: RouteHandler | null = null;
  const app = {
    post(path: string, h: RouteHandler) {
      if (path === "/api/cleancloud/webhook") handler = h;
    },
  } as any;
  return {
    app,
    getHandler: () => {
      if (!handler) throw new Error("handler not registered");
      return handler;
    },
  };
}

function fakeRes() {
  let statusCode = 200;
  let body: any = null;
  let contentType: string | null = null;
  const res: any = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    type(t: string) {
      contentType = t;
      return res;
    },
    send(b: any) {
      body = b;
      return res;
    },
    json(b: any) {
      body = b;
      contentType = "application/json";
      return res;
    },
  };
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get contentType() {
      return contentType;
    },
  };
}

describe("registerCleanCloudWebhook handler", () => {
  const originalSecret = process.env.CLEANCLOUD_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.CLEANCLOUD_WEBHOOK_SECRET = "test-secret-abc-123";
  });

  afterEach(() => {
    process.env.CLEANCLOUD_WEBHOOK_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it("returns 503 when CLEANCLOUD_WEBHOOK_SECRET is empty", async () => {
    process.env.CLEANCLOUD_WEBHOOK_SECRET = "";
    const { app, getHandler } = fakeApp();
    registerCleanCloudWebhook(app);
    const r = fakeRes();
    await getHandler()(
      { query: { token: "anything" }, body: { event: "order.created" } } as any,
      r.res,
    );
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/not configured/i);
  });

  it("returns 403 on wrong token", async () => {
    const { app, getHandler } = fakeApp();
    registerCleanCloudWebhook(app);
    const r = fakeRes();
    await getHandler()(
      { query: { token: "wrong" }, body: { event: "order.created" } } as any,
      r.res,
    );
    expect(r.statusCode).toBe(403);
    expect(r.body).toMatch(/invalid/i);
  });

  it("returns 403 when no token query param is present at all", async () => {
    const { app, getHandler } = fakeApp();
    registerCleanCloudWebhook(app);
    const r = fakeRes();
    await getHandler()(
      { query: {}, body: { event: "order.created" } } as any,
      r.res,
    );
    expect(r.statusCode).toBe(403);
  });

  it("returns 400 when token is right but body has no event field", async () => {
    const { app, getHandler } = fakeApp();
    registerCleanCloudWebhook(app);
    const r = fakeRes();
    await getHandler()(
      { query: { token: "test-secret-abc-123" }, body: { random: "noise" } } as any,
      r.res,
    );
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/missing event/i);
  });

  it("returns 200 + JSON {status: inserted} on a valid known event in the no-DB branch", async () => {
    const { app, getHandler } = fakeApp();
    registerCleanCloudWebhook(app);
    const r = fakeRes();
    await getHandler()(
      {
        query: { token: "test-secret-abc-123" },
        body: { event: "order.status_changed", id: "ord_42" },
      } as any,
      r.res,
    );
    expect(r.statusCode).toBe(200);
    expect(r.contentType).toBe("application/json");
    expect(r.body).toEqual({ status: "inserted", step: "cleancloud.no_db.skip" });
  });

  it("returns 200 + status=unknown_type for unrecognized event names", async () => {
    const { app, getHandler } = fakeApp();
    registerCleanCloudWebhook(app);
    const r = fakeRes();
    await getHandler()(
      {
        query: { token: "test-secret-abc-123" },
        body: { event: "user.exploded" },
      } as any,
      r.res,
    );
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ status: "unknown_type" });
  });
});
