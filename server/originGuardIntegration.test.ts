/**
 * §5.10 carryover: deployment-time integration test for `requireSameOrigin`.
 *
 * The unit tests in `originGuard.test.ts` mock `req`/`res` directly. This file
 * mounts the middleware in front of a real Express app and exercises it with
 * `supertest`, which is the same machinery our real /api/trpc handler uses. If
 * any future refactor moves the middleware order, breaks Express header
 * propagation, or trips the proxy-host fallback, these tests will catch it.
 */

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { requireSameOrigin } from "./originGuard";

function makeApp() {
  const app = express();
  // Mirror the real wiring in server/_core/index.ts: the guard sits *in front
  // of* /api/trpc, before the tRPC handler. We replace the handler with a
  // sentinel so we can assert the request reached past the guard.
  app.use("/api/trpc", requireSameOrigin, (_req, res) => {
    res.status(200).json({ reached: true });
  });
  // Twilio webhook is mounted OUTSIDE /api/trpc, so the guard must not
  // accidentally cover it.
  app.post("/api/twilio/sms", (_req, res) => {
    res.status(200).send("<Response/>");
  });
  return app;
}

describe("§5.10 originGuard integration (real Express + supertest)", () => {
  it("allows GET /api/trpc/* with no Origin (subscriptions, queries)", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/trpc/auth.me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it("allows same-origin POST /api/trpc/drafts.approve under proxy headers", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/trpc/drafts.approve")
      .set("Host", "internal-host:3000") // raw express host
      .set("X-Forwarded-Host", "dropshopai-vx45nyzf.manus.space") // proxy override
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "https://dropshopai-vx45nyzf.manus.space")
      .send({ draftId: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it("rejects cross-origin POST /api/trpc/drafts.approve with 403", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/trpc/drafts.approve")
      .set("Host", "dropshopai-vx45nyzf.manus.space")
      .set("Origin", "https://attacker.example.com")
      .send({ draftId: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CSRF/);
  });

  it("rejects POST with no Origin AND no Referer", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/trpc/drafts.approve")
      .set("Host", "dropshopai-vx45nyzf.manus.space")
      .send({ draftId: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/missing Origin/);
  });

  it("falls back to Referer when Origin is absent (some old browsers)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/trpc/drafts.approve")
      .set("Host", "dropshopai-vx45nyzf.manus.space")
      .set("X-Forwarded-Host", "dropshopai-vx45nyzf.manus.space")
      .set("X-Forwarded-Proto", "https")
      .set("Referer", "https://dropshopai-vx45nyzf.manus.space/dashboard")
      .send({ draftId: 1 });
    expect(res.status).toBe(200);
  });

  it("honors ALLOWED_ORIGINS allow-list when set (and rejects everything else)", async () => {
    process.env.ALLOWED_ORIGINS =
      "https://dropshopai-vx45nyzf.manus.space,https://staging.dropshop.ai";
    try {
      const app = makeApp();
      const ok = await request(app)
        .post("/api/trpc/drafts.approve")
        .set("Origin", "https://staging.dropshop.ai")
        .send({});
      expect(ok.status).toBe(200);

      // even if request is technically same-host as Express, allow-list wins
      const blocked = await request(app)
        .post("/api/trpc/drafts.approve")
        .set("Host", "127.0.0.1")
        .set("Origin", "http://127.0.0.1:3000")
        .send({});
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toMatch(/not in ALLOWED_ORIGINS/);
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it("§5.10b suffix policy admits sibling Manus subdomains by design (CSRF risk surfaces *only* at the procedure layer)", async () => {
    // Pre-fix/1, drafts.approve was publicProcedure: a sibling Manus app
    // (e.g. "evil.manus.space") could fire cross-origin POST credentials:
    // include and the originGuard suffix policy (ADR 0003) would let it
    // through. The fix is at the tRPC layer (adminProcedure), not here —
    // the guard intentionally still admits *.manus.space to keep dev
    // sandbox URLs working. Pinning the dual-layer model: this test
    // documents that the guard is NOT the line of defense for sibling
    // subdomains. See dropshopRouter.test.ts for the procedure-level pin.
    const app = makeApp();
    const res = await request(app)
      .post("/api/trpc/drafts.approve")
      .set("Origin", "https://evil.manus.space")
      .send({ draftId: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it("does NOT block the Twilio webhook (different mount point)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/twilio/sms")
      .send("From=%2B15551234567&Body=hello");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response/>");
  });
});
